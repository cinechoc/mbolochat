import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  value: null as string | null,
  shouldFail: false,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => {
      if (storage.shouldFail) throw new Error('stockage indisponible');
      return storage.value;
    }),
    setItem: vi.fn(async (_key: string, value: string) => {
      storage.value = value;
    }),
  },
}));

describe('drapeau de l’écran unifié', () => {
  beforeEach(() => {
    storage.value = null;
    storage.shouldFail = false;
    vi.resetModules();
  });

  it('est activé par défaut quand aucune valeur n’est stockée', async () => {
    const { getUnifiedChatFlagSync, loadUnifiedChatFlag } = await import('./unified-flag');
    expect(getUnifiedChatFlagSync()).toBe(true);
    await expect(loadUnifiedChatFlag()).resolves.toBe(true);
  });

  it('respecte un retour explicite à l’ancien écran', async () => {
    storage.value = '0';
    const { getUnifiedChatFlagSync, loadUnifiedChatFlag } = await import('./unified-flag');
    await expect(loadUnifiedChatFlag()).resolves.toBe(false);
    expect(getUnifiedChatFlagSync()).toBe(false);
  });

  it('conserve l’activation par défaut si le stockage échoue', async () => {
    storage.shouldFail = true;
    const { loadUnifiedChatFlag } = await import('./unified-flag');
    await expect(loadUnifiedChatFlag()).resolves.toBe(true);
  });

  it('permet de basculer dans les deux sens depuis l’interface développeur', async () => {
    const { loadUnifiedChatFlag, setUnifiedChatFlag, getUnifiedChatFlagSync } = await import(
      './unified-flag'
    );
    await loadUnifiedChatFlag();
    await setUnifiedChatFlag(false);
    expect(getUnifiedChatFlagSync()).toBe(false);
    expect(storage.value).toBe('0');
    await setUnifiedChatFlag(true);
    expect(getUnifiedChatFlagSync()).toBe(true);
    expect(storage.value).toBe('1');
  });
});
