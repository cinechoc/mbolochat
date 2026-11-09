import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Copy, Forward, Info, Phone, Reply, Trash2, Video } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';

import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { AttachPanel } from '@/components/attach-panel';
import { Avatar } from '@/components/avatar';
import { BlurTarget } from '@/components/blur-target';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { QuoteBlock } from '@/components/quote-block';
import { SwipeableBubble } from '@/components/swipeable-bubble';
import { useChatColors } from '@/constants/chat-theme';
import { Radii, Spacing } from '@/constants/theme';
import { ChatBubble } from '@/features/chat/ui/chat-bubble';
import { ChatEmptyState } from '@/features/chat/ui/chat-empty-state';
import { ChatHeaderScreen } from '@/features/chat/ui/chat-header';
import { ChatReplyBar } from '@/features/chat/ui/chat-reply-bar';
import {
  ChatDateSeparator,
  ChatMessageRow,
  ChatTimeSeparator,
} from '@/features/chat/ui/chat-rows';
import { ChatComposer } from '@/features/composer/ChatComposer';
import { SingleEmojiMessage } from '@/features/emoji/AnimatedEmoji';
import { MessageText } from '@/features/emoji/EmojiText';
import { emojiOnlyCount, splitEmoji, type EmojiSegment } from '@/features/emoji/emojiUtils';
import { mediaDisplaySize } from '@/features/media/mediaLayout';
import { useKeyboardHeight } from '@/hooks/use-keyboard-height';
import { useTextScale } from '@/lib/text-scale';
import { formatClock, formatDateLabel } from '@/lib/format';
import { copyToClipboard } from '@/lib/clipboard';
import { buildMessageRows, type E2eeListRow } from '@/features/e2ee/rows';
import { peerProfileRoute } from '@/features/e2ee/routing';
import { bubbleMaxWidth } from '@/features/chat/row-layout';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { connectSocket, deleteMessage, ensureSocket, reportDelivered } from '@/lib/socket';
import {
  canMarkRead,
  canReportDelivered,
  deliveredIds,
  mergeReceipts,
  receiptState,
} from '@/features/e2ee/receipts';
import {
  READ_VISIBILITY_MIN_TIME_MS,
  READ_VISIBILITY_PERCENT,
  visibleForeignMessageIds,
  type ViewableRow,
} from '@/features/e2ee/read-visibility';
import {
  getPresenceRecord,
  subscribePresenceUser,
} from '@/features/presence/presenceStore';
import { MessageReceiptLabel } from '@/features/chat/ui/message-receipt';
import type {
  ConversationSummary,
  Gender,
  Message,
  MessageQuote,
  MessageReceipt,
} from '@/lib/types';
import {
  isRejectedMedia,
  normalizeImageAsset,
  pickDocuments,
  pickLibraryMedia,
} from '@/features/media/pickMedia';
import { ImageViewer, VideoViewer } from '@/features/media/MediaViewers';
import {
  claimKeysLostNotice,
  classifyE2eeFailure,
  describeE2eeFailure,
  type E2eeInitFailure,
} from '@/features/e2ee/initState';
import { runE2eeInit } from '@/features/e2ee/initRunner';
import {
  deleteLocalMessage,
  knownMessageKeys,
  listLocalMessages,
  loadDraft,
  loadE2eeAccount,
  openE2eeDatabase,
  saveDraft,
  type E2eeAccountRow,
  type StoredE2eeMessage,
} from '@/features/e2ee/db';
import { sendEncryptedMedia, type E2eeMediaAsset } from '@/features/e2ee/media';
import { createDraftQueue, type DraftQueue } from '@/features/e2ee/draftQueue';
import { closeMedia, sweepSecureMedia } from '@/features/e2ee/mediaStore';
import { decodeMediaMeta } from '@/features/e2ee/payload';
import { isE2eeEnabled } from '@/features/e2ee/policy';
import { useSecureScreen } from '@/features/e2ee/screen-security';
import { SecureMediaMessage } from '@/features/e2ee/SecureMediaMessage';
import { StickerMessage } from '@/features/stickers/StickerView';
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

/**
 * Configuration de traçage de viewport : la moitié de la bulle à l'écran et
 * un maintien minimal (stabilité pendant le défilement) afin de ne pas
 * déclarer « Ouvert » un message qui ne fait que traverser l'écran.
 */
const READ_VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: READ_VISIBILITY_PERCENT,
  minimumViewTime: READ_VISIBILITY_MIN_TIME_MS,
};

export default function E2eeChatScreen() {
  const params = useLocalSearchParams<{
    id?: string;
    peerId?: string;
    name?: string;
    username?: string;
    avatarUrl?: string;
    gender?: Gender;
  }>();
  const { token, user } = useAuth();
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const conversationId = params.id ?? '';
  const peerId = params.peerId ?? '';
  const peerUsername = params.username ?? '';
  const title = params.name ?? fr.e2eeChat.title;
  // L'avatar du correspondant vient de la liste des discussions (membre de la
  // conversation) : rien de secret, et le même rendu que la conversation claire.
  const peerAvatarUrl = params.avatarUrl || null;
  const peerGender: Gender | null = params.gender ?? null;

  // FLAG_SECURE pendant toute la vie de l'écran : la conversation chiffrée
  // n'apparaît jamais en clair dans l'aperçu « applications récentes ».
  useSecureScreen(true);

  const dbRef = useRef<Awaited<ReturnType<typeof openE2eeDatabase>>['db'] | null>(null);
  const accountRef = useRef<E2eeAccountRow | null>(null);
  const [ready, setReady] = useState(false);
  /** Échec fatal (base chiffrée ou clés) : l'écran ne fait pas semblant d'être prêt. */
  const [fatal, setFatal] = useState<E2eeInitFailure | null>(null);
  /** Incrémenté par « Réessayer » : relance tout le chargement de l'écran. */
  const [initAttempt, setInitAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredE2eeMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<StoredE2eeMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [sendingMedia, setSendingMedia] = useState(false);
  /** Message dont la feuille d'actions est ouverte (appui long). */
  const [menuFor, setMenuFor] = useState<StoredE2eeMessage | null>(null);
  /** Message dont la fiche d'informations est ouverte. */
  const [infoFor, setInfoFor] = useState<StoredE2eeMessage | null>(null);
  /** Message texte en cours de transfert vers une autre discussion chiffrée. */
  const [forwardFor, setForwardFor] = useState<StoredE2eeMessage | null>(null);
  const [forwardTargets, setForwardTargets] = useState<ConversationSummary[]>([]);
  const [forwardLoading, setForwardLoading] = useState(false);
  const [composerKey, setComposerKey] = useState(0);
  /**
   * Accusés de mes messages envoyés, par identifiant (`Reçu` / `Ouvert`).
   * Le serveur ne fournit que des métadonnées (qui a reçu, qui a lu) : jamais
   * le contenu. « Ouvert » vient d'une ligne `read_at` persistée, donc il
   * survit à la déconnexion du destinataire.
   */
  const [receipts, setReceipts] = useState<Record<string, MessageReceipt[]>>({});
  const [appActive, setAppActive] = useState(true);
  const [focused, setFocused] = useState(false);
  /** Correspondant en ligne (application au premier plan) : pilote « Reçu ». */
  const [peerOnline, setPeerOnline] = useState(false);
  /** Accusés de livraison en attente du retour au premier plan. */
  const pendingAckRef = useRef<string[]>([]);
  /** Porte d'accusé, lue sans ré-ancrer les déchiffrements en cours. */
  const ackGateRef = useRef({ appActive: true, ready: false });
  /** Données de lecture, lues depuis des callbacks stables (ref lecteur). */
  const tokenRef = useRef(token);
  const conversationIdRef = useRef(conversationId);
  /** Porte de consultation réelle des lectures (focus/app/ready), sans effet. */
  const readGateRef = useRef({ focused: false, appActive: true, ready: false });
  /** Identifiants étrangers actuellement visibles, en attente d'envoi. */
  const lastVisibleIdsRef = useRef<string[]>([]);
  const readTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [chatAreaHeight, setChatAreaHeight] = useState(0);
  const [replyBarHeight, setReplyBarHeight] = useState(0);
  const blurTargetRef = useRef<React.ComponentRef<typeof View> | null>(null);
  const listRef = useRef<FlatList<E2eeListRow>>(null);
  const atBottomRef = useRef(true);
  const [viewer, setViewer] = useState<{ id: string; uri: string; kind: 'image' | 'video' } | null>(
    null,
  );
  // Identifiant du document ouvert dans la visionneuse locale : au retour sur
  // l'écran, son clair déchiffré doit disparaître (le fichier est en attente
  // dans le dossier privé tant que la route visionneuse est au premier plan).
  const openedDocumentRef = useRef<string | null>(null);

  /**
   * Écritures du brouillon chiffré, sérialisées : SQLCipher ne garantit pas
   * l'ordre d'achèvement de deux écritures lancées coup sur coup, une valeur
   * ancienne pouvait donc écraser la dernière saisie (brouillon tronqué).
   * Créée paresseusement : la base n'existe qu'après l'ouverture de l'écran.
   */
  const draftQueueRef = useRef<DraftQueue | null>(null);
  if (!draftQueueRef.current) {
    draftQueueRef.current = createDraftQueue((value) => {
      const db = dbRef.current;
      // Base déjà refermée (écran quitté) : rien à écrire, la file se vide.
      if (!db) return Promise.resolve();
      return saveDraft(db, conversationId, value);
    });
  }

  // Palette WeChat de la conversation (partagée avec le chat classique) : les
  // bulles chiffrées reprennent exactement les mêmes couleurs que les claires.
  const chat = useChatColors();
  const { width: windowWidth } = useWindowDimensions();
  const keyboardHeight = useKeyboardHeight();
  // Largeur maximale portée par la bulle : elle réserve la place de l'avatar
  // (disposition WeChat) et les marges de la liste, sans jamais coller au bord
  // ni écraser la bulle sur un petit écran.
  const bubbleWidth = useMemo(
    () => ({
      maxWidth: bubbleMaxWidth({
        windowWidth,
        horizontalPadding: Spacing.two,
        gap: Spacing.two,
      }),
    }),
    [windowWidth],
  );
  const textScale = useTextScale();
  const chatStyles = useMemo(
    () => ({
      screen: { backgroundColor: chat.screen },
      messageText: { color: chat.primaryText },
      secondaryText: { color: chat.secondaryText },
      bubbleMine: { backgroundColor: chat.mineBubble },
      bubbleTheirs: { backgroundColor: chat.theirBubble },
    }),
    [chat],
  );
  // Mêmes séparateurs de date/heure et mêmes regroupements que la conversation
  // claire ; la logique est pure et testée à part (rows.test.ts).
  const rows = useMemo(() => buildMessageRows(messages), [messages]);

  /** Aperçu d'un message cité, reconstruit localement depuis la base chiffrée. */
  const resolveQuote = useCallback(
    (quoteId: string | null): MessageQuote | null => {
      if (!quoteId) return null;
      const origin = messages.find((item) => item.id === quoteId);
      if (!origin) return null;
      const media = origin.media_meta ? decodeMediaMeta(origin.media_meta) : null;
      // Un sticker cité garde son type : l'aperçu affiche « Sticker » et non une
      // ligne vide. La référence, elle, reste locale (elle n'est jamais envoyée).
      // Un message illisible n'a pas de corps : le citer affiche le même
      // libellé que la bulle, jamais une ligne vide.
      const unreadable = Boolean(origin.unreadable_reason);
      return {
        id: origin.id,
        senderName: origin.sender_name,
        content: unreadable ? fr.e2eeChat.unreadableMessage : origin.body,
        type: unreadable ? 'text' : origin.sticker_ref ? 'sticker' : 'text',
        attachmentType: unreadable ? null : origin.sticker_ref ? 'STICKER' : (media?.type ?? null),
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
        // Le message est écrit sur cet appareil : c'est exactement ce que
        // signifie « Reçu » pour l'expéditeur. L'accusé ne part que si
        // l'application est active : reçu en arrière-plan, il attend le retour
        // au premier plan plutôt que de signaler une présence inexistante.
        const acked = deliveredIds([result.stored]);
        if (acked.length > 0) {
          if (canReportDelivered(ackGateRef.current)) {
            reportDelivered(acked);
          } else {
            pendingAckRef.current = [...pendingAckRef.current, ...acked];
          }
        }
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
        setFatal(null);
        // Initialisation partagée avec la porte de démarrage : son état est
        // consultable, et un échec n'est jamais silencieux.
        const boot = await runE2eeInit(token);
        if (claimKeysLostNotice(boot?.recovered)) {
          Alert.alert(fr.e2ee.keysLostTitle, fr.e2ee.keysLostBody);
        }
        const opened = await openE2eeDatabase();
        dbRef.current = opened.db;
        const account = await loadE2eeAccount(opened.db);
        if (!account) throw new Error('account_missing');
        accountRef.current = account;
        const storedDraft = await loadDraft(opened.db, conversationId);
        if (!cancelled) {
          // Saisie commencée avant la fin du chargement : c'est elle qui fait
          // foi, on ne la remplace pas par le brouillon stocké.
          const earlyTyping = draftQueueRef.current?.pending() ?? null;
          if (earlyTyping === null) {
            setDraft(storedDraft);
            // Le brouillon chiffré arrive après le premier rendu : on remonte le
            // compositeur pour qu'il démarre avec ce texte, au lieu d'afficher un
            // champ vide au-dessus d'un brouillon restauré.
            if (storedDraft) setComposerKey((key) => key + 1);
          }
          // Le brouillon stocké est connu : les écritures peuvent commencer.
          draftQueueRef.current?.enable();
        }
        const local = await listLocalMessages(opened.db, conversationId);
        if (!cancelled) setMessages(sortMessages(local));
        // États déjà connus du serveur : « Ouvert » reste affiché après un
        // redémarrage, sans dépendre d'un événement temps réel.
        const knownReceipts = await api.listReceipts(token, conversationId).catch(() => []);
        if (!cancelled && knownReceipts.length > 0) {
          setReceipts((current) => mergeReceipts(current, knownReceipts));
        }
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
        // L'accusé de lecture n'est émis que par la visibilité réelle
        // (`handleViewableItemsChanged`), jamais par le chargement.
        if (!cancelled) setReady(true);
      } catch (cause) {
        if (!cancelled) {
          const failure = classifyE2eeFailure(cause);
          // Aucun message d'exception brut à l'écran : une catégorie et un
          // libellé compréhensible, jamais un chemin, une clé ou un interne.
          if (failure === 'storage' || failure === 'crypto') {
            setFatal(failure);
            setError(null);
          } else {
            setError(describeE2eeFailure(failure).body);
            setReady(true);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, decryptChainRef, queueDecrypt, token, user, initAttempt]);

  // Suivi de la consultation réelle : le premier plan de l'écran et l'état de
  // l'application, pas la simple présence ni une notification.
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  /**
   * « Ouvert » n'est déclaré que pour les messages réellement visibles dans la
   * conversation consultée : écran au premier plan, application active, liste
   * chargée, et élément effectivement affiché (pas seulement en mémoire).
   * Un message hors écran, chargé mais non visible, ou reçu en arrière-plan
   * n'est jamais déclaré lu.
   */
  const flushReadPending = useCallback(() => {
    readTimerRef.current = null;
    if (!canMarkRead(readGateRef.current)) return;
    const ids = lastVisibleIdsRef.current;
    lastVisibleIdsRef.current = [];
    if (ids.length === 0) return;
    const currentToken = tokenRef.current;
    const conversationIdRefCurrent = conversationIdRef.current;
    if (!currentToken || !conversationIdRefCurrent) return;
    void api
      .markMessagesRead(currentToken, conversationIdRefCurrent, ids)
      .catch(() => {
        // Idempotent côté serveur : les identifiants restent en file pour la
        // prochaine visibilité, sans effet double.
        lastVisibleIdsRef.current = [...lastVisibleIdsRef.current, ...ids];
      });
  }, []);

  /**
   * Regroupe les lectures visibles avant l'appel réseau : le défilement
   * déclenche des visibilités par fenêtres, un court délai les fusionne.
   */
  const scheduleReadFlush = useCallback(() => {
    if (readTimerRef.current) clearTimeout(readTimerRef.current);
    readTimerRef.current = setTimeout(() => {
      void flushReadPending();
    }, 150);
  }, [flushReadPending]);

  /**
   * Traçage de viewport : la liste annonce les éléments réellement affichés
   * (seuil + stabilité). Les lectures passent seulement si la porte de
   * consultation réelle est ouverte *au moment de l'enregistrement*.
   */
  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewableRow[] }) => {
      const ids = visibleForeignMessageIds(viewableItems);
      lastVisibleIdsRef.current = ids;
      if (!canMarkRead(readGateRef.current)) return;
      scheduleReadFlush();
    },
    [scheduleReadFlush],
  );

  // Présence en ligne du correspondant : « Reçu » la suit en direct, sans
  // attendre un événement temps réel du serveur sur le métier.
  useEffect(() => {
    if (!peerId) {
      setPeerOnline(false);
      return;
    }
    const sync = () => {
      setPeerOnline(getPresenceRecord(peerId).state === 'online');
    };
    sync();
    return subscribePresenceUser(peerId, sync);
  }, [peerId]);

  // Synchronise les portes d'accusé/lecture et décharge les files dès que
  // l'application (et l'écran) redeviennent actifs.
  useEffect(() => {
    ackGateRef.current = { appActive, ready };
    readGateRef.current = { focused, appActive, ready };
    tokenRef.current = token;
    conversationIdRef.current = conversationId;
    if (canReportDelivered({ appActive, ready }) && pendingAckRef.current.length > 0) {
      const ids = pendingAckRef.current;
      pendingAckRef.current = [];
      reportDelivered(ids);
    }
    // Les lectures visibles en attente partent quand la porte s'ouvre : un
    // message devenu visible pendant le chargement n'est déclaré lu qu'après.
    if (canMarkRead({ focused, appActive, ready }) && lastVisibleIdsRef.current.length > 0) {
      scheduleReadFlush();
    }
  }, [appActive, conversationId, focused, ready, scheduleReadFlush, token]);

  // Le changement de discussion ne doit pas laisser filer une lecture de la
  // précédente : file, visible et minuteur sont vidés avant tout chargement.
  useEffect(() => {
    lastVisibleIdsRef.current = [];
    if (readTimerRef.current) {
      clearTimeout(readTimerRef.current);
      readTimerRef.current = null;
    }
    pendingAckRef.current = [];
  }, [conversationId]);

  useEffect(() => {
    if (!token || !ready || !isE2eeEnabled()) return;
    const socket = connectSocket(token);
    const onMessage = (message: Message) => {
      if (message.conversationId !== conversationId || message.sender.id === user?.id) return;
      if (message.encryption !== 'v1') return;
      // Un message arrivé n'est découvert que s'il devient visible : le
      // déchiffrement le rend, la visibilité décide de la lecture.
      void queueDecrypt(message);
    };
    // « Reçu » puis « Ouvert » : les états viennent du serveur, message par
    // message, et sont fusionnés sans jamais rétrograder une lecture connue.
    const onReceipt = (payload: { receipts?: MessageReceipt[] }) => {
      if (!Array.isArray(payload?.receipts) || payload.receipts.length === 0) return;
      setReceipts((current) => mergeReceipts(current, payload.receipts ?? []));
    };
    socket.on('message:new', onMessage);
    socket.on('receipt', onReceipt);
    void ensureSocket(token).catch(() => undefined);
    return () => {
      socket.off('message:new', onMessage);
      socket.off('receipt', onReceipt);
    };
  }, [conversationId, queueDecrypt, ready, token, user?.id]);

  useEffect(() => {
    return () => {
      const db = dbRef.current;
      dbRef.current = null;
      // Quitter l'écran referme les médias : aucun clair ne reste en cache.
      sweepSecureMedia();
      // Puis on laisse la dernière écriture de brouillon atteindre la base
      // avant de la refermer : sinon la frappe la plus récente serait perdue.
      void (async () => {
        await draftQueueRef.current?.idle();
        await db?.closeAsync().catch(() => undefined);
      })().catch(() => undefined);
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

  if (fatal) {
    const message = describeE2eeFailure(fatal);
    return (
      <ThemedView style={[styles.container, chatStyles.screen]}>
        {/* Même en-tête que la conversation : la panne est expliquée dans le
            corps, pas à la place du nom du correspondant. */}
        <ChatHeaderScreen title={title} subtitle="" blurTarget={blurTargetRef} />
        <BlurTarget ref={blurTargetRef} style={styles.flex}>
          <View style={styles.fatalBlock}>
            <ThemedText type="sectionTitle">{message.title}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.fatalBody}>
              {message.body}
            </ThemedText>
            <Pressable
              accessibilityRole="button"
              onPress={() => setInitAttempt((attempt) => attempt + 1)}
              style={({ pressed }) => [
                styles.fatalButton,
                { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
              ]}>
              <ThemedText style={styles.fatalLabel}>{fr.e2ee.retry}</ThemedText>
            </Pressable>
          </View>
        </BlurTarget>
      </ThemedView>
    );
  }

  // Représentation minimale de la conversation directe, telle que l'attendent
  // les fonctions d'envoi chiffré : l'identité des deux participants et
  // `e2eeSince` (le serveur reste l'autorité pour le routage, ceci ne sert
  // qu'aux enveloppes Olm).
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

  /**
   * Envoi chiffré d'un texte. Le contenu vient du compositeur, jamais du
   * brouillon en mémoire : une seule source, donc aucun risque d'envoyer un
   * texte différent de celui affiché.
   */
  const sendText = async (value: string, allowKeyChange = false) => {
    const text = value.trim();
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
      // Vidage et saisies passent par la même file : une écriture ancienne ne
      // peut pas ressusciter le brouillon envoyé.
      draftQueueRef.current?.set('');
      await draftQueueRef.current?.idle();
      setComposerKey((key) => key + 1);
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
            onPress: () => void sendText(text, true),
          },
          { text: fr.common.cancel, style: 'cancel' },
        ]);
      } else {
        Alert.alert(
          fr.e2eeChat.error,
          cause instanceof Error ? cause.message : '',
        );
      }
    } finally {
      setSending(false);
    }
  };

  const onChangeDraft = (value: string) => {
    setDraft(value);
    draftQueueRef.current?.set(value);
  };

  /**
   * Envoie un média chiffré : réduction et retrait des métadonnées pour une
   * photo, chiffrement, téléversement du ciphertext, puis enveloppe Olm `v:2`
   * avec la clé. L'identité du média ne quitte jamais l'appareil autrement que
   * chiffrée.
   */
  const sendMedia = async (asset: E2eeMediaAsset) => {
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
      setComposerKey((key) => key + 1);
    }
  };

  const pickPhotos = async () => {
    try {
      const picked = await pickLibraryMedia();
      if (!picked) return;
      setComposerKey((key) => key + 1);
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
      setComposerKey((key) => key + 1);
    }
  };

  const pickCamera = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return;
      // `quality`/`allowsEditing` : mêmes réglages que la conversation claire.
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 0.8,
      });
      setComposerKey((key) => key + 1);
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
      setComposerKey((key) => key + 1);
    }
  };

  const pickFiles = async () => {
    try {
      const picked = await pickDocuments();
      setComposerKey((key) => key + 1);
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
      setComposerKey((key) => key + 1);
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

  /**
   * Profil du correspondant, ouvert depuis le nom ou son avatar. Fonction
   * simple et non `useCallback` : elle est définie après les retours anticipés
   * de l'écran, un hook y serait appelé de façon conditionnelle.
   */
  const openPeerProfile = () => {
    const route = peerProfileRoute({
      peerId,
      name: params.name,
      username: peerUsername,
      avatarUrl: peerAvatarUrl,
      gender: peerGender,
    });
    // Sans identifiant réel, aucun profil n'est ouvert : on ne devine jamais
    // une identité à partir du nom affiché.
    if (route) router.push(route);
  };

  /** Aucun appel non chiffré ne part d'ici : on explique au lieu de faire semblant. */
  const notifyCallsUnavailable = () => {
    Alert.alert(fr.e2eeChat.callsUnavailableTitle, fr.e2eeChat.callsUnavailableBody);
  };

  const copyMessage = async (message: StoredE2eeMessage) => {
    if (!(await copyToClipboard(message.body))) {
      Alert.alert(fr.e2eeChat.error, fr.e2eeChat.copyFailed);
    }
  };

  /**
   * « Supprimer pour moi » : on retire la ligne locale (SQLCipher) et on
   * demande au serveur de ne plus la renvoyer à ce compte. Le correspondant
   * n'est pas concerné — il garde sa copie, c'est exactement la différence
   * avec « supprimer pour tous » (non proposé ici : la copie du pair est
   * déchiffrée sur son appareil, aucun retrait n'y est possible).
   */
  const deleteForMe = async (message: StoredE2eeMessage) => {
    const db = dbRef.current;
    if (!db) return;
    if (replyTo?.id === message.id) setReplyTo(null);
    setMessages((prev) => prev.filter((item) => item.id !== message.id));
    if (message.media_meta) {
      try {
        closeMedia(decodeMediaMeta(message.media_meta)?.blob.uploadId ?? '');
      } catch {
        // Fermeture best-effort : le média décorrelé reste inaccessible.
      }
    }
    void deleteLocalMessage(db, message.id).catch(() => undefined);
    try {
      await deleteMessage(token, conversationId, message.id, false);
    } catch {
      Alert.alert(fr.e2eeChat.error, fr.e2eeChat.deleteFailed);
    }
  };

  /** Seul un texte clair transitable est traférable ; jamais un média ou un illisible. */
  const isForwardable = (message: StoredE2eeMessage) =>
    Boolean(message.body) &&
    !message.media_meta &&
    !message.sticker_ref &&
    !message.unreadable_reason;

  const nameOf = (target: ConversationSummary) => {
    const other = target.members.find((member) => member.id !== user?.id);
    return target.name ?? other?.displayName ?? other?.username ?? fr.e2eeChat.title;
  };

  /** Les cibles ne sont que des discussions directes chiffrées (jamais du clair). */
  const openForward = (message: StoredE2eeMessage) => {
    setForwardFor(message);
    setForwardTargets([]);
    setForwardLoading(true);
    void api
      .listConversations(token)
      .then((list) => {
        const targets = (list ?? []).filter(
          (target) =>
            target.type === 'DIRECT' && !!target.e2eeSince && target.id !== conversationId,
        );
        setForwardTargets(targets);
      })
      .catch(() => setForwardTargets([]))
      .finally(() => setForwardLoading(false));
  };

  /** Ré-émission chiffrée vers le pair de la discussion cible. */
  const doForward = (message: StoredE2eeMessage, target: ConversationSummary) => {
    const db = dbRef.current;
    const account = accountRef.current;
    setForwardFor(null);
    if (!db || !account || !user) return;
    void (async () => {
      try {
        await sendEncryptedText({
          token,
          db,
          account,
          conversation: target,
          currentUserId: user.id,
          currentUserName: user.displayName,
          text: message.body,
        });
        Alert.alert(fr.e2eeChat.forward, fr.e2eeChat.forwardDone);
      } catch (cause) {
        if (cause instanceof E2eeKeyChangedError) {
          Alert.alert(fr.e2eeChat.keyChangedTitle, fr.e2eeChat.keyChangedBody);
        } else {
          Alert.alert(fr.e2eeChat.error, fr.e2eeChat.forwardError);
        }
      }
    })();
  };

  const menuActions: SheetAction[] = menuFor
    ? [
        {
          key: 'reply',
          label: fr.e2eeChat.reply,
          icon: Reply,
          onPress: () => setReplyTo(menuFor),
        },
        ...(isForwardable(menuFor)
          ? [
              {
                key: 'forward',
                label: fr.e2eeChat.forward,
                icon: Forward,
                onPress: () => void openForward(menuFor),
              } as SheetAction,
            ]
          : []),
        ...(menuFor.body
          ? [
              {
                key: 'copy',
                label: fr.e2eeChat.copy,
                icon: Copy,
                onPress: () => void copyMessage(menuFor),
              } as SheetAction,
            ]
          : []),
        {
          key: 'info',
          label: fr.e2eeChat.messageInfo,
          icon: Info,
          onPress: () => setInfoFor(menuFor),
        },
        {
          key: 'deleteForMe',
          label: fr.e2eeChat.deleteForMe,
          icon: Trash2,
          destructive: true,
          onPress: () => void deleteForMe(menuFor),
        },
      ]
    : [];

  const renderRow = ({ item }: { item: E2eeListRow }) => {
    if (item.type === 'date') {
      return <ChatDateSeparator label={item.label} />;
    }
    if (item.type === 'time') {
      return <ChatTimeSeparator label={item.label} />;
    }
    const message = item.message;
    // La référence du média vit dans la base chiffrée ; l'enveloppe ne porte
    // que le texte. Un média sans référence exploitable s'affiche comme un
    // simple texte, jamais comme une erreur.
    const media = message.media_meta ? decodeMediaMeta(message.media_meta) : null;
    const mine = message.mine === 1;
    const quote = resolveQuote(message.quote_id);
    const stickerRef = message.sticker_ref ?? null;

    const avatarName = mine ? (user?.displayName ?? fr.e2eeChat.me) : message.sender_name;
    const avatarUri = mine ? user?.avatarUrl : peerAvatarUrl;
    const rowProps = {
      mine,
      continuation: item.continuation,
      avatarName,
      avatarUri,
      gender: mine ? null : peerGender,
      // L'avatar du correspondant ouvre son profil ; le mien reste inerte.
      onAvatarPress: mine ? undefined : openPeerProfile,
    };
    const openMenu = () => setMenuFor(message);
    const startReply = () => setReplyTo(message);

    // Sticker de catalogue : dessiné hors bulle (règle WeChat), comme en clair.
    if (stickerRef) {
      return (
        <ChatMessageRow {...rowProps}>
          <SwipeableBubble
            mine={mine}
            onReply={startReply}
            onLongPress={openMenu}
            style={bubbleWidth}
            accessibilityLabel={fr.e2eeChat.messageOptions}>
            <View
              style={[styles.stickerMessageBlock, mine ? styles.stickerMessageBlockMine : null]}>
              {quote ? (
                <View style={styles.stickerReplyQuote}>
                  <QuoteBlock quote={quote} mine={mine} />
                </View>
              ) : null}
              <StickerMessage stickerRef={stickerRef} size={140} />
            </View>
          </SwipeableBubble>
          {mine ? <MessageReceiptLabel state={receiptState(receipts[message.id], user?.id, peerOnline)} /> : null}
        </ChatMessageRow>
      );
    }

    // Média : bloc à largeur fixe, **sans bulle**. C'est la différence visible
    // avec l'écran classique : la photo était noyée dans une bulle rembourrée
    // qui la tirait sur toute la largeur de la colonne.
    if (media) {
      const blockWidth =
        media.type === 'FILE'
          ? Math.min(280, Math.round(windowWidth * 0.7))
          : mediaDisplaySize(
              { width: media.width, height: media.height },
              windowWidth,
            ).width;
      return (
        <ChatMessageRow {...rowProps}>
          <SwipeableBubble
            mine={mine}
            onReply={startReply}
            onLongPress={openMenu}
            style={bubbleWidth}
            accessibilityLabel={fr.e2eeChat.messageOptions}>
            <View
              style={[
                styles.mediaBlock,
                mine ? styles.mediaBlockMine : styles.mediaBlockOther,
                { width: blockWidth },
              ]}>
              {quote ? (
                <View
                  style={[
                    styles.mediaQuote,
                    mine ? chatStyles.bubbleMine : chatStyles.bubbleTheirs,
                  ]}>
                  <QuoteBlock quote={quote} mine={mine} />
                </View>
              ) : null}
              <SecureMediaMessage
                token={token}
                media={media}
                mine={mine}
                caption={message.body}
                onLongPress={openMenu}
                onOpen={(uri, opened) => {
                  const id = opened.blob.uploadId;
                  if (opened.type === 'FILE') {
                    // Un document déchiffré s'ouvre dans la visionneuse locale
                    // (le fichier est déjà sur le disque, plus rien à charger).
                    // Son clair ne sera libéré qu'au retour sur cet écran.
                    openedDocumentRef.current = id;
                    router.push({
                      pathname: '/document-viewer',
                      params: {
                        url: uri,
                        name: opened.name ?? fr.e2eeMedia.fileFallbackName,
                        mime: opened.mime,
                        size: String(opened.blob.size ?? 0),
                      },
                    });
                    return;
                  }
                  setViewer({ id, uri, kind: opened.type === 'VIDEO' ? 'video' : 'image' });
                }}
              />
            </View>
          </SwipeableBubble>
          {mine ? <MessageReceiptLabel state={receiptState(receipts[message.id], user?.id, peerOnline)} /> : null}
        </ChatMessageRow>
      );
    }

    // Message d'un à trois emojis : bloc large sans bulle, comme en clair.
    const trimmed = message.body.trim();
    const emojiCount = message.unreadable_reason ? 0 : emojiOnlyCount(trimmed);
    if (emojiCount >= 1 && emojiCount <= 3) {
      const emojiSegment =
        emojiCount === 1
          ? splitEmoji(trimmed).find(
              (segment): segment is EmojiSegment => segment.type === 'emoji',
            )
          : undefined;
      const createdAtMs = Date.parse(message.created_at) || 0;
      const fresh = Date.now() - createdAtMs < 15_000;
      return (
        <ChatMessageRow {...rowProps}>
          <SwipeableBubble
            mine={mine}
            onReply={startReply}
            onLongPress={openMenu}
            style={bubbleWidth}
            accessibilityLabel={fr.e2eeChat.messageOptions}>
            <View style={[styles.emojiOnlyBlock, mine ? styles.emojiOnlyBlockMine : null]}>
              {quote ? (
                <View style={styles.emojiOnlyQuote}>
                  <QuoteBlock quote={quote} mine={mine} />
                </View>
              ) : null}
              {emojiCount === 1 && emojiSegment ? (
                <SingleEmojiMessage
                  emoji={emojiSegment.value}
                  messageId={message.client_id ?? message.id}
                  fresh={fresh}
                />
              ) : (
                <MessageText
                  text={trimmed}
                  style={[styles.emojiOnlyText, chatStyles.messageText]}
                />
              )}
              <View style={[styles.emojiOnlyMeta, mine ? styles.emojiOnlyMetaMine : null]}>
                <ThemedText style={[styles.emojiOnlyTime, chatStyles.secondaryText]}>
                  {formatClock(message.created_at)}
                </ThemedText>
              </View>
            </View>
          </SwipeableBubble>
          {mine ? <MessageReceiptLabel state={receiptState(receipts[message.id], user?.id, peerOnline)} /> : null}
        </ChatMessageRow>
      );
    }

    return (
      <ChatMessageRow {...rowProps}>
        <SwipeableBubble
          mine={mine}
          onReply={startReply}
          onLongPress={openMenu}
          style={bubbleWidth}
          accessibilityLabel={fr.e2eeChat.messageOptions}>
          <ChatBubble mine={mine}>
            {quote ? <QuoteBlock quote={quote} mine={mine} /> : null}
            {message.unreadable_reason ? (
              // Le motif (`unreadable_reason`) est la seule source de vérité :
              // un corps vide légitime reste un message vide, il n'affiche
              // jamais ce libellé. Aucun contenu du payload n'est exposé.
              <ThemedText type="small" style={[styles.unreadableText, chatStyles.messageText]}>
                {fr.e2eeChat.unreadableMessage}
              </ThemedText>
            ) : (
              // Même rendu de texte que la conversation claire : emojis Mbolo,
              // même corps, même interligne, même mise à l'échelle du texte.
              <MessageText
                text={message.body}
                style={[
                  styles.messageText,
                  chatStyles.messageText,
                  textScale.factor !== 1
                    ? {
                        fontSize: 16 * textScale.factor,
                        lineHeight: 21 * textScale.factor,
                      }
                    : null,
                ]}
              />
            )}
          </ChatBubble>
        </SwipeableBubble>
        {mine ? <MessageReceiptLabel state={receiptState(receipts[message.id], user?.id, peerOnline)} /> : null}
      </ChatMessageRow>
    );
  };

  const replyQuote: MessageQuote | null = replyTo
    ? {
        id: replyTo.id,
        senderName: replyTo.sender_name,
        content: replyTo.unreadable_reason ? fr.e2eeChat.unreadableMessage : replyTo.body,
        type: replyTo.sticker_ref ? 'sticker' : 'text',
        attachmentType: replyTo.sticker_ref
          ? 'STICKER'
          : replyTo.media_meta
            ? (decodeMediaMeta(replyTo.media_meta)?.type ?? null)
            : null,
        deleted: false,
      }
    : null;

  return (
    <ThemedView
      style={[
        styles.container,
        chatStyles.screen,
        // Android (edge-to-edge) : la fenêtre n'est pas redimensionnée, on
        // pousse donc nous-mêmes le contenu au-dessus du clavier.
        keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : null,
      ]}>
      <ChatHeaderScreen
        title={title}
        // Disposition WeChat : ni avatar, ni sous-titre chiffré, ni cadenas,
        // ni recherche. Le nom seul, cliquable, ouvre le profil du
        // correspondant ; la présence réelle reste dessous.
        subtitle=""
        presenceUserId={peerId || undefined}
        onPressTitle={openPeerProfile}
        titleAccessibilityLabel={`${fr.e2eeChat.viewProfile} — ${title}`}
        right={
          <View style={styles.headerCallActions}>
            {/* Les appels ne passent pas encore par le chiffrement de bout en
                bout : les icônes gardent leur place, mais elles sont inertes et
                annoncées comme telles. Aucun appel non chiffré ne part d'ici. */}
            <Pressable
              onPress={notifyCallsUnavailable}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ disabled: true }}
              accessibilityLabel={fr.e2eeChat.callVideoUnavailable}
              style={({ pressed }) => [
                styles.headerCallDisabled,
                pressed ? styles.headerCallPressed : null,
              ]}>
              <Video size={26} color={chat.headerText} />
            </Pressable>
            <Pressable
              onPress={notifyCallsUnavailable}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ disabled: true }}
              accessibilityLabel={fr.e2eeChat.callVoiceUnavailable}
              style={({ pressed }) => [
                styles.headerCallDisabled,
                pressed ? styles.headerCallPressed : null,
              ]}>
              {/* Combiné retourné (sens « raccroché »), comme en un à un. */}
              <View style={styles.phoneFlipped}>
                <Phone size={22} color={chat.headerText} />
              </View>
            </Pressable>
          </View>
        }
        blurTarget={blurTargetRef}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        onLayout={(event) => setChatAreaHeight(event.nativeEvent.layout.height)}
        style={styles.flex}>
        <BlurTarget ref={blurTargetRef} style={styles.flex}>
          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={(row) => row.key}
            viewabilityConfig={READ_VIEWABILITY_CONFIG}
            onViewableItemsChanged={handleViewableItemsChanged}
            contentContainerStyle={[
              styles.listContent,
              rows.length === 0 ? styles.listContentEmpty : null,
            ]}
            keyboardShouldPersistTaps="handled"
            onScroll={(event) => {
              // Liste simple (non inversée) : on recolle un nouvel arrivant
              // seulement si l'utilisateur était déjà en bas.
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              atBottomRef.current =
                contentSize.height - contentOffset.y - layoutMeasurement.height < 48;
            }}
            scrollEventThrottle={160}
            onContentSizeChange={() => {
              if (atBottomRef.current) listRef.current?.scrollToEnd({ animated: false });
            }}
            renderItem={renderRow}
            ListEmptyComponent={
              ready ? (
                <ChatEmptyState
                  avatar={
                    <Avatar
                      name={title}
                      uri={peerAvatarUrl ?? undefined}
                      size={72}
                      variant="user"
                      gender={peerGender}
                    />
                  }
                  title={fr.e2eeChat.emptyGreeting}
                  text={fr.e2eeChat.emptyHint}
                  suggestions={fr.e2eeChat.emptySuggestions}
                  onSuggestion={(value) => void sendText(value)}
                />
              ) : undefined
            }
          />
        </BlurTarget>
        {error ? (
          <ThemedText type="small" style={[styles.error, { color: chat.error }]}>
            {fr.e2eeChat.error}: {error}
          </ThemedText>
        ) : null}
        {replyTo && replyQuote ? (
          <View onLayout={(event) => setReplyBarHeight(event.nativeEvent.layout.height)}>
            <ChatReplyBar quote={replyQuote} onCancel={() => setReplyTo(null)} />
          </View>
        ) : null}
        <ChatComposer
          key={composerKey}
          blurTarget={blurTargetRef}
          initialText={draft}
          onSendText={(value) => void sendText(value)}
          // Les stickers et GIF ne sont pas encore envoyés en chiffré : les
          // onglets correspondants ne sont pas proposés (aucune fausse
          // promesse), et ces rappels ne peuvent pas être atteints.
          sections={['emoji']}
          onSendSticker={() => undefined}
          onSendPersonalSticker={() => undefined}
          recentGifs={[]}
          onSendGif={() => undefined}
          onSendVoice={(note) => void sendVoiceNote(note)}
          onVoicePermissionDenied={() => Alert.alert(fr.e2eeMedia.micTitle, fr.e2eeMedia.micBody)}
          onVoiceError={() =>
            Alert.alert(fr.e2eeChat.error, fr.e2eeChat.mediaSendFailed)
          }
          onTextChange={onChangeDraft}
          bottomInset={insets.bottom}
          availableHeight={
            chatAreaHeight > 0
              ? Math.max(0, chatAreaHeight - (replyTo ? replyBarHeight : 0))
              : undefined
          }
          plusPanel={
            <AttachPanel
              onPhotos={() => void pickPhotos()}
              onCamera={() => void pickCamera()}
              onDocuments={() => void pickFiles()}
            />
          }
        />
      </KeyboardAvoidingView>
      <ActionSheet
        visible={menuFor !== null}
        title={fr.e2eeChat.messageOptions}
        actions={menuActions}
        onClose={() => setMenuFor(null)}
      />
      <ActionSheet
        visible={infoFor !== null}
        title={fr.e2eeChat.messageInfo}
        actions={[]}
        onClose={() => setInfoFor(null)}
        header={
          <View style={styles.infoRows}>
            <View style={styles.infoRow}>
              <ThemedText style={chatStyles.secondaryText}>{fr.e2eeChat.infoSender}</ThemedText>
              <ThemedText>
                {infoFor && infoFor.mine === 1
                  ? fr.e2eeChat.me
                  : (infoFor?.sender_name ?? title)}
              </ThemedText>
            </View>
            <View style={styles.infoRow}>
              <ThemedText style={chatStyles.secondaryText}>{fr.e2eeChat.infoSentAt}</ThemedText>
              <ThemedText>
                {infoFor
                  ? `${formatDateLabel(infoFor.created_at)} · ${formatClock(infoFor.created_at)}`
                  : ''}
              </ThemedText>
            </View>
            <View style={styles.infoRow}>
              <ThemedText style={chatStyles.secondaryText}>{fr.e2eeChat.infoType}</ThemedText>
              <ThemedText>
                {infoFor?.unreadable_reason
                  ? fr.e2eeChat.infoTypeUnreadable
                  : infoFor?.media_meta
                    ? fr.e2eeChat.infoTypeMedia
                    : infoFor?.sticker_ref
                      ? fr.e2eeChat.infoTypeSticker
                      : fr.e2eeChat.infoTypeText}
              </ThemedText>
            </View>
            <View style={styles.infoRow}>
              <ThemedText style={chatStyles.secondaryText}>{fr.e2eeChat.infoState}</ThemedText>
              <ThemedText>
                {infoFor
                  ? (() => {
                      const state = receiptState(
                        receipts[infoFor.id],
                        user?.id,
                        peerOnline,
                      );
                      return state === 'read'
                        ? fr.e2eeChat.receiptRead
                        : state === 'delivered'
                          ? fr.e2eeChat.receiptDelivered
                          : fr.e2eeChat.infoStateNone;
                    })()
                  : ''}
              </ThemedText>
            </View>
          </View>
        }
      />
      <ActionSheet
        visible={forwardFor !== null}
        title={fr.e2eeChat.forwardTo}
        actions={[]}
        onClose={() => setForwardFor(null)}
        header={
          <View>
            {forwardLoading ? (
              <ThemedText style={styles.forwardNote}>{fr.e2eeChat.forwardLoading}</ThemedText>
            ) : forwardTargets.length === 0 ? (
              <ThemedText style={styles.forwardNote}>{fr.e2eeChat.forwardNoTarget}</ThemedText>
            ) : (
              forwardTargets.map((target) => (
                <Pressable
                  key={target.id}
                  onPress={() => {
                    if (forwardFor) doForward(forwardFor, target);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={nameOf(target)}>
                  <ThemedText style={styles.forwardRow}>{nameOf(target)}</ThemedText>
                </Pressable>
              ))
            )}
          </View>
        }
      />
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
  flex: { flex: 1 },
  /**
   * La liste n'est pas inversée : on garde l'ordre chronologique et on recolle
   * le bas seulement si l'utilisateur y était déjà. Les marges et les
   * séparateurs viennent des composants partagés avec la conversation claire.
   */
  listContent: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
    flexGrow: 1,
  },
  listContentEmpty: { justifyContent: 'center' },
  headerCallActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  /** Icônes d'appel présentes mais inactives tant que l'appel n'est pas chiffré. */
  headerCallDisabled: { opacity: 0.45 },
  headerCallPressed: { opacity: 0.6 },
  phoneFlipped: { transform: [{ rotate: '135deg' }] },
  /** Bloc média : largeur fixe comme en clair, aucun rembourrage de bulle. */
  mediaBlock: { gap: Spacing.one },
  mediaBlockMine: { alignItems: 'flex-end' },
  mediaBlockOther: { alignItems: 'flex-start' },
  mediaQuote: {
    width: '100%',
    borderRadius: Radii.sm,
    padding: Spacing.one,
  },
  emojiOnlyBlock: { maxWidth: 180, gap: 4 },
  emojiOnlyBlockMine: { alignItems: 'flex-end' },
  emojiOnlyQuote: { width: 160 },
  emojiOnlyText: { textAlign: 'center' },
  emojiOnlyMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  emojiOnlyMetaMine: { justifyContent: 'flex-end' },
  emojiOnlyTime: { fontSize: 11, lineHeight: 14 },
  /** Un sticker n'a pas de bulle : juste la largeur de l'illustration. */
  stickerMessageBlock: { maxWidth: 160, gap: 4 },
  stickerMessageBlockMine: { alignItems: 'flex-end' },
  stickerReplyQuote: { width: 160 },
  messageText: { fontSize: 16, lineHeight: 21 },
  fatalBlock: { flex: 1, justifyContent: 'center', padding: Spacing.four, gap: Spacing.three },
  fatalBody: { lineHeight: 20 },
  fatalButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Radii.full,
  },
  fatalLabel: { fontWeight: '600' },
  unreadableText: { fontStyle: 'italic', opacity: 0.8 },
  error: { color: '#e5484d', paddingHorizontal: Spacing.three },
  infoRows: { gap: Spacing.two, paddingBottom: Spacing.two },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  forwardNote: { paddingVertical: Spacing.two },
  forwardRow: {
    paddingVertical: Spacing.threeHalf,
    paddingHorizontal: Spacing.one,
  },
});
