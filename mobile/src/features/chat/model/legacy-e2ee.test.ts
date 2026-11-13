import { describe, expect, it } from 'vitest';

import type { StoredE2eeMessage } from '@/features/e2ee/db';
import { sortMessages } from './legacy-e2ee';

const stored = (input: Partial<StoredE2eeMessage> & Pick<StoredE2eeMessage, 'id'>) : StoredE2eeMessage => ({
  conversation_id: 'conversation-1',
  sender_id: 'peer',
  sender_name: 'Pair',
  body: '',
  created_at: '2026-01-01T00:00:00.000Z',
  client_id: null,
  mine: 0,
  media_meta: null,
  quote_id: null,
  sticker_ref: null,
  unreadable_reason: null,
  ...input,
});

describe('caractérisation — sortMessages (écran chiffré)', () => {
  it('trie par date croissante', () => {
    const sorted = sortMessages([
      stored({ id: 'b', created_at: '2026-01-01T00:00:02.000Z' }),
      stored({ id: 'a', created_at: '2026-01-01T00:00:01.000Z' }),
      stored({ id: 'c', created_at: '2026-01-01T00:00:03.000Z' }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('déduplique par identifiant en gardant la première occurrence triée', () => {
    const sorted = sortMessages([
      stored({ id: 'a', created_at: '2026-01-01T00:00:02.000Z', body: 'tard' }),
      stored({ id: 'a', created_at: '2026-01-01T00:00:01.000Z', body: 'tôt' }),
    ]);
    expect(sorted).toHaveLength(1);
    expect(sorted[0]?.body).toBe('tôt');
  });

  it('ne modifie pas le tableau source', () => {
    const source = [
      stored({ id: 'b', created_at: '2026-01-01T00:00:02.000Z' }),
      stored({ id: 'a', created_at: '2026-01-01T00:00:01.000Z' }),
    ];
    const snapshot = source.map((entry) => entry.id);
    sortMessages(source);
    expect(source.map((entry) => entry.id)).toEqual(snapshot);
  });
});
