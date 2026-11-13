import { describe, expect, it, vi } from 'vitest';

import type { ConversationSummary, Message } from '@/lib/types';
import { ClassicTransport } from './classic-transport';
import { contractMessage, runTransportContract } from './contract';
import type { ClassicTransportDeps, ClassicTransportOptions } from './deps';
import { EncryptedConversationError, type ChatMessageView } from './types';

const sender = (id: string) => ({
  id,
  username: id,
  displayName: id,
  avatarUrl: null,
  gender: null,
  genderCustom: null,
});

const message = (id: string, createdAt: string): Message => ({
  id,
  conversationId: 'conversation-1',
  type: 'text',
  content: id,
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
  createdAt,
  sender: sender('peer'),
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
  e2eeSince: null,
  members: [
    { ...sender('me'), lastReadAt: null, role: 'member' },
    { ...sender('peer'), lastReadAt: null, role: 'member' },
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

const options: ClassicTransportOptions = {
  conversationId: 'conversation-1',
  token: 'token',
  currentUser: { ...sender('me') },
  summary: summary(),
};

function createFakes(seed: Message[]) {
  const cache = {
    getConversation: vi.fn(() => null),
    getMessages: vi.fn(() => null),
    setMessages: vi.fn(),
    setConversation: vi.fn(),
    getDraft: vi.fn(() => ''),
    setDraft: vi.fn(),
    clearDraft: vi.fn(),
  };
  const api = {
    getConversation: vi.fn(async () => options.summary),
    listMessages: vi.fn(async () => seed),
    listReceipts: vi.fn(async () => []),
  };
  const outbox = {
    enqueue: vi.fn(async () => ({}) as never),
    drain: vi.fn(async () => undefined),
    listOutbox: vi.fn(async () => []),
    subscribe: vi.fn(() => () => undefined),
    onSent: vi.fn(() => () => undefined),
    discard: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    pendingMessage: vi.fn(),
    localCreatedAtMs: vi.fn(() => undefined),
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
    getSocket: vi.fn(() => socket as never),
    onConnection: vi.fn(() => () => undefined),
    reportDelivered: vi.fn(),
    deleteMessage: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => []),
  };
  const sync = {
    advanceCursor: vi.fn(async () => undefined),
    onMissedMessages: vi.fn(() => () => undefined),
  };

  const deps: ClassicTransportDeps = {
    api: api as unknown as ClassicTransportDeps['api'],
    cache: cache as unknown as ClassicTransportDeps['cache'],
    outbox: outbox as unknown as ClassicTransportDeps['outbox'],
    socket: socketDeps as unknown as ClassicTransportDeps['socket'],
    sync: sync as unknown as ClassicTransportDeps['sync'],
    clock: () => 0,
  };
  const emitEvent = (event: string, ...args: unknown[]) => {
    for (const handler of listeners.get(event) ?? []) {
      handler(...args);
    }
  };
  return { deps, cache, api, outbox, socket, socketDeps, emitEvent };
}

const SEED = [
  message('a', '2026-01-01T00:00:01.000Z'),
  message('b', '2026-01-01T00:00:02.000Z'),
];

const viewToServerMessage = (view: ChatMessageView): Message => ({
  id: view.id,
  conversationId: view.conversationId,
  type: 'text',
  content: view.body,
  encryption: 'none',
  payload: null,
  payloadType: null,
  senderDeviceId: null,
  stickerRef: null,
  attachment: null,
  encryptedAttachment: null,
  clientId: view.clientId,
  deleted: false,
  replyTo: null,
  reactions: [],
  createdAt: view.createdAt,
  sender: {
    id: view.sender.id,
    username: view.sender.username,
    displayName: view.sender.displayName,
    avatarUrl: view.sender.avatarUrl,
    gender: view.sender.gender,
    genderCustom: view.sender.genderCustom,
  },
});

runTransportContract({
  name: 'classique',
  create: async () => {
    const fakes = createFakes(SEED);
    const transport = new ClassicTransport(fakes.deps, options);
    return {
      transport,
      expectedInitialIds: ['a', 'b'],
      incoming: (view) => fakes.emitEvent('message:new', viewToServerMessage(view)),
      cleanup: async () => transport.dispose(),
    };
  },
});

describe('ClassicTransport — anti-downgrade et outbox', () => {
  it('refuse de s’instancier pour une conversation chiffrée', () => {
    const fakes = createFakes(SEED);
    expect(
      () =>
        new ClassicTransport(fakes.deps, {
          ...options,
          summary: summary({ e2eeSince: '2026-01-01T00:00:00.000Z' }),
        }),
    ).toThrow(EncryptedConversationError);
  });

  it('envoie un texte par l’outbox avec un contenu normalisé', async () => {
    const fakes = createFakes(SEED);
    const transport = new ClassicTransport(fakes.deps, options);
    await transport.sendText('  bonjour  ', 'quote-1');
    expect(fakes.outbox.enqueue).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      content: 'bonjour',
      replyTo: 'quote-1',
    });
    expect(fakes.outbox.drain).toHaveBeenCalledWith('token');
  });

  it('signale la lecture une fois l’historique chargé, comme l’ancien écran', async () => {
    const fakes = createFakes(SEED);
    const transport = new ClassicTransport(fakes.deps, options);
    await transport.loadInitial();
    expect(fakes.socket.emit).toHaveBeenCalledWith('message:read', {
      conversationId: 'conversation-1',
    });
    await transport.dispose();
  });

  it('n’écrit aucun brouillon pour un texte vide', () => {
    const fakes = createFakes(SEED);
    const transport = new ClassicTransport(fakes.deps, options);
    transport.saveDraft('   ');
    expect(fakes.cache.clearDraft).toHaveBeenCalledWith('conversation-1');
    expect(fakes.cache.setDraft).not.toHaveBeenCalled();
  });

  it('conserve l’ordre et déduplique les messages entrants', async () => {
    const fakes = createFakes(SEED);
    const transport = new ClassicTransport(fakes.deps, options);
    const received: string[] = [];
    transport.subscribe({
      onMessage: (message) => received.push(message.id),
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
    const incoming = viewToServerMessage(
      contractMessage('c', '2026-01-01T00:00:03.000Z'),
    );
    fakes.emitEvent('message:new', incoming);
    fakes.emitEvent('message:new', incoming);
    expect(received.filter((id) => id === 'c')).toHaveLength(1);
    await transport.dispose();
  });
});
