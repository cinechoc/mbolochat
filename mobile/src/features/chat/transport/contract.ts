import { describe, expect, it } from 'vitest';

import {
  UnsupportedCapabilityError,
  type ChatMessageView,
  type ChatTransport,
  type ChatTransportHandlers,
  type GatedCapability,
} from './types';

/**
 * Suite de contrat commune aux transports classique et chiffré.
 *
 * Chaque implémentation fournit un banc avec ses faux (API, socket, outbox,
 * base) ; la suite ne vérifie que le comportement observable de l'interface.
 */
export interface TransportContractHarness {
  transport: ChatTransport;
  /** Identifiants de l'instantané initial, triés. */
  expectedInitialIds: string[];
  /** Émet un message entrant comme le ferait le socket. */
  incoming(message: ChatMessageView): Promise<void> | void;
  cleanup(): Promise<void>;
}

export interface TransportContractFixture {
  name: string;
  create(): Promise<TransportContractHarness>;
}

/** Vues de test minimales, construites par la suite. */
export function contractMessage(
  id: string,
  createdAt: string,
  input: Partial<ChatMessageView> = {},
): ChatMessageView {
  return {
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
    edited: false,
    editRevision: 0,
    quoteId: null,
    quote: null,
    reactions: [],
    stickerRef: null,
    attachment: null,
    state: 'none',
    error: null,
    progress: null,
    ...input,
  };
}

function contractHandlers(
  received: string[],
  removed: { id: string; forEveryone: boolean }[],
): ChatTransportHandlers {
  return {
    onMessage: (message) => received.push(message.id),
    onMessageRemoved: (id, forEveryone) => removed.push({ id, forEveryone }),
    onReceipts: () => undefined,
    onReaction: () => undefined,
    onTyping: () => undefined,
    onConnection: () => undefined,
    onConversationUpdated: () => undefined,
    onConversationRemoved: () => undefined,
    onError: () => undefined,
    onFatal: () => undefined,
  };
}

const GATED_METHODS: {
  capability: GatedCapability;
  invoke: (transport: ChatTransport) => Promise<void> | void;
}[] = [
  { capability: 'reactions', invoke: (transport) => transport.toggleReaction('message-1', 'mbolo/coeur') },
  { capability: 'deleteForEveryone', invoke: (transport) => transport.deleteMessage('message-1', true) },
  { capability: 'edit', invoke: (transport) => transport.editMessage('message-1', 'modifié') },
  { capability: 'stickers', invoke: (transport) => transport.sendSticker('mbolo/merci') },
  {
    capability: 'gifs',
    invoke: (transport) =>
      transport.sendGif({ id: 'g1', url: 'https://media.giphy.com/x.gif', sticker: false }),
  },
  {
    capability: 'voice',
    invoke: (transport) =>
      transport.sendVoice({
        uri: 'file:///voix.m4a',
        mimeType: 'audio/mp4',
        durationMs: 1000,
        waveform: [],
      }),
  },
  { capability: 'typing', invoke: (transport) => transport.setTyping(true) },
];

export function runTransportContract(fixture: TransportContractFixture): void {
  describe(`contrat de transport — ${fixture.name}`, () => {
    it('sert un instantané trié et sans doublon', async () => {
      const harness = await fixture.create();
      try {
        const snapshot = await harness.transport.loadInitial();
        expect(snapshot.messages.map((message) => message.id)).toEqual(harness.expectedInitialIds);
        const times = snapshot.messages.map((message) => message.createdAt);
        expect(times).toEqual([...times].sort());
        expect(new Set(snapshot.messages.map((message) => message.id)).size).toBe(
          snapshot.messages.length,
        );
      } finally {
        await harness.cleanup();
      }
    });

    it('émet un message entrant une seule fois', async () => {
      const harness = await fixture.create();
      const received: string[] = [];
      const removed: { id: string; forEveryone: boolean }[] = [];
      const off = harness.transport.subscribe(contractHandlers(received, removed));
      try {
        await harness.transport.loadInitial();
        const message = contractMessage('incoming-1', '2026-01-01T00:00:05.000Z');
        await harness.incoming(message);
        await harness.incoming(message);
        expect(received.filter((id) => id === 'incoming-1')).toHaveLength(1);
      } finally {
        off();
        await harness.cleanup();
      }
    });

    it('supprime pour moi et notifie l’interface', async () => {
      const harness = await fixture.create();
      const received: string[] = [];
      const removed: { id: string; forEveryone: boolean }[] = [];
      const off = harness.transport.subscribe(contractHandlers(received, removed));
      try {
        await harness.transport.loadInitial();
        const target = harness.expectedInitialIds[0];
        await harness.transport.deleteMessage(target, false);
        expect(removed).toContainEqual({ id: target, forEveryone: false });
      } finally {
        off();
        await harness.cleanup();
      }
    });

    it('refuse par capacité typée les méthodes non supportées', async () => {
      const harness = await fixture.create();
      try {
        for (const entry of GATED_METHODS) {
          if (harness.transport.capabilities[entry.capability]) continue;
          await expect(
            Promise.resolve().then(() => entry.invoke(harness.transport)),
          ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
        }
      } finally {
        await harness.cleanup();
      }
    });
  });
}
