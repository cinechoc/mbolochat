import type { SQLiteDatabase } from 'expo-sqlite';

import { api } from '@/lib/api';
import type { ConversationSummary } from '@/lib/types';
import {
  listDueScheduledMessages,
  loadE2eeAccount,
  loadLocalMessage,
  markLocalMessageSendError,
  nextScheduledMessageAt,
  openE2eeDatabase,
  saveLocalMessage,
  type StoredE2eeMessage,
} from './db';
import {
  decodePreviewMeta,
  isEncryptedLinkPreview,
  type EncryptedLinkPreview,
} from './payload';
import { sendEncryptedText } from './text';

const MAX_DUE_BATCH = 20;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MISSING_ACCOUNT_RETRY_MS = 30_000;

export interface ScheduledQueueConfig {
  token: string;
  currentUserId: string;
  currentUserName: string;
}

export interface EnqueueScheduledTextInput extends ScheduledQueueConfig {
  db: SQLiteDatabase;
  conversation: ConversationSummary;
  text: string;
  replyToId: string | null;
  scheduledAt: string;
  silent?: boolean;
  viewOnce?: boolean;
  preview?: EncryptedLinkPreview | null;
}

export type ScheduledEvent =
  | {
      type: 'sent';
      conversationId: string;
      previousId: string;
      stored: StoredE2eeMessage;
    }
  | {
      type: 'failed';
      conversationId: string;
      previousId: string;
      stored: StoredE2eeMessage;
    };

let config: ScheduledQueueConfig | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let scheduleGeneration = 0;
let draining: Promise<void> | null = null;
let missingAccountBackoff = false;
const listeners = new Set<(event: ScheduledEvent) => void>();

function newClientId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function emit(event: ScheduledEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Un abonné d'interface ne doit jamais bloquer la file d'envoi.
    }
  }
}

/**
 * Écrit le clair uniquement dans SQLCipher, avec `id = client_id` : la ligne
 * est la fois bulle locale en attente et élément de la file programmée.
 */
export async function enqueueScheduledText(
  input: EnqueueScheduledTextInput,
): Promise<StoredE2eeMessage> {
  const clientId = newClientId();
  const createdAt = new Date().toISOString();
  const preview =
    input.preview && isEncryptedLinkPreview(input.preview) ? input.preview : null;
  const stored: StoredE2eeMessage = {
    id: clientId,
    conversation_id: input.conversation.id,
    sender_id: input.currentUserId,
    sender_name: input.currentUserName,
    body: input.text,
    created_at: createdAt,
    client_id: clientId,
    mine: 1,
    media_meta: null,
    quote_id: input.replyToId,
    sticker_ref: null,
    hidden: 0,
    silent: input.silent ? 1 : 0,
    view_once: input.viewOnce ? 1 : 0,
    preview_json: preview ? JSON.stringify(preview) : null,
    scheduled_at: input.scheduledAt,
    send_error: null,
  };
  await saveLocalMessage(input.db, stored);
  wakeScheduledQueue();
  return stored;
}

export function onScheduledEvent(listener: (event: ScheduledEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function wakeScheduledQueue(): void {
  void scheduleNext();
}

export function startE2eeScheduledQueue(next: ScheduledQueueConfig): () => void {
  config = next;
  wakeScheduledQueue();
  return () => {
    if (config !== next) return;
    config = null;
    scheduleGeneration += 1;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

async function scheduleNext(): Promise<void> {
  const generation = ++scheduleGeneration;
  if (timer) clearTimeout(timer);
  timer = null;
  const active = config;
  if (!active) return;

  let nextAt: string | null = null;
  try {
    const { db } = await openE2eeDatabase();
    nextAt = await nextScheduledMessageAt(db, active.currentUserId);
    await db.closeAsync().catch(() => undefined);
  } catch {
    return;
  }
  if (generation !== scheduleGeneration || config !== active || !nextAt) return;
  const delay = Date.parse(nextAt) - Date.now();
  if (!Number.isFinite(delay)) return;
  const wait = missingAccountBackoff
    ? Math.max(delay, MISSING_ACCOUNT_RETRY_MS)
    : delay;
  timer = setTimeout(
    () => {
      timer = null;
      void drainScheduledQueue();
    },
    Math.max(0, Math.min(wait, MAX_TIMER_DELAY_MS)),
  );
}

/** Envoie les échéances arrivées à terme. Une erreur laisse la ligne réessayable. */
export function drainScheduledQueue(): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    const active = config;
    if (!active) return;
    const { db } = await openE2eeDatabase();
    try {
      const account = await loadE2eeAccount(db);
      if (!account) {
        missingAccountBackoff = true;
        return;
      }
      missingAccountBackoff = false;
      for (;;) {
        const due = await listDueScheduledMessages(
          db,
          active.currentUserId,
          new Date().toISOString(),
          MAX_DUE_BATCH,
        );
        if (due.length === 0) break;
        for (const row of due) {
          await sendOne(db, account, active, row);
        }
        if (due.length < MAX_DUE_BATCH) break;
      }
    } finally {
      await db.closeAsync().catch(() => undefined);
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      draining = null;
      void scheduleNext();
    });
  return draining;
}

async function sendOne(
  db: SQLiteDatabase,
  account: NonNullable<Awaited<ReturnType<typeof loadE2eeAccount>>>,
  active: ScheduledQueueConfig,
  row: StoredE2eeMessage,
): Promise<void> {
  const clientId = row.client_id;
  if (!clientId || clientId !== row.id || !row.scheduled_at) return;
  try {
    const conversation = await api.getConversation(active.token, row.conversation_id);
    if (!conversation.e2eeSince || conversation.type !== 'DIRECT') {
      throw new Error('scheduled_conversation_not_e2ee');
    }
    const result = await sendEncryptedText({
      token: active.token,
      db,
      account,
      conversation,
      currentUserId: active.currentUserId,
      currentUserName: active.currentUserName,
      text: row.body,
      replyToId: row.quote_id,
      clientId,
      retainOnFailure: true,
      silent: row.silent === 1,
      viewOnce: row.view_once === 1,
      preview: decodePreviewMeta(row.preview_json),
      scheduledAt: row.scheduled_at,
    });
    emit({
      type: 'sent',
      conversationId: row.conversation_id,
      previousId: clientId,
      stored: result.stored,
    });
  } catch {
    await markLocalMessageSendError(db, clientId).catch(() => undefined);
    const stored = await loadLocalMessage(db, clientId).catch(() => null);
    if (stored) {
      emit({
        type: 'failed',
        conversationId: row.conversation_id,
        previousId: clientId,
        stored,
      });
    }
  }
}
