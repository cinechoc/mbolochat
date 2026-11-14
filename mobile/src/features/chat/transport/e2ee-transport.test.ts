import { describe, expect, it, vi } from 'vitest';

import { deliveredIds, mergeReceipts, receiptState, canReportDelivered } from '@/features/e2ee/receipts';
import type { E2eeAccountRow, E2eeDatabase, StoredE2eeMessage } from '@/features/e2ee/db';
import type { ConversationSummary, Message } from '@/lib/types';
import { runTransportContract } from './contract';import type { E2eeTransportDeps, E2eeTransportOptions } from './deps';
import { E2eeTransport } from './e2ee-transport';
import { PlaintextConversationError, type ChatMessageView } from './types';

const ACCOUNT: E2eeAccountRow = {
  account_pickle: 'pickle',
  device_id: 'device-1',
  identity_key: 'identity',
  signing_key: 'signing',
};

const identity = (id: string) => ({
  id,
  username: id,
  displayName: id,
  avatarUrl: null,
  gender: null,
  genderCustom: null,
});

const summary = (input: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'conversation-1',
  type: 'DIRECT',
  name: null,
  avatarUrl: null,
  emoji: null,
  color: null,
  description: null,
  ownerId: null,
  whoCanSend: 'all',
  whoCanAdd: 'all',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  e2eeSince: '2026-01-01T00:00:00.000Z',
  members: [
    { ...identity('me'), lastReadAt: null, role: 'member' },
    { ...identity('peer'), lastReadAt: null, role: 'member' },
  ],
  lastMessage: null,
  unreadCount: 0,
  pinned: false,
  muted: false,
  hidden: false,
  myRole: 'member',
  blockedByMe: false,
  blockedByThem: false,
  ...input,
});

const stored = (
  id: string,
  createdAt: string,
  input: Partial<StoredE2eeMessage> = {},
): StoredE2eeMessage => ({
  id,
  conversation_id: 'conversation-1',
  sender_id: 'peer',
  sender_name: 'Pair',
  body: id,
  created_at: createdAt,
  client_id: null,
  mine: 0,
  media_meta: null,
  quote_id: null,
  sticker_ref: null,
  unreadable_reason: null,
  ...input,
});

const serverMessage = (id: string, createdAt: string, input: Partial<Message> = {}): Message => ({
  id,
  conversationId: 'conversation-1',
  type: 'text',
  content: '',
  encryption: 'v1',
  payload: 'payload',
  payloadType: 'normal',
  senderDeviceId: 'device-1',
  stickerRef: null,
  attachment: null,
  encryptedAttachment: null,
  clientId: null,
  deleted: false,
  replyTo: null,
  reactions: [],
  createdAt,
  sender: {
    ...identity('peer'),
  },
  ...input,
});

const options: E2eeTransportOptions = {
  conversationId: 'conversation-1',
  token: 'token',
  currentUser: { ...identity('me') },
  peer: { ...identity('peer') },
  summary: summary(),
  isForeground: () => true,
  isPeerOnline: () => false,
};

const SEED = [
  stored('a', '2026-01-01T00:00:01.000Z', { mine: 1 }),
  stored('b', '2026-01-01T00:00:02.000Z'),
];

function createFakes(seed: StoredE2eeMessage[], history: Message[] = []) {
  const fakeDb = { closeAsync: vi.fn(async () => undefined) } as unknown as E2eeDatabase['db'];
  const db = {
    openE2eeDatabase: vi.fn(async () => ({
      db: fakeDb,
      recovered: false,
      cipherVersion: '4.5.0',
    })),
    loadE2eeAccount: vi.fn(async () => ACCOUNT),
    listLocalMessages: vi.fn(async () => seed),
    knownMessageKeys: vi.fn(async () => ({
      ids: new Set(seed.map((message) => message.id)),
      clientIds: new Set<string>(),
    })),
    saveDraft: vi.fn(async () => undefined),
    loadDraft: vi.fn(async () => 'brouillon chiffré'),
    deleteLocalMessage: vi.fn(async () => undefined),
    loadReactionSummaries: vi.fn(async () => new Map()),
  };
  const crypto = {
    sendEncryptedText: vi.fn(async () => ({
      clientId: 'sent-1',
      serverMessage: serverMessage('sent-1', '2026-01-01T00:00:09.000Z', { sender: identity('me') }),
      stored: stored('sent-1', '2026-01-01T00:00:09.000Z', {
        mine: 1,
        sender_id: 'me',
        sender_name: 'me',
        client_id: 'sent-1',
      }),
    })),
    sendEncryptedMedia: vi.fn(async () => ({
      clientId: 'media-1',
      serverMessage: serverMessage('media-1', '2026-01-01T00:00:10.000Z', { sender: identity('me') }),
      stored: stored('media-1', '2026-01-01T00:00:10.000Z', {
        mine: 1,
        sender_id: 'me',
        sender_name: 'me',
        client_id: 'media-1',
      }),
    })),
    sendEncryptedReaction: vi.fn(async () => ({
      clientId: 'reaction-1',
      serverMessage: serverMessage('reaction-1', '2026-01-01T00:00:11.000Z', {
        sender: identity('me'),
      }),
      stored: stored('reaction-1', '2026-01-01T00:00:11.000Z', {
        sender_id: 'me',
        sender_name: 'me',
        body: '',
        hidden: 1,
        content_kind: 'reaction',
        control_target: 'a',
        reaction: 'mbolo-panther-2d/amour',
        reaction_action: 'add',
      }),
    })),
    decryptIncoming: vi.fn(async ({ message }: { message: Message }) => ({
      text: '',
      account: ACCOUNT,
      stored: stored(message.id, message.createdAt, { sender_name: 'Pair' }),
      keyChanged: false,
    })),
  };
  const api = {
    listMessages: vi.fn(async () => history),
    listReceipts: vi.fn(async () => []),
    markMessagesRead: vi.fn(async () => undefined),
  };

  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const socket = {
    connected: true,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    emit: vi.fn(),
  };
  const socketDeps = {
    connectSocket: vi.fn(() => socket as never),
    ensureSocket: vi.fn(async () => socket as never),
    onConnection: vi.fn((listener: (online: boolean) => void) => {
      listener(true);
      return () => undefined;
    }),
    reportDelivered: vi.fn(),
    deleteMessage: vi.fn(async () => undefined),
  };
  const receipts = {
    mergeReceipts,
    receiptState,
    deliveredIds,
    canReportDelivered,
  };
  const cache = { patchConversation: vi.fn() };
  const deps: E2eeTransportDeps = {
    api: api as unknown as E2eeTransportDeps['api'],
    socket: socketDeps as unknown as E2eeTransportDeps['socket'],
    db: db as unknown as E2eeTransportDeps['db'],
    crypto: crypto as unknown as E2eeTransportDeps['crypto'],
    receipts: receipts as unknown as E2eeTransportDeps['receipts'],
    cache: cache as unknown as E2eeTransportDeps['cache'],
    clock: () => 0,
  };
  const emitEvent = (event: string, ...args: unknown[]) => {
    for (const handler of listeners.get(event) ?? []) {
      handler(...args);
    }
  };
  return { deps, db, crypto, api, socket, socketDeps, cache, emitEvent, fakeDb };
}

runTransportContract({
  name: 'chiffré',
  create: async () => {
    const fakes = createFakes(SEED);
    const transport = new E2eeTransport(fakes.deps, options);
    return {
      transport,
      expectedInitialIds: ['a', 'b'],
      incoming: async (view: ChatMessageView) => {
        fakes.emitEvent('message:new', serverMessage(view.id, view.createdAt));
        // Laisse la chaîne de déchiffrement (asynchrone) atteindre son terme.
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
      cleanup: async () => transport.dispose(),
    };
  },
});

describe('E2eeTransport — anti-downgrade et sécurité', () => {
  it('refuse de s’instancier pour une conversation claire', () => {
    const fakes = createFakes(SEED);
    expect(
      () =>
        new E2eeTransport(fakes.deps, {
          ...options,
          summary: summary({ e2eeSince: null }),
        }),
    ).toThrow(PlaintextConversationError);
  });

  it('restitue l’historique local si le chargement serveur échoue', async () => {
    const fakes = createFakes(SEED);
    fakes.api.listMessages.mockRejectedValueOnce(new Error('hors ligne'));
    const transport = new E2eeTransport(fakes.deps, options);
    const snapshot = await transport.loadInitial();
    expect(snapshot.messages.map((message) => message.id)).toEqual(['a', 'b']);
    expect(fakes.crypto.decryptIncoming).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it('déchiffre les messages serveur inconnus au chargement', async () => {
    const unknown = serverMessage('c', '2026-01-01T00:00:03.000Z');
    const fakes = createFakes(SEED, [unknown]);
    const transport = new E2eeTransport(fakes.deps, options);
    const snapshot = await transport.loadInitial();
    expect(fakes.crypto.decryptIncoming).toHaveBeenCalledTimes(1);
    expect(snapshot.messages.map((message) => message.id)).toContain('c');
    await transport.dispose();
  });

  it('envoie un texte par le chiffrement, jamais par l’outbox ni un upload clair', async () => {
    const clearUpload = vi.fn();
    const fakes = createFakes(SEED);
    const transport = new E2eeTransport(fakes.deps, options);
    await transport.sendText('secret', null);
    expect(fakes.crypto.sendEncryptedText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'secret', currentUserId: 'me' }),
    );
    expect(clearUpload).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it('remonte l’échec hors ligne sans repli clair ni effacement du brouillon', async () => {
    const fakes = createFakes(SEED);
    fakes.crypto.sendEncryptedText.mockRejectedValueOnce(
      new Error('Connexion au serveur impossible. Vérifie ta connexion.'),
    );
    const transport = new E2eeTransport(fakes.deps, options);
    await expect(transport.sendText('secret hors ligne', null)).rejects.toThrow(
      'Connexion au serveur impossible',
    );
    expect(fakes.crypto.sendEncryptedText).toHaveBeenCalledTimes(1);
    expect(fakes.db.saveDraft).not.toHaveBeenCalled();
    expect(transport.mode).toBe('e2ee');
    await transport.dispose();
  });

  it('envoie un média par le chiffrement, avec sa description intacte', async () => {
    const fakes = createFakes(SEED);
    const transport = new E2eeTransport(fakes.deps, options);
    await transport.sendMedia(
      {
        uri: 'file:///photo.jpg',
        kind: 'image',
        mime: 'image/jpeg',
        name: 'photo.jpg',
        size: 10,
        width: 100,
        height: 80,
        durationMs: null,
      },
      'légende',
      null,
    );
    expect(fakes.crypto.sendEncryptedMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: expect.objectContaining({ uri: 'file:///photo.jpg', kind: 'image' }),
        caption: 'légende',
      }),
    );
    await transport.dispose();
  });

  it('agrège les réactions et les envoie dans l’enveloppe Olm', async () => {
    const fakes = createFakes(SEED);
    fakes.db.loadReactionSummaries.mockResolvedValueOnce(
      new Map([['a', [{ reaction: 'mbolo-panther-2d/amour', count: 1, mine: false }]]]),
    );
    const transport = new E2eeTransport(fakes.deps, options);
    const snapshot = await transport.loadInitial();
    expect(snapshot.messages.find((message) => message.id === 'a')?.reactions).toEqual([
      { reaction: 'mbolo-panther-2d/amour', count: 1, mine: false },
    ]);

    await transport.toggleReaction('a', 'mbolo-panther-2d/amour');
    expect(fakes.crypto.sendEncryptedReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'a',
        reaction: 'mbolo-panther-2d/amour',
        action: 'add',
      }),
    );
    expect(fakes.socketDeps.deleteMessage).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it('applique les accusés chargés après les messages locaux', async () => {
    const fakes = createFakes(SEED);
    fakes.api.listReceipts.mockResolvedValue([
      {
        messageId: 'a',
        userId: 'peer',
        deliveredAt: '2026-01-01T00:00:03.000Z',
        readAt: '2026-01-01T00:00:04.000Z',
      },
    ] as never);
    const transport = new E2eeTransport(fakes.deps, { ...options, isPeerOnline: () => true });
    const snapshot = await transport.loadInitial();
    expect(snapshot.messages.find((message) => message.id === 'a')?.state).toBe('read');
    await transport.dispose();
  });

  it('propage l’état de connexion au bandeau hors ligne', async () => {
    const fakes = createFakes(SEED);
    fakes.socketDeps.onConnection.mockImplementationOnce((listener) => {
      listener(false);
      return () => undefined;
    });
    const transport = new E2eeTransport(fakes.deps, options);
    const states: boolean[] = [];
    const off = transport.subscribe({
      onMessage: () => undefined,
      onMessageRemoved: () => undefined,
      onReceipts: () => undefined,
      onReaction: () => undefined,
      onTyping: () => undefined,
      onConnection: (online) => states.push(online),
      onConversationUpdated: () => undefined,
      onConversationRemoved: () => undefined,
      onError: () => undefined,
      onFatal: () => undefined,
    });
    expect(states).toEqual([false]);
    off();
    await transport.dispose();
  });

  it('met à jour une bulle à l’arrivée de « Reçu » puis « Ouvert »', async () => {
    const fakes = createFakes(SEED);
    const transport = new E2eeTransport(fakes.deps, { ...options, isPeerOnline: () => true });
    await transport.loadInitial();
    const received: ChatMessageView[] = [];
    const off = transport.subscribe({
      onMessage: (message) => received.push(message),
      onMessageRemoved: () => undefined,
      onReceipts: () => undefined,
      onReaction: () => undefined,
      onTyping: () => undefined,
      onConnection: () => undefined,
      onConversationUpdated: () => undefined,
      onConversationRemoved: () => undefined,
      onError: () => undefined,
      onFatal: () => undefined,
    });
    fakes.emitEvent('receipt', {
      receipts: [
        {
          messageId: 'a',
          userId: 'peer',
          deliveredAt: '2026-01-01T00:00:03.000Z',
          readAt: null,
        },
      ],
    });
    expect(received[received.length - 1]).toMatchObject({ id: 'a', state: 'delivered' });
    fakes.emitEvent('receipt', {
      receipts: [
        {
          messageId: 'a',
          userId: 'peer',
          deliveredAt: '2026-01-01T00:00:03.000Z',
          readAt: '2026-01-01T00:00:04.000Z',
        },
      ],
    });
    expect(received[received.length - 1]).toMatchObject({ id: 'a', state: 'read' });
    off();
    await transport.dispose();
  });

  it('marque les messages lus uniquement quand des identifiants sont fournis', async () => {
    const fakes = createFakes(SEED);
    const transport = new E2eeTransport(fakes.deps, options);
    await transport.markRead([]);
    expect(fakes.api.markMessagesRead).not.toHaveBeenCalled();
    await transport.markRead(['a']);
    expect(fakes.api.markMessagesRead).toHaveBeenCalledWith('token', 'conversation-1', ['a']);
    await transport.dispose();
  });

  it('n’envoie jamais le texte de frappe et limite la fréquence', async () => {
    const fakes = createFakes(SEED);
    const transport = new E2eeTransport(fakes.deps, options);
    transport.setTyping(true, 'secret en cours');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakes.socketDeps.ensureSocket).toHaveBeenCalledTimes(1);
    expect(fakes.socket.emit).toHaveBeenCalledWith('typing', {
      conversationId: 'conversation-1',
      typing: true,
    });
    expect(JSON.stringify(fakes.socket.emit.mock.calls)).not.toContain('secret en cours');

    transport.setTyping(true, 'toujours secret');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakes.socket.emit).toHaveBeenCalledTimes(1);

    transport.setTyping(false, 'secret final');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakes.socket.emit).toHaveBeenLastCalledWith('typing', {
      conversationId: 'conversation-1',
      typing: false,
    });
    await transport.dispose();
  });

  it('efface l’indicateur de frappe reçu après expiration', async () => {
    vi.useFakeTimers();
    const fakes = createFakes(SEED);
    const transport = new E2eeTransport(fakes.deps, options);
    const states: ({ userId: string; text: string } | null)[] = [];
    const off = transport.subscribe({
      onMessage: () => undefined,
      onMessageRemoved: () => undefined,
      onReceipts: () => undefined,
      onReaction: () => undefined,
      onTyping: (state) => states.push(state),
      onConnection: () => undefined,
      onConversationUpdated: () => undefined,
      onConversationRemoved: () => undefined,
      onError: () => undefined,
      onFatal: () => undefined,
    });
    fakes.emitEvent('typing', {
      conversationId: 'conversation-1',
      userId: 'peer',
      typing: true,
      text: 'ne doit jamais être lu',
    });
    expect(states).toEqual([{ userId: 'peer', text: '' }]);
    vi.advanceTimersByTime(4_000);
    expect(states).toEqual([{ userId: 'peer', text: '' }, null]);
    off();
    await transport.dispose();
    vi.useRealTimers();
  });

  it('transfère un texte uniquement vers une cible chiffrée directe', async () => {
    const fakes = createFakes(SEED);
    const transport = new E2eeTransport(fakes.deps, options);
    const target = summary({ id: 'target-1' });
    await transport.forwardText(target, 'à transférer');
    expect(fakes.crypto.sendEncryptedText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'à transférer', conversation: target }),
    );
    expect(fakes.cache.patchConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'target-1',
        lastMessage: expect.objectContaining({ id: 'sent-1' }),
        updatedAt: '2026-01-01T00:00:09.000Z',
      }),
    );
    await expect(
      transport.forwardText(summary({ id: 'target-2', e2eeSince: null }), 'interdit'),
    ).rejects.toThrow();
    await transport.dispose();
  });

  it('charge le brouillon depuis SQLCipher, pas depuis le cache clair', async () => {
    const fakes = createFakes(SEED);
    const transport = new E2eeTransport(fakes.deps, options);
    await expect(transport.loadDraft()).resolves.toBe('brouillon chiffré');
    await transport.dispose();
  });
});
