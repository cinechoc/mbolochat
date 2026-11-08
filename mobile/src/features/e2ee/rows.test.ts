import { describe, expect, it } from 'vitest';

import { CHAT_TIME_GAP_MS } from '@/constants/chat-timing';
import type { StoredE2eeMessage } from './db';
import { buildMessageRows } from './rows';

function message(
  id: string,
  createdAt: string,
  mine: 0 | 1 = 0,
): StoredE2eeMessage {
  return {
    id,
    conversation_id: 'conv',
    sender_id: mine === 1 ? 'me' : 'peer',
    sender_name: mine === 1 ? 'Moi' : 'Pair',
    created_at: createdAt,
    body: id,
    client_id: null,
    mine,
    quote_id: null,
    sticker_ref: null,
    media_meta: null,
    unreadable_reason: null,
  };
}

describe('buildMessageRows — même grammaire que la conversation claire', () => {
  it('ouvre la liste par la date du premier message', () => {
    const rows = buildMessageRows([message('a', '2026-01-02T10:00:00.000Z')]);
    expect(rows[0]).toMatchObject({ type: 'date' });
    expect(rows[1]).toMatchObject({ type: 'message', continuation: false });
  });

  it('rappelle l’heure au-delà de la pause, et regroupe les messages rapprochés', () => {
    const base = Date.parse('2026-01-02T10:00:00.000Z');
    const rows = buildMessageRows([
      message('a', new Date(base).toISOString(), 0),
      message('b', new Date(base + 60_000).toISOString(), 0),
      message('c', new Date(base + 60_000 + CHAT_TIME_GAP_MS + 1000).toISOString(), 1),
    ]);
    expect(rows.map((row) => row.type)).toEqual(['date', 'message', 'message', 'time', 'message']);
    expect(rows[2]).toMatchObject({ type: 'message', continuation: true });
    expect(rows[4]).toMatchObject({ type: 'message', continuation: false });
  });

  it('groupe par expéditeur : un changement d’auteur coupe la continuité', () => {
    const base = Date.parse('2026-01-02T10:00:00.000Z');
    const rows = buildMessageRows([
      message('a', new Date(base).toISOString(), 0),
      message('b', new Date(base + 1000).toISOString(), 1),
    ]);
    expect(rows[1]).toMatchObject({ type: 'message', continuation: false });
    expect(rows[2]).toMatchObject({ type: 'message', continuation: false });
  });

  it('ne perd aucun message et garde l’ordre reçu', () => {
    const base = Date.parse('2026-01-02T10:00:00.000Z');
    const messages = [0, 1, 2, 3].map((index) =>
      message(`m${index}`, new Date(base + index * 1000).toISOString(), index % 2 ? 1 : 0),
    );
    const rows = buildMessageRows(messages).filter((row) => row.type === 'message');
    expect(rows.map((row) => (row.type === 'message' ? row.message.id : ''))).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
    ]);
  });

  it('tolère une date illisible sans casser la liste', () => {
    const rows = buildMessageRows([message('a', 'pas-une-date'), message('b', 'pas-une-date')]);
    expect(rows.filter((row) => row.type === 'message')).toHaveLength(2);
    expect(rows[1]).toMatchObject({ type: 'message' });
  });

  it('liste vide : aucune ligne', () => {
    expect(buildMessageRows([])).toEqual([]);
  });
});
