import type { ChatRow } from './rows';
import type { ChatMessageRowProps } from '../ui/chat-message-row';

function sameMessages(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
  return a.length === b.length && a.every((message, index) => message === b[index]);
}

/**
 * Égalité de rendu d'une ligne de message : elle compare les **références de
 * messages** (stables après fusion) et des propriétés primitives, jamais
 * l'objet de rangée recréé à chaque construction.
 */
export function sameChatMessageRow(
  previous: Pick<
    ChatMessageRowProps,
    'row' | 'currentUser' | 'capabilities' | 'chat' | 'windowWidth' | 'token' | 'pinnedMessageIds'
  >,
  next: Pick<
    ChatMessageRowProps,
    'row' | 'currentUser' | 'capabilities' | 'chat' | 'windowWidth' | 'token' | 'pinnedMessageIds'
  >,
): boolean {
  if (previous.row.type !== next.row.type) return false;
  if (previous.row.type === 'message' && next.row.type === 'message') {
    return (
      previous.row.message === next.row.message &&
      previous.row.continuation === next.row.continuation &&
      previous.pinnedMessageIds === next.pinnedMessageIds
    );
  }
  if (previous.row.type === 'album' && next.row.type === 'album') {
    return (
      sameMessages(previous.row.messages, next.row.messages) &&
      previous.row.continuation === next.row.continuation &&
      previous.pinnedMessageIds === next.pinnedMessageIds
    );
  }
  return (
    previous.row.key === next.row.key &&
    previous.currentUser === next.currentUser &&
    previous.capabilities === next.capabilities &&
    previous.chat === next.chat &&
    previous.windowWidth === next.windowWidth &&
    previous.token === next.token &&
    previous.pinnedMessageIds === next.pinnedMessageIds
  );
}

/** Réutilise une rangée identique de la construction précédente. */
export function reuseChatRow(previous: Map<string, ChatRow>, candidate: ChatRow): ChatRow {
  const old = previous.get(candidate.key);
  if (!old || old.type !== candidate.type) return candidate;
  if (old.type === 'message' && candidate.type === 'message') {
    return old.message === candidate.message && old.continuation === candidate.continuation
      ? old
      : candidate;
  }
  if (old.type === 'album' && candidate.type === 'album') {
    const same =
      old.messages.length === candidate.messages.length &&
      old.messages.every((message, index) => message === candidate.messages[index]);
    return same && old.continuation === candidate.continuation ? old : candidate;
  }
  return old;
}
