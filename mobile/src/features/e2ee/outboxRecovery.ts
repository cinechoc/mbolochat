import {
  listPendingEnvelopes,
  markEnvelopeSent,
  resetEnvelopeForRetry,
  setEnvelopeState,
  type PendingOutboxEnvelope,
} from './atomic';
import {
  loadE2eeAccount,
  loadLocalMessageByClientId,
  listPendingViewOnceConsumptions,
  markViewOnceServerHidden,
  markLocalMessageSendError,
  openE2eeDatabase,
  renameLocalMessage,
  type StoredE2eeMessage,
} from './db';
import { resumeEncryptedMedia } from './media';
import {
  listIncompleteMediaPreparations,
  noteMediaPreparationError,
} from './mediaPrep';
import { api } from '@/lib/api';
import { deleteMessage, ensureSocket, onConnection } from '@/lib/socket';
import type { Message } from '@/lib/types';

const BATCH_SIZE = 20;
const MAX_PASSES = 5;
const SEND_TIMEOUT_MS = 15_000;

export interface E2eeOutboxConfig {
  token: string;
  currentUserId: string;
  currentUserName: string;
}

export type E2eeOutboxEvent =
  | {
      type: 'sent';
      conversationId: string;
      previousId: string;
      stored: StoredE2eeMessage | null;
    }
  | {
      type: 'failed';
      conversationId: string;
      previousId: string;
      stored: StoredE2eeMessage | null;
    };

let config: E2eeOutboxConfig | null = null;
let draining: Promise<void> | null = null;
const listeners = new Set<(event: E2eeOutboxEvent) => void>();

function emit(event: E2eeOutboxEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Un abonné d'interface ne doit jamais bloquer la reprise réseau.
    }
  }
}

export function onE2eeOutboxEvent(listener: (event: E2eeOutboxEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Démarre la reprise automatique après chaque retour de connexion. Le premier
 * passage peut précéder le bootstrap : il ne fait alors rien, et le bootstrap
 * réveille explicitement la file une fois l'identité prête.
 */
export function startE2eeOutboxRecovery(next: E2eeOutboxConfig): () => void {
  config = next;
  const offConnection = onConnection((connected) => {
    if (connected) void drainE2eeOutbox();
  });
  return () => {
    offConnection();
    if (config === next) config = null;
  };
}

export function wakeE2eeOutboxRecovery(): void {
  void drainE2eeOutbox();
}

/**
 * Rejoue les enveloppes déjà chiffrées qui n'ont jamais reçu d'accusé.
 *
 * Aucun nouveau chiffrement : le couple session/enveloppe est réutilisé tel
 * quel. Deux passes concurrentes sont impossibles et le serveur déduplique par
 * `clientId`, ce qui rend une reprise après un accusé perdu inoffensive.
 */
export function drainE2eeOutbox(): Promise<void> {
  if (draining) return draining;
  draining = runDrain()
    .catch(() => undefined)
    .finally(() => {
      draining = null;
    });
  return draining;
}

async function runDrain(): Promise<void> {
  const active = config;
  if (!active) return;
  const { db } = await openE2eeDatabase(active.currentUserId);
  try {
    const account = await loadE2eeAccount(db);
    if (!account || account.user_id !== active.currentUserId) return;
    const socket = await ensureSocket(active.token);

    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const pending = await listPendingEnvelopes(db, account.identity_key, BATCH_SIZE);
      if (pending.length === 0) break;
      let stop = false;
      for (const row of pending) {
        const outcome = await sendOne(db, socket, row);
        if (outcome === 'network') {
          stop = true;
          break;
        }
      }
      if (stop || pending.length < BATCH_SIZE) break;
    }
    await recoverMedia(db, account, active);
    await hideConsumedViewOnce(db, active.token);
  } finally {
    await db.closeAsync().catch(() => undefined);
  }
}

/** Rejoue les masquages de lectures uniques consommées pendant une coupure. */
async function hideConsumedViewOnce(
  db: Awaited<ReturnType<typeof openE2eeDatabase>>['db'],
  token: string,
): Promise<void> {
  const pending = await listPendingViewOnceConsumptions(db).catch(() => []);
  for (const item of pending) {
    try {
      await deleteMessage(token, item.conversation_id, item.message_id, false);
      await markViewOnceServerHidden(db, item.message_id);
    } catch {
      // Toujours hors ligne ou refus temporaire : la tombstone reste en place
      // et sera retentée à la prochaine reconnexion.
    }
  }
}

async function recoverMedia(
  db: Awaited<ReturnType<typeof openE2eeDatabase>>['db'],
  account: NonNullable<Awaited<ReturnType<typeof loadE2eeAccount>>>,
  active: E2eeOutboxConfig,
): Promise<void> {
  const preparations = await listIncompleteMediaPreparations(db).catch(() => []);
  for (const preparation of preparations) {
    if (
      preparation.outcome.kind !== 'recoverable' ||
      preparation.outcome.next !== 'emit' ||
      (preparation.outboxState !== 'pending' && preparation.outboxState !== 'sending')
    ) {
      continue;
    }
    try {
      const conversation = await api.getConversation(active.token, preparation.conversationId);
      if (!conversation.e2eeSince || conversation.type !== 'DIRECT') {
        throw new Error('media_conversation_not_e2ee');
      }
      const result = await resumeEncryptedMedia({
        token: active.token,
        db,
        account,
        conversation,
        currentUserId: active.currentUserId,
        currentUserName: active.currentUserName,
        clientId: preparation.clientId,
      });
      emit({
        type: 'sent',
        conversationId: preparation.conversationId,
        previousId: preparation.clientId,
        stored: result.stored,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await noteMediaPreparationError(db, preparation.clientId, message).catch(() => undefined);
      const stored = await loadLocalMessageByClientId(db, preparation.clientId).catch(() => null);
      if (stored) {
        await markLocalMessageSendError(db, stored.id).catch(() => undefined);
        emit({
          type: 'failed',
          conversationId: preparation.conversationId,
          previousId: preparation.clientId,
          stored: { ...stored, send_error: 'send_failed' },
        });
      }
      if (isNetworkFailure(message)) return;
    }
  }
}

function isNetworkFailure(message: string): boolean {
  return (
    message === 'network' ||
    message.includes('Connexion au serveur impossible') ||
    message.includes('timeout') ||
    message.includes('réseau')
  );
}

async function sendOne(
  db: Awaited<ReturnType<typeof openE2eeDatabase>>['db'],
  socket: Awaited<ReturnType<typeof ensureSocket>>,
  row: PendingOutboxEnvelope,
): Promise<'ok' | 'refused' | 'network'> {
  await setEnvelopeState(db, row.clientId, 'sending', { incrementAttempts: true });
  // La ligne locale précède toujours le journal d'enveloppe : elle porte le
  // drapeau de lecture unique que le serveur doit aussi connaître.
  const local = await loadLocalMessageByClientId(db, row.clientId).catch(() => null);

  let result: Message | { error?: string } | undefined;
  try {
    result = (await socket.timeout(SEND_TIMEOUT_MS).emitWithAck('message:send', {
      conversationId: row.conversationId,
      content: '',
      encryption: 'v1',
      payload: row.envelope.payload,
      payloadType: row.envelope.payloadType,
      clientId: row.clientId,
      viewOnce: local?.view_once === 1,
    })) as Message | { error?: string } | undefined;
  } catch {
    await setEnvelopeState(db, row.clientId, 'pending', { error: 'network' });
    await markLocalMessageSendError(db, row.clientId).catch(() => undefined);
    await emitFailure(db, row);
    return 'network';
  }

  if (!result || ('error' in result && result.error)) {
    await setEnvelopeState(db, row.clientId, 'failed', { error: 'server_refused' });
    await markLocalMessageSendError(db, row.clientId).catch(() => undefined);
    await emitFailure(db, row);
    return 'refused';
  }

  const serverMessage = result as Message;
  if (typeof serverMessage.id !== 'string' || serverMessage.id.length === 0) {
    await setEnvelopeState(db, row.clientId, 'pending', { error: 'network' });
    await markLocalMessageSendError(db, row.clientId).catch(() => undefined);
    await emitFailure(db, row);
    return 'network';
  }

  if (local) {
    if (local.id === row.clientId) {
      await renameLocalMessage(db, row.clientId, serverMessage.id);
    } else {
      await markLocalMessageSendError(db, local.id, null);
    }
  }
  await markEnvelopeSent(db, row.clientId, serverMessage.id);
  if (local) {
    emit({
      type: 'sent',
      conversationId: row.conversationId,
      previousId: row.clientId,
      stored: {
        ...local,
        id: serverMessage.id,
        client_id: row.clientId,
        created_at: serverMessage.createdAt,
        send_error: null,
      },
    });
  }
  return 'ok';
}

async function emitFailure(
  db: Awaited<ReturnType<typeof openE2eeDatabase>>['db'],
  row: PendingOutboxEnvelope,
): Promise<void> {
  const stored = await loadLocalMessageByClientId(db, row.clientId).catch(() => null);
  if (!stored) return;
  emit({
    type: 'failed',
    conversationId: row.conversationId,
    previousId: row.clientId,
    stored,
  });
}

export async function retryE2eeOutboxMessage(
  clientId: string,
  currentUserId?: string,
): Promise<void> {
  const owner = currentUserId ?? config?.currentUserId;
  if (!owner) throw new Error('e2ee_account_missing');
  const { db } = await openE2eeDatabase(owner);
  try {
    await resetEnvelopeForRetry(db, clientId);
    await markLocalMessageSendError(db, clientId, null).catch(() => undefined);
  } finally {
    await db.closeAsync().catch(() => undefined);
  }
  wakeE2eeOutboxRecovery();
}
