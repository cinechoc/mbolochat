import { describe, expect, it } from 'vitest';

import type { ChatMessageView } from '@/features/chat/transport/types';
import { buildChatRows } from './rows';

const sender = {
  id: 'peer',
  username: 'peer',
  displayName: 'Pair',
  avatarUrl: null,
  gender: null,
  genderCustom: null,
};

const view = (input: Partial<ChatMessageView> & Pick<ChatMessageView, 'id' | 'createdAt'>): ChatMessageView => ({
  clientId: null,
  conversationId: 'conversation-1',
  mine: false,
  sender,
  body: '',
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

const image = (id: string, createdAt: string, senderId = 'peer', body = ''): ChatMessageView =>
  view({
    id,
    createdAt,
    body,
    sender: { ...sender, id: senderId, displayName: senderId },
    attachment: {
      type: 'IMAGE',
      url: `/media/${id}`,
      encrypted: false,
      mediaMeta: null,
      mime: 'image/jpeg',
      name: null,
      size: 10,
      width: 100,
      height: 100,
      durationMs: null,
      stickerId: null,
      stickerPackId: null,
      stickerName: null,
      giphy: null,
    },
  });

const MINUTE = 60_000;
const base = Date.parse('2026-01-01T10:00:00.000Z');

describe('buildChatRows', () => {
  it('renvoie les rangées du plus récent au plus ancien (liste inversée)', () => {
    const rows = buildChatRows({
      messages: [
        view({ id: 'a', createdAt: '2026-01-01T10:00:00.000Z' }),
        view({ id: 'b', createdAt: '2026-01-01T10:00:00.000Z' }),
      ],
      timeGapMs: 5 * MINUTE,
    });
    expect(
      rows.filter((row) => row.type === 'message').map((row) => row.key),
    ).toEqual(['b', 'a']);
  });

  it('insère un séparateur de date quand le jour change', () => {
    const rows = buildChatRows({
      messages: [
        view({ id: 'a', createdAt: '2026-01-01T10:00:00.000Z' }),
        view({ id: 'b', createdAt: '2026-01-02T10:00:00.000Z' }),
      ],
      timeGapMs: 5 * MINUTE,
    });
    expect(rows.filter((row) => row.type === 'date')).toHaveLength(2);
    expect(rows.map((row) => row.key)).toContain('date-b');
  });

  it('insère un séparateur d’heure au-delà de l’écart', () => {
    const rows = buildChatRows({
      messages: [
        view({ id: 'a', createdAt: new Date(base).toISOString() }),
        view({ id: 'b', createdAt: new Date(base + 10 * MINUTE).toISOString() }),
      ],
      timeGapMs: 5 * MINUTE,
    });
    expect(rows.some((row) => row.type === 'time' && row.key === 'time-b')).toBe(true);
  });

  it('marque la continuation pour le même expéditeur dans l’écart', () => {
    const rows = buildChatRows({
      messages: [
        view({ id: 'a', createdAt: new Date(base).toISOString() }),
        view({ id: 'b', createdAt: new Date(base + MINUTE).toISOString() }),
      ],
      timeGapMs: 5 * MINUTE,
    });
    const b = rows.find((row) => row.key === 'b');
    expect(b?.type === 'message' && b.continuation).toBe(true);
  });

  it('rompt la continuation au changement d’expéditeur', () => {
    const rows = buildChatRows({
      messages: [
        view({ id: 'a', createdAt: new Date(base).toISOString() }),
        view({
          id: 'b',
          createdAt: new Date(base + MINUTE).toISOString(),
          sender: { ...sender, id: 'other' },
        }),
      ],
      timeGapMs: 5 * MINUTE,
    });
    const b = rows.find((row) => row.key === 'b');
    expect(b?.type === 'message' && b.continuation).toBe(false);
  });

  it('regroupe les médias nus consécutifs en album', () => {
    const rows = buildChatRows({
      messages: [
        image('a', new Date(base).toISOString()),
        image('b', new Date(base + 1000).toISOString()),
        image('c', new Date(base + 2000).toISOString()),
      ],
      timeGapMs: 5 * MINUTE,
    });
    const albums = rows.filter((row) => row.type === 'album');
    expect(albums).toHaveLength(1);
    expect(albums[0]?.type === 'album' && albums[0].messages.map((entry) => entry.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('ne met pas une légende dans l’album', () => {
    const rows = buildChatRows({
      messages: [
        image('a', new Date(base).toISOString()),
        image('b', new Date(base + 1000).toISOString(), 'peer', 'légende'),
      ],
      timeGapMs: 5 * MINUTE,
    });
    expect(rows.filter((row) => row.type === 'album')).toHaveLength(0);
  });

  it('coupe l’album au changement d’expéditeur ou au-delà de l’écart', () => {
    const rows = buildChatRows({
      messages: [
        image('a', new Date(base).toISOString()),
        image('b', new Date(base + 1000).toISOString(), 'other'),
        image('c', new Date(base + 20_000).toISOString()),
      ],
      timeGapMs: 5 * MINUTE,
    });
    expect(rows.filter((row) => row.type === 'album')).toHaveLength(0);
  });

  it('place la frontière de non-lus avant le premier message concerné', () => {
    const rows = buildChatRows({
      messages: [
        view({ id: 'a', createdAt: new Date(base).toISOString() }),
        view({ id: 'b', createdAt: new Date(base + MINUTE).toISOString() }),
      ],
      timeGapMs: 5 * MINUTE,
      unreadFrom: { id: 'b', count: 1 },
    });
    const unreadIndex = rows.findIndex((row) => row.type === 'unread');
    const bIndex = rows.findIndex((row) => row.key === 'b');
    expect(unreadIndex).toBeGreaterThanOrEqual(0);
    // Liste inversée : la frontière est « au-dessus » de b, donc après dans le tableau.
    expect(unreadIndex).toBeGreaterThan(bIndex);
  });

  it('n’ajoute pas de frontière quand le message n’est pas dans la liste', () => {
    const rows = buildChatRows({
      messages: [view({ id: 'a', createdAt: new Date(base).toISOString() })],
      timeGapMs: 5 * MINUTE,
      unreadFrom: { id: 'inconnu', count: 2 },
    });
    expect(rows.some((row) => row.type === 'unread')).toBe(false);
  });
});
