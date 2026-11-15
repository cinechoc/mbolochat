import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteMessage, ensureSocket, onConnection } from '@/lib/socket';
import { api } from '@/lib/api';
import {
  listPendingEnvelopes,
  markEnvelopeSent,
  setEnvelopeState,
  type PendingOutboxEnvelope,
} from './atomic';
import {
  loadE2eeAccount,
  loadLocalMessageByClientId,
  listPendingViewOnceConsumptions,
  markViewOnceServerHidden,
  markLocalMessageSendError,
  openE2eeDatabase,
  renameLocalMessage,
  type StoredE2eeMessage,
} from './db';
import { resumeEncryptedMedia } from './media';
import { listIncompleteMediaPreparations } from './mediaPrep';
import {
  drainE2eeOutbox,
  onE2eeOutboxEvent,
  startE2eeOutboxRecovery,
  type E2eeOutboxEvent,
} from './outboxRecovery';

vi.mock('./atomic', () => ({
  listPendingEnvelopes: vi.fn(),
  markEnvelopeSent: vi.fn(),
  resetEnvelopeForRetry: vi.fn(),
  setEnvelopeState: vi.fn(),
}));

vi.mock('./db', () => ({
  loadE2eeAccount: vi.fn(),
  loadLocalMessageByClientId: vi.fn(),
  listPendingViewOnceConsumptions: vi.fn(),
  markViewOnceServerHidden: vi.fn(),
  markLocalMessageSendError: vi.fn(),
  openE2eeDatabase: vi.fn(),
  renameLocalMessage: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  deleteMessage: vi.fn(),
  ensureSocket: vi.fn(),
  onConnection: vi.fn(() => () => undefined),
}));

vi.mock('@/lib/api', () => ({
  api: { getConversation: vi.fn() },
}));

vi.mock('./media', () => ({
  resumeEncryptedMedia: vi.fn(),
}));

vi.mock('./mediaPrep', () => ({
  listIncompleteMediaPreparations: vi.fn(async () => []),
  noteMediaPreparationError: vi.fn(async () => undefined),
}));

const atomicMock = {
  listPendingEnvelopes: vi.mocked(listPendingEnvelopes),
  markEnvelopeSent: vi.mocked(markEnvelopeSent),
  setEnvelopeState: vi.mocked(setEnvelopeState),
};
const dbMock = {
  loadE2eeAccount: vi.mocked(loadE2eeAccount),
  loadLocalMessageByClientId: vi.mocked(loadLocalMessageByClientId),
  listPendingViewOnceConsumptions: vi.mocked(listPendingViewOnceConsumptions),
  markViewOnceServerHidden: vi.mocked(markViewOnceServerHidden),
  markLocalMessageSendError: vi.mocked(markLocalMessageSendError),
  openE2eeDatabase: vi.mocked(openE2eeDatabase),
  renameLocalMessage: vi.mocked(renameLocalMessage),
};
const socketMock = vi.mocked(ensureSocket);
const deleteMessageMock = vi.mocked(deleteMessage);
const connectionMock = vi.mocked(onConnection);
const apiMock = vi.mocked(api);
const mediaResumeMock = vi.mocked(resumeEncryptedMedia);
const mediaListMock = vi.mocked(listIncompleteMediaPreparations);

const fakeDb = {
  closeAsync: vi.fn(async () => undefined),
} as never;

const pending: PendingOutboxEnvelope = {
  clientId: 'client-1',
  conversationId: 'conv-1',
  accountId: 'local-identity',
  envelope: { payload: 'E1', payloadType: 'prekey' },
  state: 'pending',
  attempts: 0,
};

const local: StoredE2eeMessage = {
  id: 'client-1',
  conversation_id: 'conv-1',
  sender_id: 'me',
  sender_name: 'Moi',
  body: 'hors ligne',
  created_at: '2026-01-01T00:00:00.000Z',
  client_id: 'client-1',
  mine: 1,
  media_meta: null,
  quote_id: null,
  send_error: 'send_failed',
};

let stop: (() => void) | null = null;
let offEvent: (() => void) | null = null;

function socketAck(ack: () => Promise<unknown>) {
  const emitWithAck = vi.fn(async (_event: string, _payload: unknown) => ack());
  socketMock.mockResolvedValue({
    timeout: () => ({ emitWithAck }),
  } as never);
  return emitWithAck;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.openE2eeDatabase.mockResolvedValue({
    db: fakeDb,
    recovered: false,
    cipherVersion: '4.5.0',
  });
  dbMock.loadE2eeAccount.mockResolvedValue({
    account_pickle: 'pickle',
    device_id: 'device-1',
    user_id: 'me',
    identity_key: 'local-identity',
    signing_key: 'local-signing',
  });
  dbMock.loadLocalMessageByClientId.mockResolvedValue(local);
  dbMock.listPendingViewOnceConsumptions.mockResolvedValue([]);
  dbMock.markViewOnceServerHidden.mockResolvedValue(undefined);
  dbMock.markLocalMessageSendError.mockResolvedValue(undefined);
  dbMock.renameLocalMessage.mockResolvedValue(undefined);
  deleteMessageMock.mockResolvedValue(undefined);
  atomicMock.listPendingEnvelopes.mockResolvedValue([pending]);
  atomicMock.markEnvelopeSent.mockResolvedValue(undefined);
  atomicMock.setEnvelopeState.mockResolvedValue(undefined);
  stop = startE2eeOutboxRecovery({
    token: 'token',
    currentUserId: 'me',
    currentUserName: 'Moi',
  });
});

afterEach(() => {
  offEvent?.();
  offEvent = null;
  stop?.();
  stop = null;
});

describe('reprise de l’outbox E2EE', () => {
  it('rejoue l’enveloppe exacte avec le même clientId puis renomme la bulle', async () => {
    const events: E2eeOutboxEvent[] = [];
    offEvent = onE2eeOutboxEvent((event) => events.push(event));
    const emitWithAck = socketAck(async () => ({
      id: 'server-1',
      createdAt: '2026-01-01T00:00:05.000Z',
    }));

    await drainE2eeOutbox();

    expect(connectionMock).toHaveBeenCalledTimes(1);
    expect(atomicMock.setEnvelopeState).toHaveBeenNthCalledWith(
      1,
      fakeDb,
      'client-1',
      'sending',
      { incrementAttempts: true },
    );
    expect(emitWithAck).toHaveBeenCalledWith('message:send', {
      conversationId: 'conv-1',
      content: '',
      encryption: 'v1',
      payload: 'E1',
      payloadType: 'prekey',
      clientId: 'client-1',
      viewOnce: false,
    });
    expect(dbMock.renameLocalMessage).toHaveBeenCalledWith(fakeDb, 'client-1', 'server-1');
    expect(atomicMock.markEnvelopeSent).toHaveBeenCalledWith(fakeDb, 'client-1', 'server-1');
    expect(events).toMatchObject([
      {
        type: 'sent',
        previousId: 'client-1',
        stored: { id: 'server-1', client_id: 'client-1', send_error: null },
      },
    ]);
  });

  it('conserve la lecture unique lors d’une reprise', async () => {
    dbMock.loadLocalMessageByClientId.mockResolvedValue({ ...local, view_once: 1 });
    const emitWithAck = socketAck(async () => ({
      id: 'server-1',
      createdAt: '2026-01-01T00:00:05.000Z',
    }));

    await drainE2eeOutbox();

    expect(emitWithAck).toHaveBeenCalledWith(
      'message:send',
      expect.objectContaining({ clientId: 'client-1', viewOnce: true }),
    );
  });

  it('laisse l’enveloppe pending après une coupure et conserve la bulle en échec', async () => {
    const events: E2eeOutboxEvent[] = [];
    offEvent = onE2eeOutboxEvent((event) => events.push(event));
    const emitWithAck = socketAck(async () => {
      throw new Error('réseau coupé');
    });

    await drainE2eeOutbox();

    expect(emitWithAck).toHaveBeenCalledTimes(1);
    expect(atomicMock.setEnvelopeState).toHaveBeenLastCalledWith(
      fakeDb,
      'client-1',
      'pending',
      { error: 'network' },
    );
    expect(dbMock.markLocalMessageSendError).toHaveBeenCalledWith(fakeDb, 'client-1');
    expect(dbMock.loadLocalMessageByClientId).toHaveBeenCalledWith(fakeDb, 'client-1');
    expect(atomicMock.markEnvelopeSent).not.toHaveBeenCalled();
    expect(events).toMatchObject([{ type: 'failed', previousId: 'client-1' }]);
  });

  it('marque failed sur refus serveur et ne rejoue pas dans la même passe', async () => {
    const emitWithAck = socketAck(async () => ({ error: 'quota' }));

    await drainE2eeOutbox();

    expect(emitWithAck).toHaveBeenCalledTimes(1);
    expect(atomicMock.setEnvelopeState).toHaveBeenLastCalledWith(
      fakeDb,
      'client-1',
      'failed',
      { error: 'server_refused' },
    );
    expect(atomicMock.listPendingEnvelopes).toHaveBeenCalledTimes(1);
  });

  it('reprend un média journalisé sans retéléverser ni rechiffrer', async () => {
    const events: E2eeOutboxEvent[] = [];
    offEvent = onE2eeOutboxEvent((event) => events.push(event));
    atomicMock.listPendingEnvelopes.mockResolvedValue([]);
    socketAck(async () => ({ id: 'unused' }));
    mediaListMock.mockResolvedValueOnce([
      {
        clientId: 'media-1',
        conversationId: 'conv-1',
        outboxState: 'pending',
        outcome: { kind: 'recoverable', next: 'emit' },
      } as never,
    ]);
    apiMock.getConversation.mockResolvedValueOnce({
      id: 'conv-1',
      type: 'DIRECT',
      e2eeSince: '2026-01-01T00:00:00.000Z',
    } as never);
    mediaResumeMock.mockResolvedValueOnce({
      clientId: 'media-1',
      serverMessage: { id: 'server-media-1', createdAt: '2026-01-01T00:00:30.000Z' },
      stored: {
        ...local,
        id: 'server-media-1',
        client_id: 'media-1',
        send_error: null,
      },
    } as never);

    await drainE2eeOutbox();

    expect(mediaResumeMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'media-1', currentUserId: 'me' }),
    );
    expect(events).toMatchObject([
      { type: 'sent', previousId: 'media-1', stored: { id: 'server-media-1' } },
    ]);
  });

  it('rejoue le masquage d’une vue unique consommée hors ligne', async () => {
    atomicMock.listPendingEnvelopes.mockResolvedValue([]);
    socketAck(async () => ({ id: 'unused' }));
    dbMock.listPendingViewOnceConsumptions.mockResolvedValue([
      { message_id: 'view-once-1', conversation_id: 'conv-1' },
    ]);

    await drainE2eeOutbox();

    expect(deleteMessageMock).toHaveBeenCalledWith(
      'token',
      'conv-1',
      'view-once-1',
      false,
    );
    expect(dbMock.markViewOnceServerHidden).toHaveBeenCalledWith(fakeDb, 'view-once-1');
  });
});
