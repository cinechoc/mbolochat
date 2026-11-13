import { describe, expect, it, vi } from 'vitest';

import type { ChatCapabilities, ChatMessageView } from '../transport/types';
import { buildChatActions } from './chat-actions';

const CLASSIC: ChatCapabilities = {
  replies: true,
  reactions: true,
  deleteForEveryone: true,
  stickers: true,
  gifs: true,
  voice: true,
  typing: true,
  calls: true,
  albums: true,
  groups: true,
  encrypted: false,
  pagination: 'server',
  receipts: 'ticks',
};

const E2EE: ChatCapabilities = {
  ...CLASSIC,
  reactions: false,
  deleteForEveryone: false,
  stickers: false,
  gifs: false,
  typing: false,
  calls: false,
  albums: false,
  groups: false,
  encrypted: true,
  pagination: 'local',
  receipts: 'delivered-opened',
};

const view = (input: Partial<ChatMessageView> = {}): ChatMessageView => ({
  id: 'm1',
  clientId: null,
  conversationId: 'conversation-1',
  mine: true,
  sender: {
    id: 'me',
    username: 'me',
    displayName: 'Moi',
    avatarUrl: null,
    gender: null,
    genderCustom: null,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  body: 'bonjour',
  type: 'text',
  deleted: false,
  unreadable: false,
  quoteId: null,
  quote: null,
  reactions: [],
  stickerRef: null,
  attachment: null,
  state: 'sent',
  error: null,
  progress: null,
  ...input,
});

const callbacks = () => ({
  onReply: vi.fn(),
  onCopy: vi.fn(),
  onDeleteForMe: vi.fn(),
  onDeleteForAll: vi.fn(),
});

describe('buildChatActions', () => {
  it('offre toutes les actions classiques sur mon message', () => {
    const actions = buildChatActions({
      message: view(),
      capabilities: CLASSIC,
      ...callbacks(),
    });
    expect(actions.map((action) => action.key)).toEqual([
      'reply',
      'copy',
      'delete-me',
      'delete-all',
    ]);
    expect(actions.find((action) => action.key === 'delete-all')?.destructive).toBe(true);
  });

  it('masque « pour tous » en chiffré et sur le message d’un autre', () => {
    const e2ee = buildChatActions({ message: view(), capabilities: E2EE, ...callbacks() });
    expect(e2ee.map((action) => action.key)).toEqual(['reply', 'copy', 'delete-me']);
    const other = buildChatActions({
      message: view({ mine: false }),
      capabilities: CLASSIC,
      ...callbacks(),
    });
    expect(other.some((action) => action.key === 'delete-all')).toBe(false);
  });

  it('réduit les actions d’un message en attente', () => {
    const actions = buildChatActions({
      message: view({ state: 'pending' }),
      capabilities: CLASSIC,
      ...callbacks(),
    });
    expect(actions.map((action) => action.key)).toEqual(['copy', 'delete-me']);
    expect(actions[1]?.label).toBe('Supprimer');
  });

  it('n’offre rien sur un message supprimé pour tous, sauf copier vide', () => {
    const actions = buildChatActions({
      message: view({ deleted: true, body: '' }),
      capabilities: CLASSIC,
      ...callbacks(),
    });
    expect(actions.map((action) => action.key)).toEqual(['delete-me']);
  });

  it('ajoute les actions spécifiques fournies par l’écran', () => {
    const extra = [
      { key: 'info', label: 'Infos', onPress: vi.fn() },
    ];
    const actions = buildChatActions({
      message: view(),
      capabilities: E2EE,
      ...callbacks(),
      extra,
    });
    expect(actions[0]).toBe(extra[0]);
  });

  it('renvoie un tableau vide sans message', () => {
    expect(buildChatActions({ message: null, capabilities: CLASSIC, ...callbacks() })).toEqual([]);
  });
});
