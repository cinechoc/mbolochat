import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Redirect, Stack, useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TextField, accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useKeyboardHeight } from '@/hooks/use-keyboard-height';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cache } from '@/lib/cache';
import { API_URL } from '@/lib/config';
import { conversationTitle, formatDateLabel, formatTime, tickState, type TickState } from '@/lib/format';
import {
  discard,
  drain,
  enqueue,
  listOutbox,
  onSent,
  pendingMessage,
  retry as retryOutbox,
  subscribe as subscribeOutbox,
  type OutboxItem,
} from '@/lib/outbox';
import { connectSocket, deleteMessage, getSocket, onConnection, reportDelivered } from '@/lib/socket';
import { advanceCursor, onMissedMessages } from '@/lib/sync';
import type { VoiceComponents, VoiceTake } from '@/lib/voice';
import { loadVoice } from '@/lib/voice';
import type { ConversationSummary, Message, MessageQuote, MessageReceipt } from '@/lib/types';

type ListRow =
  | { key: string; type: 'date'; label: string }
  | { key: string; type: 'unread'; count: number }
  | { key: string; type: 'message'; message: Message };

const TYPING_STEP_MS = 170;
/** Au-delà de ce défilement, la pastille de retour en bas apparaît. */
const JUMP_AFTER_PX = 320;
/** Double coche bleue : le message a été lu. */
const TICK_READ = '#53bdeb';

/** Les médias arrivent en chemin relatif signé et éphémère (« /media?f=… »). */
function mediaUrl(url: string): string {
  return /^(https?:|file:|content:|data:)/i.test(url) ? url : `${API_URL}${url}`;
}

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

/** Taille d'affichage d'une photo dans une bulle, en gardant ses proportions. */
function bubbleSize(attachment: { width?: number; height?: number }): { width: number; height: number } {
  const ratio =
    attachment.width && attachment.height ? attachment.height / attachment.width : 1.25;
  return { width: 230, height: Math.min(Math.max(230 * ratio, 120), 300) };
}

/**
 * Les coches, en glyphes purs — pas d'icône : ✓ envoyé, ✓✓ reçu, ✓✓ bleu lu,
 * ◷ en file, ! refusé (toucher la bulle pour relancer).
 */
const TICK_GLYPH: Record<TickState, string> = {
  pending: '◷',
  failed: '!',
  sent: '✓',
  delivered: '✓✓',
  read: '✓✓',
};

const TICK_LABEL: Record<TickState, string> = {
  pending: "En attente d'envoi",
  failed: "Échec de l'envoi",
  sent: 'Envoyé',
  delivered: 'Reçu',
  read: 'Lu',
};

function Ticks({ state, style }: { state: TickState; style?: StyleProp<TextStyle> }) {
  return (
    <ThemedText
      accessibilityLabel={TICK_LABEL[state]}
      style={[
        style ?? styles.metaText,
        style ? null : styles.metaTextMine,
        state === 'read' ? { color: TICK_READ } : null,
        state === 'pending' ? { opacity: 0.75 } : null,
      ]}>
      {TICK_GLYPH[state]}
    </ThemedText>
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
  const body = (
    <View style={[styles.quote, mine ? styles.quoteMine : null]}>
      <View style={[styles.quoteBar, mine ? styles.quoteBarMine : null]} />
      <View style={styles.quoteBody}>
        <ThemedText type="smallBold" style={[styles.quoteName, mine ? styles.quoteTextMine : null]}>
          {quote.senderName}
        </ThemedText>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          numberOfLines={1}
          style={mine ? styles.quoteTextMine : null}>
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
  uri,
  onPress,
}: {
  title: string;
  subtitle: string;
  uri?: string | null;
  onPress?: () => void;
}) {
  const content = (
    <View style={styles.headerTitle}>
      <Avatar name={title} uri={uri} size={36} />
      <View style={styles.headerTitleBody}>
        <ThemedText numberOfLines={1} style={styles.headerName}>
          {title}
        </ThemedText>
        {subtitle ? (
          <ThemedText numberOfLines={1} type="small" themeColor="textSecondary" style={styles.headerSubtitle}>
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
    <Pressable onPress={onPress} hitSlop={8} style={styles.headerPressable}>
      {content}
    </Pressable>
  );
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { token, user } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();

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
  const [attachSheet, setAttachSheet] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  /** Message cité par la réponse en cours de composition. */
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  /** Bulle dont le menu d'appui long est ouvert. */
  const [menuFor, setMenuFor] = useState<Message | null>(null);
  /** Composants audio : null si l'appareil ne sait pas enregistrer. */
  const [voice, setVoice] = useState<VoiceComponents | null>(null);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    let active = true;
    void loadVoice().then((components) => {
      if (active) {
        setVoice(components);
      }
    });
    return () => {
      active = false;
    };
  }, []);
  const listRef = useRef<FlatList<ListRow>>(null);
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
    if (user && id) {
      const sender: Message['sender'] = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      };
      for (const item of queued) {
        all.push(
          pendingMessage(item, sender, (quotedId) => {
            const origin = all.find((row) => row.id === quotedId);
            return origin ? quoteOfMessage(origin) : null;
          }),
        );
      }
      all.sort((a, b) => atMs(a.createdAt) - atMs(b.createdAt));
    }

    const chronological: ListRow[] = [];
    let lastLabel = '';
    let unreadPlaced = !unreadFrom;
    for (const message of all) {
      const label = formatDateLabel(message.createdAt);
      if (label !== lastLabel) {
        chronological.push({ key: `date-${message.id}`, type: 'date', label });
        lastLabel = label;
      }
      if (!unreadPlaced && message.id === unreadFrom?.id) {
        chronological.push({ key: 'unread', type: 'unread', count: unreadFrom.count });
        unreadPlaced = true;
      }
      chronological.push({ key: message.id, type: 'message', message });
    }
    return chronological.reverse();
  }, [messages, queued, user, id, unreadFrom]);

  const queuedById = useMemo(() => new Map(queued.map((item) => [item.clientId, item])), [queued]);

  /** Coche de chaque bulle : la file pour mes envois, les accusés du serveur sinon. */
  const tickById = useMemo(() => {
    const map: Record<string, TickState> = {};
    for (const item of queued) {
      map[item.clientId] = item.status === 'failed' ? 'failed' : 'pending';
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
  const subtitle = isGroup
    ? `${conversation?.members.length ?? 0} membres`
    : other
      ? `@${other.username}`
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
      headerTitle: () => (
        <ChatHeaderTitle
          title={title}
          subtitle={subtitle}
          uri={conversation?.type === 'DIRECT' ? other?.avatarUrl : null}
          onPress={conversation?.type === 'DIRECT' && other ? openOtherProfile : undefined}
        />
      ),
      headerRight: () =>
        conversation?.type === 'GROUP' ? (
          <Pressable onPress={openConversationSettings}>
            <ThemedText style={{ color: accentColor, fontWeight: '600' }}>Infos</ThemedText>
          </Pressable>
        ) : null,
    }),
    [conversation, other, title, subtitle, openOtherProfile, openConversationSettings],
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
      const index = rows.findIndex((row) => row.type === 'message' && row.message.id === messageId);
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
  }, [scrollToBottom]);

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
        icon: 'reply',
        onPress: () => void startReply(message),
      });
    }
    if (message.content) {
      actions.push({
        key: 'copy',
        label: 'Copier',
        icon: 'content-copy',
        onPress: () => void copyMessage(message),
      });
    }
    actions.push({
      key: 'delete-me',
      label: waiting ? 'Supprimer' : 'Supprimer pour moi',
      icon: 'delete',
      destructive: true,
      onPress: () => void removeMessage(message, false),
    });
    if (!waiting && !message.deleted && message.sender.id === user?.id) {
      actions.push({
        key: 'delete-all',
        label: 'Retirer pour tous',
        icon: 'delete-forever',
        destructive: true,
        onPress: () => void removeMessage(message, true),
      });
    }
    return actions;
  }, [menuFor, queuedById, user?.id, startReply, copyMessage, removeMessage]);

  const renderItem = useCallback(
    ({ item }: { item: ListRow }) => {
      if (item.type === 'date') {
        return (
          <View style={styles.dateRow}>
            <ThemedView style={[styles.datePill, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.dateText}>
                {item.label}
              </ThemedText>
            </ThemedView>
          </View>
        );
      }
      if (item.type === 'unread') {
        return (
          <View style={styles.unreadRow}>
            <View style={styles.unreadPill}>
              <ThemedText style={styles.unreadText}>
                {item.count} {item.count > 1 ? 'nouveaux messages' : 'nouveau message'}
              </ThemedText>
            </View>
          </View>
        );
      }
      const { message } = item;
      const mine = message.sender.id === user?.id;
      // Retiré pour tous : plus de média, plus de texte, juste le témoin.
      const attachment = message.deleted ? null : message.attachment;
      const tick = mine ? tickById[message.id] : undefined;
      const stuck = tick === 'failed' ? queuedById.get(message.id) : undefined;
      const waiting = tick === 'pending';
      const aspect = attachment && attachment.type !== 'AUDIO' ? bubbleSize(attachment) : null;
      const bubble = (
        <View
          style={[
            styles.bubble,
            aspect ? styles.bubbleWithImage : null,
            mine
              ? styles.bubbleMine
              : { backgroundColor: theme.backgroundElement, borderBottomLeftRadius: 6 },
          ]}>
          {message.replyTo ? (
            <QuoteBlock
              quote={message.replyTo}
              mine={mine}
              onPress={() => jumpToMessage(message.replyTo?.id)}
            />
          ) : null}
          {attachment?.type === 'AUDIO' ? (
            voice ? (
              <voice.Bubble
                uri={mediaUrl(attachment.url)}
                durationMs={attachment.duration ?? 0}
                mine={mine}
                onLongPress={() => setMenuFor(message)}
              />
            ) : (
              // Un build sans expo-audio ne peut pas écouter : il le dit, au lieu
              // d'afficher une bulle muette.
              <ThemedText style={[styles.deletedText, mine ? styles.bubbleTextMine : null]}>
                Message vocal · installe une version plus récente pour l’écouter
              </ThemedText>
            )
          ) : attachment ? (
            <Pressable
              onPress={() => setViewer(mediaUrl(attachment.url))}
              onLongPress={() => setMenuFor(message)}
              delayLongPress={320}
              disabled={waiting}
              accessibilityLabel="Ouvrir la photo">
              <Image
                source={{ uri: mediaUrl(attachment.url) }}
                style={[styles.bubbleImage, aspect ?? undefined]}
                contentFit="cover"
                transition={120}
              />
              <View style={styles.imageMeta}>
                <ThemedText style={styles.imageMetaText}>
                  {formatTime(message.createdAt)}
                </ThemedText>
                {mine && tick ? <Ticks state={tick} style={styles.imageMetaText} /> : null}
              </View>
            </Pressable>
          ) : null}
          {!mine && isGroup ? (
            <ThemedText type="smallBold" style={styles.senderName}>
              {message.sender.displayName}
            </ThemedText>
          ) : null}
          {message.deleted ? (
            <ThemedText style={[styles.deletedText, mine ? styles.bubbleTextMine : null]}>
              Message supprimé
            </ThemedText>
          ) : message.content ? (
            <ThemedText
              style={[mine ? styles.bubbleTextMine : undefined, attachment ? styles.caption : undefined]}>
              {message.content}
            </ThemedText>
          ) : null}
          {/* Le vocal garde son horodatage sous la piste ; la photo le pose dessus. */}
          {attachment && attachment.type !== 'AUDIO' ? null : (
            <View style={styles.metaRow}>
              <ThemedText
                style={[
                  styles.metaText,
                  mine ? styles.metaTextMine : { color: theme.textSecondary },
                ]}>
                {formatTime(message.createdAt)}
              </ThemedText>
              {mine && tick ? <Ticks state={tick} /> : null}
            </View>
          )}
          {stuck ? (
            <ThemedText style={styles.failedHint} numberOfLines={2}>
              {stuck.error ?? "Le message n'est pas parti."} · retenter
            </ThemedText>
          ) : null}
        </View>
      );
      return (
        <View style={[styles.bubbleRow, mine ? styles.rowMine : styles.rowTheirs]}>
          <Pressable
            onPress={stuck ? () => resend(stuck.clientId) : undefined}
            onLongPress={() => setMenuFor(message)}
            delayLongPress={320}
            accessibilityRole="button"
            accessibilityLabel={stuck ? 'Renvoyer ce message' : 'Options du message'}>
            {bubble}
          </Pressable>
        </View>
      );
    },
    [user?.id, theme, isGroup, tickById, queuedById, resend, voice, jumpToMessage],
  );

  /**
   * La photo apparaît dans la conversation aussitôt et part par la file : elle
   * survivra à une coupure, voire à la fermeture de l'app, et s'importera au
   * premier retour du réseau.
   */
  const sendPhoto = useCallback(
    async (asset: ImagePicker.ImagePickerAsset) => {
      if (!token || !id) {
        return;
      }
      setError(null);
      await enqueue({
        conversationId: id,
        content: '',
        attachment: {
          localUri: asset.uri,
          mime: asset.mimeType,
          width: asset.width,
          height: asset.height,
        },
      });
      void drain(token);
    },
    [token, id],
  );

  const pickPhoto = useCallback(
    async (source: 'library' | 'camera') => {
      setAttachSheet(false);
      try {
        if (source === 'camera') {
          const permission = await ImagePicker.requestCameraPermissionsAsync();
          if (!permission.granted) {
            setError("Autorise l'accès à l'appareil photo pour envoyer une photo.");
            return;
          }
        }
        const result =
          source === 'camera'
            ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 })
            : await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                quality: 0.8,
                allowsMultipleSelection: false,
              });
        if (result.canceled || result.assets.length === 0) {
          return;
        }
        await sendPhoto(result.assets[0]);
      } catch {
        setError("Impossible d'ouvrir la galerie.");
      }
    },
    [sendPhoto],
  );

  /**
   * Un vocal part par la même file qu'une photo : il pèse quelques kilo-octets
   * par seconde et la coupure arrive souvent au milieu d'un envoi.
   */
  const sendVoice = useCallback(
    async (take: VoiceTake) => {
      if (!token || !id) {
        return;
      }
      setRecording(false);
      setError(null);
      await enqueue({
        conversationId: id,
        content: '',
        attachment: {
          localUri: take.uri,
          mime: take.mime,
          durationMs: take.durationMs,
          kind: 'audio',
        },
      });
      void drain(token);
    },
    [token, id],
  );

  const startRecording = useCallback(async () => {
    if (!voice) {
      return;
    }
    setError(null);
    if (!(await voice.requestMicrophone())) {
      setError('Autorise le micro pour enregistrer un message vocal.');
      return;
    }
    setRecording(true);
  }, [voice]);

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
    setInput('');
    setError(null);
    connectSocket(token).emit('typing', { conversationId: id, text: '' });
    await enqueue({ conversationId: id, content, replyTo: replyTo?.id ?? null });
    setReplyTo(null);
    void drain(token);
  };

  const emitTyping = (value: string) => {
    if (!token || !id) return;
    lastTypingEmitRef.current = Date.now();
    connectSocket(token).emit('typing', { conversationId: id, text: value.slice(0, 300) });
  };

  const onInputChange = (value: string) => {
    setInput(value);
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
  };

  return (
    <ThemedView
      style={[
        styles.container,
        // Android (edge-to-edge) : la fenêtre n'est pas redimensionnée, on pousse
        // donc nous-mêmes le contenu au-dessus du clavier.
        keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : null,
      ]}>
      <Stack.Screen options={headerOptions} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
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
            <MaterialIcons name="expand-more" size={26} color={accentColor} />
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
          <View style={styles.replyBar}>
            <View style={styles.replyBarBody}>
              <QuoteBlock quote={quoteOfMessage(replyTo)} mine={false} />
            </View>
            <Pressable
              onPress={() => setReplyTo(null)}
              hitSlop={8}
              style={styles.replyClose}
              accessibilityRole="button"
              accessibilityLabel="Annuler la réponse">
              <MaterialIcons name="close" size={20} color={accentColor} />
            </Pressable>
          </View>
        ) : null}

        {recording && voice ? (
          <voice.Recorder onFinished={(take) => void sendVoice(take)} onCancel={() => setRecording(false)} />
        ) : (
          <ThemedView
            style={[
              styles.inputRow,
              {
                // Quand le clavier est ouvert, c'est lui qui fait office de marge basse.
                paddingBottom: keyboardHeight > 0 ? Spacing.two : Math.max(insets.bottom, Spacing.three),
                borderTopColor: theme.backgroundElement,
              },
            ]}>
            <Pressable
              onPress={() => setAttachSheet(true)}
              hitSlop={8}
              style={({ pressed }) => [styles.attachButton, pressed && styles.sendDisabled]}
              accessibilityLabel="Envoyer une photo">
              <MaterialIcons name="add-photo-alternate" size={26} color={accentColor} />
            </Pressable>
            <TextField
              style={styles.input}
              placeholder="Écrire un message..."
              value={input}
              multiline
              onChangeText={onInputChange}
              onSubmitEditing={send}
            />
            {voice && input.trim().length === 0 ? (
              <Pressable
                onPress={() => void startRecording()}
                style={({ pressed }) => [styles.sendButton, pressed && styles.sendDisabled]}
                accessibilityRole="button"
                accessibilityLabel="Enregistrer un message vocal">
                <MaterialIcons name="mic" size={24} color="#ffffff" />
              </Pressable>
            ) : (
              <Pressable
                onPress={send}
                disabled={input.trim().length === 0}
                style={({ pressed }) => [
                  styles.sendButton,
                  (pressed || input.trim().length === 0) && styles.sendDisabled,
                ]}
                accessibilityLabel="Envoyer le message">
                <ThemedText style={styles.sendIcon}>➤</ThemedText>
              </Pressable>
            )}
          </ThemedView>
        )}
      </KeyboardAvoidingView>

      <ActionSheet
        visible={attachSheet}
        title="Envoyer une photo"
        actions={[
          {
            key: 'library',
            label: 'Galerie',
            icon: 'photo-library',
            onPress: () => void pickPhoto('library'),
          },
          {
            key: 'camera',
            label: 'Appareil photo',
            icon: 'photo-camera',
            onPress: () => void pickPhoto('camera'),
          },
        ]}
        onClose={() => setAttachSheet(false)}
      />

      <ActionSheet
        visible={menuFor !== null}
        title="Message"
        actions={menuActions}
        onClose={() => setMenuFor(null)}
      />

      <Modal
        visible={viewer !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setViewer(null)}>
        <View style={styles.viewerBackdrop}>
          {viewer ? (
            <Image source={{ uri: viewer }} style={styles.viewerImage} contentFit="contain" />
          ) : null}
          <Pressable style={styles.viewerClose} onPress={() => setViewer(null)}>
            <MaterialIcons name="close" size={26} color="#ffffff" />
          </Pressable>
        </View>
      </Modal>
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
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerPressable: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitleBody: {
    maxWidth: 220,
  },
  headerName: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '600',
  },
  headerSubtitle: {
    fontSize: 12,
    lineHeight: 16,
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
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    flexGrow: 1,
  },
  bubbleRow: {
    flexDirection: 'row',
    marginVertical: Spacing.half,
  },
  rowMine: {
    justifyContent: 'flex-end',
  },
  rowTheirs: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: Spacing.half,
  },
  bubbleMine: {
    backgroundColor: accentColor,
    borderBottomRightRadius: 6,
  },
  bubbleWithImage: {
    padding: 3,
    gap: 2,
  },
  bubbleImage: {
    width: 230,
    height: 200,
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  imageMeta: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  imageMetaText: {
    color: '#ffffff',
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
  },
  caption: {
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  /** Citation : barre colorée et aperçu sur une ligne, dans la bulle de la réponse. */
  quote: {
    flexDirection: 'row',
    gap: Spacing.one,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.06)',
    paddingVertical: 4,
    overflow: 'hidden',
  },
  quoteMine: {
    backgroundColor: 'rgba(0,0,0,0.12)',
  },
  quoteBar: {
    width: 3,
    backgroundColor: accentColor,
  },
  quoteBarMine: {
    backgroundColor: '#ffffff',
  },
  quoteBody: {
    flex: 1,
    paddingRight: Spacing.two,
  },
  quoteName: {
    color: accentColor,
  },
  quoteTextMine: {
    color: '#ffffff',
  },
  /** Message retiré pour tous : la bulle reste, le contenu a disparu. */
  deletedText: {
    fontStyle: 'italic',
    opacity: 0.7,
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
  attachButton: {
    paddingBottom: 9,
    paddingLeft: 2,
  },
  viewerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.96)',
  },
  viewerImage: {
    flex: 1,
  },
  viewerClose: {
    position: 'absolute',
    top: 42,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  bubbleTextMine: {
    color: '#ffffff',
  },
  senderName: {
    color: accentColor,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: Spacing.one,
  },
  metaText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
  },
  metaTextMine: {
    color: '#d7e6ff',
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
  /** Séparateur de non-lus : pastille verte collée au bord d'envoi. */
  unreadRow: {
    alignItems: 'flex-end',
    marginVertical: Spacing.two,
  },
  unreadPill: {
    borderRadius: 999,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.half,
    backgroundColor: '#d9fdd3',
  },
  unreadText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    color: '#0a6a3e',
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
    color: '#ffd0d2',
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
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    borderRadius: 22,
    paddingHorizontal: Spacing.three,
    paddingTop: 12,
    paddingBottom: 12,
    maxHeight: 120,
  },
  sendButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: accentColor,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: {
    opacity: 0.45,
  },
  sendIcon: {
    color: '#ffffff',
    fontSize: 18,
    lineHeight: 20,
    marginLeft: 2,
  },
});
