import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';
import { getStore } from './store';
import { reportDelivered } from './socket';
import { runSync } from './sync';
import type { Message } from './types';

vi.mock('./api', () => ({
  api: { syncSince: vi.fn() },
}));
vi.mock('./outbox', () => ({
  drain: vi.fn(async () => undefined),
  settle: vi.fn(async () => undefined),
}));
vi.mock('./store', () => ({
  getStore: vi.fn(),
}));
vi.mock('./socket', () => ({
  connectSocket: vi.fn(),
  onConnection: vi.fn(),
  reportDelivered: vi.fn(),
}));

function message(id: string, encryption: 'none' | 'v1'): Message {
  return {
    id,
    conversationId: 'conversation-1',
    type: 'text',
    content: '',
    encryption,
    stickerRef: null,
    attachment: null,
    clientId: null,
    deleted: false,
    replyTo: null,
    reactions: [],
    createdAt: '2026-01-01T00:00:01.000Z',
    sender: {
      id: 'peer',
      username: 'peer',
      displayName: 'Pair',
      avatarUrl: null,
      gender: null,
      genderCustom: null,
    },
  };
}

describe('runSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStore).mockResolvedValue({
      readCursor: vi.fn(async () => Date.parse('2026-01-01T00:00:00.000Z')),
      advanceCursor: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof getStore>>);
  });

  it('ne confirme pas la livraison E2EE avant son déchiffrement', async () => {
    vi.mocked(api.syncSince).mockResolvedValue([
      message('classique', 'none'),
      message('chiffre', 'v1'),
    ]);

    await runSync('token', 'me');

    expect(reportDelivered).toHaveBeenCalledWith(['classique']);
  });
});
