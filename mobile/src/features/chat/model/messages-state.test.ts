import { describe, expect, it } from 'vitest';

import type { ChatMessageView } from '../transport/types';
import {
  INITIAL_MESSAGES_STATE,
  messagesReducer,
  upsertMessage,
} from './messages-state';

const view = (id: string, createdAt: string, input: Partial<ChatMessageView> = {}): ChatMessageView => ({
  id,
  clientId: null,
  conversationId: 'conversation-1',
  mine: false,
  sender: {
    id: 'peer',
    username: 'peer',
    displayName: 'Pair',
    avatarUrl: null,
    gender: null,
    genderCustom: null,
  },
  createdAt,
  body: id,
  type: 'text',
  deleted: false,
  unreadable: false,
  quoteId: null,
  quote: null,
  reactions: [],
  stickerRef: null,
  attachment: null,
  state: 'none',
  error: null,
  progress: null,
  ...input,
});

const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;

describe('messagesReducer', () => {
  it('trie et déduplique l’instantané', () => {
    const state = messagesReducer(INITIAL_MESSAGES_STATE, {
      type: 'snapshot',
      snapshot: {
        messages: [view('b', at(2)), view('a', at(1)), view('a', at(1))],
        receipts: {},
        hasMore: true,
        unreadCount: 0,
        ephemeralSeconds: 0,
      },
    });
    expect(state.messages.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(state.ready).toBe(true);
    expect(state.hasMore).toBe(true);
  });

  it('insère et remplace sans changer les références des autres messages', () => {
    const a = view('a', at(1));
    const b = view('b', at(2));
    const base = [a, b];
    const c = view('c', at(3));
    const next = upsertMessage(base, c);
    expect(next[0]).toBe(a);
    expect(next[1]).toBe(b);
    expect(next[2]).toBe(c);

    const b2 = view('b', at(4), { body: 'mis à jour' });
    const updated = upsertMessage(next, b2);
    expect(updated[0]).toBe(a);
    expect(updated[1]).toBe(c);
    expect(updated.find((entry) => entry.id === 'b')).toBe(b2);
  });

  it('conserve la même référence quand l’upsert est identique', () => {
    const a = view('a', at(1));
    const base = [a];
    expect(upsertMessage(base, a)).toBe(base);
  });

  it('remplace la bulle optimiste par la version serveur du même clientId', () => {
    const optimistic = view('local-1', at(1), { clientId: 'client-1', state: 'pending' });
    const server = view('server-1', at(2), { clientId: 'client-1', state: 'sent' });
    const next = upsertMessage([optimistic], server);
    expect(next.map((entry) => entry.id)).toEqual(['server-1']);
    expect(next[0]?.state).toBe('sent');
  });

  it('supprime un doublon résiduel quand la confirmation arrive avant le retrait optimiste', () => {
    const optimistic = view('local-1', at(1), { clientId: 'client-1', state: 'pending' });
    const server = view('server-1', at(2), { clientId: 'client-1', state: 'sent' });
    const next = upsertMessage([optimistic, server], server);
    expect(next.map((entry) => entry.id)).toEqual(['server-1']);
  });

  it('retire pour moi et vide pour tous', () => {
    const base = [view('a', at(1)), view('b', at(2))];
    const removed = messagesReducer(
      { ...INITIAL_MESSAGES_STATE, messages: base },
      { type: 'remove', id: 'a', forEveryone: false },
    );
    expect(removed.messages.map((entry) => entry.id)).toEqual(['b']);
    const emptied = messagesReducer(
      { ...INITIAL_MESSAGES_STATE, messages: base },
      { type: 'remove', id: 'a', forEveryone: true },
    );
    expect(emptied.messages[0]).toMatchObject({ id: 'a', deleted: true, body: '' });
  });

  it('applique une réaction et fusionne les accusés', () => {
    const base = [view('a', at(1))];
    const reacted = messagesReducer(
      { ...INITIAL_MESSAGES_STATE, messages: base },
      { type: 'reaction', id: 'a', reactions: [{ reaction: 'mbolo/coeur', count: 1, mine: true }] },
    );
    expect(reacted.messages[0]?.reactions).toHaveLength(1);

    const withReceipt = messagesReducer(reacted, {
      type: 'receipts',
      receipts: [{ messageId: 'a', userId: 'peer', deliveredAt: at(2), readAt: null }],
    });
    expect(withReceipt.receipts.a).toHaveLength(1);
    const replaced = messagesReducer(withReceipt, {
      type: 'receipts',
      receipts: [{ messageId: 'a', userId: 'peer', deliveredAt: at(2), readAt: at(3) }],
    });
    expect(replaced.receipts.a).toHaveLength(1);
    expect(replaced.receipts.a[0]?.readAt).toBe(at(3));
  });

  it('ne recrée pas l’état quand rien ne change', () => {
    const state = { ...INITIAL_MESSAGES_STATE, ready: true, hasMore: false };
    expect(messagesReducer(state, { type: 'ready' })).toBe(state);
    expect(messagesReducer(state, { type: 'hasMore', hasMore: false })).toBe(state);
    expect(messagesReducer(state, { type: 'error', error: null })).toBe(state);
  });
});
