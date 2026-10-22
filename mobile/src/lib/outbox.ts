import { ApiError, api } from './api';
import type { Socket } from 'socket.io-client';

import { getStore, type OutboxItem, type OutboxStatus } from './store';
import { ensureSocket } from './socket';
import type { Message, MessageAttachment } from './types';

/**
 * File d'attente des messages à envoyer.
 *
 * Un message est écrit ici avant toute tentative : il survit à une coupure, à
 * un plantage, à la fermeture de l'app, et part dès que le réseau revient. La
 * clé `client_id` est transmise au serveur, qui s'en sert pour ne jamais stocker
 * deux fois le même envoi — une reprise après un acquittement perdu ne crée donc
 * pas de doublon.
 */

export type { OutboxItem, OutboxStatus };

export interface NewOutboxItem {
  conversationId: string;
  content: string;
  /** Message cité par une réponse. */
  replyTo?: string | null;
  attachment?: {
    localUri: string;
    mime?: string | null;
    width?: number | null;
    height?: number | null;
    /** Durée d'un message vocal, en millisecondes. */
    durationMs?: number | null;
    /** Une photo par défaut ; un enregistrement passe en 'audio'. */
    kind?: 'image' | 'audio';
  };
}

const listeners = new Set<() => void>();
const sentListeners = new Set<(message: Message) => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Identifiant unique à cet appareil ; le serveur le traite comme une opacité. */
let sequence = 0;
function newClientId(): string {
  sequence += 1;
  return `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Ajoute un message à la file. Il apparaît aussitôt dans la conversation, même
 * sans réseau ; l'envoi réel tente sa chance dans la foulée.
 */
export async function enqueue(input: NewOutboxItem): Promise<OutboxItem> {
  const item: OutboxItem = {
    clientId: newClientId(),
    conversationId: input.conversationId,
    content: input.content,
    replyTo: input.replyTo ?? null,
    localUri: input.attachment?.localUri ?? null,
    kind: input.attachment?.kind ?? 'image',
    durationMs: input.attachment?.durationMs ?? null,
    mime: input.attachment?.mime ?? null,
    width: input.attachment?.width ?? null,
    height: input.attachment?.height ?? null,
    uploadId: null,
    status: 'pending',
    attempts: 0,
    error: null,
    createdAt: Date.now(),
  };
  const store = await getStore();
  await store.save(item);
  notify();
  return item;
}

/** Messages en attente, dans l'ordre où l'utilisateur les a composés. */
export async function listOutbox(conversationId?: string): Promise<OutboxItem[]> {
  const store = await getStore();
  return store.list(conversationId);
}

async function update(clientId: string, changes: Partial<OutboxItem>): Promise<void> {
  const store = await getStore();
  const current = (await store.list()).find((item) => item.clientId === clientId);
  if (!current) {
    return;
  }
  await store.save({ ...current, ...changes });
  notify();
}

/** Retire un message de la file sans l'envoyer. */
export async function discard(clientId: string): Promise<void> {
  const store = await getStore();
  if (await store.remove(clientId)) {
    notify();
  }
}

/** Nouvelle tentative manuelle : le message repasse en attente. */
export async function retry(clientId: string): Promise<void> {
  await update(clientId, { status: 'pending', error: null });
}

/**
 * Le serveur a confirmé ce message (il arrive par le socket) : la file n'a plus
 * besoin de le retenter, même si l'acquittement d'envoi s'était perdu.
 */
export async function settle(clientId: string): Promise<boolean> {
  const store = await getStore();
  const removed = await store.remove(clientId);
  if (removed) {
    notify();
  }
  return removed;
}

/** S'abonne aux changements de file : la conversation redessine ses bulles. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Un message de la file est parti : l'écran remplace sa bulle optimiste. */
export function onSent(listener: (message: Message) => void): () => void {
  sentListeners.add(listener);
  return () => sentListeners.delete(listener);
}

let draining: Promise<void> | null = null;

/**
 * Tente de faire partir tous les messages en attente. Un seul drain à la fois :
 * les reconnectations, les retours d'application et les nouveaux envois le
 * relancent sans se marcher dessus.
 */
export function drain(token: string): Promise<void> {
  if (draining) {
    return draining;
  }
  draining = drainOnce(token).finally(() => {
    draining = null;
  });
  return draining;
}

async function drainOnce(token: string): Promise<void> {
  const waiting = (await listOutbox()).filter((item) => item.status !== 'failed');
  for (const item of waiting) {
    // Plus de réseau : le reste attendra la prochaine connexion, sans compter
    // une tentative de plus.
    if (!(await deliver(token, item))) {
      return;
    }
  }
}

/**
 * Renvoie false si le réseau manque — il faut réessayer plus tard, pas marquer
 * l'échec.
 */
async function deliver(token: string, item: OutboxItem): Promise<boolean> {
  let socket: Socket;
  try {
    socket = await ensureSocket(token);
  } catch {
    return false;
  }

  await update(item.clientId, { status: 'sending', attempts: item.attempts + 1, error: null });

  try {
    let uploadId = item.uploadId;
    if (item.localUri && !uploadId) {
      const upload = await api.uploadMedia(token, {
        uri: item.localUri,
        mimeType: item.mime,
        width: item.width ?? undefined,
        height: item.height ?? undefined,
        durationMs: item.durationMs ?? undefined,
      });
      uploadId = upload.id;
      await update(item.clientId, { uploadId });
    }

    const result = (await socket
      .timeout(15000)
      .emitWithAck('message:send', {
        conversationId: item.conversationId,
        content: item.content,
        attachmentId: uploadId ?? undefined,
        clientId: item.clientId,
        replyToId: item.replyTo ?? undefined,
      })) as Message | { error?: string };

    if ('error' in result && result.error) {
      // Refus du serveur (conversation bloquée, quota…) : le message reste à
      // l'écran, marqué, jusqu'à ce que l'utilisateur décide de retenter.
      await update(item.clientId, { status: 'failed', error: result.error });
      return true;
    }

    await discard(item.clientId);
    for (const listener of sentListeners) {
      listener(result as Message);
    }
    return true;
  } catch (error) {
    // Le serveur a refusé (photo disparue du disque, taille dépassée…) : marquer
    // l'échec empêche ce message de bloquer toute la file derrière lui. Une panne
    // réseau, elle, laisse tout en attente pour la prochaine reprise.
    const refused = error instanceof ApiError && error.status > 0;
    await update(item.clientId, {
      status: refused ? 'failed' : 'pending',
      error: error instanceof Error ? error.message : 'Envoi non confirmé',
    });
    return refused;
  }
}

/** Aperçu optimiste d'un item de file, pour l'afficher comme un message. */
export function pendingMessage(
  item: OutboxItem,
  sender: Message['sender'],
  /** La conversation sous la main résout la citation depuis ce qu'elle a déjà. */
  quoteOf?: (id: string) => Message['replyTo'] | null,
): Message {
  const audio = item.kind === 'audio';
  const attachment: MessageAttachment | null = item.localUri
    ? {
        type: audio ? 'AUDIO' : 'IMAGE',
        url: item.localUri,
        mime: item.mime ?? (audio ? 'audio/mp4' : 'image/jpeg'),
        size: 0,
        width: item.width ?? undefined,
        height: item.height ?? undefined,
        duration: item.durationMs ?? undefined,
      }
    : null;
  return {
    id: item.clientId,
    conversationId: item.conversationId,
    content: item.content,
    attachment,
    clientId: item.clientId,
    deleted: false,
    replyTo: item.replyTo ? (quoteOf?.(item.replyTo) ?? null) : null,
    createdAt: new Date(item.createdAt).toISOString(),
    sender,
  };
}
