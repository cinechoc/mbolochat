import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutboxItem } from './store';

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: vi.fn(() => null),
}));

const item = (clientId: string, conversationId: string): OutboxItem => ({
  clientId,
  conversationId,
  messageType: 'text',
  stickerRef: null,
  content: clientId,
  replyTo: null,
  silent: false,
  viewOnce: false,
  scheduledAt: null,
  localUri: null,
  kind: 'file',
  durationMs: null,
  waveform: null,
  mime: null,
  width: null,
  height: null,
  name: null,
  size: null,
  external: null,
  uploadId: null,
  status: 'pending',
  attempts: 0,
  error: null,
  createdAt: 1,
  progress: null,
  uploadedBytes: null,
  totalBytes: null,
});

describe('file locale — propriétaire du compte', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('conserve les envois en attente quand le même compte revient', async () => {
    const store = await import('./store');
    await store.activateLocalStore('user-a');
    await (await store.getStore()).save(item('pending-a', 'conversation-a'));

    await store.activateLocalStore('user-a');

    expect((await (await store.getStore()).list()).map((row) => row.clientId)).toEqual([
      'pending-a',
    ]);
  });

  it('ne transmet pas la file d’un compte au suivant', async () => {
    const store = await import('./store');
    await store.activateLocalStore('user-a');
    await (await store.getStore()).save(item('pending-a', 'conversation-a'));
    await (await store.getStore()).advanceCursor(1000);

    await store.activateLocalStore('user-b');

    expect(await (await store.getStore()).list()).toEqual([]);
    expect(await (await store.getStore()).readCursor()).toBeNull();
  });
});
