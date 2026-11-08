import { Redirect, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { LiquidGlass } from '@/components/liquid-glass';
import { AttachPanel } from '@/components/attach-panel';
import { QuoteBlock } from '@/components/quote-block';
import { SwipeableBubble } from '@/components/swipeable-bubble';
import { useChatColors } from '@/constants/chat-theme';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { connectSocket, ensureSocket } from '@/lib/socket';
import type { ConversationSummary, Message, MessageQuote } from '@/lib/types';
import {
  isRejectedMedia,
  normalizeImageAsset,
  pickDocuments,
  pickLibraryMedia,
} from '@/features/media/pickMedia';
import { ImageViewer, VideoViewer } from '@/features/media/MediaViewers';
import { bootstrapE2ee } from '@/features/e2ee/bootstrap';
import {
  knownMessageKeys,
  listLocalMessages,
  loadDraft,
  loadE2eeAccount,
  openE2eeDatabase,
  saveDraft,
  searchLocalMessages,
  type E2eeAccountRow,
  type StoredE2eeMessage,
} from '@/features/e2ee/db';
import { sendEncryptedMedia, type E2eeMediaKind } from '@/features/e2ee/media';
import { closeMedia, sweepSecureMedia } from '@/features/e2ee/mediaStore';
import { decodeMediaMeta } from '@/features/e2ee/payload';
import { isE2eeEnabled } from '@/features/e2ee/policy';
import { useSecureScreen } from '@/features/e2ee/screen-security';
import { SecureMediaMessage } from '@/features/e2ee/SecureMediaMessage';
import { VoiceRecordButton } from '@/features/voice-notes/VoiceRecordButton';
import type { VoiceNote } from '@/features/voice-notes/useVoiceRecorder';
import { decryptIncoming, E2eeKeyChangedError, sendEncryptedText } from '@/features/e2ee/text';

function sortMessages(messages: StoredE2eeMessage[]): StoredE2eeMessage[] {
  const seen = new Set<string>();
  return [...messages]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
}

export default function E2eeChatScreen() {
  const params = useLocalSearchParams<{
    id?: string;
    peerId?: string;
    name?: string;
  }>();
  const { token, user } = useAuth();
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const conversationId = params.id ?? '';
  const peerId = params.peerId ?? '';
  const title = params.name ?? fr.e2eeChat.title;

  // FLAG_SECURE pendant toute la vie de l'écran : la conversation chiffrée
  // n'apparaît jamais en clair dans l'aperçu « applications récentes ».
  useSecureScreen(true);

  const dbRef = useRef<Awaited<ReturnType<typeof openE2eeDatabase>>['db'] | null>(null);
  const accountRef = useRef<E2eeAccountRow | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredE2eeMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<StoredE2eeMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StoredE2eeMessage[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [sendingMedia, setSendingMedia] = useState(false);
  const [viewer, setViewer] = useState<{ id: string; uri: string; kind: 'image' | 'video' } | null>(
    null,
  );
  // Identifiant du document ouvert dans la visionneuse locale : au retour sur
  // l'écran, son clair déchiffré doit disparaître (le fichier est en attente
  // dans le dossier privé tant que la route visionneuse est au premier plan).
  const openedDocumentRef = useRef<string | null>(null);

  // Palette WeChat de la conversation (partagée avec le chat classique) : les
  // bulles chiffrées reprennent exactement les mêmes couleurs que les claires.
  const chat = useChatColors();
  const chatStyles = useMemo(
    () => ({
      messageText: { color: chat.primaryText },
      bubbleMine: { backgroundColor: chat.mineBubble },
      bubbleTheirs: { backgroundColor: chat.theirBubble },
    }),
    [chat],
  );

  /** Aperçu d'un message cité, reconstruit localement depuis la base chiffrée. */
  const resolveQuote = useCallback(
    (quoteId: string | null): MessageQuote | null => {
      if (!quoteId) return null;
      const origin = messages.find((item) => item.id === quoteId);
      if (!origin) return null;
      const media = origin.media_meta ? decodeMediaMeta(origin.media_meta) : null;
      return {
        id: origin.id,
        senderName: origin.sender_name,
        content: origin.body,
        type: 'text',
        attachmentType: media?.type ?? null,
        deleted: false,
      };
    },
    [messages],
  );

  // `decryptIncoming` persiste le compte dans la même transaction que la
  // session et le message : l'écran ne garde ici que l'état en mémoire, sans
  // seconde écriture qui pourrait écraser une avancée plus récente.
  const rememberAccount = useCallback((account: E2eeAccountRow) => {
    accountRef.current = account;
  }, []);

  const addStored = useCallback((stored: StoredE2eeMessage) => {
    setMessages((previous) =>
      previous.some((item) => item.id === stored.id)
        ? previous
        : sortMessages([...previous, stored]),
    );
  }, []);

  const decryptMessage = useCallback(
    async (message: Message) => {
      if (!token || !dbRef.current || !accountRef.current) return null;
      try {
        const result = await decryptIncoming({
          token,
          db: dbRef.current,
          account: accountRef.current,
          message,
          currentUserId: user?.id ?? '',
        });
        rememberAccount(result.account);
        addStored(result.stored);
        if (result.keyChanged) {
          Alert.alert(fr.e2eeChat.keyChangedTitle, fr.e2eeChat.keyChangedBody);
        }
        return result.stored;
      } catch {
        return null;
      }
    },
    [addStored, rememberAccount, token, user?.id],
  );

  // Les déchiffrements doivent se suivre : deux messages simultanés partiraient
  // du même pickle de session et le second échouerait silencieusement.
  const decryptChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const queueDecrypt = useCallback(
    (message: Message) => {
      decryptChainRef.current = decryptChainRef.current
        .then(() => decryptMessage(message))
        .catch(() => undefined);
      return decryptChainRef.current;
    },
    [decryptMessage],
  );

  useEffect(() => {
    if (!isE2eeEnabled() || !token || !user || !conversationId) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const boot = await bootstrapE2ee(token);
        if (boot.recovered) {
          Alert.alert(fr.e2ee.keysLostTitle, fr.e2ee.keysLostBody);
        }
        const opened = await openE2eeDatabase();
        dbRef.current = opened.db;
        const account = await loadE2eeAccount(opened.db);
        if (!account) throw new Error('account_missing');
        accountRef.current = account;
        const storedDraft = await loadDraft(opened.db, conversationId);
        if (!cancelled) setDraft(storedDraft);
        const local = await listLocalMessages(opened.db, conversationId);
        if (!cancelled) setMessages(sortMessages(local));
        const history = await api.listMessages(token, conversationId, { limit: 50 });
        const known = await knownMessageKeys(opened.db, conversationId);
        for (const message of history) {
          if (message.encryption !== 'v1') continue;
          // Un message déjà stocké (ou sa ligne provisoire) ne se relit pas :
          // sa clé de ratchet a déjà été consommée.
          if (known.ids.has(message.id)) continue;
          if (message.clientId && known.clientIds.has(message.clientId)) continue;
          await queueDecrypt(message);
        }
        await api.markRead(token, conversationId).catch(() => undefined);
        if (!cancelled) setReady(true);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : fr.e2eeChat.error);
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, queueDecrypt, token, user]);

  useEffect(() => {
    if (!token || !ready || !isE2eeEnabled()) return;
    const socket = connectSocket(token);
    const onMessage = (message: Message) => {
      if (message.conversationId !== conversationId || message.sender.id === user?.id) return;
      if (message.encryption !== 'v1') return;
      void queueDecrypt(message);
      void api.markRead(token, conversationId).catch(() => undefined);
    };
    socket.on('message:new', onMessage);
    void ensureSocket(token).catch(() => undefined);
    return () => {
      socket.off('message:new', onMessage);
    };
  }, [conversationId, queueDecrypt, ready, token, user?.id]);

  useEffect(() => {
    return () => {
      void dbRef.current?.closeAsync().catch(() => undefined);
      dbRef.current = null;
      // Quitter l'écran referme les médias : aucun clair ne reste en cache.
      sweepSecureMedia();
    };
  }, []);

  // Revenir sur l'écran (après fermeture d'un document) libère son clair : la
  // visionneuse de documents est une route distincte, son démontage ne suffit
  // pas à effacer le fichier déchiffré qui a servi à l'ouvrir.
  useFocusEffect(
    useCallback(() => {
      if (openedDocumentRef.current) {
        closeMedia(openedDocumentRef.current);
        openedDocumentRef.current = null;
      }
    }, []),
  );

  if (!token || !user) {
    return <Redirect href="/login" />;
  }
  if (!isE2eeEnabled()) {
    return <Redirect href="/" />;
  }
  if (!conversationId || !peerId) {
    return <Redirect href="/chats" />;
  }

  const conversation: ConversationSummary = {
    id: conversationId,
    type: 'DIRECT',
    name: null,
    avatarUrl: null,
    emoji: null,
    color: null,
    description: null,
    ownerId: null,
    whoCanSend: 'all',
    whoCanAdd: 'all',
    createdAt: '',
    updatedAt: '',
    e2eeSince: new Date().toISOString(),
    members: [
      {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        gender: user.gender,
        genderCustom: user.genderCustom,
        lastReadAt: null,
        role: 'member',
      },
      {
        id: peerId,
        username: '',
        displayName: title,
        avatarUrl: null,
        gender: null,
        genderCustom: null,
        lastReadAt: null,
        role: 'member',
      },
    ],
    lastMessage: null,
    unreadCount: 0,
    pinned: false,
    muted: false,
    hidden: false,
    myRole: 'member',
    blockedByMe: false,
    blockedByThem: false,
  };

  const send = async (allowKeyChange = false) => {
    const text = draft.trim();
    if (!text || sending || !dbRef.current || !accountRef.current) return;
    setSending(true);
    try {
      const result = await sendEncryptedText({
        token,
        db: dbRef.current,
        account: accountRef.current,
        conversation,
        currentUserId: user.id,
        currentUserName: user.displayName,
        text,
        allowKeyChange,
        replyToId: replyTo?.id ?? null,
      });
      addStored(result.stored);
      setReplyTo(null);
      setDraft('');
      await saveDraft(dbRef.current, conversationId, '');
    } catch (cause) {
      if (cause instanceof E2eeKeyChangedError) {
        Alert.alert(fr.e2eeChat.keyChangedTitle, fr.e2eeChat.keyChangedBody, [
          {
            text: fr.e2eeChat.verifyCode,
            onPress: () =>
              Alert.alert(fr.e2eeChat.verifyCode, cause.signingKey.slice(0, 32), [
                { text: fr.common.close },
              ]),
          },
          {
            text: fr.e2eeChat.sendAnyway,
            style: 'destructive',
            onPress: () => void send(true),
          },
          { text: fr.common.cancel, style: 'cancel' },
        ]);
      } else {
        Alert.alert(fr.e2eeChat.error, cause instanceof Error ? cause.message : '');
      }
    } finally {
      setSending(false);
    }
  };

  const onChangeDraft = (value: string) => {
    setDraft(value);
    if (dbRef.current) void saveDraft(dbRef.current, conversationId, value);
  };

  /**
   * Envoie un média chiffré : réduction et retrait des métadonnées pour une
   * photo, chiffrement, téléversement du ciphertext, puis enveloppe Olm `v:2`
   * avec la clé. L'identité du média ne quitte jamais l'appareil autrement que
   * chiffrée.
   */
  const sendMedia = async (asset: {
    uri: string;
    kind: E2eeMediaKind;
    mime: string;
    name: string;
    size?: number | null;
    width?: number;
    height?: number;
    durationMs?: number;
    waveform?: number[];
  }) => {
    if (!token || !user || !dbRef.current || !accountRef.current || sendingMedia) return;
    setSendingMedia(true);
    try {
      const result = await sendEncryptedMedia({
        token,
        db: dbRef.current,
        account: accountRef.current,
        conversation,
        currentUserId: user.id,
        currentUserName: user.displayName,
        asset,
        replyToId: replyTo?.id ?? null,
      });
      addStored(result.stored);
      setReplyTo(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      Alert.alert(
        fr.e2eeChat.error,
        message === 'media_too_large'
          ? fr.e2eeChat.mediaTooLarge
          : message === 'media_unreadable'
            ? fr.e2eeChat.mediaUnreadable
            : fr.e2eeChat.mediaSendFailed,
      );
    } finally {
      setSendingMedia(false);
      setAttachOpen(false);
    }
  };

  const pickPhotos = async () => {
    try {
      const picked = await pickLibraryMedia();
      if (!picked) return;
      setAttachOpen(false);
      for (const file of picked.files) {
        await sendMedia({
          uri: file.uri,
          kind: file.kind === 'video' ? 'video' : 'image',
          mime: file.mime,
          name: file.name,
          size: file.size,
          width: file.width,
          height: file.height,
          durationMs: file.durationMs,
        });
      }
      if (picked.rejected.length > 0) {
        Alert.alert(fr.e2eeChat.attachPhotos, picked.rejected[0].reason);
      }
    } catch {
      setAttachOpen(false);
    }
  };

  const pickCamera = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return;
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 });
      setAttachOpen(false);
      if (result.canceled || !result.assets[0]) return;
      const normalized = normalizeImageAsset(result.assets[0]);
      if (isRejectedMedia(normalized)) {
        Alert.alert(fr.e2eeChat.attachCamera, normalized.reason);
        return;
      }
      await sendMedia({
        uri: normalized.uri,
        kind: 'image',
        mime: normalized.mime,
        name: normalized.name,
        size: normalized.size,
        width: normalized.width,
        height: normalized.height,
      });
    } catch {
      setAttachOpen(false);
    }
  };

  const pickFiles = async () => {
    try {
      const picked = await pickDocuments();
      setAttachOpen(false);
      if (!picked) return;
      for (const file of picked.files) {
        await sendMedia({
          uri: file.uri,
          kind: 'file',
          mime: file.mime,
          name: file.name,
          size: file.size,
        });
      }
      if (picked.rejected.length > 0) {
        Alert.alert(fr.e2eeChat.attachFile, picked.rejected[0].reason);
      }
    } catch {
      setAttachOpen(false);
    }
  };

  const sendVoiceNote = async (note: VoiceNote) => {
    await sendMedia({
      uri: note.uri,
      kind: 'audio',
      mime: note.mimeType,
      name: fr.e2eeMedia.voiceName,
      size: null,
      durationMs: note.durationMs,
      waveform: note.waveform,
    });
  };

  // Fermer la visionneuse plein écran libère le clair du média **avant** de
  // démonter la modale : c'est le geste de fermeture qui efface, pas seulement
  // la sortie de la conversation.
  const closeViewer = () => {
    if (viewer) closeMedia(viewer.id);
    setViewer(null);
  };

  const runSearch = async (value: string) => {
    setQuery(value);
    if (!dbRef.current || value.trim().length === 0) {
      setResults([]);
      return;
    }
    setResults(await searchLocalMessages(dbRef.current, conversationId, value.trim()));
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => setSearchOpen((open) => !open)} accessibilityRole="button">
          <ThemedText type="smallBold" themeColor="textSecondary">
            {searchOpen ? fr.common.close : fr.e2eeChat.search}
          </ThemedText>
        </Pressable>
      </View>
      {searchOpen ? (
        <View style={styles.searchArea}>
          <TextInput
            value={query}
            onChangeText={(value) => void runSearch(value)}
            placeholder={fr.e2eeChat.searchPlaceholder}
            placeholderTextColor={theme.textSecondary}
            style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }]}
            autoFocus
          />
          {results.map((result) => (
            <View key={result.id} style={styles.result}>
              <ThemedText type="small" numberOfLines={2}>
                {result.body}
              </ThemedText>
            </View>
          ))}
        </View>
      ) : null}
      {error ? (
        <ThemedText type="small" style={styles.error}>
          {fr.e2eeChat.error}: {error}
        </ThemedText>
      ) : null}
      <FlatList
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          ready ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
              {fr.e2eeChat.empty}
            </ThemedText>
          ) : undefined
        }
        renderItem={({ item }) => {
          // La référence du média vit dans la base chiffrée ; l'enveloppe ne
          // porte que le texte. Un média sans référence exploitable s'affiche
          // comme un simple texte, jamais comme une erreur.
          const media = item.media_meta ? decodeMediaMeta(item.media_meta) : null;
          const mine = item.mine === 1;
          const quote = resolveQuote(item.quote_id);
          const bubble = (
            <View
              style={[
                styles.bubble,
                mine ? chatStyles.bubbleMine : chatStyles.bubbleTheirs,
                mine ? styles.bubbleMineEdge : styles.bubbleTheirsEdge,
              ]}>
              <View
                pointerEvents="none"
                style={[
                  styles.tail,
                  mine ? styles.tailRight : styles.tailLeft,
                  mine ? chatStyles.bubbleMine : chatStyles.bubbleTheirs,
                ]}
              />
              {quote ? <QuoteBlock quote={quote} mine={mine} /> : null}
              {media ? (
                <SecureMediaMessage
                  token={token}
                  media={media}
                  mine={mine}
                  caption={item.body}
                  onOpen={(uri, opened) => {
                    const id = opened.blob.uploadId;
                    if (opened.type === 'FILE') {
                      // Un document déchiffré s'ouvre dans la visionneuse locale
                      // (le fichier est déjà sur le disque, plus rien à charger).
                      // Son clair ne sera libéré qu'au retour sur cet écran.
                      // Les vocaux, eux, se lisent dans la bulle (SecureVoicePlayer).
                      openedDocumentRef.current = id;
                      router.push({
                        pathname: '/document-viewer',
                        params: {
                          url: uri,
                          name: opened.name ?? 'fichier',
                          mime: opened.mime,
                          size: String(opened.blob.size ?? 0),
                        },
                      });
                      return;
                    }
                    setViewer({ id, uri, kind: opened.type === 'VIDEO' ? 'video' : 'image' });
                  }}
                />
              ) : (
                <ThemedText style={[styles.messageText, chatStyles.messageText]}>{item.body}</ThemedText>
              )}
            </View>
          );
          return (
            <SwipeableBubble
              mine={mine}
              onReply={() => setReplyTo(item)}
              onLongPress={() => setReplyTo(item)}
              style={styles.bubbleWrapper}
              accessibilityLabel={fr.e2eeChat.messageOptions}>
              {bubble}
            </SwipeableBubble>
          );
        }}
      />
      {replyTo ? (
        <View style={styles.replyBar}>
          <View style={styles.replyBarBody}>
            <QuoteBlock
              quote={{
                id: replyTo.id,
                senderName: replyTo.sender_name,
                content: replyTo.body,
                type: 'text',
                attachmentType: replyTo.media_meta
                  ? (decodeMediaMeta(replyTo.media_meta)?.type ?? null)
                  : null,
                deleted: false,
              }}
              mine={false}
            />
          </View>
          <Pressable
            onPress={() => setReplyTo(null)}
            hitSlop={8}
            style={styles.replyClose}
            accessibilityRole="button"
            accessibilityLabel={fr.common.cancel}>
            <X size={20} color={theme.accent} />
          </Pressable>
        </View>
      ) : null}
      <View style={[styles.composer, { paddingBottom: insets.bottom + Spacing.two }]}>
        <Pressable
          onPress={() => setAttachOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel={fr.e2eeChat.attachFile}
          style={styles.attachButton}>
          <ThemedText type="sectionTitle">+</ThemedText>
        </Pressable>
        {voiceOpen ? (
          <VoiceRecordButton
            onSend={(note) => void sendVoiceNote(note)}
            onPermissionDenied={() =>
              Alert.alert(fr.e2eeMedia.micTitle, fr.e2eeMedia.micBody)
            }
            style={styles.voiceButton}
          />
        ) : (
          <TextInput
            value={draft}
            onChangeText={onChangeDraft}
            placeholder={fr.e2eeChat.placeholder}
            placeholderTextColor={theme.textSecondary}
            multiline
            style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }]}
          />
        )}
        {!voiceOpen && draft.trim().length === 0 ? (
          <Pressable
            onPress={() => setVoiceOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={fr.e2eeMedia.voiceName}
            style={styles.attachButton}>
            <ThemedText type="sectionTitle">🎙</ThemedText>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => {
              if (voiceOpen) {
                setVoiceOpen(false);
                return;
              }
              void send();
            }}
            disabled={!voiceOpen && (sending || draft.trim().length === 0)}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.send,
              {
                opacity: !voiceOpen && (sending || !draft.trim()) ? 0.5 : pressed ? 0.85 : 1,
              },
            ]}>
            <LiquidGlass radius={Radii.button} style={styles.sendGlass}>
              <ThemedText style={styles.sendLabel}>
                {voiceOpen ? fr.common.close : fr.e2eeChat.send}
              </ThemedText>
            </LiquidGlass>
          </Pressable>
        )}
      </View>
      {attachOpen ? (
        <View style={[styles.attachPanel, { paddingBottom: insets.bottom + Spacing.two }]}>
          <AttachPanel
            onPhotos={() => void pickPhotos()}
            onCamera={() => void pickCamera()}
            onDocuments={() => void pickFiles()}
          />
        </View>
      ) : null}
      {viewer ? (
        viewer.kind === 'image' ? (
          <ImageViewer urls={[viewer.uri]} initialIndex={0} onClose={closeViewer} />
        ) : (
          <VideoViewer visible uri={viewer.uri} onClose={closeViewer} />
        )
      ) : null}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two },
  searchArea: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two, gap: Spacing.one },
  result: { paddingVertical: Spacing.two },
  list: { padding: Spacing.three, gap: Spacing.two, flexGrow: 1 },
  empty: { alignSelf: 'center', marginTop: Spacing.five },
  bubbleWrapper: { maxWidth: '82%' },
  bubble: {
    borderRadius: Radii.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: Spacing.half,
  },
  /** Coin côté expéditeur légèrement plus petit : donne la direction de la bulle. */
  bubbleMineEdge: { borderTopRightRadius: Radii.xs },
  bubbleTheirsEdge: { borderTopLeftRadius: Radii.xs },
  tail: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: Radii.xs,
    top: 13,
    transform: [{ rotate: '45deg' }],
  },
  tailLeft: { left: -4 },
  tailRight: { right: -4 },
  messageText: { fontSize: 16, lineHeight: 21 },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  replyBarBody: { flex: 1 },
  replyClose: { padding: Spacing.one },
  attachButton: {
    width: 36,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceButton: { flex: 1 },
  attachPanel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.25)',
    paddingTop: Spacing.two,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  send: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendGlass: {
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    borderRadius: Radii.button,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendLabel: { color: '#ffffff', fontWeight: '700' },
  error: { color: '#e5484d', paddingHorizontal: Spacing.three },
});
