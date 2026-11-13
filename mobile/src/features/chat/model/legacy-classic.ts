import type { TickState } from '@/lib/format';
import type {
  Message,
  MessageQuote,
  MessageReceipt,
  ReactionSummary,
} from '@/lib/types';

/**
 * Copie **verbatim** des fonctions pures privées de `app/chat/[id].tsx`
 * (état HEAD `3a8bdc8`), extraite pour les tests de caractérisation B.2.
 *
 * Aucun comportement n'est modifié : les écrans continuent d'utiliser leurs
 * propres définitions jusqu'à B.3.5. Toute divergence future entre ce module et
 * l'écran doit être traitée comme une régression de la caractérisation.
 */

/** Horodatage en millisecondes, pour ordonner réellement les messages. */
export const atMs = (value: string): number => new Date(value).getTime();

/**
 * Fusionne des messages sans doublon et dans l'ordre chronologique.
 *
 * Deux clés de déduplication : l'identifiant du serveur, et la clé d'idempotence
 * de l'appareil — un message peut arriver par le socket avant que l'acquittement
 * d'envoi ne soit revenu, ou être renvoyé par le rattrapage.
 */
export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) {
    return current;
  }
  const byId = new Map(current.map((message) => [message.id, message]));
  const mineByClientId = new Map(
    current
      .filter((message) => message.clientId)
      .map((message) => [message.clientId as string, message]),
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
export function unreadBoundary(
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
