import type { ChatIdentity } from './types';
import type { ConversationSummary } from '@/lib/types';

type ApiModule = typeof import('@/lib/api');
type CacheModule = typeof import('@/lib/cache');
type OutboxModule = typeof import('@/lib/outbox');
type SocketModule = typeof import('@/lib/socket');
type SyncModule = typeof import('@/lib/sync');

/**
 * Dépendances injectables du transport classique.
 *
 * Les types sont dérivés des modules réels (`typeof import`), mais l'instance
 * de production est fournie par l'appelant : les tests substituent des faux
 * sans charger les modules natifs (SQLite, socket, filesystem).
 */
export interface ClassicTransportDeps {
  api: Pick<ApiModule['api'], 'getConversation' | 'listMessages' | 'listReceipts'>;
  cache: Pick<
    CacheModule['cache'],
    | 'getConversation'
    | 'getMessages'
    | 'setMessages'
    | 'setConversation'
    | 'getDraft'
    | 'setDraft'
    | 'clearDraft'
  >;
  outbox: Pick<
    OutboxModule,
    | 'enqueue'
    | 'drain'
    | 'listOutbox'
    | 'subscribe'
    | 'onSent'
    | 'discard'
    | 'retry'
    | 'pendingMessage'
    | 'localCreatedAtMs'
  >;
  socket: Pick<
    SocketModule,
    'connectSocket' | 'getSocket' | 'onConnection' | 'reportDelivered' | 'deleteMessage' | 'toggleReaction'
  >;
  sync: Pick<SyncModule, 'advanceCursor' | 'onMissedMessages'>;
  /** Horloge injectable : les tests n'attendent pas le temps réel. */
  clock: () => number;
}

export interface ClassicTransportOptions {
  conversationId: string;
  token: string;
  currentUser: ChatIdentity;
  /** Résumé déjà résolu (serveur ou cache). */
  summary: ConversationSummary;
}

type E2eeDbModule = typeof import('@/features/e2ee/db');
type E2eeTextModule = typeof import('@/features/e2ee/text');
type E2eeMediaModule = typeof import('@/features/e2ee/media');
type E2eeReceiptsModule = typeof import('@/features/e2ee/receipts');

/**
 * Dépendances injectables du transport chiffré. Les fonctions crypto sont
 * **importées telles quelles** : aucun export n'est ajouté dans
 * `features/e2ee/`, et les tests fournissent des faux.
 */
export interface E2eeTransportDeps {
  api: Pick<ApiModule['api'], 'listMessages' | 'listReceipts' | 'markMessagesRead'>;
  socket: Pick<
    SocketModule,
    'connectSocket' | 'ensureSocket' | 'reportDelivered' | 'deleteMessage'
  >;
  db: Pick<
    E2eeDbModule,
    | 'openE2eeDatabase'
    | 'loadE2eeAccount'
    | 'listLocalMessages'
    | 'knownMessageKeys'
    | 'saveDraft'
    | 'loadDraft'
    | 'deleteLocalMessage'
  >;
  crypto: Pick<E2eeTextModule, 'sendEncryptedText' | 'decryptIncoming'> &
    Pick<E2eeMediaModule, 'sendEncryptedMedia'>;
  receipts: Pick<
    E2eeReceiptsModule,
    'mergeReceipts' | 'receiptState' | 'deliveredIds' | 'canReportDelivered'
  >;
  clock: () => number;
}

export interface E2eeTransportOptions {
  conversationId: string;
  token: string;
  currentUser: ChatIdentity;
  /** Identité du pair, déjà résolue par le mode (jamais un nom seul). */
  peer: ChatIdentity;
  summary: ConversationSummary;
  /** Application au premier plan : porte des accusés de livraison. */
  isForeground: () => boolean;
  /** Présence réelle du pair : conditionne l'affichage « Reçu ». */
  isPeerOnline: () => boolean;
}
