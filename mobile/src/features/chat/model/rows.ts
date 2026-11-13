import { formatClock, formatDateLabel } from '@/lib/format';
import type { ChatMessageView } from '@/features/chat/transport/types';
import { reuseChatRow } from './row-equality';

/**
 * Rangées unifiées de la liste, quel que soit le mode.
 *
 * La logique reprend celle de l'écran clair (date, heure, continuations,
 * albums, frontière de non-lus) et l'applique aux `ChatMessageView`. Le tri est
 * chronologique en entrée ; la sortie est **du plus récent au plus ancien**
 * pour la liste inversée (index 0 = dernier message).
 */
export type ChatRow =
  | { key: string; type: 'date'; label: string }
  | { key: string; type: 'time'; label: string }
  | { key: string; type: 'unread'; count: number }
  | { key: string; type: 'message'; message: ChatMessageView; continuation: boolean }
  | { key: string; type: 'album'; messages: ChatMessageView[]; continuation: boolean };

export const DEFAULT_ALBUM_GAP_MS = 15_000;
export const DEFAULT_ALBUM_MAX_TILES = 9;

export interface BuildChatRowsInput {
  /** Messages triés du plus ancien au plus récent. */
  messages: readonly ChatMessageView[];
  unreadFrom?: { id: string; count: number } | null;
  /** Écart au-delà duquel un séparateur d'heure est inséré. */
  timeGapMs: number;
  albumGapMs?: number;
  albumMaxTiles?: number;
  /**
   * Rangées de la construction précédente. Une rangée dont la clé, le type et
   * les messages (références) n'ont pas changé est réutilisée telle quelle :
   * `FlatList` et les composants mémoïsés gardent alors la même identité.
   */
  previousRows?: readonly ChatRow[];
}

const atMs = (value: string): number => new Date(value).getTime();

/** Réutilise une rangée identique de la construction précédente. */
function reuseRow(previous: Map<string, ChatRow>, candidate: ChatRow): ChatRow {
  return reuseChatRow(previous, candidate);
}

/** Un média entre dans un album s'il est nu : ni légende ni réponse. */
function isAlbumPart(message: ChatMessageView): boolean {
  if (message.deleted || message.quoteId || message.body.length > 0) {
    return false;
  }
  const type = message.attachment?.type;
  return type === 'IMAGE' || type === 'VIDEO';
}

function clusterAlbums(
  messages: readonly ChatMessageView[],
  albumGapMs: number,
  albumMaxTiles: number,
): ChatMessageView[][] {
  const clusters: ChatMessageView[][] = [];
  let current: ChatMessageView[] | null = null;
  for (const message of messages) {
    if (!isAlbumPart(message)) {
      if (current) {
        clusters.push(current);
        current = null;
      }
      clusters.push([message]);
      continue;
    }
    const last = current?.[current.length - 1];
    const sameAlbum =
      Boolean(current) &&
      Boolean(last) &&
      current![0].sender.id === message.sender.id &&
      current!.length < albumMaxTiles &&
      atMs(message.createdAt) - atMs(last!.createdAt) <= albumGapMs;
    if (sameAlbum) {
      current!.push(message);
      continue;
    }
    if (current) {
      clusters.push(current);
    }
    current = [message];
  }
  if (current) {
    clusters.push(current);
  }
  return clusters;
}

export function buildChatRows({
  messages,
  unreadFrom = null,
  timeGapMs,
  albumGapMs = DEFAULT_ALBUM_GAP_MS,
  albumMaxTiles = DEFAULT_ALBUM_MAX_TILES,
  previousRows = [],
}: BuildChatRowsInput): ChatRow[] {
  const previous = new Map(previousRows.map((row) => [row.key, row]));
  const rows: ChatRow[] = [];
  const push = (row: ChatRow) => {
    rows.push(reuseRow(previous, row));
  };
  const clusters = clusterAlbums(messages, albumGapMs, albumMaxTiles);
  let lastLabel = '';
  let lastMs: number | null = null;
  let lastSenderId: string | null = null;
  let unreadPlaced = !unreadFrom;

  for (const cluster of clusters) {
    const first = cluster[0];
    const firstMs = atMs(first.createdAt);
    const lastAt = atMs(cluster[cluster.length - 1].createdAt);
    const label = formatDateLabel(first.createdAt);
    const continuation =
      lastSenderId === first.sender.id &&
      lastMs !== null &&
      firstMs - lastMs <= timeGapMs;

    if (label !== lastLabel) {
      push({ key: `date-${first.id}`, type: 'date', label });
      lastLabel = label;
      lastMs = null;
      lastSenderId = null;
    } else if (lastMs !== null && firstMs - lastMs > timeGapMs) {
      push({ key: `time-${first.id}`, type: 'time', label: formatClock(first.createdAt) });
    }

    if (!unreadPlaced && unreadFrom && cluster.some((message) => message.id === unreadFrom.id)) {
      push({ key: 'unread', type: 'unread', count: unreadFrom.count });
      unreadPlaced = true;
    }

    if (cluster.length > 1) {
      push({
        key: `album-${first.id}-${cluster[cluster.length - 1].id}`,
        type: 'album',
        messages: cluster,
        continuation,
      });
    } else {
      push({ key: first.id, type: 'message', message: first, continuation });
    }

    lastMs = lastAt;
    lastSenderId = first.sender.id;
  }

  return rows.reverse();
}
