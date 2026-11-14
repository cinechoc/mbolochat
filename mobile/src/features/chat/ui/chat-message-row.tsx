import { AlertTriangle, Check, CheckCheck, Clock, Phone } from 'lucide-react-native';
import { memo, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { ChatPalette } from '@/constants/chat-theme';
import { Radii, Spacing } from '@/constants/theme';
import { decodeMediaMeta } from '@/features/e2ee/payload';
import { SecureMediaMessage } from '@/features/e2ee/SecureMediaMessage';
import { SingleEmojiMessage } from '@/features/emoji/AnimatedEmoji';
import { MessageText } from '@/features/emoji/EmojiText';
import { emojiOnlyCount, splitEmoji, type EmojiSegment } from '@/features/emoji/emojiUtils';
import { ChatBubble } from '@/features/chat/ui/chat-bubble';
import { ChatDateSeparator, ChatMessageRow as ChatRowLayout, ChatTimeSeparator } from '@/features/chat/ui/chat-rows';
import { QuoteBlock } from '@/components/quote-block';
import { SwipeableBubble } from '@/components/swipeable-bubble';
import { ThemedText } from '@/components/themed-text';
import { GifMessageBubble } from '@/features/media/GifMessageBubble';
import {
  DocumentMessageBubble,
  ImageMessageBubble,
  VideoMessageBubble,
} from '@/features/media/MediaMessage';
import { mediaUrl } from '@/features/media/mediaUrl';
import { StickerMessageBubble } from '@/features/stickers/StickerMessageBubble';
import { findSticker } from '@/features/stickers/stickerPacks';
import { StickerMessage, StickerView } from '@/features/stickers/StickerView';
import { VoiceMessageBubble } from '@/features/voice-notes/VoiceMessageBubble';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { useTextScale } from '@/lib/text-scale';
import type { MessageQuote } from '@/lib/types';
import type { ChatRow } from '../model/rows';
import { sameChatMessageRow } from '../model/row-equality';
import type { ChatCapabilities, ChatIdentity, ChatMessageView } from '../transport/types';

export interface MediaOpenRequest {
  uri: string;
  kind: 'image' | 'video' | 'file' | 'audio';
  encrypted: boolean;
  uploadId?: string;
  name?: string;
  mime?: string;
  size?: number;
}

export interface ChatMessageRowProps {
  row: ChatRow;
  currentUser: ChatIdentity;
  isGroup: boolean;
  capabilities: ChatCapabilities;
  chat: ChatPalette;
  bubbleStyle: { maxWidth: number };
  windowWidth: number;
  token: string;
  resolveQuote: (id: string | null) => MessageQuote | null;
  /** Nombre de lecteurs d'un message (groupes), calculé par l'écran. */
  seenByCountFor?: (message: ChatMessageView) => number;
  onOpenAlbum?: (messages: ChatMessageView[], index: number) => void;
  onReply: (message: ChatMessageView) => void;
  onLongPress: (message: ChatMessageView) => void;
  onRetry: (message: ChatMessageView) => void;
  onDiscard: (message: ChatMessageView) => void;
  onOpenMedia: (request: MediaOpenRequest) => void;
  onToggleReaction: (message: ChatMessageView, reaction: string) => void;
  onPressAvatar?: (userId: string) => void;
  onSeenBy?: (message: ChatMessageView) => void;
}

const TICK_ICON = {
  pending: Clock,
  failed: AlertTriangle,
  sent: Check,
  delivered: CheckCheck,
  read: CheckCheck,
} as const;

const TICK_LABEL = {
  pending: fr.chat.unified.tickPending,
  failed: fr.chat.unified.tickFailed,
  sent: fr.chat.unified.tickSent,
  delivered: fr.chat.unified.tickDelivered,
  read: fr.chat.unified.tickRead,
} as const;

function ReceiptBadge({
  message,
  capabilities,
  chat,
}: {
  message: ChatMessageView;
  capabilities: ChatCapabilities;
  chat: ChatPalette;
}) {
  if (!message.mine || message.state === 'none') return null;
  if (capabilities.receipts === 'delivered-opened') {
    if (message.state === 'read') {
      return (
        <ThemedText type="micro" themeColor="textSecondary" accessibilityLabel={fr.e2eeChat.receiptRead}>
          {fr.e2eeChat.receiptRead}
        </ThemedText>
      );
    }
    if (message.state === 'delivered') {
      return (
        <ThemedText
          type="micro"
          themeColor="textSecondary"
          accessibilityLabel={fr.e2eeChat.receiptDelivered}>
          {fr.e2eeChat.receiptDelivered}
        </ThemedText>
      );
    }
    return null;
  }
  const state = message.state;
  const Icon = TICK_ICON[state];
  const color =
    state === 'read' ? chat.tickRead : state === 'failed' ? chat.error : chat.tick;
  return (
    <View accessible accessibilityLabel={TICK_LABEL[state]}>
      <Icon size={state === 'failed' ? 14 : 16} strokeWidth={2.6} color={color} />
    </View>
  );
}

function RetryActions({
  message,
  chat,
  onRetry,
  onDiscard,
}: {
  message: ChatMessageView;
  chat: ChatPalette;
  onRetry: (message: ChatMessageView) => void;
  onDiscard: (message: ChatMessageView) => void;
}) {
  return (
    <View style={styles.failedBlock}>
      <ThemedText style={[styles.failedText, { color: chat.error }]} numberOfLines={2}>
        {message.error ?? fr.chat.unified.failedToSend}
      </ThemedText>
      <View style={styles.failedActions}>
        <Pressable
          onPress={() => onRetry(message)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={fr.chat.retrySend}>
          <ThemedText type="micro" style={{ color: chat.error }}>
            {fr.chat.retry}
          </ThemedText>
        </Pressable>
        <Pressable
          onPress={() => onDiscard(message)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={fr.chat.removeMessage}>
          <ThemedText type="micro" themeColor="textSecondary">
            {fr.chat.menu.delete}
          </ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

function ReactionChips({
  message,
  onToggle,
}: {
  message: ChatMessageView;
  onToggle: (message: ChatMessageView, reaction: string) => void;
}) {
  const theme = useTheme();
  if (message.reactions.length === 0) return null;
  return (
    <View style={[styles.reactions, message.mine ? styles.reactionsMine : null]}>
      {message.reactions.map((reaction) => {
        const sticker = findSticker(reaction.reaction);
        const label = sticker
          ? sticker.kind === 'image'
            ? (sticker.name ?? sticker.alt)
            : sticker.label
          : fr.chat.unified.reactionFallback;
        return (
          <Pressable
            key={reaction.reaction}
            onPress={() => onToggle(message, reaction.reaction)}
            accessibilityRole="button"
            accessibilityLabel={`${label}, ${reaction.count}`}
            style={[
              styles.reactionChip,
              {
                backgroundColor: reaction.mine ? theme.accentSoft : theme.backgroundElement,
                borderColor: reaction.mine ? theme.accent : theme.border,
              },
            ]}>
            {sticker ? <StickerView sticker={sticker} size={22} /> : null}
            {reaction.count > 1 ? (
              <ThemedText type="micro" themeColor="textSecondary">
                {reaction.count}
              </ThemedText>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function MessageBody({
  message,
  quote,
  capabilities,
  chat,
  bubbleStyle,
  onReply,
  onLongPress,
  onRetry,
  onDiscard,
  onOpenMedia,
  token,
}: {
  message: ChatMessageView;
  quote: MessageQuote | null;
  capabilities: ChatCapabilities;
  chat: ChatPalette;
  bubbleStyle: { maxWidth: number };
  onReply: (message: ChatMessageView) => void;
  onLongPress: (message: ChatMessageView) => void;
  onRetry: (message: ChatMessageView) => void;
  onDiscard: (message: ChatMessageView) => void;
  onOpenMedia: (request: MediaOpenRequest) => void;
  token: string;
}) {
  const textScale = useTextScale();
  const waiting = message.state === 'pending';
  const failed = message.state === 'failed';
  const attachment = message.attachment;
  const accessibleLabel = failed
    ? fr.chat.retrySend
    : fr.chat.unified.messageOptions;

  const swipe = (content: ReactNode) => (
    <SwipeableBubble
      mine={message.mine}
      onReply={() => onReply(message)}
      onLongPress={() => onLongPress(message)}
      style={bubbleStyle}
      accessibilityLabel={accessibleLabel}>
      {content}
    </SwipeableBubble>
  );

  if (message.stickerRef) {
    return swipe(
      <View style={[styles.stickerBlock, message.mine ? styles.alignEnd : null]}>
        {quote ? (
          <View style={styles.quoteBlock}>
            <QuoteBlock quote={quote} mine={message.mine} />
          </View>
        ) : null}
        <StickerMessage stickerRef={message.stickerRef} size={140} />
      </View>,
    );
  }

  if (attachment?.encrypted) {
    const media = decodeMediaMeta(attachment.mediaMeta);
    if (media) {
      return swipe(
        <View style={[styles.mediaBlock, message.mine ? styles.alignEnd : null]}>
          {quote ? (
            <View style={styles.quoteBlock}>
              <QuoteBlock quote={quote} mine={message.mine} />
            </View>
          ) : null}
          <SecureMediaMessage
            token={token}
            media={media}
            mine={message.mine}
            caption={message.body || undefined}
            onLongPress={() => onLongPress(message)}
            onOpen={(uri, opened) =>
              onOpenMedia({
                uri,
                kind:
                  opened.type === 'VIDEO'
                    ? 'video'
                    : opened.type === 'AUDIO'
                      ? 'audio'
                      : opened.type === 'FILE'
                        ? 'file'
                        : 'image',
                encrypted: true,
                uploadId: opened.blob.uploadId,
                name: opened.name,
                mime: opened.mime,
                size: opened.blob.size,
              })
            }
          />
        </View>,
      );
    }
  }

  if (attachment?.type === 'AUDIO' && attachment.url) {
    const uri = mediaUrl(attachment.url);
    return swipe(
      <View style={[styles.mediaBlock, message.mine ? styles.alignEnd : null]}>
        <VoiceMessageBubble
          id={message.id}
          uri={uri}
          durationMs={attachment.durationMs ?? 0}
          isMine={message.mine}
          accentColor={chat.mineBubble}
          receivedColor={chat.theirBubble}
          foregroundColor={chat.primaryText}
          barOffColor={chat.voiceBarOff}
          barOnColor={chat.voiceBarOn}
          speedControl
        />
        {failed ? (
          <RetryActions message={message} chat={chat} onRetry={onRetry} onDiscard={onDiscard} />
        ) : null}
      </View>,
    );
  }

  if (attachment?.type === 'STICKER' && attachment.url) {
    return swipe(
      <View style={[styles.mediaBlock, message.mine ? styles.alignEnd : null]}>
        <StickerMessageBubble
          uri={mediaUrl(attachment.url)}
          name={attachment.stickerName ?? undefined}
          width={attachment.width ?? undefined}
          height={attachment.height ?? undefined}
          sending={waiting}
          failed={failed}
          onLongPress={() => onLongPress(message)}
          onRetry={() => onRetry(message)}
          onPress={() =>
            onOpenMedia({
              uri: mediaUrl(attachment.url as string),
              kind: 'image',
              encrypted: false,
            })
          }
        />
        {failed ? (
          <RetryActions message={message} chat={chat} onRetry={onRetry} onDiscard={onDiscard} />
        ) : null}
      </View>,
    );
  }

  if (attachment && attachment.url) {
    const uri = mediaUrl(attachment.url);
    const width = attachment.width ?? Math.round(bubbleStyle.maxWidth * 0.8);
    const height = attachment.height ?? Math.round(width * 0.75);
    return swipe(
      <View style={[styles.mediaBlock, message.mine ? styles.alignEnd : null]}>
        {quote ? (
          <View style={styles.quoteBlock}>
            <QuoteBlock quote={quote} mine={message.mine} />
          </View>
        ) : null}
        {attachment.type === 'IMAGE' ? (
          <ImageMessageBubble
            uri={uri}
            width={width}
            height={height}
            sending={waiting}
            progress={message.progress}
            failed={failed}
            onRetry={() => onRetry(message)}
            onPress={() => onOpenMedia({ uri, kind: 'image', encrypted: false })}
            onLongPress={() => onLongPress(message)}
          />
        ) : attachment.type === 'VIDEO' ? (
          <VideoMessageBubble
            uri={uri}
            width={width}
            height={height}
            durationMs={attachment.durationMs ?? undefined}
            sending={waiting}
            progress={message.progress}
            failed={failed}
            onRetry={() => onRetry(message)}
            onPress={() => onOpenMedia({ uri, kind: 'video', encrypted: false })}
            onLongPress={() => onLongPress(message)}
          />
        ) : attachment.type === 'GIF' ? (
          <GifMessageBubble
            uri={uri}
            stillUri={attachment.giphy?.stillUrl ?? undefined}
            sticker={attachment.giphy?.sticker ?? false}
            width={width}
            height={height}
            sending={waiting}
            failed={failed}
            onRetry={() => onRetry(message)}
            onPress={() => onOpenMedia({ uri, kind: 'image', encrypted: false })}
            onLongPress={() => onLongPress(message)}
          />
        ) : (
          <DocumentMessageBubble
            name={attachment.name ?? 'fichier'}
            mime={attachment.mime ?? 'application/octet-stream'}
            size={attachment.size}
            width={Math.round(bubbleStyle.maxWidth * 0.9)}
            mine={message.mine}
            sending={waiting}
            progress={message.progress}
            uploadedBytes={null}
            totalBytes={null}
            failed={failed}
            onRetry={() => onRetry(message)}
            onOpen={() =>
              onOpenMedia({
                uri,
                kind: 'file',
                encrypted: false,
                name: attachment.name ?? undefined,
                mime: attachment.mime ?? undefined,
                size: attachment.size ?? undefined,
              })
            }
            onLongPress={() => onLongPress(message)}
          />
        )}
        {message.body ? (
          <ThemedText style={[styles.caption, { color: chat.primaryText }]}>
            {message.body}
          </ThemedText>
        ) : null}
        {failed ? (
          <RetryActions message={message} chat={chat} onRetry={onRetry} onDiscard={onDiscard} />
        ) : null}
      </View>,
    );
  }

  const trimmed = message.body.trim();
  const emojiCount = message.unreadable ? 0 : emojiOnlyCount(trimmed);
  if (emojiCount >= 1 && emojiCount <= 3) {
    const segment =
      emojiCount === 1
        ? splitEmoji(trimmed).find((entry): entry is EmojiSegment => entry.type === 'emoji')
        : undefined;
    return swipe(
      <View style={[styles.emojiBlock, message.mine ? styles.alignEnd : null]}>
        {quote ? (
          <View style={styles.quoteBlock}>
            <QuoteBlock quote={quote} mine={message.mine} />
          </View>
        ) : null}
        {emojiCount === 1 && segment ? (
          <SingleEmojiMessage
            emoji={segment.value}
            messageId={message.clientId ?? message.id}
            fresh={false}
          />
        ) : (
          <MessageText text={trimmed} style={[styles.emojiText, { color: chat.primaryText }]} />
        )}
        {message.edited ? (
          <ThemedText type="micro" themeColor="textSecondary">
            {fr.chat.unified.edited}
          </ThemedText>
        ) : null}
        {failed ? (
          <RetryActions message={message} chat={chat} onRetry={onRetry} onDiscard={onDiscard} />
        ) : null}
      </View>,
    );
  }

  return swipe(
    <ChatBubble mine={message.mine}>
      {quote ? <QuoteBlock quote={quote} mine={message.mine} /> : null}
      {message.unreadable ? (
        <ThemedText type="small" style={[styles.unreadable, { color: chat.secondaryText }]}>
          {fr.chat.unified.unreadableMessage}
        </ThemedText>
      ) : (
        <MessageText
          text={message.body}
          style={[
            styles.text,
            { color: chat.primaryText },
            textScale.factor !== 1
              ? {
                  fontSize: 16 * textScale.factor,
                  lineHeight: 21 * textScale.factor,
                }
              : null,
          ]}
        />
      )}
      {message.edited ? (
        <ThemedText type="micro" themeColor="textSecondary">
          {fr.chat.unified.edited}
        </ThemedText>
      ) : null}
      {failed ? (
        <RetryActions message={message} chat={chat} onRetry={onRetry} onDiscard={onDiscard} />
      ) : null}
    </ChatBubble>,
  );
}

function ChatMessageRowComponent(props: ChatMessageRowProps) {
  const { row, currentUser, isGroup, capabilities, chat, token } = props;

  if (row.type === 'date') {
    return <ChatDateSeparator label={row.label} />;
  }
  if (row.type === 'time') {
    return <ChatTimeSeparator label={row.label} />;
  }
  if (row.type === 'unread') {
    return (
      <View style={styles.unreadRow}>
        <View style={[styles.unreadLine, { backgroundColor: chat.border }]} />
        <ThemedText type="micro" themeColor="textSecondary">
          {fr.chat.unified.unreadCount(row.count)}
        </ThemedText>
        <View style={[styles.unreadLine, { backgroundColor: chat.border }]} />
      </View>
    );
  }

  if (row.type === 'album') {
    const first = row.messages[0];
    if (!first) return null;
    const mine = first.mine;
    const tileWidth = Math.max(
      80,
      Math.round(Math.min(props.bubbleStyle.maxWidth, 320) / 2 - 2),
    );
    return (
      <ChatRowLayout
        mine={mine}
        continuation={row.continuation}
        avatarName={mine ? currentUser.displayName : first.sender.displayName}
        avatarUri={mine ? currentUser.avatarUrl : first.sender.avatarUrl}
        gender={mine ? currentUser.gender : first.sender.gender}
        onAvatarPress={
          !mine && props.onPressAvatar ? () => props.onPressAvatar?.(first.sender.id) : undefined
        }>
        <View style={[styles.albumGrid, { maxWidth: tileWidth * 2 + 4 }]}>
          {row.messages.map((message, index) => {
            const attachment = message.attachment;
            if (!attachment?.url) return null;
            const uri = mediaUrl(attachment.url);
            return (
              <ImageMessageBubble
                key={message.id}
                uri={uri}
                width={tileWidth}
                height={tileWidth}
                sending={message.state === 'pending'}
                failed={message.state === 'failed'}
                onRetry={() => props.onRetry(message)}
                onPress={() =>
                  props.onOpenAlbum
                    ? props.onOpenAlbum(row.messages, index)
                    : props.onOpenMedia({ uri, kind: 'image', encrypted: false })
                }
                onLongPress={() => props.onLongPress(message)}
              />
            );
          })}
        </View>
      </ChatRowLayout>
    );
  }

  const message = row.message;
  if (message.type === 'system' || message.type === 'call') {
    return (
      <View style={styles.systemRow}>
        {message.type === 'call' ? (
          <Phone size={13} strokeWidth={2.4} color={chat.systemText} />
        ) : null}
        <ThemedText type="caption" style={{ color: chat.systemText }}>
          {message.body}
        </ThemedText>
      </View>
    );
  }
  if (message.deleted) {
    return (
      <View style={styles.systemRow}>
        <ThemedText style={{ color: chat.systemText }}>
          {capabilities.encrypted
            ? fr.chat.unified.deletedForEveryoneEncrypted
            : fr.chat.unified.deletedMessage}
        </ThemedText>
      </View>
    );
  }

  const quote = message.quote ?? props.resolveQuote(message.quoteId);
  return (
    <ChatRowLayout
      mine={message.mine}
      continuation={row.continuation}
      avatarName={message.mine ? currentUser.displayName : message.sender.displayName}
      avatarUri={message.mine ? currentUser.avatarUrl : message.sender.avatarUrl}
      gender={message.mine ? currentUser.gender : message.sender.gender}
      onAvatarPress={
        !message.mine && props.onPressAvatar
          ? () => props.onPressAvatar?.(message.sender.id)
          : undefined
      }>
      <View>
        {!message.mine && isGroup && !row.continuation ? (
          <ThemedText
            type="smallBold"
            style={[styles.senderName, { color: chat.secondaryText }]}>
            {message.sender.displayName}
          </ThemedText>
        ) : null}
        <MessageBody
          message={message}
          quote={quote}
          capabilities={capabilities}
          chat={chat}
          bubbleStyle={props.bubbleStyle}
          onReply={props.onReply}
          onLongPress={props.onLongPress}
          onRetry={props.onRetry}
          onDiscard={props.onDiscard}
          onOpenMedia={props.onOpenMedia}
          token={token}
        />
        {capabilities.reactions ? (
          <ReactionChips
            message={message}
            onToggle={props.onToggleReaction}
          />
        ) : null}
        {message.mine && capabilities.receipts === 'ticks' ? (
          <View style={styles.ticksRow}>
            <ReceiptBadge message={message} capabilities={capabilities} chat={chat} />
          </View>
        ) : null}
        {message.mine && capabilities.receipts === 'delivered-opened' ? (
          <View style={styles.ticksRow}>
            <ReceiptBadge message={message} capabilities={capabilities} chat={chat} />
          </View>
        ) : null}
        {message.mine && isGroup && (props.seenByCountFor?.(message) ?? 0) > 0 ? (
          <Pressable
            onPress={() => props.onSeenBy?.(message)}
            accessibilityRole="button"
            accessibilityLabel={fr.chat.unified.seenBy(props.seenByCountFor?.(message) ?? 0)}
            style={styles.seenBy}>
            <ThemedText type="micro" themeColor="textSecondary">
              {fr.chat.unified.seenBy(props.seenByCountFor?.(message) ?? 0)}
            </ThemedText>
          </Pressable>
        ) : null}
      </View>
    </ChatRowLayout>
  );
}

/**
 * Ligne mémoïsée : la comparaison pure est dans `row-equality.ts` et porte sur
 * les références de messages, jamais sur l'objet de rangée recréé.
 */
export const ChatMessageRow = memo(ChatMessageRowComponent, sameChatMessageRow);

const styles = StyleSheet.create({
  stickerBlock: { gap: 4, maxWidth: 160 },
  alignEnd: { alignItems: 'flex-end' },
  quoteBlock: { width: '100%', borderRadius: Radii.sm, padding: Spacing.one },
  mediaBlock: { gap: Spacing.one, maxWidth: '100%' },
  caption: { fontSize: 15, lineHeight: 20 },
  emojiBlock: { maxWidth: 180, gap: 4 },
  emojiText: { textAlign: 'center' },
  text: { fontSize: 16, lineHeight: 21 },
  unreadable: { fontStyle: 'italic', opacity: 0.8 },
  failedBlock: { gap: Spacing.half, maxWidth: '100%' },
  failedText: { fontSize: 11, lineHeight: 14 },
  failedActions: { flexDirection: 'row', gap: Spacing.three },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one, marginTop: Spacing.half },
  reactionsMine: { justifyContent: 'flex-end' },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: Radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  ticksRow: { flexDirection: 'row', alignSelf: 'flex-end', marginTop: Spacing.half },
  seenBy: { alignSelf: 'flex-end' },
  senderName: { fontSize: 12, lineHeight: 16 },
  systemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 5,
    marginVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  unreadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  unreadLine: { flex: 1, height: StyleSheet.hairlineWidth },
  albumGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
});
