import AsyncStorage from '@react-native-async-storage/async-storage';import * as ImagePicker from 'expo-image-picker';
import { Redirect, Stack, useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import {
  Check,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  Clock,
  Copy,
  Reply,
  Trash,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Animated,
  BackHandler,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type TextInputInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { AttachPanel } from '@/components/attach-panel';
import { Avatar } from '@/components/avatar';
import { MessageComposer } from '@/components/message-composer';
import { SwipeableBubble } from '@/components/swipeable-bubble';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { accentColor } from '@/components/ui';
import { CHAT_TIME_GAP_MS, useChatColors } from '@/constants/chat-theme';
import { Spacing } from '@/constants/theme';
import { PresenceSubtitle } from '@/features/presence/PresenceSubtitle';
import { VoiceMessageBubble, voiceBubbleWidth } from '@/features/voice-notes/VoiceMessageBubble';
import { VoiceRecordButton } from '@/features/voice-notes/VoiceRecordButton';
import { previousClusterIndex } from '@/features/emoji/emoji-text';
import { GifMessageBubble } from '@/features/giphy/GifMessageBubble';
import { ExpressionPanel, type ExpressionTab } from '@/features/stickers/ExpressionPanel';
import { StickerMessageBubble } from '@/features/stickers/StickerMessageBubble';
import { resolveStickerUri } from '@/features/stickers/sticker-service';
import type { Sticker } from '@/features/stickers/sticker-catalog';
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
import { useKeyboardHeight, useKeyboardVisible } from '@/hooks/use-keyboard-height';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cache } from '@/lib/cache';
import { conversationTitle, formatClock, formatDateLabel, tickState, type TickState } from '@/lib/format';
import { GIPHY_API_KEY } from '@/lib/giphy';
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
import { connectSocket, deleteMessage, getSocket, onConnection, reportDelivered } from '@/lib/socket';
import { advanceCursor, onMissedMessages } from '@/lib/sync';
import type {
  ConversationSummary,
  GifSendPayload,
  Message,
  MessageAttachment,
  MessageQuote,
  MessageReceipt,
} from '@/lib/types';

type ListRow =
  | { key: string; type: 'date'; label: string }
  | { key: string; type: 'time'; label: string }
  | { key: string; type: 'unread'; count: number }
  | { key: string; type: 'message'; message: Message }
  | { key: string; type: 'album'; messages: Message[] };

const TYPING_STEP_MS = 170;
/** Au-delà de ce défilement, la pastille de retour en bas apparaît. */
const JUMP_AFTER_PX = 320;
/** Espace minimal laissé à la conversation quand un panneau est ouvert. */
const CONVERSATION_RESERVE_DP = 120;
const MIN_EXPRESSION_HEIGHT_DP = 150;
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
        <ThemedText type="small" numberOfLines={1} style={tone.text}>
          {quoteText(quote)}
        </ThemedText>
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

function ChatHeaderTitle({
  title,
  subtitle,
  presenceUserId,
  onPress,
}: {
  title: string;
  subtitle: string;
  presenceUserId?: string;
  onPress?: () => void;
}) {
  const chat = useChatColors();
  const content = (
    <View style={styles.headerTitleBody}>
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
        <ThemedText numberOfLines={1} style={[styles.headerSubtitle, { color: chat.headerSubtitle }]}>
          {subtitle}
        </ThemedText>
      ) : null}
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
  const theme = useTheme();
  const chat = useChatColors();
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const keyboardVisible = useKeyboardVisible();
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
      voiceButtonText: { color: chat.primaryText },
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
  const [typing, setTyping] = useState<{ userId: string; text: string } | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingEmitRef = useRef(0);
  const pendingTypingRef = useRef<string | null>(null);
  /** Accusés de réception de mes messages, regroupés par message. */
  const [receipts, setReceipts] = useState<Record<string, MessageReceipt[]>>({});
  const [ready, setReady] = useState(() => (id ? cache.getMessages(id) !== null : false));
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachPanelOpen, setAttachPanelOpen] = useState(false);
  /** Panneau d'expression : stickers locaux, émojis, GIF (si configuré). */
  const [expressionOpen, setExpressionOpen] = useState(false);
  const [expressionTab, setExpressionTab] = useState<ExpressionTab>('stickers');
  const giphyEnabled = GIPHY_API_KEY.length > 0;
  /** Anti-double-appui : deux stickers identiques ne partent pas en rafale. */
  const lastStickerSendAt = useRef(0);
  const [imageViewer, setImageViewer] = useState<{ urls: string[]; index: number } | null>(null);
  const [albumViewer, setAlbumViewer] = useState<{ items: MediaViewerItem[]; index: number } | null>(
    null,
  );
  const [videoViewer, setVideoViewer] = useState<string | null>(null);
  /** Message cité par la réponse en cours de composition. */
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  /**
   * Mesures réelles du bas de l'écran. Le clavier peut rétrécir la fenêtre
   * (adjustResize) ou être compensé par un padding racine (edge-to-edge) :
   * mesurer le conteneur évite de dépendre de l'un ou de l'autre.
   */
  const [chatAreaHeight, setChatAreaHeight] = useState(0);
  const [composerHeight, setComposerHeight] = useState(0);
  const [replyBarHeight, setReplyBarHeight] = useState(0);
  /**
   * Espace clavier rendu au panneau mais pas encore reflété par le layout du
   * KAV. Il évite que le panneau naisse avec la hauteur « clavier ouvert ».
   */
  const [pendingKeyboardHeight, setPendingKeyboardHeight] = useState(0);
  const pendingKeyboardBaseRef = useRef(0);
  const expressionMaxHeight = useMemo(
    () =>
      chatAreaHeight > 0
        ? Math.max(
            MIN_EXPRESSION_HEIGHT_DP,
            chatAreaHeight +
              pendingKeyboardHeight -
              composerHeight -
              (replyTo ? replyBarHeight : 0) -
              CONVERSATION_RESERVE_DP,
          )
        : undefined,
    [chatAreaHeight, pendingKeyboardHeight, composerHeight, replyBarHeight, replyTo],
  );
  useEffect(() => {
    if (
      pendingKeyboardHeight > 0 &&
      !keyboardVisible &&
      chatAreaHeight !== pendingKeyboardBaseRef.current
    ) {
      setPendingKeyboardHeight(0);
    }
  }, [pendingKeyboardHeight, keyboardVisible, chatAreaHeight]);
  /** Bulle dont le menu d'appui long est ouvert. */
  const [menuFor, setMenuFor] = useState<Message | null>(null);
  /** Le compositeur montre le clavier ou le bouton « maintenir pour parler ». */
  const [inputMode, setInputMode] = useState<'keyboard' | 'voice'>('keyboard');
  /** Waveforms des vocaux de cette session, indexées par clientId/URI locale. */
  const [voiceWaveforms, setVoiceWaveforms] = useState<Record<string, number[]>>({});
  const [playedVoiceIds, setPlayedVoiceIds] = useState<Set<string>>(() => new Set());
  const playedLoadedRef = useRef(false);
  const listRef = useRef<FlatList<ListRow>>(null);
  /** Champ de saisie, pour rendre le clavier au panneau puis le rouvrir. */
  const composerInputRef = useRef<TextInputInstance>(null);
  /** Action différée jusqu'à la fermeture effective du clavier. */
  const pendingExpressionRef = useRef<null | (() => void)>(null);
  /** Le dernier message est-il à l'écran ? Décide si on doit y recoller. */
  const atBottomRef = useRef(true);
  /** Séparateur de non-lus, figé à l'ouverture : il ne suit pas les arrivages. */
  const [unreadFrom, setUnreadFrom] = useState<{ id: string; count: number } | null>(null);
  const [showJump, setShowJump] = useState(false);
  /** Messages reçus pendant que l'on était remonté dans l'historique. */
  const [unseen, setUnseen] = useState(0);
  const unseenRef = useRef(0);
  const showJumpRef = useRef(false);
  /** L'historique est-il à l'écran ? Ce n'est qu'alors que la lecture se signale. */
  const historyLoadedRef = useRef(false);

  const cancelPendingExpression = useCallback(() => {
    pendingExpressionRef.current = null;
    setPendingKeyboardHeight(0);
  }, []);
  const closeAttachPanel = useCallback(() => setAttachPanelOpen(false), []);
  const closePanels = useCallback(() => {
    cancelPendingExpression();
    setAttachPanelOpen(false);
    setExpressionOpen(false);
  }, [cancelPendingExpression]);
  const toggleAttachPanel = useCallback(() => {
    cancelPendingExpression();
    setExpressionOpen(false);
    // Le sélecteur de pièces jointes est un panneau d'actions plein : on libère
    // le clavier et le focus pour pouvoir le rouvrir proprement ensuite.
    composerInputRef.current?.blur();
    Keyboard.dismiss();
    setAttachPanelOpen((open) => !open);
  }, [cancelPendingExpression]);
  /**
   * Ouvre un onglet. Si le clavier est visible, on attend sa fermeture
   * effective (keyboardDidHide) avant de monter le panneau, afin qu'il soit
   * dimensionné directement pour l'espace libéré.
   */
  const openExpression = useCallback(
    (tab: ExpressionTab) => {
      setAttachPanelOpen(false);
      // Le panneau prend le relais du clavier : le champ perd le focus pour
      // que le bouton clavier puisse rouvrir l'IME de façon fiable.
      composerInputRef.current?.blur();
      if (!keyboardVisible) {
        setPendingKeyboardHeight(0);
        setExpressionTab(tab);
        setExpressionOpen(true);
        return;
      }
      if (pendingExpressionRef.current) {
        return;
      }
      pendingKeyboardBaseRef.current = chatAreaHeight;
      setPendingKeyboardHeight(keyboardHeight);
      pendingExpressionRef.current = () => {
        setExpressionTab(tab);
        setExpressionOpen(true);
      };
      Keyboard.dismiss();
    },
    [chatAreaHeight, keyboardHeight, keyboardVisible],
  );

  useEffect(() => {
    if (!attachPanelOpen && !expressionOpen) {
      return;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setAttachPanelOpen(false);
      setExpressionOpen(false);
      return true;
    });
    return () => subscription.remove();
  }, [attachPanelOpen, expressionOpen]);

  /**
   * Miroir du texte et suivi du curseur : le panneau d'émojis insère à
   * l'endroit exact où l'utilisateur s'est arrêté, comme un clavier.
   */
  const inputRef = useRef('');
  const selectionRef = useRef({ start: 0, end: 0 });
  /** Sélection forcée une fois (après insertion), puis rendue au champ. */
  const [emojiSelection, setEmojiSelection] = useState<{ start: number; end: number } | null>(null);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  // Une sélection contrôlée figerait le curseur : on la lâche dès qu'elle est
  // appliquée, le champ repart en non contrôlé avec sa vraie position.
  useEffect(() => {
    if (!emojiSelection) {
      return;
    }
    const timer = setTimeout(() => setEmojiSelection(null), 120);
    return () => clearTimeout(timer);
  }, [emojiSelection]);

  /** Ferme le panneau et rend le clavier au champ, curseur restauré. */
  const showKeyboardFromPanel = useCallback(() => {
    setExpressionOpen(false);
    setAttachPanelOpen(false);
    const { start, end } = selectionRef.current;
    setEmojiSelection({ start, end });
    setTimeout(() => composerInputRef.current?.focus(), 0);
  }, []);

  /** Bascule entre le clavier et les onglets du panneau d'expression. */
  const toggleExpressionFromComposer = useCallback(() => {
    if (!expressionOpen) {
      openExpression('emoji');
      return;
    }
    if (expressionTab === 'emoji') {
      if (keyboardVisible) {
        // Clavier de recherche du panneau : on le referme sans quitter Émojis.
        Keyboard.dismiss();
        return;
      }
      showKeyboardFromPanel();
      return;
    }
    // Stickers/GIF : basculer sur Émojis sans fermer puis rouvrir le panneau.
    if (keyboardVisible) {
      Keyboard.dismiss();
    }
    setExpressionTab('emoji');
  }, [expressionOpen, expressionTab, keyboardVisible, openExpression, showKeyboardFromPanel]);

  // Le clavier vient de se fermer : laisser passer la mise en page (le KAV
  // reprend sa hauteur), puis monter le panneau avec sa taille finale.
  useEffect(() => {
    if (keyboardVisible || !pendingExpressionRef.current) {
      return;
    }
    const action = pendingExpressionRef.current;
    pendingExpressionRef.current = null;
    action?.();
  }, [keyboardVisible]);

  // Même événement que la fermeture du clavier : le panneau est monté dans le
  // rendu qui suit, sans rendu intermédiaire ni attente de frames.
  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidHide', () => {
      const action = pendingExpressionRef.current;
      if (!action) {
        return;
      }
      pendingExpressionRef.current = null;
      action();
    });
    return () => subscription.remove();
  }, []);

  const onInputSelectionChange = useCallback((event: { nativeEvent: { selection: { start: number; end: number } } }) => {
    selectionRef.current = event.nativeEvent.selection;
  }, []);

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
      inputRef.current = value;
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

  /** Insère à la position actuelle du curseur, que l'émission de « saisie » suivie. */
  const insertEmoji = useCallback(
    (glyph: string) => {
      const text = inputRef.current;
      const { start, end } = selectionRef.current;
      const from = Math.min(start, end, text.length);
      const to = Math.min(Math.max(start, end), text.length);
      const next = `${text.slice(0, from)}${glyph}${text.slice(to)}`;
      onInputChange(next);
      const caret = from + glyph.length;
      selectionRef.current = { start: caret, end: caret };
      setEmojiSelection({ start: caret, end: caret });
    },
    [onInputChange],
  );

  /** ⌫ du panneau : les séquences (famille, ton, drapeau) partent entières. */
  const backspaceEmoji = useCallback(() => {
    const text = inputRef.current;
    if (!text) return;
    const { start, end } = selectionRef.current;
    let from: number;
    let to: number;
    if (start !== end) {
      from = Math.min(start, end);
      to = Math.max(start, end);
    } else {
      from = previousClusterIndex(text, Math.min(end, text.length));
      to = end;
    }
    if (from >= to) {
      return;
    }
    onInputChange(`${text.slice(0, from)}${text.slice(to)}`);
    selectionRef.current = { start: from, end: from };
    setEmojiSelection({ start: from, end: from });
  }, [onInputChange]);

  /** Vide le champ et remet le curseur à zéro après un envoi confirmé. */
  const clearComposer = useCallback(() => {
    setInput('');
    inputRef.current = '';
    selectionRef.current = { start: 0, end: 0 };
    setEmojiSelection(null);
    if (token && id) {
      connectSocket(token).emit('typing', { conversationId: id, text: '' });
    }
  }, [token, id]);

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
      socket.off('connect', join);
      offMissed();
      offSent();
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (typingFlushRef.current) clearTimeout(typingFlushRef.current);
      // Le socket reste ouvert : la liste des discussions continue de
      // recevoir les messages en temps réel après le retour.
    };
  }, [token, id, user]);

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
    let unreadPlaced = !unreadFrom;
    for (const cluster of clusterMessages(all, orderAt)) {
      const first = cluster.messages[0];
      const displayIso = new Date(cluster.firstAt).toISOString();
      const label = formatDateLabel(displayIso);
      if (label !== lastLabel) {
        chronological.push({ key: `date-${first.id}`, type: 'date', label });
        lastLabel = label;
        lastMs = null;
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
        });
      } else {
        chronological.push({ key: first.id, type: 'message', message: first });
      }
      lastMs = cluster.lastAt;
    }
    return chronological.reverse();
  }, [messages, queued, user, id, unreadFrom]);

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
  const isGroup = Boolean(conversation?.name);
  const other = user ? conversation?.members.find((member) => member.id !== user.id) : undefined;
  const subtitle = isGroup ? `${conversation?.members.length ?? 0} membres` : '';

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
      },
    });
  }, [other, router]);

  const openConversationSettings = useCallback(() => {
    if (id) {
      router.push({ pathname: '/conversation-settings/[id]', params: { id } });
    }
  }, [id, router]);

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
          onPress={conversation?.type === 'DIRECT' && other ? openOtherProfile : undefined}
        />
      ),
      headerRight: () =>
        conversation?.type === 'GROUP' ? (
          <Pressable onPress={openConversationSettings} hitSlop={8}>
            <ThemedText style={[styles.headerAction, { color: chat.headerText }]}>Infos</ThemedText>
          </Pressable>
        ) : null,
    }),
    [conversation, other, title, subtitle, openOtherProfile, openConversationSettings, chat],
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

  const listEmpty = useMemo(
    () =>
      ready ? (
        <ThemedView style={styles.center}>
          <ThemedText themeColor="textSecondary" style={styles.emptyText}>
            Aucun message. Dis bonjour !
          </ThemedText>
        </ThemedView>
      ) : undefined,
    [ready],
  );

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
  const menuActions = useMemo<SheetAction[]>(() => {
    const message = menuFor;
    if (!message) {
      return [];
    }
    const waiting = queuedById.has(message.id);
    const actions: SheetAction[] = [];
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
  }, [menuFor, queuedById, user?.id, startReply, copyMessage, removeMessage]);

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
                  {!mine && isGroup ? (
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
          style={styles.messageAvatar}
        />
      );
      const row = (content: ReactNode) => (
        <View style={styles.messageRow}>
          {mine ? null : avatar}
          <View style={styles.bubbleColumn}>{content}</View>
          {mine ? avatar : null}
        </View>
      );

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
              {!mine && isGroup ? (
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
              {!mine && isGroup ? (
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
              {!mine && isGroup ? (
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
                  <ThemedText style={[styles.mediaCaptionText, { color: foreground }]}>
                    {message.content}
                  </ThemedText>
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
        <View style={[styles.bubble, mine ? chatStyles.bubbleMine : chatStyles.bubbleTheirs]}>
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
          {!mine && isGroup ? (
            <ThemedText type="smallBold" style={[styles.senderName, chatStyles.senderName]}>
              {message.sender.displayName}
            </ThemedText>
          ) : null}
          {message.content ? (
            <ThemedText style={[styles.messageText, chatStyles.messageText]}>
              {message.content}
            </ThemedText>
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
      queuedById,
      resend,
      startReply,
      jumpToMessage,
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
      const caption = inputRef.current.trim();
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
      if (caption) {
        clearComposer();
      }
      void drain(token);
    },
    [token, id, clearComposer],
  );

  const pickLibrary = useCallback(async () => {
    closeAttachPanel();
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
  }, [closeAttachPanel, queueAttachments, reportPickerError, showRejected]);

  const pickCamera = useCallback(async () => {
    closeAttachPanel();
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
  }, [closeAttachPanel, queueAttachments, reportPickerError, showRejected]);

  const pickFileDocuments = useCallback(async () => {
    closeAttachPanel();
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
  }, [closeAttachPanel, queueAttachments, reportPickerError, showRejected]);

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
   * Envoi d'un GIF GIPHY : aucun octet ne transite par notre API — l'URL du
   * rendu messagerie (intacte, exigence GIPHY) est validée par le serveur
   * (allowlist media*.giphy.com) puis stockée dans la pièce jointe.
   */
  const sendGif = useCallback(
    async (gif: GifSendPayload) => {
      if (!token || !id) {
        return;
      }
      setError(null);
      await enqueue({
        conversationId: id,
        content: '',
        attachment: {
          mime: gif.sticker === true ? 'image/webp' : 'image/gif',
          width: gif.width ?? null,
          height: gif.height ?? null,
          kind: 'gif',
          external: gif,
        },
      });
      void drain(token);
    },
    [token, id],
  );

  /**
   * Envoi d'un sticker local : l'image est d'abord rendue disponible comme
   * fichier (asset bundlé ou création personnelle), puis confiée à la file
   * d'attente existante. Le serveur requalifie l'upload en STICKER à partir
   * des identifiants ci-dessous. Un appui bref et répété est neutralisé.
   */
  const sendSticker = useCallback(
    async (sticker: Sticker) => {
      if (!token || !id) {
        return;
      }
      const now = Date.now();
      if (now - lastStickerSendAt.current < 600) {
        return;
      }
      lastStickerSendAt.current = now;
      setError(null);
      try {
        const localUri = await resolveStickerUri(sticker);
        await enqueue({
          conversationId: id,
          content: '',
          replyTo: replyTo?.id ?? null,
          attachment: {
            localUri,
            kind: 'sticker',
            mime: sticker.mime,
            name: sticker.name,
            width: sticker.width,
            height: sticker.height,
            external: {
              id: sticker.id,
              packId: sticker.packId,
              name: sticker.name,
              width: sticker.width,
              height: sticker.height,
            },
          },
        });
        setReplyTo(null);
        void drain(token);
      } catch (stickerError) {
        setError(
          stickerError instanceof Error
            ? stickerError.message
            : "Impossible d'envoyer ce sticker.",
        );
      }
    },
    [token, id, replyTo],
  );

  const toggleInputMode = useCallback(() => {
    cancelPendingExpression();
    setAttachPanelOpen(false);
    setExpressionOpen(false);
    if (inputMode === 'keyboard') {
      composerInputRef.current?.blur();
      Keyboard.dismiss();
      setInputMode('voice');
      return;
    }
    setInputMode('keyboard');
  }, [cancelPendingExpression, inputMode]);

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  /**
   * Le texte quitte le champ immédiatement et passe par la file : la bulle
   * horloge reste visible tant que le serveur n'a pas confirmé, et le message
   * repart tout seul dès que la connexion revient.
   */
  const send = async () => {
    const content = input.trim();
    if (!content || !token || !id) {
      return;
    }
    setError(null);
    await enqueue({ conversationId: id, content, replyTo: replyTo?.id ?? null });
    setAttachPanelOpen(false);
    clearComposer();
    setReplyTo(null);
    void drain(token);
  };

  return (
    <ThemedView
      style={[
        styles.container,
        chatStyles.screen,
        // Android (edge-to-edge) : la fenêtre n'est pas redimensionnée, on pousse
        // donc nous-mêmes le contenu au-dessus du clavier. En mode vocal ou avec
        // le panneau de pièces jointes, le clavier est fermé volontairement :
        // on libère la réserve immédiatement au lieu d'attendre l'événement.
        keyboardHeight > 0 && inputMode === 'keyboard' && !attachPanelOpen
          ? { paddingBottom: keyboardHeight }
          : null,
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
          onTouchStart={attachPanelOpen || expressionOpen ? closePanels : undefined}
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
          ListEmptyComponent={listEmpty}
          renderItem={renderItem}
        />

        {showJump ? (
          <Pressable
            onPress={jumpToBottom}
            accessibilityRole="button"
            accessibilityLabel="Retourner aux derniers messages"
            style={[styles.jump, { backgroundColor: theme.backgroundElement }]}>
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
          <MessageComposer
            inputRef={composerInputRef}
            value={input}
            onChangeText={onInputChange}
            onSelectionChange={onInputSelectionChange}
            selection={emojiSelection ?? undefined}
            mode={inputMode}
            onToggleMode={toggleInputMode}
            voiceRecorder={
              <VoiceRecordButton
                onSend={sendVoiceMessage}
                onPermissionDenied={handleVoicePermissionDenied}
                onError={handleVoiceError}
                accentColor={chat.mineBubble}
                idleColor={chat.input}
                pressedColor={chat.border}
                textStyle={chatStyles.voiceButtonText}
              />
            }
            expressionOpen={expressionOpen}
            expressionTab={expressionTab}
            keyboardVisible={keyboardVisible}
            onToggleExpression={toggleExpressionFromComposer}
            attachOpen={attachPanelOpen}
            onToggleAttach={toggleAttachPanel}
            onSend={send}
            onFocus={closePanels}
            bottomInset={insets.bottom}
            compactBottom={keyboardHeight > 0 || attachPanelOpen || expressionOpen}
          />
        </View>

        {attachPanelOpen ? (
          <AttachPanel
            onPhotos={() => void pickLibrary()}
            onCamera={() => void pickCamera()}
            onDocuments={() => void pickFileDocuments()}
            onStickers={() => openExpression('stickers')}
          />
        ) : null}

        {expressionOpen ? (
          <ExpressionPanel
            tab={expressionTab}
            onChangeTab={setExpressionTab}
            giphyEnabled={giphyEnabled}
            maxHeight={expressionMaxHeight}
            compactBottom={keyboardHeight > 0}
            onSelectEmoji={insertEmoji}
            onBackspace={backspaceEmoji}
            onSendSticker={(sticker) => void sendSticker(sticker)}
            onSendGif={(gif) => void sendGif(gif)}
            customerId={user.id}
          />
        ) : null}
      </KeyboardAvoidingView>

      <ActionSheet
        visible={menuFor !== null}
        title="Message"
        actions={menuActions}
        onClose={() => setMenuFor(null)}
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
  flex: {
    flex: 1,
  },
  headerBackground: {
    flex: 1,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitleBody: {
    alignItems: 'center',
    maxWidth: 240,
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
    borderRadius: Spacing.one,
  },
  bubble: {
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: Spacing.half,
  },
  tail: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 1,
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
    borderRadius: 6,
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
    borderRadius: 6,
    padding: Spacing.one,
  },
  mediaCaption: {
    width: '100%',
    borderRadius: 6,
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
    borderRadius: 4,
    paddingVertical: 4,
    overflow: 'hidden',
  },
  quoteBar: {
    width: 3,
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
    borderRadius: 999,
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
    bottom: 92,
    width: 42,
    height: 42,
    borderRadius: 21,
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
    borderRadius: 11,
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
    borderRadius: 3,
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
    borderRadius: 6,
    padding: Spacing.one,
  },
  tickPending: {
    opacity: 0.75,
  },
});
