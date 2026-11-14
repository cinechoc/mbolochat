import { describe, expect, it } from 'vitest';

import type { ChatCapabilities, ChatIdentity, ChatMessageView } from '../transport/types';
import type { ChatRow } from './rows';
import { sameChatMessageRow } from './row-equality';

const identity: ChatIdentity = {
  id: 'me',
  username: 'me',
  displayName: 'Moi',
  avatarUrl: null,
  gender: null,
  genderCustom: null,
};

const capabilities: ChatCapabilities = {
  replies: true,
  reactions: true,
  deleteForEveryone: true,
  stickers: true,
  gifs: true,
  voice: true,
  typing: true,
  ephemeral: false,
  calls: true,
  albums: true,
  groups: true,
  forwarded: true,
  encrypted: false,
  pagination: 'server',
  receipts: 'ticks',
};

const message = (id: string): ChatMessageView => ({
  id,
  clientId: null,
  conversationId: 'c1',
  mine: false,
  sender: identity,
  createdAt: '2026-01-01T00:00:00.000Z',
  body: id,
  type: 'text',
  deleted: false,
  unreadable: false,
  quoteId: null,
  quote: null,
  reactions: [],
  stickerRef: null,
  attachment: null,
  state: 'none',
  error: null,
  progress: null,
});

const chat = {} as never;

function props(row: ChatRow) {
  return {
    row,
    currentUser: identity,
    capabilities,
    chat,
    windowWidth: 400,
    token: 'token',
  };
}

describe('sameChatMessageRow', () => {
  it('égale deux rangées recréées qui portent le même message', () => {
    const view = message('m1');
    const first: ChatRow = { key: 'm1', type: 'message', message: view, continuation: false };
    const second: ChatRow = { key: 'm1', type: 'message', message: view, continuation: false };
    expect(first).not.toBe(second);
    expect(sameChatMessageRow(props(first), props(second))).toBe(true);
  });

  it('différencie un message remplacé ou une continuation changée', () => {
    const a = message('m1');
    const b = message('m1');
    expect(
      sameChatMessageRow(
        props({ key: 'm1', type: 'message', message: a, continuation: false }),
        props({ key: 'm1', type: 'message', message: b, continuation: false }),
      ),
    ).toBe(false);
    expect(
      sameChatMessageRow(
        props({ key: 'm1', type: 'message', message: a, continuation: false }),
        props({ key: 'm1', type: 'message', message: a, continuation: true }),
      ),
    ).toBe(false);
  });

  it('compare les albums par références de messages', () => {
    const a = message('a');
    const b = message('b');
    expect(
      sameChatMessageRow(
        props({ key: 'album', type: 'album', messages: [a, b], continuation: false }),
        props({ key: 'album', type: 'album', messages: [a, b], continuation: false }),
      ),
    ).toBe(true);
    expect(
      sameChatMessageRow(
        props({ key: 'album', type: 'album', messages: [a, b], continuation: false }),
        props({ key: 'album', type: 'album', messages: [a, message('b')], continuation: false }),
      ),
    ).toBe(false);
  });
});
