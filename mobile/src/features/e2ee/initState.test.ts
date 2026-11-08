import { describe, expect, it, vi, beforeEach } from 'vitest';

import { fr } from '@/i18n/fr';
import {
  classifyE2eeFailure,
  describeE2eeFailure,
  getE2eeInitState,
  resetE2eeInitState,
  setE2eeInitState,
  subscribeE2eeInit,
} from './initState';

vi.mock('./bootstrap', () => ({ bootstrapE2ee: vi.fn() }));

describe('classifyE2eeFailure — catégories finies, jamais de message brut', () => {
  it('reconnaît un problème de stockage chiffré', () => {
    expect(classifyE2eeFailure(new Error('file is not a database'))).toBe('storage');
    expect(classifyE2eeFailure(new Error('no such column: unreadable_reason'))).toBe('storage');
    expect(classifyE2eeFailure(new Error('SQLCipher: invalid key'))).toBe('storage');
  });

  it('reconnaît un problème de clés', () => {
    expect(classifyE2eeFailure(new Error('account_missing'))).toBe('crypto');
    expect(classifyE2eeFailure(new Error('bad pickle'))).toBe('crypto');
  });

  it('reconnaît un problème réseau', () => {
    expect(classifyE2eeFailure(new Error('Network request failed'))).toBe('network');
    expect(classifyE2eeFailure(new Error('timeout'))).toBe('network');
  });

  it('classe tout le reste en inconnu, sans jamais relayer le texte', () => {
    expect(classifyE2eeFailure(new Error('boom'))).toBe('unknown');
    expect(classifyE2eeFailure(undefined)).toBe('unknown');
  });

  it('n’expose aucun contenu d’exception dans les libellés', () => {
    const message = 'SECRET-key-material-42';
    const described = describeE2eeFailure(classifyE2eeFailure(new Error(message)));
    expect(JSON.stringify(described)).not.toContain(message);
    expect(described.title).toBe(fr.e2ee.initFailedTitle);
  });
});

describe('état d’initialisation partagé', () => {
  beforeEach(() => {
    resetE2eeInitState();
  });

  it('démarre à idle et notifie ses abonnés', () => {
    expect(getE2eeInitState()).toEqual({ status: 'idle' });
    const seen: string[] = [];
    const unsubscribe = subscribeE2eeInit(() => seen.push(getE2eeInitState().status));
    setE2eeInitState({ status: 'pending' });
    setE2eeInitState({ status: 'failed', failure: 'storage' });
    unsubscribe();
    setE2eeInitState({ status: 'ready' });
    expect(seen).toEqual(['pending', 'failed']);
  });

  it('ne conserve jamais un « prêt » après une remise à zéro', () => {
    setE2eeInitState({ status: 'ready' });
    resetE2eeInitState();
    expect(getE2eeInitState()).toEqual({ status: 'idle' });
  });
});

describe('runE2eeInit — l’échec n’est jamais silencieux', () => {
  beforeEach(async () => {
    resetE2eeInitState();
    const { bootstrapE2ee } = await import('./bootstrap');
    vi.mocked(bootstrapE2ee).mockReset();
  });

  it('marque ready quand la publication réussit', async () => {
    const { bootstrapE2ee } = await import('./bootstrap');
    vi.mocked(bootstrapE2ee).mockResolvedValue({
      disabled: false,
      recovered: false,
      registered: true,
    });
    const { runE2eeInit } = await import('./initRunner');
    await runE2eeInit('t');
    expect(getE2eeInitState()).toEqual({ status: 'ready' });
  });

  it('marque degraded (et non ready) quand la publication échoue', async () => {
    const { bootstrapE2ee } = await import('./bootstrap');
    vi.mocked(bootstrapE2ee).mockResolvedValue({
      disabled: false,
      recovered: false,
      registered: false,
      error: 'Network request failed',
    });
    const { runE2eeInit } = await import('./initRunner');
    await runE2eeInit('t');
    expect(getE2eeInitState()).toEqual({ status: 'degraded', failure: 'network' });
  });

  it('marque failed quand la base chiffrée ne s’ouvre pas', async () => {
    const { bootstrapE2ee } = await import('./bootstrap');
    vi.mocked(bootstrapE2ee).mockRejectedValue(new Error('file is not a database'));
    const { runE2eeInit } = await import('./initRunner');
    await runE2eeInit('t');
    expect(getE2eeInitState()).toEqual({ status: 'failed', failure: 'storage' });
  });

  it('ne lance qu’une initialisation à la fois', async () => {
    const { bootstrapE2ee } = await import('./bootstrap');
    vi.mocked(bootstrapE2ee).mockResolvedValue({
      disabled: false,
      recovered: false,
      registered: true,
    });
    const { runE2eeInit } = await import('./initRunner');
    await Promise.all([runE2eeInit('t'), runE2eeInit('t')]);
    expect(vi.mocked(bootstrapE2ee)).toHaveBeenCalledTimes(1);
  });
});
