import type { TickState } from '@/lib/format';
import type {
  Message,
  MessageQuote,
  MessageReceipt,
  ReactionSummary,
} from '@/lib/types';

/**
 * Modèle unifié de fusion. Les fonctions sont génériques sur la forme minimale
 * partagée par `Message` (clair) et `ChatMessageView` (écran unifié) : la
 * logique de déduplication et d'ordre reste éprouvée une seule fois.
 */
export interface MergeableMessage {
  id: string;
  clientId: string | null;
  createdAt: string;
}

const atMs = (value: string): number => new Date(value).getTime();

/**
 * Fusionne des messages sans doublon et dans l'ordre chronologique.
 *
 * Deux clés de déduplication : l'identifiant du serveur, et la clé
 * d'idempotence de l'appareil — un message peut arriver par le socket avant
 * l'acquittement d'envoi, ou être renvoyé par le rattrapage.
 */
export function mergeMessages<T extends MergeableMessage>(current: T[], incoming: T[]): T[] {
  if (incoming.length === 0) {
    return current;
  }
  const byId = new Map(current.map((message) => [message.id, message]));
  const byClientId = new Map(
    current
      .filter((message) => message.clientId)
      .map((message) => [message.clientId as string, message]),
  );
  let changed = false;
  for (const message of incoming) {
    if (byId.has(message.id)) {
      continue;
    }
    const known = message.clientId ? byClientId.get(message.clientId) : undefined;
    if (known) {
      byId.delete(known.id);
      byClientId.set(message.clientId as string, message);
    }
    byId.set(message.id, message);
    changed = true;
  }
  if (!changed) {
    return current;
  }
  return [...byId.values()].sort((a, b) => atMs(a.createdAt) - atMs(b.createdAt));
}

/** Tri complet de référence : ordre chronologique puis déduplication par id. */
export function fullSort<T extends MergeableMessage>(messages: readonly T[]): T[] {
  const seen = new Set<string>();
  return [...messages]
    .sort((a, b) => atMs(a.createdAt) - atMs(b.createdAt))
    .filter((message) => {
      if (seen.has(message.id)) {
        return false;
      }
      seen.add(message.id);
      return true;
    });
}

/**
 * Emplacement du séparateur de non-lus : le plus ancien des N messages reçus
 * qui restent à lire, en partant de la fin.
 */
export function unreadBoundary<T extends { id: string; sender: { id: string } }>(
  messages: T[],
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
export function groupReceipts(rows: MessageReceipt[]): Record<string, MessageReceipt[]> {
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

export const TICK_PRIORITY: Record<TickState, number> = {
  failed: 0,
  pending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

/** L'album est « envoyé » quand sa tuile la moins avancée l'est aussi. */
export function aggregateTick(states: (TickState | undefined)[]): TickState | undefined {
  let result: TickState | undefined;
  for (const state of states) {
    if (state && (!result || TICK_PRIORITY[state] < TICK_PRIORITY[result])) {
      result = state;
    }
  }
  return result;
}

/** Bascule locale d'une réaction, avant la confirmation du serveur. */
export function toggleLocalReaction(
  reactions: ReactionSummary[],
  reaction: string,
): ReactionSummary[] {
  const existing = reactions.find((entry) => entry.reaction === reaction);
  if (!existing) {
    return [...reactions, { reaction, count: 1, mine: true }];
  }
  if (existing.mine) {
    return existing.count <= 1
      ? reactions.filter((entry) => entry.reaction !== reaction)
      : reactions.map((entry) =>
          entry.reaction === reaction
            ? { ...entry, count: entry.count - 1, mine: false }
            : entry,
        );
  }
  return reactions.map((entry) =>
    entry.reaction === reaction ? { ...entry, count: entry.count + 1, mine: true } : entry,
  );
}

/** Aperçu à insérer dans une réponse, depuis le message que l'on cite. */
export function quoteOfMessage(message: Message): MessageQuote {
  return {
    id: message.id,
    senderName: message.sender.displayName,
    content: message.deleted ? '' : message.content,
    type: message.type ?? 'text',
    attachmentType: message.deleted ? null : (message.attachment?.type ?? null),
    deleted: message.deleted,
  };
}
