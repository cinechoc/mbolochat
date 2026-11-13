import type { MessageReceipt, ReactionSummary } from '@/lib/types';
import type { ChatMessageView, ChatSnapshot } from '../transport/types';
import { fullSort } from './merge';

/** État complet des messages, manipulé par des actions pures. */
export interface MessagesState {
  messages: ChatMessageView[];
  receipts: Record<string, MessageReceipt[]>;
  ready: boolean;
  hasMore: boolean;
  error: string | null;
}

export const INITIAL_MESSAGES_STATE: MessagesState = {
  messages: [],
  receipts: {},
  ready: false,
  hasMore: false,
  error: null,
};

/** Insertion par recherche binaire, horodatages égaux conservés dans l'ordre. */
export function insertSorted(
  messages: readonly ChatMessageView[],
  message: ChatMessageView,
): ChatMessageView[] {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (messages[middle].createdAt <= message.createdAt) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return [...messages.slice(0, low), message, ...messages.slice(low)];
}

/**
 * Insère ou remplace un message **sans toucher aux références des autres** :
 * une fusion qui n'apporte qu'un message ne doit pas invalider la mémoïsation
 * des bulles inchangées.
 */
export function upsertMessage(
  messages: readonly ChatMessageView[],
  message: ChatMessageView,
): ChatMessageView[] {
  const index = messages.findIndex((entry) => entry.id === message.id);
  if (index === -1) {
    return insertSorted(messages, message);
  }
  if (messages[index] === message) {
    return messages as ChatMessageView[];
  }
  if (messages[index].createdAt === message.createdAt) {
    const next = messages.slice();
    next[index] = message;
    return next;
  }
  const without = [...messages.slice(0, index), ...messages.slice(index + 1)];
  return insertSorted(without, message);
}

export function removeMessage(
  messages: readonly ChatMessageView[],
  id: string,
): ChatMessageView[] {
  const index = messages.findIndex((entry) => entry.id === id);
  if (index === -1) return messages as ChatMessageView[];
  return [...messages.slice(0, index), ...messages.slice(index + 1)];
}

/** « Supprimer pour tous » conserve la rangée, vidée. */
export function markMessageDeleted(
  messages: readonly ChatMessageView[],
  id: string,
): ChatMessageView[] {
  const index = messages.findIndex((entry) => entry.id === id);
  if (index === -1) return messages as ChatMessageView[];
  const next = messages.slice();
  next[index] = { ...next[index], deleted: true, body: '', attachment: null };
  return next;
}

export function applyReaction(
  messages: readonly ChatMessageView[],
  id: string,
  reactions: ReactionSummary[],
): ChatMessageView[] {
  const index = messages.findIndex((entry) => entry.id === id);
  if (index === -1) return messages as ChatMessageView[];
  const next = messages.slice();
  next[index] = { ...next[index], reactions };
  return next;
}

export function mergeReceiptMaps(
  current: Record<string, MessageReceipt[]>,
  incoming: MessageReceipt[],
): Record<string, MessageReceipt[]> {
  if (incoming.length === 0) return current;
  const next = { ...current };
  for (const receipt of incoming) {
    const list = (next[receipt.messageId] ?? []).filter(
      (existing) => existing.userId !== receipt.userId,
    );
    list.push(receipt);
    next[receipt.messageId] = list;
  }
  return next;
}

export type MessagesAction =
  | { type: 'reset' }
  | { type: 'snapshot'; snapshot: ChatSnapshot }
  | { type: 'upsert'; message: ChatMessageView }
  | { type: 'remove'; id: string; forEveryone: boolean }
  | { type: 'reaction'; id: string; reactions: ReactionSummary[] }
  | { type: 'receipts'; receipts: MessageReceipt[] }
  | { type: 'ready' }
  | { type: 'hasMore'; hasMore: boolean }
  | { type: 'error'; error: string | null };

export function messagesReducer(state: MessagesState, action: MessagesAction): MessagesState {
  switch (action.type) {
    case 'reset':
      return INITIAL_MESSAGES_STATE;
    case 'snapshot':
      return {
        messages: fullSort(action.snapshot.messages),
        receipts: action.snapshot.receipts,
        ready: true,
        hasMore: action.snapshot.hasMore,
        error: null,
      };
    case 'upsert':
      return { ...state, messages: upsertMessage(state.messages, action.message) };
    case 'remove':
      return {
        ...state,
        messages: action.forEveryone
          ? markMessageDeleted(state.messages, action.id)
          : removeMessage(state.messages, action.id),
      };
    case 'reaction':
      return {
        ...state,
        messages: applyReaction(state.messages, action.id, action.reactions),
      };
    case 'receipts':
      return { ...state, receipts: mergeReceiptMaps(state.receipts, action.receipts) };
    case 'ready':
      return state.ready ? state : { ...state, ready: true };
    case 'hasMore':
      return state.hasMore === action.hasMore ? state : { ...state, hasMore: action.hasMore };
    case 'error':
      return state.error === action.error ? state : { ...state, error: action.error };
    default:
      return state;
  }
}
