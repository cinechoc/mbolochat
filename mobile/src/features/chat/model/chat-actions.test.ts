import { describe, expect, it, vi } from 'vitest';

import type { ChatCapabilities, ChatMessageView } from '../transport/types';
import { buildChatActions } from './chat-actions';

const CLASSIC: ChatCapabilities = {
  replies: true,
  reactions: true,
  deleteForEveryone: true,
  stickers: true,
  gifs: true,
  forwarded: false,
  voice: true,
  typing: true,
  edit: false,
  ephemeral: false,
  calls: true,
  albums: true,
  groups: true,
  encrypted: false,
  pagination: 'server',
  receipts: 'ticks',
  sendOptions: true,
};

const E2EE: ChatCapabilities = {
  ...CLASSIC,
  reactions: false,
  deleteForEveryone: false,
  stickers: false,
  gifs: false,
  forwarded: true,
  typing: false,
  edit: true,
  ephemeral: false,
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
  edited: false,
  editRevision: 0,
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
  onEdit: vi.fn(),
  onDelete: vi.fn(),
});

describe('buildChatActions', () => {
  it('offre toutes les actions classiques sur mon message', () => {
    const actions = buildChatActions({
      message: view(),
      capabilities: CLASSIC,
      ...callbacks(),
    });
    expect(actions.map((action) => action.key)).toEqual(['reply', 'copy', 'delete']);
    expect(actions.find((action) => action.key === 'delete')?.destructive).toBe(true);
  });

  it('garde une seule action de suppression : le choix est demandé ensuite', () => {
    const e2ee = buildChatActions({ message: view(), capabilities: E2EE, ...callbacks() });
    expect(e2ee.map((action) => action.key)).toEqual(['reply', 'copy', 'delete']);
    const other = buildChatActions({
      message: view({ mine: false }),
      capabilities: CLASSIC,
      ...callbacks(),
    });
    expect(other.filter((action) => action.key === 'delete')).toHaveLength(1);
  });

  it('réduit les actions d’un message en attente', () => {
    const actions = buildChatActions({
      message: view({ state: 'pending' }),
      capabilities: CLASSIC,
      ...callbacks(),
    });
    expect(actions.map((action) => action.key)).toEqual(['copy', 'delete']);
    expect(actions[1]?.label).toBe('Supprimer');
  });

  it('ne laisse que la suppression sur un message à lecture unique', () => {
    const actions = buildChatActions({
      message: view({ viewOnce: true }),
      capabilities: CLASSIC,
      ...callbacks(),
    });
    expect(actions.map((action) => action.key)).toEqual(['delete']);
  });

  it('n’offre aucune action sur un message supprimé pour tous', () => {
    const actions = buildChatActions({
      message: view({ deleted: true, body: '' }),
      capabilities: CLASSIC,
      ...callbacks(),
    });
    expect(actions).toEqual([]);
  });

  it('propose la modification chiffrée seulement dans la fenêtre et sous 5 révisions', () => {
    const now = Date.parse('2026-01-01T00:10:00.000Z');
    const editable = buildChatActions({
      message: view({ mine: true, createdAt: '2026-01-01T00:00:00.000Z' }),
      capabilities: E2EE,
      now,
      ...callbacks(),
    });
    expect(editable.map((action) => action.key)).toContain('edit');

    const late = buildChatActions({
      message: view({ mine: true, createdAt: '2026-01-01T00:00:00.000Z' }),
      capabilities: E2EE,
      now: Date.parse('2026-01-01T00:16:00.000Z'),
      ...callbacks(),
    });
    expect(late.map((action) => action.key)).not.toContain('edit');

    const exhausted = buildChatActions({
      message: view({ mine: true, createdAt: '2026-01-01T00:00:00.000Z', editRevision: 5 }),
      capabilities: E2EE,
      now,
      ...callbacks(),
    });
    expect(exhausted.map((action) => action.key)).not.toContain('edit');
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
    expect(actions.map((action) => action.key)).toEqual(['reply', 'copy', 'info', 'delete']);
  });

  it('renvoie un tableau vide sans message', () => {
    expect(buildChatActions({ message: null, capabilities: CLASSIC, ...callbacks() })).toEqual([]);
  });
});
