import { describe, expect, it } from 'vitest';

import { CHAT_TIME_GAP_MS } from '@/constants/chat-timing';
import { clusterMessages } from '@/features/media/album';
import { formatClock, formatDateLabel } from '@/lib/format';
import type { Message, MessageReceipt, SenderInfo } from '@/lib/types';
import { classicMessageToView } from './message-view';
import {
  aggregateTick,
  groupReceipts,
  mergeMessages,
  quoteOfMessage,
  toggleLocalReaction,
  unreadBoundary,
} from './merge';
import { buildChatRows } from './rows';
import * as legacy from './legacy-classic';

const sender = (id: string): SenderInfo => ({
  id,
  username: id,
  displayName: id,
  avatarUrl: null,
  gender: null,
  genderCustom: null,
});

const message = (input: Partial<Message> & Pick<Message, 'id'>): Message => ({
  conversationId: 'conversation-1',
  type: 'text',
  content: '',
  encryption: 'none',
  payload: null,
  payloadType: null,
  senderDeviceId: null,
  stickerRef: null,
  attachment: null,
  encryptedAttachment: null,
  clientId: null,
  deleted: false,
  replyTo: null,
  reactions: [],
  createdAt: '2026-01-01T10:00:00.000Z',
  sender: sender('peer'),
  ...input,
});

const image = (id: string, at: string, input: Partial<Message> = {}) =>
  message({
    id,
    createdAt: at,
    attachment: {
      type: 'IMAGE',
      url: `/media/${id}`,
      mime: 'image/jpeg',
      size: 10,
      width: 100,
      height: 100,
    },
    ...input,
  });

const DATASET: Message[] = [
  message({ id: 'a', createdAt: '2026-01-01T10:00:00.000Z' }),
  message({ id: 'b', createdAt: '2026-01-01T10:00:30.000Z' }),
  message({ id: 'c', createdAt: '2026-01-01T10:10:00.000Z', sender: sender('me') }),
  image('d', '2026-01-01T10:20:00.000Z'),
  image('e', '2026-01-01T10:20:01.000Z'),
  image('f', '2026-01-01T10:20:02.000Z', { content: 'légende' }),
  message({ id: 'g', createdAt: '2026-01-02T09:00:00.000Z' }),
];

const views = DATASET.map((entry) => classicMessageToView(entry, { currentUserId: 'me' }));

const receipts: MessageReceipt[] = [
  { messageId: 'a', userId: 'u1', deliveredAt: null, readAt: null },
  { messageId: 'a', userId: 'u2', deliveredAt: null, readAt: null },
  { messageId: 'b', userId: 'u1', deliveredAt: null, readAt: null },
];

/** Oracle : algorithme exact de l'écran classique, sur des `Message`. */
function oracleRows(messages: Message[], unreadFrom: { id: string; count: number } | null) {
  const chronological: Record<string, unknown>[] = [];
  let lastLabel = '';
  let lastMs: number | null = null;
  let lastSenderId: string | null = null;
  let unreadPlaced = !unreadFrom;
  for (const cluster of clusterMessages(messages, (entry) => Date.parse(entry.createdAt))) {
    const first = cluster.messages[0];
    const label = formatDateLabel(first.createdAt);
    const continuation =
      lastSenderId === first.sender.id &&
      lastMs !== null &&
      cluster.firstAt - lastMs <= CHAT_TIME_GAP_MS;
    if (label !== lastLabel) {
      chronological.push({ type: 'date', key: `date-${first.id}`, label });
      lastLabel = label;
      lastMs = null;
      lastSenderId = null;
    } else if (lastMs !== null && cluster.firstAt - lastMs > CHAT_TIME_GAP_MS) {
      chronological.push({
        type: 'time',
        key: `time-${first.id}`,
        label: formatClock(first.createdAt),
      });
    }
    if (!unreadPlaced && unreadFrom && cluster.messages.some((entry) => entry.id === unreadFrom.id)) {
      chronological.push({ type: 'unread', key: 'unread', count: unreadFrom.count });
      unreadPlaced = true;
    }
    if (cluster.messages.length > 1) {
      chronological.push({
        type: 'album',
        key: `album-${first.id}-${cluster.messages[cluster.messages.length - 1].id}`,
        ids: cluster.messages.map((entry) => entry.id),
        continuation,
      });
    } else {
      chronological.push({
        type: 'message',
        key: first.id,
        id: first.id,
        continuation,
      });
    }
    lastMs = cluster.lastAt;
    lastSenderId = first.sender.id;
  }
  return chronological.reverse();
}

function simplifyRows(rows: ReturnType<typeof buildChatRows>) {
  return rows.map((row) => {
    if (row.type === 'message') {
      return { type: row.type, key: row.key, id: row.message.id, continuation: row.continuation };
    }
    if (row.type === 'album') {
      return {
        type: row.type,
        key: row.key,
        ids: row.messages.map((entry) => entry.id),
        continuation: row.continuation,
      };
    }
    if (row.type === 'unread') {
      return { type: row.type, key: row.key, count: row.count };
    }
    return { type: row.type, key: row.key, label: row.label };
  });
}

describe('différentiel — copies legacy vs modèle unifié', () => {
  it('fusionne dans le même ordre, avec les mêmes identifiants', () => {
    const incoming = [
      message({ id: 'h', createdAt: '2026-01-01T10:05:00.000Z' }),
      message({ id: 'a', createdAt: '2026-01-01T10:00:00.000Z' }),
    ];
    const legacyMerged = legacy.mergeMessages(DATASET, incoming);
    const nextMerged = mergeMessages(
      views,
      incoming.map((entry) => classicMessageToView(entry, { currentUserId: 'me' })),
    );
    expect(nextMerged.map((entry) => entry.id)).toEqual(legacyMerged.map((entry) => entry.id));
    expect(nextMerged.map((entry) => entry.body)).toEqual(legacyMerged.map((entry) => entry.content));
  });

  it('calcule la même frontière de non-lus', () => {
    for (const count of [0, 1, 3, 99]) {
      expect(unreadBoundary(views, count, 'me')).toEqual(
        legacy.unreadBoundary(DATASET, count, 'me'),
      );
    }
  });

  it('regroupe les accusés de la même façon', () => {
    expect(legacy.groupReceipts(receipts)).toEqual(groupReceipts(receipts));
  });

  it('agrège les coches et bascule les réactions de la même façon', () => {
    expect(aggregateTick(['read', 'pending', undefined])).toEqual(
      legacy.aggregateTick(['read', 'pending', undefined]),
    );
    const reactions = [{ reaction: 'mbolo/coeur', count: 2, mine: true }];
    expect(toggleLocalReaction(reactions, 'mbolo/coeur')).toEqual(
      legacy.toggleLocalReaction(reactions, 'mbolo/coeur'),
    );
  });

  it('produit une citation identique', () => {
    const source = DATASET[3];
    expect(quoteOfMessage(source)).toEqual(legacy.quoteOfMessage(source));
  });

  it('produit les mêmes rangées que l’oracle de l’écran classique', () => {
    const unreadFrom = { id: 'f', count: 2 };
    const expected = oracleRows(DATASET, unreadFrom);
    const actual = simplifyRows(
      buildChatRows({
        messages: views,
        unreadFrom,
        timeGapMs: CHAT_TIME_GAP_MS,
      }),
    );
    expect(actual).toEqual(expected);
  });
});

describe('références stables', () => {
  it('conserve la référence des messages inchangés après une fusion', () => {
    const [a, b] = views;
    const incoming = classicMessageToView(
      message({ id: 'z', createdAt: '2026-01-01T11:00:00.000Z' }),
      { currentUserId: 'me' },
    );
    const merged = mergeMessages([a, b], [incoming]);
    expect(merged[0]).toBe(a);
    expect(merged[1]).toBe(b);
    expect(merged[2]).toBe(incoming);
  });

  it('réutilise les rangées et les messages inchangés dans les rangées', () => {
    const firstRows = buildChatRows({
      messages: views,
      timeGapMs: CHAT_TIME_GAP_MS,
    });
    const incoming = classicMessageToView(
      message({ id: 'z', createdAt: '2026-01-01T11:00:00.000Z' }),
      { currentUserId: 'me' },
    );
    const mergedMessages = mergeMessages(views, [incoming]);
    const secondRows = buildChatRows({
      messages: mergedMessages,
      timeGapMs: CHAT_TIME_GAP_MS,
      previousRows: firstRows,
    });

    const before = firstRows.find((row) => row.key === 'a');
    const after = secondRows.find((row) => row.key === 'a');
    expect(after).toBe(before);
    if (before?.type === 'message' && after?.type === 'message') {
      expect(after.message).toBe(before.message);
    }

    const albumBefore = firstRows.find((row) => row.type === 'album');
    const albumAfter = secondRows.find((row) => row.type === 'album');
    expect(albumAfter).toBe(albumBefore);
  });
});
