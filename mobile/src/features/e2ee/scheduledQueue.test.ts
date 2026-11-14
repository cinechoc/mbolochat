import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationSummary } from '@/lib/types';
import {
  listDueScheduledMessages,
  loadE2eeAccount,
  loadLocalMessage,
  markLocalMessageSendError,
  nextScheduledMessageAt,
  openE2eeDatabase,
  saveLocalMessage,
  type StoredE2eeMessage,
} from './db';
import { api } from '@/lib/api';
import {
  drainScheduledQueue,
  enqueueScheduledText,
  onScheduledEvent,
  startE2eeScheduledQueue,
  type ScheduledEvent,
} from './scheduledQueue';
import { sendEncryptedText } from './text';

vi.mock('@/lib/api', () => ({
  api: { getConversation: vi.fn() },
}));

vi.mock('./db', () => ({
  listDueScheduledMessages: vi.fn(),
  loadE2eeAccount: vi.fn(),
  loadLocalMessage: vi.fn(),
  markLocalMessageSendError: vi.fn(),
  nextScheduledMessageAt: vi.fn(),
  openE2eeDatabase: vi.fn(),
  saveLocalMessage: vi.fn(),
}));

vi.mock('./text', () => ({
  sendEncryptedText: vi.fn(),
}));

const dbMock = {
  openE2eeDatabase: vi.mocked(openE2eeDatabase),
  listDueScheduledMessages: vi.mocked(listDueScheduledMessages),
  loadE2eeAccount: vi.mocked(loadE2eeAccount),
  loadLocalMessage: vi.mocked(loadLocalMessage),
  markLocalMessageSendError: vi.mocked(markLocalMessageSendError),
  nextScheduledMessageAt: vi.mocked(nextScheduledMessageAt),
  saveLocalMessage: vi.mocked(saveLocalMessage),
};
const apiMock = vi.mocked(api);
const sendMock = vi.mocked(sendEncryptedText);
const fakeDb = { closeAsync: vi.fn(async () => undefined) } as never;

const account = {
  account_pickle: 'pickle',
  device_id: 'device',
  identity_key: 'identity',
  signing_key: 'signing',
};

const row = (input: Partial<StoredE2eeMessage> = {}): StoredE2eeMessage => ({
  id: 'scheduled-1',
  conversation_id: 'conversation-1',
  sender_id: 'me',
  sender_name: 'Moi',
  body: 'message programmé',
  created_at: '2026-01-01T00:00:00.000Z',
  client_id: 'scheduled-1',
  mine: 1,
  media_meta: null,
  quote_id: null,
  sticker_ref: null,
  scheduled_at: '2026-01-01T01:00:00.000Z',
  silent: 0,
  view_once: 0,
  ...input,
});

const conversation = {
  id: 'conversation-1',
  type: 'DIRECT',
  e2eeSince: '2026-01-01T00:00:00.000Z',
} as ConversationSummary;

const preview = {
  url: 'https://exemple.test/article',
  host: 'exemple.test',
  title: 'Article',
  description: 'Résumé',
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.openE2eeDatabase.mockResolvedValue({
    db: fakeDb,
    recovered: false,
    cipherVersion: '4.5.0',
  });
  dbMock.loadE2eeAccount.mockResolvedValue(account);
  dbMock.listDueScheduledMessages.mockResolvedValue([]);
  dbMock.nextScheduledMessageAt.mockResolvedValue(null);
  dbMock.markLocalMessageSendError.mockResolvedValue(undefined);
  apiMock.getConversation.mockResolvedValue(conversation);
});

describe('file des messages E2EE programmés', () => {
  it('écrit le clair et ses options dans le stockage chiffré, sans envoyer', async () => {
    const stored = await enqueueScheduledText({
      token: 'token',
      currentUserId: 'me',
      currentUserName: 'Moi',
      db: fakeDb,
      conversation,
      text: 'message programmé',
      replyToId: null,
      scheduledAt: '2026-01-01T01:00:00.000Z',
      silent: true,
      viewOnce: true,
      preview,
    });
    expect(stored.id).toBe(stored.client_id);
    expect(stored.scheduled_at).toBe('2026-01-01T01:00:00.000Z');
    expect(stored.silent).toBe(1);
    expect(stored.view_once).toBe(1);
    expect(stored.preview_json).toBe(JSON.stringify(preview));
    expect(dbMock.saveLocalMessage).toHaveBeenCalledWith(fakeDb, stored);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('envoie une échéance due avec le même clientId et les options', async () => {
    const events: ScheduledEvent[] = [];
    const off = onScheduledEvent((event) => events.push(event));
    const stop = startE2eeScheduledQueue({
      token: 'token',
      currentUserId: 'me',
      currentUserName: 'Moi',
    });
    const pending = row({ silent: 1, view_once: 1, preview_json: JSON.stringify(preview) });
    dbMock.listDueScheduledMessages.mockResolvedValueOnce([pending]);
    sendMock.mockResolvedValueOnce({
      clientId: 'scheduled-1',
      serverMessage: { id: 'server-1', createdAt: '2026-01-01T01:00:01.000Z' } as never,
      stored: { ...pending, id: 'server-1' },
    });

    await drainScheduledQueue();

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'scheduled-1',
        scheduledAt: '2026-01-01T01:00:00.000Z',
        silent: true,
        viewOnce: true,
        preview,
        retainOnFailure: true,
      }),
    );
    expect(events).toMatchObject([
      {
        type: 'sent',
        previousId: 'scheduled-1',
        stored: { id: 'server-1' },
      },
    ]);
    off();
    stop();
  });

  it('marque un échec sans boucle et sans supprimer le clair local', async () => {
    const events: ScheduledEvent[] = [];
    const off = onScheduledEvent((event) => events.push(event));
    const stop = startE2eeScheduledQueue({
      token: 'token',
      currentUserId: 'me',
      currentUserName: 'Moi',
    });
    const pending = row();
    dbMock.listDueScheduledMessages.mockResolvedValueOnce([pending]);
    sendMock.mockRejectedValueOnce(new Error('réseau'));
    dbMock.loadLocalMessage.mockResolvedValueOnce({ ...pending, send_error: 'send_failed' });

    await drainScheduledQueue();

    expect(dbMock.markLocalMessageSendError).toHaveBeenCalledWith(fakeDb, 'scheduled-1');
    expect(dbMock.loadLocalMessage).toHaveBeenCalledWith(fakeDb, 'scheduled-1');
    expect(events[0]).toMatchObject({ type: 'failed', previousId: 'scheduled-1' });
    expect(sendMock).toHaveBeenCalledTimes(1);
    off();
    stop();
  });
});
