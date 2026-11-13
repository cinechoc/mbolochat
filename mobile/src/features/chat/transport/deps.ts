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
