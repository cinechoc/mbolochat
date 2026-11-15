import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from './types';

const disk = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      async getAllKeys() {
        return [...values.keys()];
      },
      async multiGet(keys: string[]) {
        return keys.map((key) => [key, values.get(key) ?? null] as const);
      },
      async multiSet(pairs: readonly (readonly [string, string])[]) {
        for (const [key, value] of pairs) values.set(key, value);
      },
      async setItem(key: string, value: string) {
        values.set(key, value);
      },
      async multiRemove(keys: string[]) {
        for (const key of keys) values.delete(key);
      },
    },
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({ default: disk.storage }));

const message = (id: string): Message =>
  ({
    id,
    conversationId: 'conversation-1',
    type: 'text',
    content: id,
    encryption: 'none',
    sender: {
      id: 'peer',
      username: 'peer',
      displayName: 'Pair',
      avatarUrl: null,
      gender: null,
      genderCustom: null,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  }) as Message;

describe('cache persistant — isolation des comptes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    disk.values.clear();
    vi.stubGlobal('require', (id: string) => {
      if (id === '@react-native-async-storage/async-storage') {
        return { default: disk.storage };
      }
      throw new Error(`module inattendu: ${id}`);
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retrouve les messages du même compte après un redémarrage', async () => {
    const first = await import('./cache');
    await first.cache.prepareForUser('user-a');
    first.cache.setMessages('conversation-1', [message('m1'), message('m2')]);
    await first.cache.flush();

    vi.resetModules();
    const restarted = await import('./cache');
    await restarted.cache.hydrate();
    await restarted.cache.prepareForUser('user-a');

    expect(restarted.cache.getMessages('conversation-1')?.map((item) => item.id)).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('ne supprime rien quand le même compte se reconnecte', async () => {
    const { cache } = await import('./cache');
    await cache.prepareForUser('user-a');
    cache.setMessages('conversation-1', [message('m1')]);
    await cache.flush();

    await cache.prepareForUser('user-a');

    expect(cache.getMessages('conversation-1')?.map((item) => item.id)).toEqual(['m1']);
  });

  it('efface l’historique local lorsqu’un autre compte se connecte', async () => {
    const { cache } = await import('./cache');
    await cache.prepareForUser('user-a');
    cache.setMessages('conversation-1', [message('m1')]);
    await cache.flush();

    await cache.prepareForUser('user-b');

    expect(cache.getMessages('conversation-1')).toBeNull();
    expect([...disk.values.keys()].some((key) => key.includes(':messages:'))).toBe(false);
    expect([...disk.values.keys()].some((key) => key.endsWith(':owner'))).toBe(true);
  });
});
