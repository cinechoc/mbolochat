import { ApiError, api } from './api';
import type { Socket } from 'socket.io-client';

import { getStore, type OutboxItem, type OutboxStatus } from './store';
import { ensureSocket } from './socket';
import type { GifSendPayload, Message, MessageAttachment, StickerSendPayload } from './types';

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
  /** Texte normal ou sticker référencé (jamais de fichier pour un sticker). */
  type?: 'text' | 'sticker';
  /** Référence de catalogue d'un sticker. */
  stickerRef?: string;
  content: string;
  /** Message cité par une réponse. */
  replyTo?: string | null;
  attachment?: {
    /** Absent pour un GIF externe : aucun fichier à importer. */
    localUri?: string;
    mime?: string | null;
    width?: number | null;
    height?: number | null;
    /** Durée d'un vocal ou d'une vidéo, en millisecondes. */
    durationMs?: number | null;
    /** Une photo par défaut ; audio, vidéo, document, GIF ou sticker. */
    kind?: 'image' | 'video' | 'file' | 'audio' | 'gif' | 'sticker';
    name?: string | null;
    size?: number | null;
    /** GIF GIPHY ou sticker : métadonnées jointes à l'import. */
    external?: GifSendPayload | StickerSendPayload;
  };
}

const listeners = new Set<() => void>();
const sentListeners = new Set<(message: Message) => void>();
/** Progression d'upload en mémoire : inutile de l'écrire à chaque pourcent. */
const progressById = new Map<string, number>();
/** Octets réellement transférés, pour les cartes de documents. */
const bytesById = new Map<string, { uploaded: number; total: number }>();
/** Heure de sélection locale, conservée après confirmation pour l'ordre visuel. */
const clientCreatedAtById = new Map<string, number>();

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

/** Deux fichiers choisis ensemble doivent garder un ordre strict. */
let lastQueuedAt = 0;

/**
 * Ajoute un message à la file. Il apparaît aussitôt dans la conversation, même
 * sans réseau ; l'envoi réel tente sa chance dans la foulée.
 */
export async function enqueue(input: NewOutboxItem): Promise<OutboxItem> {
  lastQueuedAt = Math.max(Date.now(), lastQueuedAt + 1);
  const clientId = newClientId();
  const item: OutboxItem = {
    clientId,
    conversationId: input.conversationId,
    messageType: input.type === 'sticker' ? 'sticker' : 'text',
    stickerRef: input.type === 'sticker' ? (input.stickerRef ?? null) : null,
    content: input.content,
    replyTo: input.replyTo ?? null,
    localUri: input.attachment?.localUri ?? null,
    kind: input.attachment?.kind ?? 'image',
    durationMs: input.attachment?.durationMs ?? null,
    mime: input.attachment?.mime ?? null,
    width: input.attachment?.width ?? null,
    height: input.attachment?.height ?? null,
    name: input.attachment?.name ?? null,
    size: input.attachment?.size ?? null,
    uploadId: null,
    external: input.attachment?.external
      ? JSON.stringify(input.attachment.external)
      : null,
    status: 'pending',
    attempts: 0,
    error: null,
    createdAt: lastQueuedAt,
    progress: null,
    uploadedBytes: null,
    totalBytes: null,
  };
  clientCreatedAtById.set(clientId, lastQueuedAt);
  const store = await getStore();
  await store.save(item);
  notify();
  return item;
}

/** Messages en attente, dans l'ordre où l'utilisateur les a composés. */
/** Heure de sélection locale d'un envoi, même après sa sortie de la file. */
export function localCreatedAtMs(clientId: string | null | undefined): number | undefined {
  return clientId ? clientCreatedAtById.get(clientId) : undefined;
}

export async function listOutbox(conversationId?: string): Promise<OutboxItem[]> {
  const store = await getStore();
  const items = await store.list(conversationId);
  return items.map((item) => {
    const bytes = bytesById.get(item.clientId);
    return {
      ...item,
      progress: progressById.get(item.clientId) ?? null,
      uploadedBytes: bytes?.uploaded ?? null,
      totalBytes: bytes?.total ?? null,
    };
  });
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

/** Désérialise la pièce jointe GIF externe d'un message en file. */
export function gifExternalOf(item: OutboxItem): GifSendPayload | null {
  if (item.kind !== 'gif' || !item.external) {
    return null;
  }
  try {
    const parsed = JSON.parse(item.external) as GifSendPayload;
    return typeof parsed?.url === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Identifiants d'un sticker en file, sérialisés dans `external`. */
export function stickerMetaOf(item: OutboxItem): StickerSendPayload | null {
  if (item.kind !== 'sticker' || !item.external) {
    return null;
  }
  try {
    const parsed = JSON.parse(item.external) as StickerSendPayload;
    if (typeof parsed?.id !== 'string' || typeof parsed?.packId !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Retire un message de la file sans l'envoyer. */
export async function discard(clientId: string): Promise<void> {
  progressById.delete(clientId);
  bytesById.delete(clientId);
  const store = await getStore();
  if (await store.remove(clientId)) {
    notify();
  }
}

/** Nouvelle tentative manuelle : le message repasse en attente. */
export async function retry(clientId: string): Promise<void> {
  progressById.delete(clientId);
  bytesById.delete(clientId);
  await update(clientId, { status: 'pending', error: null, progress: null });
}

/**
 * Le serveur a confirmé ce message (il arrive par le socket) : la file n'a plus
 * besoin de le retenter, même si l'acquittement d'envoi s'était perdu.
 */
export async function settle(clientId: string): Promise<boolean> {
  progressById.delete(clientId);
  bytesById.delete(clientId);
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
let rerunRequested = false;

/**
 * Tente de faire partir tous les messages en attente. Un seul drain à la fois :
 * les reconnectations, les retours d'application et les nouveaux envois le
 * relancent sans se marcher dessus. Les lots ajoutés pendant un drain sont
 * repris à la fin de celui-ci.
 */
export function drain(token: string): Promise<void> {
  if (draining) {
    rerunRequested = true;
    return draining;
  }
  draining = (async () => {
    do {
      rerunRequested = false;
      await drainOnce(token);
    } while (rerunRequested);
  })().finally(() => {
    draining = null;
  });
  return draining;
}

/** Deux uploads au maximum, dans l'ordre de création des bulles. */
async function drainOnce(token: string): Promise<void> {
  const waiting = (await listOutbox()).filter((item) => item.status !== 'failed');
  let cursor = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      if (index >= waiting.length) {
        return;
      }
      if (!(await deliver(token, waiting[index]))) {
        stopped = true;
      }
    }
  };
  await Promise.all([worker(), worker()]);
}

function isMediaItem(item: OutboxItem): boolean {
  return item.localUri !== null && item.kind !== 'audio' && item.content.length === 0;
}

/**
 * Renvoie false si le réseau manque pour un texte/vocal : la file s'arrête et
 * reprendra. Un média en échec est marqué indépendamment pour offrir son propre
 * bouton « Réessayer », sans bloquer les autres fichiers.
 */
async function deliver(token: string, item: OutboxItem): Promise<boolean> {
  const media = isMediaItem(item);
  let socket: Socket;
  try {
    socket = await ensureSocket(token);
  } catch {
    progressById.delete(item.clientId);
    if (media) {
      await update(item.clientId, {
        status: 'pending',
        error: 'Connexion impossible. Vérifie ta connexion.',
        progress: null,
      });
      return true;
    }
    return false;
  }

  progressById.set(item.clientId, 0);
  bytesById.delete(item.clientId);
  await update(item.clientId, {
    status: 'sending',
    attempts: item.attempts + 1,
    error: null,
    progress: 0,
  });

  try {
    let uploadId = item.uploadId;
    if (item.localUri && !uploadId) {
      let lastPercent = -1;
      const upload = await api.uploadMedia(
        token,
        {
          uri: item.localUri,
          mimeType: item.mime,
          fileName: item.name,
          width: item.width ?? undefined,
          height: item.height ?? undefined,
          durationMs: item.durationMs ?? undefined,
        },
        (fraction, uploadedBytes, totalBytes) => {
          const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
          const total = totalBytes > 0 ? totalBytes : (item.size ?? 0);
          if (total > 0) {
            bytesById.set(item.clientId, {
              uploaded: Math.min(uploadedBytes, total),
              total,
            });
          }
          if (percent === lastPercent) return;
          if (percent < 100 && percent - lastPercent < 5) return;
          lastPercent = percent;
          progressById.set(item.clientId, percent);
          notify();
        },
      );
      uploadId = upload.id;
      await update(item.clientId, { uploadId, progress: 100 });
    }

    progressById.delete(item.clientId);
    const stillQueued = (await listOutbox()).some((row) => row.clientId === item.clientId);
    if (!stillQueued) {
      return true;
    }

    const result = (await socket
      .timeout(15000)
      .emitWithAck('message:send', {
        conversationId: item.conversationId,
        type: item.messageType === 'sticker' ? 'sticker' : undefined,
        stickerRef: item.messageType === 'sticker' ? (item.stickerRef ?? undefined) : undefined,
        content: item.content,
        attachmentId: uploadId ?? undefined,
        // GIF GIPHY : le serveur revalide l'URL (allowlist) avant stockage.
        gif: (item.kind === 'gif' ? gifExternalOf(item) : null) ?? undefined,
        // Sticker : l'image est déjà passée par /uploads, le serveur la requalifie.
        sticker:
          (item.kind === 'sticker' ? stickerMetaOf(item) : null) ?? undefined,
        clientId: item.clientId,
        replyToId: item.replyTo ?? undefined,
      })) as Message | { error?: string };

    if ('error' in result && result.error) {
      // Refus du serveur (conversation bloquée, quota…) : le message reste à
      // l'écran, marqué, jusqu'à ce que l'utilisateur décide de retenter.
      bytesById.delete(item.clientId);
      await update(item.clientId, { status: 'failed', error: result.error, progress: null });
      return true;
    }

    await discard(item.clientId);
    for (const listener of sentListeners) {
      listener(result as Message);
    }
    return true;
  } catch (error) {
    progressById.delete(item.clientId);
    bytesById.delete(item.clientId);
    const refused = error instanceof ApiError && error.status > 0;
    await update(item.clientId, {
      status: refused ? 'failed' : 'pending',
      error: error instanceof Error ? error.message : 'Envoi non confirmé',
      progress: null,
    });
    // Un média en panne réseau reste repris automatiquement, mais les autres
    // fichiers du lot continuent ; un texte/vocal stoppe la file comme avant.
    return refused || media;
  }
}

/** Aperçu optimiste d'un item de file, pour l'afficher comme un message. */
export function pendingMessage(
  item: OutboxItem,
  sender: Message['sender'],
  /** La conversation sous la main résout la citation depuis ce qu'elle a déjà. */
  quoteOf?: (id: string) => Message['replyTo'] | null,
): Message {
  const type =
    item.kind === 'audio'
      ? 'AUDIO'
      : item.kind === 'video'
        ? 'VIDEO'
        : item.kind === 'file'
          ? 'FILE'
          : item.kind === 'gif'
            ? 'GIF'
            : item.kind === 'sticker'
              ? 'STICKER'
              : 'IMAGE';
  const fallbackMime =
    type === 'AUDIO'
      ? 'audio/mp4'
      : type === 'VIDEO'
        ? 'video/mp4'
        : type === 'FILE'
          ? 'application/octet-stream'
          : type === 'GIF'
            ? 'image/gif'
            : type === 'STICKER'
              ? 'image/png'
              : 'image/jpeg';
  // Un GIF GIPHY n'a pas de fichier local : son aperçu front vient du payload
  // externe ; les Médias locaux restent pilotés par `localUri`.
  const externalGif = type === 'GIF' ? gifExternalOf(item) : null;
  const stickerMeta = type === 'STICKER' ? stickerMetaOf(item) : null;
  const attachment: MessageAttachment | null =
    externalGif && type === 'GIF'
      ? {
          type: 'GIF',
          url: externalGif.url,
          mime: item.mime ?? fallbackMime,
          size: 0,
          width: externalGif.width ?? item.width ?? undefined,
          height: externalGif.height ?? item.height ?? undefined,
          sticker: externalGif.sticker ?? false,
          giphyId: externalGif.giphyId,
          username: externalGif.username,
          title: externalGif.title,
          stillUrl: externalGif.stillUrl,
        }
      : item.localUri
        ? {
            type,
            url: item.localUri,
            mime: item.mime ?? fallbackMime,
            size: item.size ?? 0,
            width: item.width ?? undefined,
            height: item.height ?? undefined,
            duration: item.durationMs ?? undefined,
            name: item.name ?? undefined,
            ...(stickerMeta
              ? {
                  stickerId: stickerMeta.id,
                  stickerPackId: stickerMeta.packId,
                  stickerName: stickerMeta.name ?? item.name ?? undefined,
                }
              : {}),
          }
        : null;
  return {
    id: item.clientId,
    conversationId: item.conversationId,
    type: item.messageType,
    stickerRef: item.stickerRef,
    content: item.content,
    attachment,
    clientId: item.clientId,
    deleted: false,
    replyTo: item.replyTo ? (quoteOf?.(item.replyTo) ?? null) : null,
    createdAt: new Date(item.createdAt).toISOString(),
    sender,
  };
}
