import { describe, expect, it } from 'vitest';

import type { Message, SenderInfo } from '@/lib/types';
import {
  aggregateTick,
  groupReceipts,
  mergeMessages,
  quoteOfMessage,
  toggleLocalReaction,
  unreadBoundary,
} from './legacy-classic';

const sender = (id: string, displayName = id): SenderInfo => ({
  id,
  username: id,
  displayName,
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
  createdAt: '2026-01-01T00:00:00.000Z',
  sender: sender('me'),
  ...input,
});

describe('caractérisation — mergeMessages', () => {
  it('renvoie le tableau courant tel quel quand il n’y a rien à ajouter', () => {
    const current = [message({ id: 'a' })];
    expect(mergeMessages(current, [])).toBe(current);
  });

  it('insère les nouveaux messages dans l’ordre chronologique', () => {
    const current = [message({ id: 'b', createdAt: '2026-01-01T00:00:02.000Z' })];
    const next = mergeMessages(current, [
      message({ id: 'c', createdAt: '2026-01-01T00:00:03.000Z' }),
      message({ id: 'a', createdAt: '2026-01-01T00:00:01.000Z' }),
    ]);
    expect(next.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('ignore un message déjà connu par son identifiant serveur', () => {
    const current = [message({ id: 'a' })];
    expect(mergeMessages(current, [message({ id: 'a' })])).toBe(current);
  });

  it('remplace la bulle optimiste par la version serveur du même clientId', () => {
    const optimistic = message({
      id: 'local-1',
      clientId: 'client-1',
      sender: sender('me'),
    });
    const server = message({
      id: 'server-1',
      clientId: 'client-1',
      createdAt: '2026-01-01T00:00:01.000Z',
      sender: sender('me'),
    });
    const next = mergeMessages([optimistic], [server]);
    expect(next.map((entry) => entry.id)).toEqual(['server-1']);
  });

  it('conserve les deux messages quand les clientId diffèrent', () => {
    const current = [message({ id: 'server-1', clientId: 'client-1' })];
    const next = mergeMessages(current, [message({ id: 'server-2', clientId: 'client-2' })]);
    expect(next.map((entry) => entry.id)).toEqual(['server-1', 'server-2']);
  });
});

describe('caractérisation — unreadBoundary', () => {
  const mine = (id: string, at: string) =>
    message({ id, createdAt: at, sender: sender('me') });
  const theirs = (id: string, at: string) =>
    message({ id, createdAt: at, sender: sender('peer') });

  it('ne place aucune frontière sans message non lu', () => {
    expect(unreadBoundary([theirs('a', '2026-01-01T00:00:01.000Z')], 0, 'me')).toBeNull();
  });

  it('part du plus ancien des N messages reçus non lus', () => {
    const list = [
      theirs('a', '2026-01-01T00:00:01.000Z'),
      theirs('b', '2026-01-01T00:00:02.000Z'),
      theirs('c', '2026-01-01T00:00:03.000Z'),
    ];
    expect(unreadBoundary(list, 2, 'me')).toEqual({ id: 'b', count: 2 });
  });

  it('ignore mes propres messages dans le décompte', () => {
    const list = [
      theirs('a', '2026-01-01T00:00:01.000Z'),
      mine('b', '2026-01-01T00:00:02.000Z'),
      theirs('c', '2026-01-01T00:00:03.000Z'),
    ];
    expect(unreadBoundary(list, 1, 'me')).toEqual({ id: 'c', count: 1 });
  });

  it('renvoie null quand tous les messages sont les miens', () => {
    const list = [mine('a', '2026-01-01T00:00:01.000Z')];
    expect(unreadBoundary(list, 3, 'me')).toBeNull();
  });

  it('compte au plus le nombre de messages reçus disponibles', () => {
    const list = [
      theirs('a', '2026-01-01T00:00:01.000Z'),
      theirs('b', '2026-01-01T00:00:02.000Z'),
    ];
    expect(unreadBoundary(list, 5, 'me')).toEqual({ id: 'a', count: 2 });
  });
});

describe('caractérisation — groupReceipts', () => {
  it('regroupe les accusés par message en conservant l’ordre', () => {
    const grouped = groupReceipts([
      { messageId: 'm1', userId: 'u1', deliveredAt: null, readAt: null },
      { messageId: 'm2', userId: 'u1', deliveredAt: null, readAt: null },
      { messageId: 'm1', userId: 'u2', deliveredAt: null, readAt: null },
    ]);
    expect(Object.keys(grouped)).toEqual(['m1', 'm2']);
    expect(grouped.m1.map((receipt) => receipt.userId)).toEqual(['u1', 'u2']);
    expect(grouped.m2).toHaveLength(1);
  });
});

describe('caractérisation — aggregateTick', () => {
  it('renvoie undefined sans état', () => {
    expect(aggregateTick([])).toBeUndefined();
    expect(aggregateTick([undefined, undefined])).toBeUndefined();
  });

  it('retient l’état le moins avancé de l’album', () => {
    expect(aggregateTick(['read', 'delivered'])).toBe('delivered');
    expect(aggregateTick(['sent', 'pending'])).toBe('pending');
    expect(aggregateTick(['failed', 'read'])).toBe('failed');
  });
});

describe('caractérisation — toggleLocalReaction', () => {
  it('ajoute une réaction absente, à mon nom', () => {
    expect(toggleLocalReaction([], 'mbolo/coeur')).toEqual([
      { reaction: 'mbolo/coeur', count: 1, mine: true },
    ]);
  });

  it('retire ma réaction unique', () => {
    expect(toggleLocalReaction([{ reaction: 'mbolo/coeur', count: 1, mine: true }], 'mbolo/coeur')).toEqual(
      [],
    );
  });

  it('décrémente ma réaction partagée sans la supprimer', () => {
    expect(
      toggleLocalReaction([{ reaction: 'mbolo/coeur', count: 2, mine: true }], 'mbolo/coeur'),
    ).toEqual([{ reaction: 'mbolo/coeur', count: 1, mine: false }]);
  });

  it('rejoint la réaction d’un autre en incrémentant le compteur', () => {
    expect(
      toggleLocalReaction([{ reaction: 'mbolo/coeur', count: 1, mine: false }], 'mbolo/coeur'),
    ).toEqual([{ reaction: 'mbolo/coeur', count: 2, mine: true }]);
  });
});

describe('caractérisation — quoteOfMessage', () => {
  it('reprend l’identité, le texte et le type de la pièce jointe', () => {
    const source = message({
      id: 'm1',
      content: 'Bonjour',
      sender: sender('peer', 'Amina'),
      attachment: {
        type: 'IMAGE',
        url: '/media?f=x',
        width: 10,
        height: 10,
        mime: 'image/jpeg',
        size: 10,
      },
    });
    expect(quoteOfMessage(source)).toEqual({
      id: 'm1',
      senderName: 'Amina',
      content: 'Bonjour',
      type: 'text',
      attachmentType: 'IMAGE',
      deleted: false,
    });
  });

  it('vide une citation supprimée pour tous', () => {
    const source = message({
      id: 'm1',
      content: 'Secret',
      deleted: true,
      attachment: {
        type: 'IMAGE',
        url: '/media?f=x',
        width: 10,
        height: 10,
        mime: 'image/jpeg',
        size: 10,
      },
    });
    expect(quoteOfMessage(source)).toEqual({
      id: 'm1',
      senderName: 'me',
      content: '',
      type: 'text',
      attachmentType: null,
      deleted: true,
    });
  });
});
