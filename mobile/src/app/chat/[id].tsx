import AsyncStorage from '@react-native-async-storage/async-storage';import * as ImagePicker from 'expo-image-picker';
import { Redirect, Stack, useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import {
  Check,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  Clock,
  Copy,
  Phone,
  Reply,
  Star,
  StarOff,
  Trash,
  Trash2,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { AttachPanel } from '@/components/attach-panel';
import { Avatar } from '@/components/avatar';
import { SwipeableBubble } from '@/components/swipeable-bubble';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { accentColor } from '@/components/ui';
import { CHAT_TIME_GAP_MS, useChatColors } from '@/constants/chat-theme';
import { Spacing, Radii } from '@/constants/theme';
import { PresenceSubtitle } from '@/features/presence/PresenceSubtitle';
import { VoiceMessageBubble, voiceBubbleWidth } from '@/features/voice-notes/VoiceMessageBubble';
import { ChatComposer, type ComposerTheme } from '@/features/composer/ChatComposer';
import { useCalls } from '@/features/calls/CallProvider';
import { SingleEmojiMessage } from '@/features/emoji/AnimatedEmoji';
import { EmojiText, MessageText } from '@/features/emoji/EmojiText';
import { emojiOnlyCount, splitEmoji, type EmojiSegment } from '@/features/emoji/emojiUtils';
import { GifMessageBubble } from '@/features/media/GifMessageBubble';
import type { RecentGif } from '@/features/media/GifPanel';
import { StickerMessageBubble } from '@/features/stickers/StickerMessageBubble';
import { findSticker } from '@/features/stickers/stickerPacks';
import { StickerMessage, StickerView } from '@/features/stickers/StickerView';
import {
  PERSONAL_PACK_ID,
  receivedStickerId,
  receivedStickerSeed,
  saveReceivedSticker,
  toggleStickerFavorite,
  type PersonalSticker,
} from '@/features/stickers/stickerLibrary';
import { useStickerLibrary } from '@/features/stickers/useStickerLibrary';
import { albumGridWidth, clusterMessages } from '@/features/media/album';
import { AlbumMessageBubble } from '@/features/media/AlbumMessage';
import {
  DocumentMessageBubble,
  ImageMessageBubble,
  VideoMessageBubble,
} from '@/features/media/MediaMessage';
import {
  documentCardWidth,
  gifDisplaySize,
  mediaDisplaySize,
} from '@/features/media/mediaLayout';
import { mediaUrl } from '@/features/media/mediaUrl';
import {
  AlbumViewer,
  ImageViewer,
  VideoViewer,
  type MediaViewerItem,
} from '@/features/media/MediaViewers';
import {
  isRejectedMedia,
  normalizeImageAsset,
  pickDocuments,
  pickLibraryMedia,
  type PickedAttachment,
  type RejectedMedia,
} from '@/features/media/pickMedia';
import { stopVoicePlayback } from '@/features/voice-notes/voicePlayback';
import type { VoiceNote } from '@/features/voice-notes/useVoiceRecorder';
import { useKeyboardHeight } from '@/hooks/use-keyboard-height';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cache } from '@/lib/cache';
import { conversationTitle, formatClock, formatDateLabel, tickState, type TickState } from '@/lib/format';
import {
  discard,
  drain,
  enqueue,
  listOutbox,
  localCreatedAtMs,
  onSent,
  pendingMessage,
  retry as retryOutbox,
  subscribe as subscribeOutbox,
  type OutboxItem,
} from '@/lib/outbox';
import {
  connectSocket,
  deleteMessage,
  getSocket,
  onConnection,
  reportDelivered,
  REACTION_STICKERS,
  toggleReaction,
} from '@/lib/socket';
import { advanceCursor, onMissedMessages } from '@/lib/sync';
import type {
  ConversationRemovedEvent,
  ConversationSummary,
  GroupUpdatedEvent,
  Message,
  MessageAttachment,
  MessageQuote,
  MessageReactionEvent,
  MessageReceipt,
  ReactionSummary,
} from '@/lib/types';

type ListRow =
  | { key: string; type: 'date'; label: string }
  | { key: string; type: 'time'; label: string }
  | { key: string; type: 'unread'; count: number }
  | { key: string; type: 'message'; message: Message; continuation?: boolean }
  | { key: string; type: 'album'; messages: Message[]; continuation?: boolean };

const TYPING_STEP_MS = 170;

/** Bascule locale d'une réaction, avant la confirmation du serveur. */
function toggleLocalReaction(
  reactions: ReactionSummary[],
  reaction: string,
): ReactionSummary[] {
  const existing = reactions.find((entry) => entry.reaction === reaction);
  if (!existing) {
    return [...reactions, { reaction, count: 1, mine: true }];
  }
  if (existing.mine) {
    return existing.count <= 1
      ? reactions.filter((entry) => entry.reaction !== reaction)
      : reactions.map((entry) =>
          entry.reaction === reaction
            ? { ...entry, count: entry.count - 1, mine: false }
            : entry,
        );
  }
  return reactions.map((entry) =>
    entry.reaction === reaction ? { ...entry, count: entry.count + 1, mine: true } : entry,
  );
}
/** Au-delà de ce défilement, la pastille de retour en bas apparaît. */
const JUMP_AFTER_PX = 320;
/** Double coche bleue : le message a été lu. */
const TICK_READ = '#53bdeb';
/** Le backend n'a pas de « playedBy » : l'écoute des vocaux reste locale. */
const PLAYED_VOICES_KEY = 'mbolochat.played-voices';

/** Horodatage en millisecondes, pour ordonner réellement les messages. */
const atMs = (value: string): number => new Date(value).getTime();

/**
 * Copie dans le presse-papiers. Le module est natif : un build plus ancien que
 * cette version le renvoie absent, et son simple import ferait tomber l'écran.
 * On le sonde donc avant de le charger, et on le dit si il manque.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    if (!requireOptionalNativeModule('ExpoClipboard')) {
      return false;
    }
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fusionne des messages sans doublon et dans l'ordre chronologique.
 *
 * Deux clés de déduplication : l'identifiant du serveur, et la clé d'idempotence
 * de l'appareil — un message peut arriver par le socket avant que l'acquittement
 * d'envoi ne soit revenu, ou être renvoyé par le rattrapage.
 */
function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) {
    return current;
  }
  const byId = new Map(current.map((message) => [message.id, message]));
  const mineByClientId = new Map(
    current.filter((message) => message.clientId).map((message) => [message.clientId as string, message]),
  );
  let changed = false;
  for (const message of incoming) {
    if (byId.has(message.id)) {
      continue;
    }
    const known = message.clientId ? mineByClientId.get(message.clientId) : undefined;
    if (known) {
      // Le serveur a gardé la trace de mon envoi optimiste : il remplace la
      // version locale, qui n'a plus lieu d'être.
      byId.delete(known.id);
      mineByClientId.set(message.clientId as string, message);
    }
    byId.set(message.id, message);
    changed = true;
  }
  if (!changed) {
    return current;
  }
  return [...byId.values()].sort((a, b) => atMs(a.createdAt) - atMs(b.createdAt));
}

/**
 * Emplacement du séparateur de non-lus : le plus ancien des N messages reçus qui
 * restent à lire. On part du compteur affiché dans la liste des discussions
 * plutôt que de `last_read_at` — cet écran envoie un accusé de lecture en
 * s'ouvrant, qui aurait déjà repoussé ce point.
 */
function unreadBoundary(
  messages: Message[],
  unreadCount: number,
  myId: string,
): { id: string; count: number } | null {
  if (unreadCount <= 0) {
    return null;
  }
  let id: string | null = null;
  let counted = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.sender.id === myId) {
      continue;
    }
    id = message.id;
    counted += 1;
    if (counted >= unreadCount) {
      break;
    }
  }
  return id ? { id, count: counted } : null;
}

/** Accusés regroupés par message, pour retrouver vite la coche d'une bulle. */
function groupReceipts(rows: MessageReceipt[]): Record<string, MessageReceipt[]> {
  const grouped: Record<string, MessageReceipt[]> = {};
  for (const row of rows) {
    const list = grouped[row.messageId];
    if (list) {
      list.push(row);
    } else {
      grouped[row.messageId] = [row];
    }
  }
  return grouped;
}

/**
 * Coches des messages : horloge en file, alerte en cas d'échec, simple coche
 * envoyée, double coche reçue, double coche bleue lue.
 */
const TICK_ICON: Record<TickState, LucideIcon> = {
  pending: Clock,
  failed: CircleAlert,
  sent: Check,
  delivered: CheckCheck,
  read: CheckCheck,
};

const TICK_LABEL: Record<TickState, string> = {
  pending: "En attente d'envoi",
  failed: "Échec de l'envoi",
  sent: 'Envoyé',
  delivered: 'Reçu',
  read: 'Lu',
};

const TICK_PRIORITY: Record<TickState, number> = {
  failed: 0,
  pending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

/** L'album est « envoyé » quand sa tuile la moins avancée l'est aussi. */
function aggregateTick(states: (TickState | undefined)[]): TickState | undefined {
  let result: TickState | undefined;
  for (const state of states) {
    if (state && (!result || TICK_PRIORITY[state] < TICK_PRIORITY[result])) {
      result = state;
    }
  }
  return result;
}

function Ticks({
  state,
  tone = '#d7e6ff',
  failedTone = '#ffd2d2',
}: {
  state: TickState;
  tone?: string;
  failedTone?: string;
}) {
  const Glyph = TICK_ICON[state];
  return (
    <View
      accessible
      accessibilityLabel={TICK_LABEL[state]}
      style={state === 'pending' ? styles.tickPending : null}>
      <Glyph
        size={state === 'failed' ? 14 : 16}
        strokeWidth={2.6}
        color={state === 'read' ? TICK_READ : state === 'failed' ? failedTone : tone}
      />
    </View>
  );
}

/** Ce qu'affiche une citation quand l'original n'avait que du média. */
function quoteText(quote: MessageQuote): string {
  if (quote.deleted) {
    return 'Message supprimé';
  }
  if (quote.type === 'sticker') {
    return 'Sticker';
  }
  if (quote.content) {
    return quote.content;
  }
  switch (quote.attachmentType) {
    case 'AUDIO':
      return 'Message vocal';
    case 'VIDEO':
      return 'Vidéo';
    case 'IMAGE':
      return 'Photo';
    case 'GIF':
      return 'GIF';
    case 'STICKER':
      return 'Sticker';
    case 'FILE':
      return 'Document';
    default:
      return 'Pièce jointe';
  }
}

/** Aperçu à insérer dans une réponse, depuis le message que l'on cite. */
function quoteOfMessage(message: Message): MessageQuote {
  return {
    id: message.id,
    senderName: message.sender.displayName,
    content: message.deleted ? '' : message.content,
    type: message.type ?? 'text',
    attachmentType: message.deleted ? null : (message.attachment?.type ?? null),
    deleted: message.deleted,
  };
}

/** Bandeau du message cité, posé au-dessus du texte de la réponse. */
function QuoteBlock({ quote, mine, onPress }: { quote: MessageQuote; mine: boolean; onPress?: () => void }) {
  const chat = useChatColors();
  const tone = useMemo(
    () => ({
      quote: { backgroundColor: mine ? chat.quoteBackgroundMine : chat.quoteBackground },
      bar: { backgroundColor: mine ? chat.quoteBarMine : chat.quoteBar },
      name: { color: chat.quoteName },
      text: { color: chat.quoteText },
    }),
    [chat, mine],
  );
  const body = (
    <View style={[styles.quote, tone.quote]}>
      <View style={[styles.quoteBar, tone.bar]} />
      <View style={styles.quoteBody}>
        <ThemedText type="smallBold" style={tone.name}>
          {quote.senderName}
        </ThemedText>
        <EmojiText numberOfLines={1} style={[styles.quotePreviewText, tone.text]}>
          {quoteText(quote)}
        </EmojiText>
      </View>
    </View>
  );
  if (!onPress) {
    return body;
  }
  return (
    <Pressable onPress={onPress} hitSlop={4} accessibilityRole="button" accessibilityLabel="Aller au message cité">
      {body}
    </Pressable>
  );
}

function TypingDots({ color }: { color: string }) {
  const [dots] = useState(() => [
    new Animated.Value(0.25),
    new Animated.Value(0.25),
    new Animated.Value(0.25),
  ]);

  useEffect(() => {
    const animations = dots.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * TYPING_STEP_MS),
          Animated.timing(value, { toValue: 1, duration: 250, useNativeDriver: true, isInteraction: false }),
          Animated.timing(value, { toValue: 0.25, duration: 250, useNativeDriver: true, isInteraction: false }),
          Animated.delay(TYPING_STEP_MS * (2 - index)),
        ]),
      ),
    );
    animations.forEach((animation) => animation.start());
    return () => {
      animations.forEach((animation) => animation.stop());
    };
  }, [dots]);

  return (
    <View style={styles.dotsRow}>
      {dots.map((value, index) => (
        <Animated.View key={index} style={[styles.dot, { backgroundColor: color, opacity: value }]} />
      ))}
    </View>
  );
}

function TypingLine({ name, text }: { name: string; text: string }) {
  const [opacity] = useState(() => new Animated.Value(0));
  const [translateY] = useState(() => new Animated.Value(4));

  useEffect(() => {
    const animation = Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true, isInteraction: false }),
      Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true, isInteraction: false }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [opacity, translateY]);

  return (
    <Animated.View style={[styles.typingRow, { opacity, transform: [{ translateY }] }]}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.typing} numberOfLines={1}>
        {name} : {text}
      </ThemedText>
      <TypingDots color={accentColor} />
    </Animated.View>
  );
}

function ReactionChips({
  reactions,
  alignEnd,
  onToggle,
}: {
  reactions: ReactionSummary[];
  alignEnd: boolean;
  onToggle: (reaction: string) => void;
}) {
  const theme = useTheme();
  // Les messages mis en cache avant le passage aux stickers peuvent porter
  // d'anciennes réactions Unicode : on ignore tout ce qui n'est pas une réf.
  const visible = reactions.filter(
    (entry) => typeof entry.reaction === 'string' && entry.reaction.length > 0,
  );
  if (visible.length === 0) {
    return null;
  }
  return (
    <View style={[styles.reactionChips, alignEnd && styles.reactionChipsEnd]}>
      {visible.map((reaction) => {
        const sticker = findSticker(reaction.reaction);
        return (
          <Pressable
            key={reaction.reaction}
            onPress={() => onToggle(reaction.reaction)}
            accessibilityRole="button"
            accessibilityLabel={`${
              sticker
                ? sticker.kind === 'image'
                  ? (sticker.name ?? sticker.alt)
                  : sticker.label
                : 'Réaction'
            }, ${reaction.count}`}
            style={[
              styles.reactionChip,
              {
                backgroundColor: reaction.mine ? theme.accentSoft : theme.backgroundElement,
                borderColor: reaction.mine ? theme.accent : theme.border,
              },
            ]}>
            {sticker ? (
              <StickerView sticker={sticker} size={24} />
            ) : (
              <ThemedText type="micro">?</ThemedText>
            )}
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

function ChatHeaderTitle({
  title,
  subtitle,
  presenceUserId,
  avatar,
  onPress,
}: {
  title: string;
  subtitle: string;
  presenceUserId?: string;
  avatar?: React.ReactNode;
  onPress?: () => void;
}) {
  const chat = useChatColors();
  const content = (
    <View style={styles.headerTitleBody}>
      {avatar}
      <View style={styles.headerTitleText}>
        <ThemedText numberOfLines={1} style={[styles.headerName, { color: chat.headerText }]}>
          {title}
        </ThemedText>
        {presenceUserId ? (
          <PresenceSubtitle
            userId={presenceUserId}
            onlineColor={chat.send}
            offlineColor={chat.headerSubtitle}
          />
        ) : subtitle ? (
          <ThemedText
            numberOfLines={1}
            style={[styles.headerSubtitle, { color: chat.headerSubtitle }]}>
            {subtitle}
          </ThemedText>
        ) : null}
      </View>
    </View>
  );

  if (!onPress) {
    return content;
  }

  return (
    <Pressable onPress={onPress} hitSlop={8}>
      {content}
    </Pressable>
  );
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { token, user } = useAuth();
  const stickerLibrary = useStickerLibrary();
  const theme = useTheme();
  const chat = useChatColors();
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const bubbleMaxWidth = useMemo(
    () => ({ maxWidth: Math.round(windowWidth * 0.7) }),
    [windowWidth],
  );
  const chatStyles = useMemo(
    () => ({
      screen: { backgroundColor: chat.screen },
      messageText: { color: chat.primaryText },
      secondaryText: { color: chat.secondaryText },
      systemText: { color: chat.systemText },
      senderName: { color: chat.secondaryText },
      dateText: { color: chat.dateText },
      bubbleMine: { backgroundColor: chat.mineBubble },
      bubbleTheirs: { backgroundColor: chat.theirBubble },
      unreadText: { color: chat.unreadText },
      unreadLine: { backgroundColor: chat.border },
      failed: { color: chat.error },
      replyBar: { backgroundColor: chat.composer },
    }),
    [chat],
  );

  // Historique déjà connu : la conversation s'affiche immédiatement.
  const [conversation, setConversation] = useState<ConversationSummary | null>(() =>
    id ? cache.getConversation(id) : null,
  );
  const [messages, setMessages] = useState<Message[]>(() => (id ? cache.getMessages(id) ?? [] : []));
  /** Mes messages pas encore partis : la file, persistée sur l'appareil. */
  const [queued, setQueued] = useState<OutboxItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [input, setInput] = useState('');
  /** Brouillon persistant de cette conversation. */
  const [draft, setDraft] = useState(() => (id ? cache.getDraft(id) : ''));
  const [typing, setTyping] = useState<{ userId: string; text: string } | null>(null);
  /** Anti-double-appui : deux stickers identiques ne partent pas en rafale. */
  const lastStickerSendAt = useRef(0);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingEmitRef = useRef(0);
  const pendingTypingRef = useRef<string | null>(null);
  /** Accusés de réception de mes messages, regroupés par message. */
  const [receipts, setReceipts] = useState<Record<string, MessageReceipt[]>>({});
  const [ready, setReady] = useState(() => (id ? cache.getMessages(id) !== null : false));
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Compteur qui remonte ChatComposer après l'envoi d'une pièce jointe. */
  const [composerKey, setComposerKey] = useState(0);
  const [imageViewer, setImageViewer] = useState<{ urls: string[]; index: number } | null>(null);
  const [albumViewer, setAlbumViewer] = useState<{ items: MediaViewerItem[]; index: number } | null>(
    null,
  );
  const [videoViewer, setVideoViewer] = useState<string | null>(null);
  /** Message cité par la réponse en cours de composition. */
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  /** Espace réel au-dessus du clavier, utilisé pour dimensionner la recherche emoji. */
  const [chatAreaHeight, setChatAreaHeight] = useState(0);
  const [replyBarHeight, setReplyBarHeight] = useState(0);
  /** Bulle dont le menu d'appui long est ouvert. */
  const [menuFor, setMenuFor] = useState<Message | null>(null);
  /** Message dont on consulte la liste des lecteurs (groupes). */
  const [seenFor, setSeenFor] = useState<Message | null>(null);
  /** Waveforms des vocaux de cette session, indexées par clientId/URI locale. */
  const [voiceWaveforms, setVoiceWaveforms] = useState<Record<string, number[]>>({});
  const [playedVoiceIds, setPlayedVoiceIds] = useState<Set<string>>(() => new Set());
  const playedLoadedRef = useRef(false);
  const listRef = useRef<FlatList<ListRow>>(null);
  /** Le dernier message est-il à l'écran ? Décide si on doit y recoller. */
  const atBottomRef = useRef(true);
  /** Séparateur de non-lus, figé à l'ouverture : il ne suit pas les arrivages. */
  const [unreadFrom, setUnreadFrom] = useState<{ id: string; count: number } | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  /** Messages reçus pendant que l'on était remonté dans l'historique. */
  const [unseen, setUnseen] = useState(0);
  const unseenRef = useRef(0);
  const showJumpRef = useRef(false);
  /** L'historique est-il à l'écran ? Ce n'est qu'alors que la lecture se signale. */
  const historyLoadedRef = useRef(false);

  /** Vide le brouillon et remonte le compositeur (après une pièce jointe). */
  const resetComposer = useCallback(() => {
    setInput('');
    setDraft('');
    if (id) {
      cache.clearDraft(id);
    }
    setComposerKey((key) => key + 1);
    if (token && id) {
      connectSocket(token).emit('typing', { conversationId: id, text: '' });
    }
  }, [token, id]);

  const composerTheme = useMemo<ComposerTheme>(
    () => ({
      barBg: chat.composer,
      inputBg: chat.input,
      inputText: chat.primaryText,
      placeholder: chat.inputPlaceholder,
      panelBg: chat.composer,
      tabBg: chat.input,
      tabActiveBg: theme.backgroundSelected,
      text: chat.primaryText,
      subtle: chat.secondaryText,
      icon: chat.composerIcon,
      border: chat.border,
      pressed: theme.backgroundSelected,
      accent: chat.send,
      accentText: chat.sendText,
      sendBg: chat.send,
    }),
    [chat, theme],
  );

  const emitTyping = useCallback(
    (value: string) => {
      if (!token || !id) return;
      lastTypingEmitRef.current = Date.now();
      connectSocket(token).emit('typing', { conversationId: id, text: value.slice(0, 300) });
    },
    [token, id],
  );

  const onInputChange = useCallback(
    (value: string) => {
      setInput(value);
      setDraft(value);
      if (id) {
        cache.setDraft(id, value);
      }
      if (!token || !id) return;
      const wait = 150 - (Date.now() - lastTypingEmitRef.current);
      if (wait <= 0) {
        if (typingFlushRef.current) {
          clearTimeout(typingFlushRef.current);
          typingFlushRef.current = null;
        }
        pendingTypingRef.current = null;
        emitTyping(value);
        return;
      }
      pendingTypingRef.current = value;
      if (typingFlushRef.current) return;
      typingFlushRef.current = setTimeout(() => {
        typingFlushRef.current = null;
        const pending = pendingTypingRef.current;
        pendingTypingRef.current = null;
        if (pending !== null) emitTyping(pending);
      }, wait);
    },
    [emitTyping, token, id],
  );

  useEffect(() => {
    if (!token || !id || !user) {
      return;
    }
    let active = true;
    historyLoadedRef.current = false;
    (async () => {
      try {
        const [summary, history, received] = await Promise.all([
          api.getConversation(token, id),
          api.listMessages(token, id, { limit: 30 }),
          api.listReceipts(token, id),
        ]);
        if (!active) {
          return;
        }
        setConversation(summary);
        setMessages(history);
        setHasMore(history.length >= 30);
        setReceipts(groupReceipts(received));
        cache.setConversation(summary);
        cache.setMessages(id, history);
        // Le rattrapage repartira de l'horodatage du serveur le plus récent.
        void advanceCursor(history);
        const boundary = unreadBoundary(history, summary.unreadCount, user.id);
        if (boundary) {
          setUnreadFrom((current) => current ?? boundary);
        }
        // La discussion ne passe en « lu » qu'une fois l'historique affiché :
        // signalée plus tôt, la lecture effaçait le compteur avant de l'afficher.
        historyLoadedRef.current = true;
        getSocket()?.emit('message:read', { conversationId: id });
        setError(null);
      } catch (err) {
        if (active) {
          setError(err instanceof ApiError ? err.message : 'Impossible de charger la discussion.');
        }
      } finally {
        if (active) {
          setReady(true);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [token, id, user]);

  useEffect(() => {
    if (!token || !id || !user) {
      return;
    }
    const socket = connectSocket(token);

    const join = () => {
      socket.emit('conversation:join', { conversationId: id });
      // La discussion est à l'écran : pas besoin de notification push.
      socket.emit('conversation:focus', { conversationId: id });
      // Une reconnexion tardive rattrape la lecture qui n'a pas pu être
      // signalée pendant le chargement de l'historique.
      if (historyLoadedRef.current) {
        socket.emit('message:read', { conversationId: id });
      }
    };

    /**
     * Ajoute des messages arrivés par le socket ou par le rattrapage : dédupliqués
     * et remis dans l'ordre chronologique, quelle que soit leur arrivée.
     */
    const append = (incoming: Message[]) => {
      const here = incoming.filter((message) => message.conversationId === id);
      if (here.length === 0) {
        return;
      }
      setMessages((previous) => {
        const next = mergeMessages(previous, here);
        cache.setMessages(id, next);
        return next;
      });
      void advanceCursor(here);
      const foreign = here.filter((message) => message.sender.id !== user.id);
      if (foreign.length > 0) {
        // Ce que l'appareil a réellement entre dans la conversation : coche « reçue ».
        reportDelivered(foreign.map((message) => message.id));
        socket.emit('message:read', { conversationId: id });
        if (!atBottomRef.current) {
          // Remonté dans l'historique : ces arrivages comptent sur la pastille.
          unseenRef.current += foreign.length;
          setUnseen(unseenRef.current);
        }
      }
    };

    const onMessage = (message: Message) => {
      append([message]);
      if (message.sender.id !== user.id) {
        setTyping((cur) => (cur && cur.userId === message.sender.id ? null : cur));
      }
    };
    const onTyping = (payload: { conversationId: string; userId: string; text?: string }) => {
      if (payload.conversationId !== id || payload.userId === user.id) return;
      const text = (payload.text ?? '').slice(0, 300);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (!text) {
        setTyping((cur) => (cur && cur.userId === payload.userId ? null : cur));
        return;
      }
      setTyping({ userId: payload.userId, text });
      typingTimeoutRef.current = setTimeout(() => setTyping(null), 2500);
    };
    /** Accusés de réception de MES messages : c'est ce qui colore les coches. */
    const onReceipt = (payload: { receipts: MessageReceipt[] }) => {
      if (!Array.isArray(payload?.receipts)) {
        return;
      }
      setReceipts((previous) => {
        const next = { ...previous };
        for (const receipt of payload.receipts) {
          const list = (next[receipt.messageId] ?? []).filter(
            (existing) => existing.userId !== receipt.userId,
          );
          list.push(receipt);
          next[receipt.messageId] = list;
        }
        return next;
      });
    };

    /**
     * Retrait d'un message. « Pour tous » laisse la bulle et dit qu'elle est
     * vide ; « pour moi » la fait disparaître de mon seul écran.
     */
    const onDeleted = (payload: { conversationId?: string; messageId?: string; forEveryone?: boolean }) => {
      if (payload?.conversationId !== id || !payload.messageId) {
        return;
      }
      const removed = payload.messageId;
      setMessages((previous) => {
        const next = payload.forEveryone
          ? previous.map((message) =>
              message.id === removed ? { ...message, deleted: true, content: '', attachment: null } : message,
            )
          : previous.filter((message) => message.id !== removed);
        cache.setMessages(id, next);
        return next;
      });
    };

    socket.on('message:new', onMessage);
    socket.on('typing', onTyping);
    socket.on('receipt', onReceipt);
    socket.on('message:deleted', onDeleted);

    // Le groupe a changé (identité, membres, rôle) : l'en-tête et les noms
    // d'expéditeurs suivent sans rechargement.
    const onGroupUpdated = (event: GroupUpdatedEvent) => {
      if (event.conversationId !== id) return;
      setConversation((prev) => {
        if (!prev) return prev;
        const next: ConversationSummary = {
          ...prev,
          name: event.group.name,
          description: event.group.description,
          emoji: event.group.emoji,
          color: event.group.color,
          avatarUrl: event.group.avatarUrl,
          ownerId: event.group.ownerId,
          whoCanSend: event.group.whoCanSend,
          whoCanAdd: event.group.whoCanAdd,
          members: event.members,
          updatedAt: event.group.updatedAt,
        };
        cache.setConversation(next);
        return next;
      });
    };
    const onConversationRemoved = (event: ConversationRemovedEvent) => {
      if (event.conversationId !== id) return;
      cache.removeConversation(id);
      router.replace('/chats');
    };
    const onReaction = (event: MessageReactionEvent) => {
      if (event.conversationId !== id) return;
      setMessages((previous) => {
        const next = previous.map((message) =>
          message.id === event.messageId
            ? { ...message, reactions: event.reactions }
            : message,
        );
        cache.setMessages(id, next);
        return next;
      });
    };
    socket.on('group:updated', onGroupUpdated);
    socket.on('members:changed', onGroupUpdated);
    socket.on('conversation:removed', onConversationRemoved);
    socket.on('message:reaction', onReaction);
    const offMissed = onMissedMessages(append);
    // La file a la confirmation d'un envoi : on l'affiche même si la diffusion
    // temps réel de mon propre message s'était perdue.
    const offSent = onSent((message) => append([message]));
    if (socket.connected) {
      join();
    } else {
      socket.on('connect', join);
    }

    return () => {
      socket.off('message:new', onMessage);
      socket.off('typing', onTyping);
      socket.off('receipt', onReceipt);
      socket.off('message:deleted', onDeleted);
      socket.off('group:updated', onGroupUpdated);
      socket.off('members:changed', onGroupUpdated);
      socket.off('conversation:removed', onConversationRemoved);
      socket.off('message:reaction', onReaction);
      socket.off('connect', join);
      offMissed();
      offSent();
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (typingFlushRef.current) clearTimeout(typingFlushRef.current);
      // Le socket reste ouvert : la liste des discussions continue de
      // recevoir les messages en temps réel après le retour.
    };
  }, [token, id, user, router]);

  // Quitter l'écran (profil, retour à la liste…) réautorise les notifications.
  useFocusEffect(
    useCallback(() => {
      if (!id) {
        return;
      }
      const socket = getSocket();
      if (socket?.connected) {
        socket.emit('conversation:focus', { conversationId: id });
      }
      return () => {
        socket?.emit('conversation:blur', { conversationId: id });
        void stopVoicePlayback();
      };
    }, [id]),
  );

  /**
   * La file d'attente dicte les bulles « pas encore parties ». Elle change quand
   * un envoi aboutit, échoue, ou quand la reprise automatique s'en mêle.
   */
  useEffect(() => {
    if (!id) {
      return;
    }
    let active = true;
    const refresh = () => {
      listOutbox(id)
        .then((items) => {
          if (active) {
            setQueued(items);
          }
        })
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = subscribeOutbox(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [id]);

  useEffect(() => onConnection((connected) => setOffline(!connected)), []);

  const rows = useMemo(() => {
    // Les messages partis en attente se mêlent aux messages confirmés, dans
    // l'ordre de composition — un message qui attend ne saute pas en bas.
    const all = [...messages];
    // L'heure locale de sélection reste la référence : deux uploads terminés
    // dans le désordre ne réordonnent pas les bulles après confirmation.
    const orderAt = (message: Message) =>
      localCreatedAtMs(message.clientId) ?? atMs(message.createdAt);
    if (user && id) {
      const sender: Message['sender'] = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        gender: user.gender,
      };
      const confirmed = new Set(
        messages.map((message) => message.clientId).filter((clientId): clientId is string => Boolean(clientId)),
      );
      for (const item of queued) {
        // L’écho du serveur peut précéder la sortie de la file : une seule bulle.
        if (confirmed.has(item.clientId)) {
          continue;
        }
        all.push(
          pendingMessage(item, sender, (quotedId) => {
            const origin = all.find((row) => row.id === quotedId);
            return origin ? quoteOfMessage(origin) : null;
          }),
        );
      }
      all.sort((a, b) => orderAt(a) - orderAt(b));
    }

    const chronological: ListRow[] = [];
    let lastLabel = '';
    let lastMs: number | null = null;
    let lastSenderId: string | null = null;
    let unreadPlaced = !unreadFrom;
    for (const cluster of clusterMessages(all, orderAt)) {
      const first = cluster.messages[0];
      const displayIso = new Date(cluster.firstAt).toISOString();
      const label = formatDateLabel(displayIso);
      // Messages consécutifs du même expéditeur : un seul avatar et un seul nom.
      const continuation =
        lastSenderId === first.sender.id &&
        lastMs !== null &&
        cluster.firstAt - lastMs <= CHAT_TIME_GAP_MS;
      if (label !== lastLabel) {
        chronological.push({ key: `date-${first.id}`, type: 'date', label });
        lastLabel = label;
        lastMs = null;
        lastSenderId = null;
      } else if (lastMs !== null && cluster.firstAt - lastMs > CHAT_TIME_GAP_MS) {
        chronological.push({
          key: `time-${first.id}`,
          type: 'time',
          label: formatClock(displayIso),
        });
      }
      if (
        !unreadPlaced &&
        unreadFrom &&
        cluster.messages.some((message) => message.id === unreadFrom.id)
      ) {
        chronological.push({ key: 'unread', type: 'unread', count: unreadFrom.count });
        unreadPlaced = true;
      }
      if (cluster.messages.length > 1) {
        chronological.push({
          key: `album-${first.id}-${cluster.messages[cluster.messages.length - 1].id}`,
          type: 'album',
          messages: cluster.messages,
          continuation,
        });
      } else {
        chronological.push({
          key: first.id,
          type: 'message',
          message: first,
          continuation,
        });
      }
      lastMs = cluster.lastAt;
      lastSenderId = first.sender.id;
    }
    return chronological.reverse();
  }, [messages, queued, user, id, unreadFrom]);

  /**
   * GIF de cette conversation réutilisables tels quels. On ne garde que les
   * médias GIPHY déjà acceptés par le serveur : leur URL peut repartir sans
   * ré-upload et le backend revalide l'allowlist.
   */
  const recentGifs = useMemo<RecentGif[]>(() => {
    const seen = new Set<string>();
    const out: RecentGif[] = [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const attachment = messages[index]?.attachment;
      if (attachment?.type !== 'GIF') continue;
      const url = mediaUrl(attachment.url);
      if (!/^https:\/\/media\d*\.giphy\.com\//i.test(url)) continue;
      const key = attachment.giphyId ?? url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: key,
        url,
        stillUrl: attachment.stillUrl ? mediaUrl(attachment.stillUrl) : undefined,
        width: attachment.width,
        height: attachment.height,
        sticker: attachment.sticker === true,
        title: attachment.title,
        giphyId: attachment.giphyId,
        username: attachment.username,
      });
      if (out.length >= 24) break;
    }
    return out;
  }, [messages]);

  const openImage = useCallback(
    (uri: string) => {
      const urls = rows
        .flatMap((row) => {
          if (row.type === 'message') {
            const attachment = row.message.attachment;
            if (!attachment) return [];
            // Les stickers gardent leur affichage transparent dans la
            // conversation ; le zoom reste possible comme pour une image.
            const gallery =
              attachment.type === 'IMAGE' ||
              attachment.type === 'STICKER' ||
              (attachment.type === 'GIF' && attachment.sticker !== true);
            return gallery ? [mediaUrl(attachment.url)] : [];
          }
          if (row.type === 'album') {
            return row.messages.flatMap((message) => {
              const attachment = message.attachment;
              return attachment?.type === 'IMAGE' ? [mediaUrl(attachment.url)] : [];
            });
          }
          return [];
        })
        .reverse();
      const index = urls.indexOf(uri);
      setImageViewer({ urls, index: index >= 0 ? index : 0 });
    },
    [rows],
  );

  /** Chaque tuile ouvre l'album entier, positionnée sur le fichier touché. */
  const openAlbum = useCallback((albumMessages: Message[], index: number) => {
    const items: MediaViewerItem[] = [];
    for (const message of albumMessages) {
      const attachment = message.attachment;
      if (!attachment) continue;
      if (attachment.type !== 'IMAGE' && attachment.type !== 'VIDEO') continue;
      items.push({
        type: attachment.type === 'VIDEO' ? 'video' : 'image',
        uri: mediaUrl(attachment.url),
        durationMs: attachment.duration,
      });
    }
    if (items.length === 0) {
      return;
    }
    setAlbumViewer({
      items,
      index: Math.max(0, Math.min(index, items.length - 1)),
    });
  }, []);

  const openDocument = useCallback(
    (attachment: MessageAttachment) => {
      router.push({
        pathname: '/document-viewer',
        params: {
          url: mediaUrl(attachment.url),
          name: attachment.name ?? 'fichier',
          mime: attachment.mime,
          size: String(attachment.size ?? 0),
        },
      });
    },
    [router],
  );

  const queuedById = useMemo(() => new Map(queued.map((item) => [item.clientId, item])), [queued]);

  /** Coche de chaque bulle : la file pour mes envois, les accusés du serveur sinon. */
  const tickById = useMemo(() => {
    const map: Record<string, TickState> = {};
    for (const item of queued) {
      const networkFailure =
        item.kind !== 'audio' && item.status === 'pending' && item.error !== null;
      map[item.clientId] = item.status === 'failed' || networkFailure ? 'failed' : 'pending';
    }
    if (!user) {
      return map;
    }
    for (const message of messages) {
      if (message.sender.id !== user.id || map[message.id]) {
        continue;
      }
      map[message.id] = tickState(receipts[message.id] ?? []);
    }
    return map;
  }, [queued, messages, receipts, user]);

  const title = conversation && user ? conversationTitle(conversation, user.id) : '';
  const isGroup = conversation?.type === 'GROUP';
  const other = user ? conversation?.members.find((member) => member.id !== user.id) : undefined;
  const typingName =
    isGroup && typing
      ? (conversation?.members.find((member) => member.id === typing.userId)?.displayName ??
        'Quelqu’un')
      : null;
  const subtitle = isGroup
    ? typingName
      ? `${typingName} est en train d’écrire…`
      : `${conversation?.members.length ?? 0} membres`
    : '';

  // Les callbacks et l'en-tête sont mémorisés : chaque frappe dans le champ
  // ne doit pas reconstruire l'en-tête ni les bulles de la liste.
  const openOtherProfile = useCallback(() => {
    if (!other) {
      return;
    }
    router.push({
      pathname: '/user/[id]',
      params: {
        id: other.id,
        name: other.displayName,
        username: other.username,
        avatar: other.avatarUrl ?? '',
        gender: other.gender ?? '',
      },
    });
  }, [other, router]);

  const openConversationSettings = useCallback(() => {
    if (!id) return;
    if (conversation?.type === 'GROUP') {
      router.push({ pathname: '/group/[id]', params: { id } });
      return;
    }
    router.push({ pathname: '/conversation-settings/[id]', params: { id } });
  }, [conversation?.type, id, router]);

  const calls = useCalls();
  const onGroupCallPress = useCallback(
    (kind: 'audio' | 'video') => {
      if (!conversation || conversation.type !== 'GROUP') {
        return;
      }
      if (calls.status !== 'idle') {
        calls.restore();
        return;
      }
      void calls.startGroupCall(conversation.id, { video: kind === 'video' });
    },
    [calls, conversation],
  );

  const onCallPress = useCallback(
    (kind: 'voice' | 'video') => {
      if (!conversation || conversation.type !== 'DIRECT') {
        return;
      }
      if (conversation.blockedByMe || conversation.blockedByThem) {
        Alert.alert('Appel indisponible', 'Cette conversation est bloquée.');
        return;
      }
      void calls.startCall(conversation.id, { video: kind === 'video' });
    },
    [calls, conversation],
  );

  const headerOptions = useMemo(
    () => ({
      headerTitleAlign: 'center' as const,
      headerShadowVisible: false,
      headerTintColor: chat.headerText,
      headerBackground: () => (
        <View
          style={[
            styles.headerBackground,
            { backgroundColor: chat.screen, borderBottomColor: chat.border },
          ]}
        />
      ),
      headerTitle: () => (
        <ChatHeaderTitle
          title={title}
          subtitle={subtitle}
          presenceUserId={
            conversation?.type === 'DIRECT' && other ? other.id : undefined
          }
          avatar={
            conversation?.type === 'GROUP' ? (
              <Avatar
                name={title}
                uri={conversation.avatarUrl}
                emoji={conversation.emoji}
                color={conversation.color}
                variant="group"
                size={34}
              />
            ) : undefined
          }
          onPress={
            conversation?.type === 'GROUP'
              ? openConversationSettings
              : conversation?.type === 'DIRECT' && other
                ? openOtherProfile
                : undefined
          }
        />
      ),
      headerRight: () =>
        conversation?.type === 'GROUP' ? (
          <View style={styles.headerCallActions}>
            <Pressable
              onPress={() => onGroupCallPress('video')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Appel vidéo de groupe"
              style={({ pressed }) => pressed && styles.pressedHeaderAction}>
              <Video size={26} color={chat.headerText} />
            </Pressable>
            <Pressable
              onPress={() => onGroupCallPress('audio')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Appel vocal de groupe"
              style={({ pressed }) => pressed && styles.pressedHeaderAction}>
              {/* Combiné retourné (sens « raccroché »), comme en un à un. */}
              <View style={styles.phoneFlipped}>
                <Phone size={22} color={chat.headerText} />
              </View>
            </Pressable>
          </View>
        ) : conversation?.type === 'DIRECT' ? (
          <View style={styles.headerCallActions}>
            <Pressable
              onPress={() => onCallPress('video')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Appel vidéo"
              style={({ pressed }) => pressed && styles.pressedHeaderAction}>
              <Video size={26} color={chat.headerText} />
            </Pressable>
            <Pressable
              onPress={() => onCallPress('voice')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Appel vocal"
              style={({ pressed }) => pressed && styles.pressedHeaderAction}>
              {/* Combiné retourné (sens « raccroché »), comme WhatsApp. */}
              <View style={styles.phoneFlipped}>
                <Phone size={22} color={chat.headerText} />
              </View>
            </Pressable>
          </View>
        ) : null,
    }),
    [
      conversation,
      other,
      title,
      subtitle,
      openOtherProfile,
      openConversationSettings,
      onCallPress,
      onGroupCallPress,
      chat,
    ],
  );

  const keyExtractor = useCallback((item: ListRow) => item.key, []);

  const loadOlder = useCallback(() => {
    if (!hasMore || loadingMore || messages.length === 0 || !token || !id) {
      return;
    }
    const oldest = messages[0];
    setLoadingMore(true);
    api
      .listMessages(token, id, { before: oldest.createdAt, limit: 30 })
      .then((older) => {
        // Fusion triée : un message arrivé pendant la pagination ne disparaît pas.
        setMessages((previous) => {
          const next = mergeMessages(previous, older);
          cache.setMessages(id, next);
          return next;
        });
        setHasMore(older.length >= 30);
      })
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  }, [hasMore, loadingMore, messages, token, id]);

  /**
   * On recolle en bas quand un nouveau message arrive, et seulement si l'on y
   * était déjà. Se caler sur la taille du contenu dérèglait la liste dès qu'on
   * remontait dans l'historique.
   */
  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  /** Un tap sur la citation y fait sauter dans la discussion. */
  const jumpToMessage = useCallback(
    (messageId?: string) => {
      if (!messageId) {
        return;
      }
      const index = rows.findIndex(
        (row) =>
          (row.type === 'message' && row.message.id === messageId) ||
          (row.type === 'album' && row.messages.some((message) => message.id === messageId)),
      );
      if (index < 0) {
        setError('Le message cité est plus haut dans la discussion.');
        return;
      }
      setError(null);
      listRef.current?.scrollToIndex({ index, viewPosition: 0.35, animated: true });
    },
    [rows],
  );

  /** La pastille de retour : on recolle au dernier message, compteur effacé. */
  const jumpToBottom = useCallback(() => {
    unseenRef.current = 0;
    setUnseen(0);
    showJumpRef.current = false;
    setShowJump(false);
    atBottomRef.current = true;
    scrollToBottom();
  }, [scrollToBottom, setShowJump, setUnseen]);

  useEffect(() => {
    if (atBottomRef.current && rows.length > 0) {
      scrollToBottom();
    }
    // Déclenché par les rangées, jamais par la taille du contenu : remonter dans
    // l'historique ne doit pas vous ramener en bas.
  }, [rows, scrollToBottom]);

  /** Relance un message que le serveur a refusé (le réseau est revenu, etc.). */
  const resend = useCallback(
    (clientId: string) => {
      void retryOutbox(clientId).then(() => {
        if (token) {
          void drain(token);
        }
      });
    },
    [token],
  );

  /** Applique un résumé de réactions à un message (mémoire + cache disque). */
  const applyReactions = useCallback(
    (messageId: string, reactions: ReactionSummary[]) => {
      setMessages((previous) => {
        const next = previous.map((message) =>
          message.id === messageId ? { ...message, reactions } : message,
        );
        if (id) {
          cache.setMessages(id, next);
        }
        return next;
      });
    },
    [id],
  );

  /** Réaction optimiste : l'état bascule tout de suite, le serveur confirme. */
  const reactToMessage = useCallback(
    (message: Message, reaction: string) => {
      if (!token || !id) return;
      const previous = message.reactions ?? [];
      applyReactions(message.id, toggleLocalReaction(previous, reaction));
      void toggleReaction(token, id, message.id, reaction)
        .then((server) => applyReactions(message.id, server))
        .catch(() => applyReactions(message.id, previous));
    },
    [applyReactions, id, token],
  );

  /** Répondre : la bulle citée s'accroche au-dessus du champ de saisie. */
  const startReply = useCallback((message: Message) => {
    setMenuFor(null);
    setReplyTo(message);
  }, []);

  const copyMessage = useCallback(async (message: Message) => {
    setMenuFor(null);
    if (!(await copyToClipboard(message.content))) {
      setError('Copie indisponible dans cette version de l’application.');
    }
  }, []);

  /**
   * Retirer un message. « Pour tous » n'appartient qu'à l'auteur ; « pour moi »
   * marche aussi sur le message d'un autre et ne change que ma vue.
   */
  const removeMessage = useCallback(
    async (message: Message, forEveryone: boolean) => {
      setMenuFor(null);
      if (!token || !id) {
        return;
      }
      // Un message encore dans la file n'existe pas côté serveur : on le jette.
      if (queuedById.has(message.id)) {
        await discard(message.id);
        return;
      }
      try {
        await deleteMessage(token, id, message.id, forEveryone);
        if (!forEveryone) {
          setMessages((previous) => {
            const next = previous.filter((row) => row.id !== message.id);
            cache.setMessages(id, next);
            return next;
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Suppression impossible.');
      }
    },
    [token, id, queuedById],
  );

  /** Le menu d'appui long n'offre que ce qui a un sens pour cette bulle. */
  type StickerMenuTarget =
    | { kind: 'catalog'; key: string }
    | { kind: 'personal'; key: string }
    | { kind: 'received'; key: string; attachment: MessageAttachment; saved: boolean };

  const stickerMenuTarget = useMemo<StickerMenuTarget | null>(() => {
    const message = menuFor;
    if (!message) return null;
    if (message.type === 'sticker' && message.stickerRef && findSticker(message.stickerRef)) {
      return { kind: 'catalog', key: message.stickerRef };
    }
    const attachment = message.attachment;
    if (attachment?.type !== 'STICKER') return null;
    const mine = message.sender.id === user?.id;
    const local =
      mine && attachment.stickerId
        ? stickerLibrary.personal.find((sticker) => sticker.id === attachment.stickerId)
        : undefined;
    if (local) {
      return { kind: 'personal', key: local.id };
    }
    const key = receivedStickerId(receivedStickerSeed(attachment));
    return {
      kind: 'received',
      key,
      attachment,
      saved: stickerLibrary.personal.some((sticker) => sticker.id === key),
    };
  }, [menuFor, stickerLibrary.personal, user?.id]);

  const stickerIsFavorite = stickerMenuTarget
    ? stickerLibrary.favorites.includes(stickerMenuTarget.key)
    : false;

  const toggleStickerFromMenu = useCallback(async () => {
    const target = stickerMenuTarget;
    if (!target) return;
    setMenuFor(null);
    try {
      if (target.kind === 'received' && !target.saved) {
        await saveReceivedSticker({
          url: mediaUrl(target.attachment.url),
          name: target.attachment.stickerName ?? target.attachment.name,
          mime: target.attachment.mime,
          width: target.attachment.width,
          height: target.attachment.height,
          seed: receivedStickerSeed(target.attachment),
        });
        Alert.alert('Sticker ajouté aux favoris', 'Retrouve-le dans l’onglet Stickers.');
        return;
      }
      const added = await toggleStickerFavorite(target.key);
      if (added) {
        Alert.alert('Sticker ajouté aux favoris', 'Retrouve-le dans l’onglet Stickers.');
      }
    } catch (favoriteError) {
      Alert.alert(
        'Favoris indisponibles',
        favoriteError instanceof Error
          ? favoriteError.message
          : "Impossible d'enregistrer ce sticker.",
      );
    }
  }, [stickerMenuTarget]);

  const menuActions = useMemo<SheetAction[]>(() => {
    const message = menuFor;
    if (!message) {
      return [];
    }
    const waiting = queuedById.has(message.id);
    const actions: SheetAction[] = [];
    if (stickerMenuTarget) {
      actions.push({
        key: 'sticker-favorite',
        label: stickerIsFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris',
        icon: stickerIsFavorite ? StarOff : Star,
        onPress: () => void toggleStickerFromMenu(),
      });
    }
    if (!waiting && !message.deleted) {
      actions.push({
        key: 'reply',
        label: 'Répondre',
        icon: Reply,
        onPress: () => void startReply(message),
      });
    }
    if (message.content) {
      actions.push({
        key: 'copy',
        label: 'Copier',
        icon: Copy,
        onPress: () => void copyMessage(message),
      });
    }
    actions.push({
      key: 'delete-me',
      label: waiting ? 'Supprimer' : 'Supprimer pour moi',
      icon: Trash2,
      destructive: true,
      onPress: () => void removeMessage(message, false),
    });
    if (!waiting && !message.deleted && message.sender.id === user?.id) {
      actions.push({
        key: 'delete-all',
        label: 'Retirer pour tous',
        icon: Trash,
        destructive: true,
        onPress: () => void removeMessage(message, true),
      });
    }
    return actions;
  }, [
    menuFor,
    queuedById,
    user?.id,
    startReply,
    copyMessage,
    removeMessage,
    stickerMenuTarget,
    stickerIsFavorite,
    toggleStickerFromMenu,
  ]);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(PLAYED_VOICES_KEY)
      .then((raw) => {
        if (active && raw) {
          const stored = JSON.parse(raw) as string[];
          setPlayedVoiceIds((prev) => new Set([...stored, ...prev]));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        playedLoadedRef.current = true;
      });
    return () => {
      active = false;
    };
  }, []);

  const handleFirstVoicePlay = useCallback((messageId: string) => {
    setPlayedVoiceIds((prev) => {
      if (prev.has(messageId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(messageId);
      if (playedLoadedRef.current) {
        void AsyncStorage.setItem(PLAYED_VOICES_KEY, JSON.stringify([...next])).catch(() => undefined);
      }
      return next;
    });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: ListRow }) => {
      if (item.type === 'date') {
        return (
          <View style={styles.dateRow}>
            <ThemedView style={[styles.datePill, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" style={[styles.dateText, chatStyles.dateText]}>
                {item.label}
              </ThemedText>
            </ThemedView>
          </View>
        );
      }
      if (item.type === 'time') {
        return (
          <View style={styles.timeRow}>
            <ThemedText style={[styles.timeText, chatStyles.secondaryText]}>{item.label}</ThemedText>
          </View>
        );
      }
      if (item.type === 'unread') {
        return (
          <View style={styles.unreadRow}>
            <View style={[styles.unreadLine, chatStyles.unreadLine]} />
            <ThemedText style={[styles.unreadText, chatStyles.unreadText]}>
              {item.count} {item.count > 1 ? 'nouveaux messages' : 'nouveau message'}
            </ThemedText>
            <View style={[styles.unreadLine, chatStyles.unreadLine]} />
          </View>
        );
      }
      if (item.type === 'album') {
        const group = item.messages;
        const first = group[0];
        const mine = first.sender.id === user?.id;
        const tick = mine ? aggregateTick(group.map((message) => tickById[message.id])) : undefined;
        const sentTick =
          tick === 'sent' || tick === 'delivered' || tick === 'read' ? tick : undefined;
        const avatarName = mine
          ? (user?.displayName ?? 'Moi')
          : first.sender.displayName;
        const avatar = (
          <Avatar
            name={avatarName}
            uri={mine ? user?.avatarUrl : first.sender.avatarUrl}
            size={40}
            gender={mine ? user?.gender : first.sender.gender}
            style={styles.messageAvatar}
          />
        );
        const albumWidth = albumGridWidth(windowWidth);
        return (
          <View style={styles.messageRow}>
            {mine ? null : avatar}
            <View style={styles.bubbleColumn}>
              <SwipeableBubble
                mine={mine}
                onReply={() => startReply(first)}
                onLongPress={() => setMenuFor(first)}
                style={bubbleMaxWidth}
                accessibilityLabel={`Album de ${group.length} photos ou vidéos`}>
                <View
                  style={[
                    styles.mediaBlock,
                    mine ? styles.mediaBlockMine : styles.mediaBlockOther,
                    { width: albumWidth },
                  ]}>
                  {!mine && isGroup && !item.continuation ? (
                    <ThemedText
                      type="smallBold"
                      style={[styles.senderName, chatStyles.senderName]}>
                      {first.sender.displayName}
                    </ThemedText>
                  ) : null}
                  <AlbumMessageBubble
                    messages={group}
                    queuedById={queuedById}
                    width={albumWidth}
                    onOpen={openAlbum}
                    onLongPress={setMenuFor}
                    onRetry={resend}
                  />
                  {sentTick ? (
                    <View style={styles.mediaTicks}>
                      <Ticks state={sentTick} tone={chat.tick} failedTone={chat.error} />
                    </View>
                  ) : null}
                </View>
              </SwipeableBubble>
            </View>
            {mine ? avatar : null}
          </View>
        );
      }
      const { message } = item;
      if (message.type === 'call') {
        return (
          <View style={styles.callRow}>
            <Phone size={13} strokeWidth={2.4} color={chat.systemText} />
            <ThemedText style={[styles.systemText, chatStyles.systemText]}>
              {message.content}
            </ThemedText>
          </View>
        );
      }
      if (message.type === 'system') {
        return (
          <View style={styles.systemRow}>
            <ThemedText
              type="caption"
              style={[styles.systemText, chatStyles.systemText]}
              accessibilityRole="text">
              {message.content}
            </ThemedText>
          </View>
        );
      }
      if (message.deleted) {
        return (
          <View style={styles.systemRow}>
            <ThemedText style={[styles.systemText, chatStyles.systemText]}>
              Message supprimé
            </ThemedText>
          </View>
        );
      }
      const mine = message.sender.id === user?.id;
      const readByCount =
        mine && isGroup
          ? (receipts[message.id] ?? []).filter(
              (receipt) => receipt.userId !== user?.id && receipt.readAt !== null,
            ).length
          : 0;
      const attachment = message.attachment;
      const tick = mine ? tickById[message.id] : undefined;
      const stuck = tick === 'failed' ? queuedById.get(message.id) : undefined;
      const waiting = tick === 'pending';
      const avatarName = mine
        ? (user?.displayName ?? 'Moi')
        : message.sender.displayName;
      const avatar = (
        <Avatar
          name={avatarName}
          uri={mine ? user?.avatarUrl : message.sender.avatarUrl}
          size={40}
          gender={mine ? user?.gender : message.sender.gender}
          style={styles.messageAvatar}
        />
      );
      const row = (content: ReactNode) => (
        <View style={styles.messageRow}>
          {mine || item.continuation ? null : avatar}
          <View style={styles.bubbleColumn}>
            {content}
            <ReactionChips
              reactions={message.reactions ?? []}
              alignEnd={mine}
              onToggle={(reaction) => reactToMessage(message, reaction)}
            />
            {mine && isGroup && readByCount > 0 ? (
              <Pressable
                onPress={() => setSeenFor(message)}
                accessibilityRole="button"
                accessibilityLabel={`Vu par ${readByCount}`}
                style={styles.seenByRow}>
                <ThemedText type="micro" themeColor="textSecondary">
                  Vu par {readByCount}
                </ThemedText>
              </Pressable>
            ) : null}
          </View>
          {mine && !item.continuation ? avatar : null}
        </View>
      );

      if (message.type === 'sticker') {
        return row(
          <SwipeableBubble
            mine={mine}
            onReply={() => startReply(message)}
            onLongPress={() => setMenuFor(message)}
            style={bubbleMaxWidth}
            accessibilityLabel={stuck ? 'Renvoyer ce message' : 'Options du message'}>
            <View
              style={[
                styles.stickerMessageBlock,
                mine ? styles.stickerMessageBlockMine : null,
              ]}>
              {!mine && isGroup && !item.continuation ? (
                <ThemedText type="smallBold" style={[styles.senderName, chatStyles.senderName]}>
                  {message.sender.displayName}
                </ThemedText>
              ) : null}
              {message.replyTo ? (
                <View style={styles.stickerReplyQuote}>
                  <QuoteBlock
                    quote={message.replyTo}
                    mine={mine}
                    onPress={() => jumpToMessage(message.replyTo?.id)}
                  />
                </View>
              ) : null}
              <View style={{ opacity: waiting ? 0.55 : 1 }}>
                <StickerMessage stickerRef={message.stickerRef ?? ''} size={140} />
              </View>
              {mine && tick && !waiting ? (
                <View style={styles.mediaTicks}>
                  <Ticks state={tick} tone={chat.tick} failedTone={chat.error} />
                </View>
              ) : null}
              {stuck ? (
                <View style={[styles.mediaFailed, mine ? styles.mediaFailedMine : null]}>
                  <ThemedText style={[styles.failedHint, chatStyles.failed]} numberOfLines={2}>
                    {stuck.error ?? "Le message n'est pas parti."}
                  </ThemedText>
                  <View style={styles.mediaFailedActions}>
                    <Pressable
                      onPress={() => void resend(stuck.clientId)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Réessayer l'envoi">
                      <ThemedText style={[styles.failedHint, chatStyles.failed]}>
                        Réessayer
                      </ThemedText>
                    </Pressable>
                    <Pressable
                      onPress={() => void discard(stuck.clientId)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Supprimer ce sticker">
                      <ThemedText style={[styles.failedHint, chatStyles.secondaryText]}>
                        Supprimer
                      </ThemedText>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          </SwipeableBubble>,
        );
      }

      if (!attachment) {
        const trimmed = message.content.trim();
        const emojiCount = emojiOnlyCount(trimmed);
        if (emojiCount >= 1 && emojiCount <= 3) {
          const emojiSegment =
            emojiCount === 1
              ? splitEmoji(trimmed).find(
                  (segment): segment is EmojiSegment => segment.type === 'emoji',
                )
              : undefined;
          const createdAtMs = new Date(message.createdAt).getTime();
          const fresh =
            waiting || queuedById.has(message.id) || Date.now() - createdAtMs < 15_000;
          return row(
            <SwipeableBubble
              mine={mine}
              onReply={() => startReply(message)}
              onPress={stuck ? () => resend(stuck.clientId) : undefined}
              onLongPress={() => setMenuFor(message)}
              style={bubbleMaxWidth}
              accessibilityLabel={stuck ? 'Renvoyer ce message' : 'Options du message'}>
              <View
                style={[
                  styles.emojiOnlyBlock,
                  mine ? styles.emojiOnlyBlockMine : null,
                ]}>
                {!mine && isGroup && !item.continuation ? (
                  <ThemedText type="smallBold" style={[styles.senderName, chatStyles.senderName]}>
                    {message.sender.displayName}
                  </ThemedText>
                ) : null}
                {message.replyTo ? (
                  <View style={styles.emojiOnlyQuote}>
                    <QuoteBlock
                      quote={message.replyTo}
                      mine={mine}
                      onPress={() => jumpToMessage(message.replyTo?.id)}
                    />
                  </View>
                ) : null}
                {emojiCount === 1 && emojiSegment ? (
                  <SingleEmojiMessage
                    emoji={emojiSegment.value}
                    messageId={message.clientId ?? message.id}
                    fresh={fresh}
                  />
                ) : (
                  <MessageText
                    text={trimmed}
                    style={[styles.emojiOnlyText, chatStyles.messageText]}
                  />
                )}
                <View
                  style={[
                    styles.emojiOnlyMeta,
                    mine ? styles.emojiOnlyMetaMine : null,
                  ]}>
                  <ThemedText style={[styles.emojiOnlyTime, chatStyles.secondaryText]}>
                    {formatClock(message.createdAt)}
                  </ThemedText>
                  {mine && tick ? (
                    <Ticks state={tick} tone={chat.tick} failedTone={chat.error} />
                  ) : null}
                </View>
                {stuck ? (
                  <View
                    style={[
                      styles.emojiOnlyFailed,
                      mine ? styles.emojiOnlyFailedMine : null,
                    ]}>
                    <ThemedText
                      style={[styles.failedHint, chatStyles.failed]}
                      numberOfLines={2}>
                      {stuck.error ?? "Le message n'est pas parti."}
                    </ThemedText>
                    <View style={styles.mediaFailedActions}>
                      <Pressable
                        onPress={() => void resend(stuck.clientId)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel="Réessayer l'envoi">
                        <ThemedText style={[styles.failedHint, chatStyles.failed]}>
                          Réessayer
                        </ThemedText>
                      </Pressable>
                      <Pressable
                        onPress={() => void discard(stuck.clientId)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel="Supprimer ce message">
                        <ThemedText style={[styles.failedHint, chatStyles.secondaryText]}>
                          Supprimer
                        </ThemedText>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </View>
            </SwipeableBubble>,
          );
        }
      }

      if (attachment?.type === 'AUDIO') {
        const waveform =
          (message.clientId ? voiceWaveforms[message.clientId] : undefined) ??
          voiceWaveforms[attachment.url];
        const unplayed = !mine && !playedVoiceIds.has(message.id);
        const width = voiceBubbleWidth(attachment.duration ?? 0, windowWidth) + (unplayed ? 14 : 0);
        return row(
          <SwipeableBubble
            mine={mine}
            onReply={() => startReply(message)}
            onLongPress={() => setMenuFor(message)}
            style={bubbleMaxWidth}
            accessibilityLabel={stuck ? 'Renvoyer ce message' : 'Options du message'}>
            <View
              style={[
                styles.voiceBlock,
                mine ? styles.voiceBlockMine : styles.voiceBlockOther,
                { width },
              ]}>
              {message.replyTo ? (
                <View
                  style={[
                    styles.voiceQuote,
                    mine ? chatStyles.bubbleMine : chatStyles.bubbleTheirs,
                  ]}>
                  <QuoteBlock
                    quote={message.replyTo}
                    mine={mine}
                    onPress={() => jumpToMessage(message.replyTo?.id)}
                  />
                </View>
              ) : null}
              {!mine && isGroup && !item.continuation ? (
                <ThemedText type="smallBold" style={[styles.senderName, chatStyles.senderName]}>
                  {message.sender.displayName}
                </ThemedText>
              ) : null}
              <VoiceMessageBubble
                id={message.id}
                uri={mediaUrl(attachment.url)}
                durationMs={attachment.duration ?? 0}
                waveform={waveform}
                isMine={mine}
                unplayed={unplayed}
                onFirstPlay={handleFirstVoicePlay}
                accentColor={chat.mineBubble}
                receivedColor={chat.theirBubble}
                foregroundColor={chat.primaryText}
                barOffColor={chat.voiceBarOff}
                barOnColor={chat.voiceBarOn}
              />
              {mine && tick ? (
                <View style={styles.voiceMeta}>
                  <Ticks state={tick} tone={chat.tick} failedTone={chat.error} />
                </View>
              ) : null}
              {stuck ? (
                <Pressable
                  onPress={() => void resend(stuck.clientId)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Réessayer l'envoi du message vocal">
                  <ThemedText style={[styles.failedHint, chatStyles.failed]}>
                    {stuck.error ?? "Le message n'est pas parti."} · Réessayer
                  </ThemedText>
                </Pressable>
              ) : null}
            </View>
          </SwipeableBubble>,
        );
      }

      if (attachment?.type === 'STICKER') {
        const stickerUri = mediaUrl(attachment.url);
        return row(
          <SwipeableBubble
            mine={mine}
            onReply={() => startReply(message)}
            onLongPress={() => setMenuFor(message)}
            style={bubbleMaxWidth}
            accessibilityLabel={stuck ? 'Renvoyer ce message' : 'Options du message'}>
            <View
              style={[
                styles.stickerBlock,
                mine ? styles.mediaBlockMine : styles.mediaBlockOther,
              ]}>
              {!mine && isGroup && !item.continuation ? (
                <ThemedText type="smallBold" style={[styles.senderName, chatStyles.senderName]}>
                  {message.sender.displayName}
                </ThemedText>
              ) : null}
              {message.replyTo ? (
                <View
                  style={[
                    styles.stickerQuote,
                    mine ? chatStyles.bubbleMine : chatStyles.bubbleTheirs,
                  ]}>
                  <QuoteBlock
                    quote={message.replyTo}
                    mine={mine}
                    onPress={() => jumpToMessage(message.replyTo?.id)}
                  />
                </View>
              ) : null}
              <StickerMessageBubble
                uri={stickerUri}
                name={attachment.stickerName ?? attachment.name}
                width={attachment.width}
                height={attachment.height}
                sending={waiting}
                failed={!!stuck}
                onRetry={stuck ? () => void resend(stuck.clientId) : undefined}
                onPress={() => openImage(stickerUri)}
                onLongPress={() => setMenuFor(message)}
              />
              {mine && tick && !waiting ? (
                <View style={styles.mediaTicks}>
                  <Ticks state={tick} tone={chat.tick} failedTone={chat.error} />
                </View>
              ) : null}
              {stuck ? (
                <View style={[styles.mediaFailed, mine ? styles.mediaFailedMine : null]}>
                  <ThemedText style={[styles.failedHint, chatStyles.failed]} numberOfLines={3}>
                    {stuck.error ?? "Le message n'est pas parti."}
                  </ThemedText>
                  <View style={styles.mediaFailedActions}>
                    <Pressable
                      onPress={() => void resend(stuck.clientId)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Réessayer l'envoi">
                      <ThemedText style={[styles.failedHint, chatStyles.failed]}>
                        Réessayer
                      </ThemedText>
                    </Pressable>
                    <Pressable
                      onPress={() => void discard(stuck.clientId)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Supprimer ce sticker">
                      <ThemedText style={[styles.failedHint, chatStyles.secondaryText]}>
                        Supprimer
                      </ThemedText>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          </SwipeableBubble>,
        );
      }

      if (attachment) {
        const mediaUri = mediaUrl(attachment.url);
        const queuedItem = queuedById.get(message.id);
        const progress = queuedItem?.progress ?? null;
        const uploadedBytes = queuedItem?.uploadedBytes ?? null;
        const totalBytes = queuedItem?.totalBytes ?? null;
        // Tant que le serveur ne nous a pas donné d'octets, la progression est
        // réellement inconnue (le repli fetch ne sait pas la mesurer).
        const knownProgress = uploadedBytes !== null && uploadedBytes !== undefined;
        const display =
          attachment.type === 'FILE'
            ? null
            : attachment.type === 'GIF'
              ? gifDisplaySize(attachment, windowWidth)
              : mediaDisplaySize(attachment, windowWidth);
        const blockWidth =
          attachment.type === 'FILE'
            ? documentCardWidth(windowWidth)
            : (display?.width ?? Math.round(windowWidth * 0.6));
        const foreground = mine ? chat.mineText : chat.theirText;

        return row(
          <SwipeableBubble
            mine={mine}
            onReply={() => startReply(message)}
            onLongPress={() => setMenuFor(message)}
            style={bubbleMaxWidth}
            accessibilityLabel={stuck ? 'Renvoyer ce message' : 'Options du message'}>
            <View
              style={[
                styles.mediaBlock,
                mine ? styles.mediaBlockMine : styles.mediaBlockOther,
                { width: blockWidth },
              ]}>
              {!mine && isGroup && !item.continuation ? (
                <ThemedText
                  type="smallBold"
                  style={[styles.senderName, chatStyles.senderName]}>
                  {message.sender.displayName}
                </ThemedText>
              ) : null}
              {message.replyTo ? (
                <View
                  style={[
                    styles.mediaQuote,
                    mine ? chatStyles.bubbleMine : chatStyles.bubbleTheirs,
                  ]}>
                  <QuoteBlock
                    quote={message.replyTo}
                    mine={mine}
                    onPress={() => jumpToMessage(message.replyTo?.id)}
                  />
                </View>
              ) : null}
              {attachment.type === 'IMAGE' && display ? (
                <ImageMessageBubble
                  uri={mediaUri}
                  width={display.width}
                  height={display.height}
                  sending={waiting}
                  progress={knownProgress ? progress : null}
                  failed={!!stuck}
                  onRetry={stuck ? () => void resend(stuck.clientId) : undefined}
                  onPress={() => openImage(mediaUri)}
                  onLongPress={() => setMenuFor(message)}
                />
              ) : attachment.type === 'VIDEO' && display ? (
                <VideoMessageBubble
                  uri={mediaUri}
                  width={display.width}
                  height={display.height}
                  durationMs={attachment.duration}
                  sending={waiting}
                  progress={knownProgress ? progress : null}
                  failed={!!stuck}
                  onRetry={stuck ? () => void resend(stuck.clientId) : undefined}
                  onPress={() => setVideoViewer(mediaUri)}
                  onLongPress={() => setMenuFor(message)}
                />
              ) : attachment.type === 'GIF' && display ? (
                <GifMessageBubble
                  uri={mediaUri}
                  stillUri={attachment.stillUrl}
                  sticker={attachment.sticker === true}
                  width={display.width}
                  height={display.height}
                  sending={waiting}
                  failed={!!stuck}
                  onRetry={stuck ? () => void resend(stuck.clientId) : undefined}
                  onPress={() => openImage(mediaUri)}
                  onLongPress={() => setMenuFor(message)}
                />
              ) : (
                <DocumentMessageBubble
                  name={attachment.name ?? 'fichier'}
                  mime={attachment.mime}
                  size={attachment.size > 0 ? attachment.size : null}
                  width={blockWidth}
                  mine={mine}
                  sending={waiting}
                  progress={knownProgress ? progress : null}
                  uploadedBytes={uploadedBytes}
                  totalBytes={totalBytes}
                  failed={!!stuck}
                  onRetry={stuck ? () => void resend(stuck.clientId) : undefined}
                  onOpen={() => openDocument(attachment)}
                  onLongPress={() => setMenuFor(message)}
                />
              )}
              {message.content ? (
                <View
                  style={[
                    styles.mediaCaption,
                    mine ? chatStyles.bubbleMine : chatStyles.bubbleTheirs,
                  ]}>
                  <EmojiText style={[styles.mediaCaptionText, { color: foreground }]}>
                    {message.content}
                  </EmojiText>
                </View>
              ) : null}
              {mine && tick && !waiting ? (
                <View style={styles.mediaTicks}>
                  <Ticks state={tick} tone={chat.tick} failedTone={chat.error} />
                </View>
              ) : null}
              {stuck ? (
                <View style={[styles.mediaFailed, mine ? styles.mediaFailedMine : null]}>
                  <ThemedText
                    style={[styles.failedHint, chatStyles.failed]}
                    numberOfLines={3}>
                    {stuck.error ?? "Le message n'est pas parti."}
                  </ThemedText>
                  <View style={styles.mediaFailedActions}>
                    <Pressable
                      onPress={() => void resend(stuck.clientId)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Réessayer l'envoi">
                      <ThemedText style={[styles.failedHint, chatStyles.failed]}>
                        Réessayer
                      </ThemedText>
                    </Pressable>
                    <Pressable
                      onPress={() => void discard(stuck.clientId)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Supprimer ce fichier">
                      <ThemedText style={[styles.failedHint, chatStyles.secondaryText]}>
                        Supprimer
                      </ThemedText>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          </SwipeableBubble>,
        );
      }

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
          {message.replyTo ? (
            <QuoteBlock
              quote={message.replyTo}
              mine={mine}
              onPress={() => jumpToMessage(message.replyTo?.id)}
            />
          ) : null}
          {!mine && isGroup && !item.continuation ? (
            <ThemedText type="smallBold" style={[styles.senderName, chatStyles.senderName]}>
              {message.sender.displayName}
            </ThemedText>
          ) : null}
          {message.content ? (
            <MessageText
              text={message.content}
              style={[styles.messageText, chatStyles.messageText]}
            />
          ) : null}
          {mine && tick ? (
            <View style={styles.ticksRow}>
              <Ticks state={tick} tone={chat.tick} failedTone={chat.error} />
            </View>
          ) : null}
          {stuck ? (
            <ThemedText style={[styles.failedHint, chatStyles.failed]} numberOfLines={2}>
              {stuck.error ?? "Le message n'est pas parti."} · retenter
            </ThemedText>
          ) : null}
        </View>
      );
      return row(
        <SwipeableBubble
          mine={mine}
          onReply={() => startReply(message)}
          onPress={stuck ? () => resend(stuck.clientId) : undefined}
          onLongPress={() => setMenuFor(message)}
          style={bubbleMaxWidth}
          accessibilityLabel={stuck ? 'Renvoyer ce message' : 'Options du message'}>
          {bubble}
        </SwipeableBubble>,
      );
    },
    [
      user,
      theme,
      isGroup,
      tickById,
      receipts,
      queuedById,
      resend,
      startReply,
      jumpToMessage,
      reactToMessage,
      voiceWaveforms,
      playedVoiceIds,
      handleFirstVoicePlay,
      openImage,
      openAlbum,
      openDocument,
      chat,
      chatStyles,
      bubbleMaxWidth,
      windowWidth,
    ],
  );

  const showRejected = useCallback((rejected: RejectedMedia[]) => {
    if (rejected.length === 0) {
      return;
    }
    const lines = rejected.map((item) => `${item.name} — ${item.reason}`);
    Alert.alert(
      rejected.length === 1 ? 'Fichier ignoré' : 'Fichiers ignorés',
      lines.join('\n'),
    );
  }, []);

  const reportPickerError = useCallback((title: string, message: string) => {
    Alert.alert(title, message, [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Ouvrir les réglages', onPress: () => void Linking.openSettings() },
    ]);
  }, []);

  /**
   * Chaque fichier apparaît aussitôt et part par la file : il survivra à une
   * coupure, voire à la fermeture de l'app, et s'importera au premier retour du
   * réseau. L'ordre d'enqueue est celui de la sélection.
   */
  const queueAttachments = useCallback(
    async (files: PickedAttachment[]) => {
      if (!token || !id || files.length === 0) {
        return;
      }
      setError(null);
      // Le texte déjà saisi devient la légende du premier fichier ; les
      // suivants partent sans légende, dans l'ordre de sélection.
      const caption = input.trim();
      for (const [index, file] of files.entries()) {
        await enqueue({
          conversationId: id,
          content: index === 0 ? caption : '',
          attachment: {
            localUri: file.uri,
            kind: file.kind,
            mime: file.mime,
            width: file.width,
            height: file.height,
            durationMs: file.durationMs,
            name: file.name,
            size: file.size,
          },
        });
      }
      resetComposer();
      void drain(token);
    },
    [token, id, input, resetComposer],
  );

  const pickLibrary = useCallback(async () => {
    try {
      const picked = await pickLibraryMedia();
      if (!picked) {
        return;
      }
      showRejected(picked.rejected);
      await queueAttachments(picked.files);
    } catch (pickerError) {
      const detail =
        pickerError instanceof Error && pickerError.message
          ? pickerError.message
          : "Impossible d'ouvrir la galerie.";
      reportPickerError(
        'Galerie indisponible',
        `${detail}\n\nSi l'accès aux photos est refusé, autorise-le dans les réglages.`,
      );
    }
  }, [queueAttachments, reportPickerError, showRejected]);

  const pickCamera = useCallback(async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        reportPickerError(
          'Appareil photo non autorisé',
          "Autorise l'appareil photo dans les réglages pour prendre une photo.",
        );
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (result.canceled || !result.assets[0]) {
        return;
      }
      const normalized = normalizeImageAsset(result.assets[0]);
      if (isRejectedMedia(normalized)) {
        showRejected([normalized]);
        return;
      }
      await queueAttachments([normalized]);
    } catch {
      reportPickerError('Appareil photo indisponible', "Impossible d'ouvrir l'appareil photo.");
    }
  }, [queueAttachments, reportPickerError, showRejected]);

  const pickFileDocuments = useCallback(async () => {
    try {
      const picked = await pickDocuments();
      if (!picked) {
        return;
      }
      showRejected(picked.rejected);
      await queueAttachments(picked.files);
    } catch {
      reportPickerError('Fichiers indisponibles', 'Impossible de sélectionner des fichiers.');
    }
  }, [queueAttachments, reportPickerError, showRejected]);

  /**
   * Le vocal part par la même file qu'une photo : il survit à une coupure et
   * repart dès le retour du réseau. La waveform n'est pas stockée par l'API :
   * elle reste locale à cette session, avec une forme de secours à l'affichage.
   */
  const sendVoiceMessage = useCallback(
    async (note: VoiceNote) => {
      if (!token || !id) {
        return;
      }
      setError(null);
      setVoiceWaveforms((prev) => ({ ...prev, [note.uri]: note.waveform }));
      const item = await enqueue({
        conversationId: id,
        content: '',
        attachment: {
          localUri: note.uri,
          mime: note.mimeType,
          durationMs: note.durationMs,
          kind: 'audio',
        },
      });
      setVoiceWaveforms((prev) => ({ ...prev, [item.clientId]: note.waveform }));
      void drain(token);
    },
    [token, id],
  );

  const handleVoicePermissionDenied = useCallback(() => {
    Alert.alert(
      'Micro non autorisé',
      'Autorise le micro dans les réglages pour envoyer un message vocal.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Ouvrir les réglages', onPress: () => void Linking.openSettings() },
      ],
    );
  }, []);

  const handleVoiceError = useCallback((error: unknown) => {
    setError(error instanceof Error ? error.message : "Impossible d'enregistrer le message vocal.");
  }, []);

  /**
   * Le texte quitte le champ immédiatement et passe par la file : la bulle
   * horloge reste visible tant que le serveur n'a pas confirmé, et le message
   * repart tout seul dès que la connexion revient.
   */
  const sendText = useCallback(
    async (text: string) => {
      if (!token || !id) {
        return;
      }
      const content = text.trim();
      if (!content) {
        return;
      }
      setError(null);
      await enqueue({ conversationId: id, content, replyTo: replyTo?.id ?? null });
      cache.clearDraft(id);
      setDraft('');
      setReplyTo(null);
      void drain(token);
    },
    [token, id, replyTo],
  );

  /** Un sticker ne transporte qu'une référence de catalogue, jamais un fichier. */
  const sendSticker = useCallback(
    async (ref: string) => {
      if (!token || !id) {
        return;
      }
      const now = Date.now();
      if (now - lastStickerSendAt.current < 600) {
        return;
      }
      lastStickerSendAt.current = now;
      setError(null);
      await enqueue({
        conversationId: id,
        content: '',
        replyTo: replyTo?.id ?? null,
        type: 'sticker',
        stickerRef: ref,
      });
      setReplyTo(null);
      void drain(token);
    },
    [token, id, replyTo],
  );

  /**
   * Un sticker personnel est une image locale : elle passe par la file
   * d'envoi existante puis le serveur la requalifie en pièce jointe STICKER.
   */
  const sendPersonalSticker = useCallback(
    async (sticker: PersonalSticker) => {
      if (!token || !id) return;
      const now = Date.now();
      if (now - lastStickerSendAt.current < 600) return;
      lastStickerSendAt.current = now;
      setError(null);
      await enqueue({
        conversationId: id,
        content: '',
        replyTo: replyTo?.id ?? null,
        attachment: {
          localUri: sticker.uri,
          kind: 'sticker',
          mime: sticker.mime,
          width: sticker.width,
          height: sticker.height,
          name: sticker.name,
          size: sticker.size ?? null,
          external: {
            id: sticker.id,
            packId: PERSONAL_PACK_ID,
            name: sticker.name,
            width: sticker.width,
            height: sticker.height,
          },
        },
      });
      setReplyTo(null);
      void drain(token);
    },
    [token, id, replyTo],
  );

  /** Réutilise un GIF GIPHY déjà présent dans la conversation. */
  const sendGif = useCallback(
    async (gif: RecentGif) => {
      if (!token || !id) return;
      setError(null);
      await enqueue({
        conversationId: id,
        content: '',
        replyTo: replyTo?.id ?? null,
        attachment: {
          kind: 'gif',
          mime: gif.sticker ? 'image/webp' : 'image/gif',
          width: gif.width,
          height: gif.height,
          external: {
            url: gif.url,
            width: gif.width,
            height: gif.height,
            sticker: gif.sticker,
            giphyId: gif.giphyId,
            username: gif.username,
            title: gif.title,
            stillUrl: gif.stillUrl,
          },
        },
      });
      setReplyTo(null);
      void drain(token);
    },
    [token, id, replyTo],
  );

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  return (
    <ThemedView
      style={[
        styles.container,
        chatStyles.screen,
        // Android (edge-to-edge) : la fenêtre n'est pas redimensionnée, on pousse
        // donc nous-mêmes le contenu au-dessus du clavier.
        keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : null,
      ]}>
      <Stack.Screen options={headerOptions} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        onLayout={(event) => setChatAreaHeight(event.nativeEvent.layout.height)}
        style={styles.flex}>
        <FlatList
          ref={listRef}
          data={rows}
          inverted
          keyExtractor={keyExtractor}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.3}
          contentContainerStyle={styles.listContent}
          onScroll={event => {
            // Liste inversée : offset 0 = le dernier message. On n'y recolle un
            // nouvel arrivant que si l'utilisateur y était déjà.
            const offset = event.nativeEvent.contentOffset.y;
            atBottomRef.current = offset <= 32;
            // Ce callback tourne à chaque frame : on n'agit qu'aux changements d'état.
            const shouldShow = !atBottomRef.current && offset > JUMP_AFTER_PX;
            if (shouldShow !== showJumpRef.current) {
              showJumpRef.current = shouldShow;
              setShowJump(shouldShow);
            }
            if (atBottomRef.current && unseenRef.current > 0) {
              unseenRef.current = 0;
              setUnseen(0);
            }
          }}
          scrollEventThrottle={160}
          renderItem={renderItem}
        />

        {ready && messages.length === 0 ? (
          <View
            pointerEvents="box-none"
            style={[styles.emptyOverlay, { bottom: (composerHeight || 92) + Spacing.two }]}>
            <Avatar
              name={title}
              uri={isGroup ? conversation?.avatarUrl : other?.avatarUrl}
              emoji={isGroup ? conversation?.emoji : null}
              color={isGroup ? conversation?.color : null}
              variant={isGroup ? 'group' : 'user'}
              gender={isGroup ? null : other?.gender}
              size={72}
            />
            <ThemedText type="sectionTitle" style={styles.emptyTitle}>
              {isGroup ? 'Dis bonjour à ton nouveau groupe' : 'Dis bonjour !'}
            </ThemedText>
            <ThemedText type="caption" themeColor="textSecondary" style={styles.emptyText}>
              {isGroup
                ? 'Un petit message pour lancer la discussion.'
                : 'Écris le premier message.'}
            </ThemedText>
            <View style={styles.suggestions}>
              {(isGroup
                ? ['Salut tout le monde 👋', 'Bienvenue dans le groupe 🎉', 'On commence ?']
                : ['Salut 👋', 'Comment ça va ?']
              ).map((suggestion) => (
                <Pressable
                  key={suggestion}
                  onPress={() => {
                    void sendText(suggestion);
                    resetComposer();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Envoyer « ${suggestion} »`}
                  style={({ pressed }) => [
                    styles.suggestion,
                    {
                      backgroundColor: theme.backgroundElement,
                      borderColor: theme.border,
                    },
                    pressed && { opacity: 0.7 },
                  ]}>
                  <ThemedText type="caption">{suggestion}</ThemedText>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {showJump ? (
          <Pressable
            onPress={jumpToBottom}
            accessibilityRole="button"
            accessibilityLabel="Retourner aux derniers messages"
            style={[
              styles.jump,
              {
                backgroundColor: theme.backgroundElement,
                // Au-dessus du compositeur (et des panneaux emoji/+ éventuels).
                bottom: (composerHeight || 92) + Spacing.two,
              },
            ]}>
            {unseen > 0 ? (
              <View style={styles.jumpBadge}>
                <ThemedText style={styles.jumpBadgeText}>
                  {unseen > 99 ? '99+' : unseen}
                </ThemedText>
              </View>
            ) : null}
            <ChevronDown size={26} color={accentColor} />
          </Pressable>
        ) : null}

        {offline ? (
          <ThemedText type="small" style={styles.offline}>
            Hors ligne — les messages partiront au retour du réseau
          </ThemedText>
        ) : null}

        {error ? (
          <ThemedText type="small" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}

        {typing ? (
          <TypingLine
            key={typing.userId}
            name={
              conversation?.members.find((member) => member.id === typing.userId)?.displayName ??
              'Quelqu’un'
            }
            text={typing.text}
          />
        ) : null}

        {replyTo ? (
          <View
            onLayout={(event) => setReplyBarHeight(event.nativeEvent.layout.height)}
            style={[styles.replyBar, chatStyles.replyBar]}>
            <View style={styles.replyBarBody}>
              <QuoteBlock quote={quoteOfMessage(replyTo)} mine={false} />
            </View>
            <Pressable
              onPress={() => setReplyTo(null)}
              hitSlop={8}
              style={styles.replyClose}
              accessibilityRole="button"
              accessibilityLabel="Annuler la réponse">
              <X size={20} color={accentColor} />
            </Pressable>
          </View>
        ) : null}

        <View onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}>
        {conversation?.type === 'DIRECT' && conversation.blockedByThem ? (
          <View
            style={[
              styles.blockedBar,
              {
                backgroundColor: chat.composer,
                borderTopColor: chat.border,
                // Au-dessus de la barre de navigation système (gestes/boutons).
                paddingBottom: Spacing.four + insets.bottom,
              },
            ]}>
            <ThemedText type="small" themeColor="textSecondary" style={styles.blockedText}>
              Vous ne pouvez plus discuter avec cette personne.
            </ThemedText>
          </View>
        ) : conversation?.type === 'GROUP' &&
          conversation.whoCanSend === 'admins' &&
          conversation.myRole !== 'admin' ? (
          <View
            style={[
              styles.blockedBar,
              {
                backgroundColor: chat.composer,
                borderTopColor: chat.border,
                paddingBottom: Spacing.four + insets.bottom,
              },
            ]}>
            <ThemedText type="small" themeColor="textSecondary" style={styles.blockedText}>
              Seuls les administrateurs peuvent écrire dans ce groupe.
            </ThemedText>
          </View>
        ) : (
        <ChatComposer
          key={composerKey}
          theme={composerTheme}
          initialText={draft}
          mentionCandidates={
            isGroup && conversation
              ? conversation.members
                  .filter((member) => member.id !== user?.id)
                  .map((member) => ({
                    id: member.id,
                    username: member.username,
                    displayName: member.displayName,
                  }))
              : undefined
          }
          onSendText={sendText}
          onSendSticker={(ref) => void sendSticker(ref)}
          onSendPersonalSticker={(sticker) => void sendPersonalSticker(sticker)}
          recentGifs={recentGifs}
          onSendGif={(gif) => void sendGif(gif)}
          onTextChange={onInputChange}
          bottomInset={insets.bottom}
          availableHeight={
            chatAreaHeight > 0
              ? Math.max(0, chatAreaHeight - (replyTo ? replyBarHeight : 0))
              : undefined
          }
          onSendVoice={sendVoiceMessage}
          onVoicePermissionDenied={handleVoicePermissionDenied}
          onVoiceError={handleVoiceError}
          plusPanel={
            <AttachPanel
              onPhotos={() => void pickLibrary()}
              onCamera={() => void pickCamera()}
              onDocuments={() => void pickFileDocuments()}
            />
          }
        />
        )}
        </View>
      </KeyboardAvoidingView>

      <ActionSheet
        visible={menuFor !== null}
        title="Message"
        header={
          menuFor ? (
            <View style={styles.reactionPicker}>
              {REACTION_STICKERS.map((reaction) => {
                const sticker = findSticker(reaction);
                return (
                  <Pressable
                    key={reaction}
                    onPress={() => {
                      const target = menuFor;
                      setMenuFor(null);
                      reactToMessage(target, reaction);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Réagir avec ${
                      sticker
                        ? sticker.kind === 'image'
                          ? (sticker.name ?? sticker.alt)
                          : sticker.label
                        : 'la panthère'
                    }`}
                    style={({ pressed }) => [
                      styles.reactionPickerItem,
                      pressed && { opacity: 0.6 },
                    ]}>
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
        title="Vu par"
        actions={
          seenFor
            ? (receipts[seenFor.id] ?? [])
                .filter((receipt) => receipt.userId !== user?.id && receipt.readAt !== null)
                .map((receipt, index) => ({
                  key: `${receipt.userId}-${index}`,
                  label:
                    conversation?.members.find((member) => member.id === receipt.userId)
                      ?.displayName ?? 'Membre',
                  onPress: () => setSeenFor(null),
                }))
            : []
        }
        onClose={() => setSeenFor(null)}
      />

      {imageViewer ? (
        <ImageViewer
          urls={imageViewer.urls}
          initialIndex={imageViewer.index}
          onClose={() => setImageViewer(null)}
        />
      ) : null}
      {albumViewer ? (
        <AlbumViewer
          items={albumViewer.items}
          initialIndex={albumViewer.index}
          onClose={() => setAlbumViewer(null)}
        />
      ) : null}
      <VideoViewer
        visible={videoViewer !== null}
        uri={videoViewer}
        onClose={() => setVideoViewer(null)}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerCallActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingRight: Spacing.two,
  },
  pressedHeaderAction: {
    opacity: 0.55,
  },
  phoneFlipped: {
    transform: [{ scaleX: -1 }],
  },
  blockedBar: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.four,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  blockedText: {
    textAlign: 'center',
  },
  flex: {
    flex: 1,
  },
  stickerMessageBlock: {
    maxWidth: 160,
    gap: 4,
  },
  stickerMessageBlockMine: {
    alignItems: 'flex-end',
  },
  stickerReplyQuote: {
    width: 160,
  },
  emojiOnlyBlock: {
    maxWidth: 180,
    gap: 4,
  },
  emojiOnlyBlockMine: {
    alignItems: 'flex-end',
  },
  emojiOnlyQuote: {
    width: 160,
  },
  emojiOnlyText: {
    textAlign: 'center',
  },
  emojiOnlyMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  emojiOnlyMetaMine: {
    justifyContent: 'flex-end',
  },
  emojiOnlyTime: {
    fontSize: 11,
    lineHeight: 14,
  },
  emojiOnlyFailed: {
    maxWidth: 180,
    gap: 4,
  },
  emojiOnlyFailedMine: {
    alignItems: 'flex-end',
  },
  headerBackground: {
    flex: 1,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitleBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    maxWidth: 240,
  },
  headerTitleText: {
    flexShrink: 1,
    alignItems: 'center',
  },
  headerName: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '500',
    textAlign: 'center',
  },
  headerSubtitle: {
    fontSize: 11,
    lineHeight: 14,
    textAlign: 'center',
  },
  headerAction: {
    fontWeight: '600',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  emptyText: {
    textAlign: 'center',
  },
  emptyChat: {
    gap: Spacing.two,
  },
  emptyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.two,
  },
  reactionChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
    marginTop: Spacing.half,
  },
  reactionChipsEnd: { justifyContent: 'flex-end' },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: Radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  reactionChipEmoji: { fontSize: 12, lineHeight: 16 },
  reactionPicker: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  reactionPickerItem: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  reactionPickerEmoji: { fontSize: 24, lineHeight: 30 },
  seenByRow: { alignItems: 'flex-end', paddingTop: 1 },
  emptyTitle: {
    textAlign: 'center',
    marginTop: Spacing.two,
  },
  suggestions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  suggestion: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  listContent: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
    flexGrow: 1,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    marginVertical: Spacing.one,
  },
  bubbleColumn: {
    flex: 1,
    minWidth: 0,
  },
  messageAvatar: {
    borderRadius: Radii.full,
  },
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
    top: 15,
    transform: [{ rotate: '45deg' }],
  },
  tailLeft: {
    left: -5,
  },
  tailRight: {
    right: -5,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 21,
  },
  ticksRow: {
    flexDirection: 'row',
    alignSelf: 'flex-end',
    marginTop: Spacing.half,
  },
  mediaBlock: {
    gap: Spacing.one,
  },
  stickerBlock: {
    gap: Spacing.one,
    maxWidth: '100%',
  },
  stickerQuote: {
    borderRadius: Radii.sm,
    padding: Spacing.one,
  },
  mediaBlockMine: {
    alignItems: 'flex-end',
  },
  mediaBlockOther: {
    alignItems: 'flex-start',
  },
  mediaQuote: {
    width: '100%',
    borderRadius: Radii.sm,
    padding: Spacing.one,
  },
  mediaCaption: {
    width: '100%',
    borderRadius: Radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  mediaCaptionText: {
    fontSize: 16,
    lineHeight: 21,
  },
  mediaTicks: {
    alignSelf: 'flex-end',
    paddingTop: 2,
  },
  mediaFailed: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    gap: Spacing.half,
  },
  mediaFailedMine: {
    alignSelf: 'flex-end',
  },
  mediaFailedActions: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  /** Citation : barre colorée et aperçu sur une ligne, dans la bulle de la réponse. */
  quote: {
    flexDirection: 'row',
    gap: Spacing.one,
    borderRadius: Radii.xs,
    paddingVertical: 4,
    overflow: 'hidden',
  },
  quoteBar: {
    width: 3,
  },
  quotePreviewText: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
  },
  quoteBody: {
    flex: 1,
    paddingRight: Spacing.two,
  },
  /** Bandeau de la réponse en cours, au-dessus du champ de saisie. */
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  replyBarBody: {
    flex: 1,
  },
  replyClose: {
    padding: Spacing.one,
  },
  senderName: {
    fontSize: 12,
    lineHeight: 16,
  },
  voiceMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  dateRow: {
    alignItems: 'center',
    marginVertical: Spacing.two,
  },
  datePill: {
    borderRadius: Radii.sm,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.half,
  },
  dateText: {
    fontSize: 12,
    lineHeight: 16,
  },
  timeRow: {
    alignItems: 'center',
    marginVertical: Spacing.two,
  },
  timeText: {
    fontSize: 12,
    lineHeight: 16,
  },
  systemRow: {
    alignItems: 'center',
    marginVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  callRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 5,
    marginVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  systemText: {
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  /** Séparateur de non-lus : texte centré entre deux traits fins. */
  unreadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  unreadLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  unreadText: {
    fontSize: 12,
    lineHeight: 16,
  },
  /** Pastille de retour en bas, posée au-dessus du champ de saisie. */
  jump: {
    position: 'absolute',
    right: Spacing.three,
    width: 42,
    height: 42,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.14)',
  },
  jumpBadge: {
    position: 'absolute',
    top: -24,
    right: -4,
    minWidth: 22,
    height: 22,
    borderRadius: Radii.full,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: accentColor,
  },
  jumpBadgeText: {
    color: '#ffffff',
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
  },
  error: {
    color: '#e5484d',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.one,
  },
  offline: {
    color: accentColor,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.one,
    fontStyle: 'italic',
  },
  /** Bulle dont l'envoi a été refusé : le motif, et l'invitation à retenter. */
  failedHint: {
    fontSize: 11,
    lineHeight: 14,
    opacity: 0.9,
  },
  typingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.half,
  },
  typing: {
    fontStyle: 'italic',
    flexShrink: 1,
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: Radii.full,
  },
  /** Bloc du vocal : la bulle fournie gère sa propre largeur et ses couleurs. */
  voiceBlock: {
    maxWidth: '100%',
    gap: Spacing.one,
  },
  voiceBlockMine: {
    alignItems: 'flex-end',
  },
  voiceBlockOther: {
    alignItems: 'flex-start',
  },
  voiceQuote: {
    width: '100%',
    borderRadius: Radii.sm,
    padding: Spacing.one,
  },
  tickPending: {
    opacity: 0.75,
  },
});
