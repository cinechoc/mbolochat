import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ value: null as string | null, failing: false }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => {
      if (storage.failing) throw new Error('stockage indisponible');
      return storage.value;
    }),
    setItem: vi.fn(async (_key: string, value: string) => {
      storage.value = value;
    }),
  },
}));

describe('vitesse de lecture des notes vocales', () => {
  beforeEach(() => {
    storage.value = null;
    storage.failing = false;
    vi.resetModules();
  });

  it('boucle 1x → 1,5x → 2x → 1x', async () => {
    const { nextVoiceSpeed } = await import('./voiceSpeed');
    expect(nextVoiceSpeed(1)).toBe(1.5);
    expect(nextVoiceSpeed(1.5)).toBe(2);
    expect(nextVoiceSpeed(2)).toBe(1);
  });

  it('accepte uniquement les vitesses connues', async () => {
    const { parseVoiceSpeed } = await import('./voiceSpeed');
    expect(parseVoiceSpeed('1.5')).toBe(1.5);
    expect(parseVoiceSpeed('2')).toBe(2);
    expect(parseVoiceSpeed('1,5')).toBe(1.5);
    expect(parseVoiceSpeed('3')).toBe(1);
    expect(parseVoiceSpeed('vite')).toBe(1);
    expect(parseVoiceSpeed(null)).toBe(1);
  });

  it('reprend la valeur mémorisée', async () => {
    storage.value = '2';
    const { loadVoiceSpeed } = await import('./voiceSpeed');
    await expect(loadVoiceSpeed()).resolves.toBe(2);
  });

  it('retombe à 1x si la valeur est absente, invalide ou illisible', async () => {
    const { loadVoiceSpeed } = await import('./voiceSpeed');
    await expect(loadVoiceSpeed()).resolves.toBe(1);
    vi.resetModules();
    storage.value = 'invalide';
    const second = await import('./voiceSpeed');
    await expect(second.loadVoiceSpeed()).resolves.toBe(1);
    vi.resetModules();
    storage.failing = true;
    const third = await import('./voiceSpeed');
    await expect(third.loadVoiceSpeed()).resolves.toBe(1);
  });
});
