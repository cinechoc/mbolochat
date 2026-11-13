import * as ImagePicker from 'expo-image-picker';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { ChevronDown, Phone, Video } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import {
  Alert,
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionSheet } from '@/components/action-sheet';
import { Avatar } from '@/components/avatar';
import { BlurTarget } from '@/components/blur-target';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { CHAT_TIME_GAP_MS, useChatColors } from '@/constants/chat-theme';
import { Spacing } from '@/constants/theme';
import { useCalls } from '@/features/calls/CallProvider';
import { ChatEmptyState } from '@/features/chat/ui/chat-empty-state';
import { ChatHeaderBar } from '@/features/chat/ui/chat-header-bar';
import { ChatInputBar } from '@/features/chat/ui/chat-input-bar';
import { ChatMessageList } from '@/features/chat/ui/chat-message-list';
import { ChatSecurityBanner } from '@/features/chat/ui/chat-security-banner';
import type { MediaOpenRequest } from '@/features/chat/ui/chat-message-row';
import { ImageViewer, VideoViewer } from '@/features/media/MediaViewers';
import {
  isRejectedMedia,
  normalizeImageAsset,
  pickDocuments,
  pickLibraryMedia,
} from '@/features/media/pickMedia';
import { closeMedia } from '@/features/e2ee/mediaStore';
import { isE2eeEnabled } from '@/features/e2ee/policy';
import {
  READ_VISIBILITY_MIN_TIME_MS,
  READ_VISIBILITY_PERCENT,
  visibleForeignMessageIds,
} from '@/features/e2ee/read-visibility';
import type { E2eeListRow } from '@/features/e2ee/rows';
import { getPresenceRecord } from '@/features/presence/presenceStore';
import { REACTION_STICKERS, onConnection } from '@/lib/socket';
import { StickerView } from '@/features/stickers/StickerView';
import { findSticker } from '@/features/stickers/stickerPacks';
import { copyToClipboard } from '@/lib/clipboard';
import { conversationTitle } from '@/lib/format';
import type { MessageQuote, MessageReceipt } from '@/lib/types';
import { useKeyboardHeight } from '@/hooks/use-keyboard-height';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { useChatConversation } from '../hooks/use-chat-conversation';
import { useChatMessages } from '../hooks/use-chat-messages';
import { useChatScroll } from '../hooks/use-chat-scroll';
import { useChatSecurity } from '../hooks/use-chat-security';
import { useChatActions } from '../hooks/use-chat-actions';
import { useChatTransport } from '../hooks/use-chat-transport';
import { useChatMedia } from '../hooks/use-chat-media';
import { identityOf } from '../model/message-view';
import type {
  ChatCapabilities,
  ChatMessageView,
} from '../transport/types';
import { CLASSIC_DEPS, E2EE_DEPS } from '../transport/production-deps';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { cache } from '@/lib/cache';

const EMPTY_CAPABILITIES: ChatCapabilities = {
  replies: true,
  reactions: false,
  deleteForEveryone: false,
  stickers: false,
  gifs: false,
  voice: false,
  typing: false,
  calls: false,
  albums: false,
  groups: false,
  encrypted: false,
  pagination: 'server',
  receipts: 'ticks',
};

const READ_VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: READ_VISIBILITY_PERCENT,
  minimumViewTime: READ_VISIBILITY_MIN_TIME_MS,
};

function quoteOfView(message: ChatMessageView): MessageQuote {
  return {
    id: message.id,
    senderName: message.sender.displayName,
    content: message.deleted ? '' : message.body,
    type: message.type,
    attachmentType: message.deleted ? null : (message.attachment?.type ?? null),
    deleted: message.deleted,
  };
}

/**
 * Écran de conversation unifié : il ne parle qu'aux hooks et aux composants.
 * Le pipeline (clair ou chiffré) est entièrement derrière `ChatTransport`.
 */
export function ChatScreen({ conversationId }: { conversationId: string }) {
  const { token, user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const { width: windowWidth } = useWindowDimensions();
  const theme = useTheme();
  const chat = useChatColors();
  const calls = useCalls();
  const [online, setOnline] = useState(true);
  const [focused, setFocused] = useState(false);
  const [replyTo, setReplyTo] = useState<MessageQuote | null>(null);
  const [menuFor, setMenuFor] = useState<ChatMessageView | null>(null);
  const [seenFor, setSeenFor] = useState<ChatMessageView | null>(null);
  const [chatAreaHeight, setChatAreaHeight] = useState(0);
  const media = useChatMedia();
  const { openImage, openVideo, closeImage, closeVideo } = media;
  const mediaIdRef = useRef<string | null>(null);
  const appActiveRef = useRef(AppState.currentState === 'active');
  const blurTargetRef = useRef<ComponentRef<typeof View>>(null);

  const conversation = useChatConversation({
    conversationId,
    token,
    currentUserId: user?.id ?? null,
    e2eeEnabled: isE2eeEnabled(),
    online,
    api,
    cache,
  });
  const resolution = conversation.resolution;
  const mode = resolution.kind;
  const summary =
    resolution.kind === 'classic' || resolution.kind === 'e2ee' ? resolution.summary : null;
  const currentUser = useMemo(() => (user ? identityOf(user) : null), [user]);
  const isGroup = summary?.type === 'GROUP';

  const classicOptions = useMemo(
    () =>
      mode === 'classic' && summary && token && currentUser
        ? { conversationId, token, currentUser, summary }
        : null,
    [mode, summary, token, currentUser, conversationId],
  );

  const peerOnline = useCallback(
    () =>
      resolution.kind === 'e2ee'
        ? getPresenceRecord(resolution.peer.id).state === 'online'
        : false,
    [resolution],
  );

  const e2eeOptions = useMemo(() => {
    if (mode !== 'e2ee' || !summary || !token || !currentUser || resolution.kind !== 'e2ee') {
      return null;
    }
    const peer = identityOf({
      id: resolution.peer.id,
      username: resolution.peer.username,
      displayName: resolution.peer.name,
      avatarUrl: resolution.peer.avatarUrl,
      gender: resolution.peer.gender,
    });
    return {
      conversationId,
      token,
      currentUser,
      peer,
      summary,
      isForeground: () => appActiveRef.current,
      isPeerOnline: peerOnline,
    };
  }, [mode, summary, token, currentUser, conversationId, resolution, peerOnline]);

  const transport = useChatTransport({
    mode,
    classic: { deps: CLASSIC_DEPS, options: classicOptions },
    e2ee: { deps: E2EE_DEPS, options: e2eeOptions },
  });

  const {
    rows,
    messages,
    receipts,
    ready,
    error,
    typing,
    loadOlder,
  } = useChatMessages({
    transport,
    timeGapMs: CHAT_TIME_GAP_MS,
    currentUserId: user?.id ?? '',
    unreadCount: summary?.unreadCount ?? 0,
  });
  const scroll = useChatScroll(rows);
  useChatSecurity(mode);
  const bubbleStyle = useMemo(
    () => ({ maxWidth: Math.round(windowWidth * 0.7) }),
    [windowWidth],
  );
  const onEndReached = useCallback(() => {
    void loadOlder();
  }, [loadOlder]);

  useEffect(() => onConnection(setOnline), []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      appActiveRef.current = state === 'active';
    });
    return () => subscription.remove();
  }, []);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const messageIndex = useMemo(
    () => new Map(messages.map((message) => [message.id, message] as const)),
    [messages],
  );

  const quoteResolver = useCallback(
    (id: string | null) => {
      if (!id) return null;
      const origin = messageIndex.get(id);
      return origin ? quoteOfView(origin) : null;
    },
    [messageIndex],
  );

  const seenByCountFor = useCallback(
    (message: ChatMessageView) =>
      (receipts[message.id] ?? []).filter(
        (receipt: MessageReceipt) => receipt.userId !== user?.id && receipt.readAt !== null,
      ).length,
    [receipts, user?.id],
  );

  const openProfile = useCallback(
    (userId: string) => {
      const member = summary?.members.find((entry) => entry.id === userId);
      router.push({
        pathname: '/user/[id]',
        params: {
          id: userId,
          name: member?.displayName ?? '',
          username: member?.username ?? '',
          avatar: member?.avatarUrl ?? '',
          gender: member?.gender ?? '',
        },
      });
    },
    [router, summary?.members],
  );

  const onPressTitle = useCallback(() => {
    if (!summary) return;
    if (summary.type === 'GROUP') {
      router.push({ pathname: '/group/[id]', params: { id: summary.id } });
      return;
    }
    const other = summary.members.find((member) => member.id !== user?.id);
    if (other) openProfile(other.id);
  }, [summary, router, user?.id, openProfile]);

  const showCallsUnavailable = useCallback(() => {
    Alert.alert(fr.chat.unified.callsUnavailableTitle, fr.chat.unified.callsUnavailableBody);
  }, []);

  const headerRight = useMemo(() => {
    if (!transport) return null;
    if (!transport.capabilities.calls) {
      return (
        <View style={styles.headerActions}>
          <Pressable
            onPress={showCallsUnavailable}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ disabled: true }}
            accessibilityLabel={fr.e2eeChat.callVideoUnavailable}
            style={styles.headerActionDisabled}>
            <Video size={26} color={chat.headerText} />
          </Pressable>
          <Pressable
            onPress={showCallsUnavailable}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ disabled: true }}
            accessibilityLabel={fr.e2eeChat.callVoiceUnavailable}
            style={styles.headerActionDisabled}>
            <View style={styles.phoneFlipped}>
              <Phone size={22} color={chat.headerText} />
            </View>
          </Pressable>
        </View>
      );
    }
    const group = summary?.type === 'GROUP';
    return (
      <View style={styles.headerActions}>
        <Pressable
          onPress={() =>
            group
              ? void calls.startGroupCall(conversationId, { video: true })
              : void calls.startCall(conversationId, { video: true })
          }
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={
            group ? fr.chat.unified.groupCallVideo : fr.chat.unified.callVideo
          }>
          <Video size={26} color={chat.headerText} />
        </Pressable>
        <Pressable
          onPress={() =>
            group
              ? void calls.startGroupCall(conversationId, { video: false })
              : void calls.startCall(conversationId, { video: false })
          }
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={
            group ? fr.chat.unified.groupCallVoice : fr.chat.unified.callVoice
          }>
          <View style={styles.phoneFlipped}>
            <Phone size={22} color={chat.headerText} />
          </View>
        </Pressable>
      </View>
    );
  }, [transport, summary?.type, calls, conversationId, chat.headerText, showCallsUnavailable]);

  const copyMessage = useCallback(async (message: ChatMessageView) => {
    if (!(await copyToClipboard(message.body))) {
      Alert.alert(fr.e2eeChat.error, fr.chat.errors.copyUnavailable);
    }
  }, []);

  const menuActions = useChatActions({
    message: menuFor,
    capabilities: transport?.capabilities ?? EMPTY_CAPABILITIES,
    onReply: (message) => {
      setReplyTo(quoteOfView(message));
      setMenuFor(null);
    },
    onCopy: (message) => {
      setMenuFor(null);
      void copyMessage(message);
    },
    onDeleteForMe: (message) => {
      setMenuFor(null);
      void transport?.deleteMessage(message.id, false);
    },
    onDeleteForAll: (message) => {
      setMenuFor(null);
      void transport?.deleteMessage(message.id, true);
    },
  });

  const closeViewer = useCallback(() => {
    if (mediaIdRef.current) {
      closeMedia(mediaIdRef.current);
      mediaIdRef.current = null;
    }
    closeImage();
    closeVideo();
  }, [closeImage, closeVideo]);

  const openMedia = useCallback(
    (request: MediaOpenRequest) => {
      if (request.encrypted && request.uploadId) {
        mediaIdRef.current = request.uploadId;
      }
      if (request.kind === 'file') {
        router.push({
          pathname: '/document-viewer',
          params: {
            url: request.uri,
            name: request.name ?? 'fichier',
            mime: request.mime ?? 'application/octet-stream',
            size: String(request.size ?? 0),
          },
        });
        return;
      }
      if (request.kind === 'video') {
        openVideo(request.uri);
        return;
      }
      openImage([request.uri], 0);
    },
    [openImage, openVideo, router],
  );

  const sendText = useCallback(
    (text: string) => {
      void transport?.sendText(text, replyTo?.id ?? null);
      setReplyTo(null);
    },
    [transport, replyTo?.id],
  );

  const sendAttachments = useCallback(
    async (files: Awaited<ReturnType<typeof pickLibraryMedia>>) => {
      if (!files || !transport) return;
      if (files.rejected.length > 0) {
        Alert.alert(fr.chat.picker.filesIgnored(files.rejected.length), files.rejected[0].reason);
      }
      for (const file of files.files) {
        await transport.sendMedia(
          {
            uri: file.uri,
            kind: file.kind === 'video' ? 'video' : file.kind === 'file' ? 'file' : 'image',
            mime: file.mime,
            name: file.name,
            size: file.size,
            width: file.width ?? null,
            height: file.height ?? null,
            durationMs: file.durationMs ?? null,
          },
          '',
          replyTo?.id ?? null,
        );
      }
      setReplyTo(null);
    },
    [transport, replyTo?.id],
  );

  const pickPhotos = useCallback(() => {
    void pickLibraryMedia()
      .then((picked) => sendAttachments(picked))
      .catch(() => undefined);
  }, [sendAttachments]);

  const pickCamera = useCallback(() => {
    void (async () => {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(fr.chat.picker.cameraDeniedTitle, fr.chat.picker.cameraDeniedBody);
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (result.canceled || !result.assets[0] || !transport) return;
      const normalized = normalizeImageAsset(result.assets[0]);
      if (isRejectedMedia(normalized)) {
        Alert.alert(fr.chat.picker.filesIgnored(1), normalized.reason);
        return;
      }
      await transport.sendMedia(
        {
          uri: normalized.uri,
          kind: 'image',
          mime: normalized.mime,
          name: normalized.name,
          size: normalized.size,
          width: normalized.width ?? null,
          height: normalized.height ?? null,
          durationMs: null,
        },
        '',
        replyTo?.id ?? null,
      );
      setReplyTo(null);
    })();
  }, [transport, replyTo?.id]);

  const pickFiles = useCallback(() => {
    void pickDocuments()
      .then((picked) => sendAttachments(picked))
      .catch(() => undefined);
  }, [sendAttachments]);

  const onViewableItemsChanged = useCallback(
    (info: { viewableItems: { item?: unknown }[] }) => {
      if (mode !== 'e2ee' || !transport || !focused || !ready || !appActiveRef.current) {
        return;
      }
      const adapted = info.viewableItems.flatMap((view) => {
        const row = view.item as { type?: string; key?: string; message?: ChatMessageView } | undefined;
        if (!row || row.type !== 'message' || !row.message || !row.key) return [];
        return [
          {
            key: row.key,
            item: {
              type: 'message',
              key: row.key,
              message: { id: row.message.id, mine: row.message.mine ? 1 : 0 },
            } as unknown as E2eeListRow,
          },
        ];
      });
      const ids = visibleForeignMessageIds(adapted);
      if (ids.length > 0) {
        void transport.markRead(ids);
      }
    },
    [mode, transport, focused, ready],
  );

  if (!token || !user || !currentUser) {
    return <Redirect href="/login" />;
  }

  if (mode === 'pending') {
    return (
      <ThemedView style={[styles.container, { backgroundColor: chat.screen }]}>
        <View style={styles.centered}>
          <ThemedText type="sectionTitle">{fr.chat.unified.waitingTitle}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centeredText}>
            {fr.chat.unified.waitingBody}
          </ThemedText>
          <Pressable
            accessibilityRole="button"
            onPress={conversation.refresh}
            style={[styles.retryButton, { backgroundColor: theme.accent }]}>
            <ThemedText style={{ color: theme.onAccent }}>
              {fr.chat.unified.retryConnection}
            </ThemedText>
          </Pressable>
        </View>
      </ThemedView>
    );
  }

  if (mode === 'blocked') {
    return (
      <ThemedView style={[styles.container, { backgroundColor: chat.screen }]}>
        <View style={styles.centered}>
          <ThemedText type="sectionTitle">{fr.chat.unified.blockedTitle}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centeredText}>
            {fr.chat.unified.blockedBody}
          </ThemedText>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/chats')}
            style={[styles.retryButton, { backgroundColor: theme.accent }]}>
            <ThemedText style={{ color: theme.onAccent }}>{fr.common.close}</ThemedText>
          </Pressable>
        </View>
      </ThemedView>
    );
  }

  const title = summary ? conversationTitle(summary, user.id) : '';
  const other = summary?.members.find((member) => member.id !== user.id);
  const typingName =
    typing && summary
      ? (summary.members.find((member) => member.id === typing.userId)?.displayName ??
        fr.e2eeChat.me)
      : null;
  const subtitle = isGroup
    ? typingName
      ? fr.chat.unified.typing(typingName)
      : fr.chat.unified.members(summary?.members.length ?? 0)
    : typingName
      ? fr.chat.unified.typing(typingName)
      : '';
  const blockedText = summary?.blockedByThem
    ? fr.chat.unified.blockedPeer
    : isGroup && summary?.whoCanSend === 'admins' && summary.myRole !== 'admin'
      ? fr.chat.unified.groupAdminsOnly
      : null;

  return (
    <ThemedView
      style={[
        styles.container,
        { backgroundColor: chat.screen },
        keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : null,
      ]}>
      <BlurTarget ref={blurTargetRef} style={styles.flex}>
        <ChatHeaderBar
            title={title}
            subtitle={subtitle}
            mode={mode}
            presenceUserId={summary?.type === 'DIRECT' && other ? other.id : undefined}
            avatar={
              isGroup && summary ? (
                <Avatar
                  name={title}
                  uri={summary.avatarUrl}
                  emoji={summary.emoji}
                  color={summary.color}
                  variant="group"
                  size={34}
                />
              ) : undefined
            }
            onPressTitle={onPressTitle}
            right={headerRight}
            blurTarget={blurTargetRef}
          />
          <ChatSecurityBanner mode={mode} />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
            onLayout={(event) => setChatAreaHeight(event.nativeEvent.layout.height)}
            style={styles.flex}>
            <ChatMessageList
              rows={rows}
              listRef={scroll.listRef}
              currentUser={currentUser}
              isGroup={Boolean(isGroup)}
              capabilities={transport?.capabilities ?? EMPTY_CAPABILITIES}
              chat={chat}
              bubbleStyle={bubbleStyle}
              windowWidth={windowWidth}
              token={token}
              resolveQuote={quoteResolver}
              seenByCountFor={seenByCountFor}
              onReply={(message) => setReplyTo(quoteOfView(message))}
              onLongPress={setMenuFor}
              onRetry={(message) => transport?.retry(message.clientId ?? message.id)}
              onDiscard={(message) => void transport?.discard(message.clientId ?? message.id)}
              onOpenMedia={openMedia}
              onToggleReaction={(message, reaction) =>
                void transport?.toggleReaction(message.id, reaction)
              }
              onPressAvatar={openProfile}
              onSeenBy={setSeenFor}
              onScroll={scroll.onScroll}
              onEndReached={onEndReached}
              emptyComponent={
                ready ? (
                  <ChatEmptyState
                    avatar={
                      <Avatar
                        name={title}
                        uri={isGroup ? summary?.avatarUrl : other?.avatarUrl}
                        emoji={isGroup ? summary?.emoji : null}
                        color={isGroup ? summary?.color : null}
                        variant={isGroup ? 'group' : 'user'}
                        gender={isGroup ? null : other?.gender}
                        size={72}
                      />
                    }
                    title={
                      isGroup
                        ? fr.chat.unified.emptyGroupTitle
                        : fr.chat.unified.emptyDirectTitle
                    }
                    text={
                      isGroup
                        ? fr.chat.unified.emptyGroupText
                        : fr.chat.unified.emptyDirectText
                    }
                    suggestions={
                      isGroup
                        ? fr.chat.unified.emptyGroupSuggestions
                        : fr.chat.unified.emptySuggestions
                    }
                    onSuggestion={(value) => sendText(value)}
                  />
                ) : null
              }
              viewabilityConfig={mode === 'e2ee' ? READ_VIEWABILITY_CONFIG : undefined}
              onViewableItemsChanged={mode === 'e2ee' ? onViewableItemsChanged : undefined}
            />
            {!online ? (
              <ThemedText
                type="small"
                style={[styles.banner, { color: theme.accent }]}
                accessibilityLiveRegion="polite">
                {fr.chat.unified.offline}
              </ThemedText>
            ) : null}
            {error ? (
              <ThemedText
                type="small"
                style={[styles.banner, { color: theme.error }]}
                accessibilityLiveRegion="polite">
                {error}
              </ThemedText>
            ) : null}
            {typingName ? (
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.typing}
                accessibilityLiveRegion="polite">
                {fr.chat.unified.typing(typingName)}
              </ThemedText>
            ) : null}
            {scroll.showJump ? (
              <Pressable
                onPress={scroll.jumpToBottom}
                accessibilityRole="button"
                accessibilityLabel={fr.chat.unified.jumpToLatest}
                style={[styles.jump, { backgroundColor: theme.backgroundElement }]}>
                <ChevronDown size={24} color={theme.accent} />
              </Pressable>
            ) : null}
            {transport ? (
              <ChatInputBar
                transport={transport}
                capabilities={transport.capabilities}
                composerTheme={{
                  inputBg: chat.input,
                  inputText: chat.primaryText,
                  placeholder: chat.inputPlaceholder,
                  panelBg: chat.composer,
                  text: chat.primaryText,
                  subtle: chat.secondaryText,
                  icon: chat.composerIcon,
                  border: chat.border,
                  accent: chat.send,
                  accentText: chat.sendText,
                  sendBg: chat.send,
                }}
                blurTarget={blurTargetRef}
                replyTo={replyTo}
                onCancelReply={() => setReplyTo(null)}
                blockedText={blockedText}
                bottomInset={insets.bottom}
                availableHeight={chatAreaHeight > 0 ? chatAreaHeight : undefined}
                mentionCandidates={
                  isGroup && summary
                    ? summary.members
                        .filter((member) => member.id !== user.id)
                        .map((member) => ({
                          id: member.id,
                          username: member.username,
                          displayName: member.displayName,
                        }))
                    : undefined
                }
                recentGifs={[]}
                onSendText={sendText}
                onSendSticker={(ref) => void transport.sendSticker(ref)}
                onSendPersonalSticker={(sticker) => void transport.sendPersonalSticker(sticker)}
                onSendGif={(gif) => void transport.sendGif(gif)}
                onSendVoice={(note) => void transport.sendVoice(note)}
                onPickPhotos={pickPhotos}
                onPickCamera={pickCamera}
                onPickDocuments={pickFiles}
                onVoicePermissionDenied={() =>
                  Alert.alert(fr.chat.picker.micDeniedTitle, fr.chat.picker.micDeniedBody)
                }
                onVoiceError={() => Alert.alert(fr.e2eeChat.error, fr.e2eeChat.mediaSendFailed)}
              />
            ) : null}
          </KeyboardAvoidingView>
        </BlurTarget>

      <ActionSheet
        visible={menuFor !== null}
        title={fr.chat.unified.messageOptions}
        header={
          menuFor && transport?.capabilities.reactions ? (
            <View style={styles.reactionPicker}>
              {REACTION_STICKERS.map((reaction) => {
                const sticker = findSticker(reaction);
                return (
                  <Pressable
                    key={reaction}
                    accessibilityRole="button"
                    accessibilityLabel={reaction}
                    onPress={() => {
                      void transport.toggleReaction(menuFor.id, reaction);
                      setMenuFor(null);
                    }}>
                    {sticker ? <StickerView sticker={sticker} size={36} /> : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null
        }
        actions={menuActions}
        onClose={() => setMenuFor(null)}
      />

      <ActionSheet
        visible={seenFor !== null}
        title={fr.chat.unified.seenBy(seenFor ? seenByCountFor(seenFor) : 0)}
        actions={[]}
        onClose={() => setSeenFor(null)}
        header={
          seenFor ? (
            <View>
              {(receipts[seenFor.id] ?? [])
                .filter((receipt) => receipt.readAt !== null)
                .map((receipt) => (
                  <ThemedText key={receipt.userId} style={styles.seenRow}>
                    {summary?.members.find((member) => member.id === receipt.userId)
                      ?.displayName ?? fr.e2eeChat.me}
                  </ThemedText>
                ))}
            </View>
          ) : null
        }
      />

      {media.image ? (
        <ImageViewer
          urls={media.image.urls}
          initialIndex={media.image.index}
          onClose={closeViewer}
        />
      ) : null}
      <VideoViewer visible={media.video !== null} uri={media.video} onClose={closeViewer} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.three,
  },
  centeredText: { textAlign: 'center' },
  retryButton: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: 999,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  headerActionDisabled: { opacity: 0.45 },
  phoneFlipped: { transform: [{ rotate: '135deg' }] },
  bubble: { maxWidth: 300 },
  banner: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
  typing: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one, fontStyle: 'italic' },
  jump: {
    position: 'absolute',
    right: Spacing.three,
    bottom: 80,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionPicker: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  seenRow: { paddingVertical: Spacing.two, paddingHorizontal: Spacing.one },
});
