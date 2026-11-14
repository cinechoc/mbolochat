import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearStoredTokens, getStoredRefreshToken } from './token-storage';
import { refreshAccessToken, TokenRefreshError } from './token-refresh';

vi.mock('./config', () => ({ API_URL: 'http://api.test' }));

vi.mock('./token-storage', () => {
  let refreshToken: string | null = null;
  let epoch = 0;
  return {
    getAuthSessionEpoch: vi.fn(() => epoch),
    getStoredRefreshToken: vi.fn(async () => refreshToken),
    storeTokens: vi.fn(async (access: string, refresh: string) => {
      void access;
      refreshToken = refresh;
    }),
    clearStoredTokens: vi.fn(async () => {
      refreshToken = null;
      epoch += 1;
    }),
    __setRefreshToken: (value: string | null) => {
      refreshToken = value;
    },
  };
});

const storageMock = await import('./token-storage') as typeof import('./token-storage') & {
  __setRefreshToken(value: string | null): void;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  storageMock.__setRefreshToken('refresh-ancien');
  vi.mocked(storageMock.storeTokens).mockClear();
  vi.mocked(clearStoredTokens).mockClear();
});

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch);
  vi.restoreAllMocks();
});

describe('rafraîchissement de l’access token', () => {
  it('partage un seul appel entre plusieurs demandes concurrentes', async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    vi.stubGlobal('fetch', fetchMock);

    const first = refreshAccessToken();
    const second = refreshAccessToken();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    gate.resolve({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'access-frais', refreshToken: 'refresh-tourne' }),
    } as Response);

    await expect(Promise.all([first, second])).resolves.toEqual([
      'access-frais',
      'access-frais',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storageMock.storeTokens).toHaveBeenCalledWith('access-frais', 'refresh-tourne');
    expect(storageMock.storeTokens).toHaveBeenCalledTimes(1);
  });

  it('échoue explicitement sans boucler quand le rafraîchissement est refusé', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const error = await refreshAccessToken().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TokenRefreshError);
    expect((error as Error).message).toBe('Refresh failed (401)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storageMock.storeTokens).not.toHaveBeenCalled();
  });

  it('échoue explicitement sans jeton stocké et ne tente aucun appel réseau', async () => {
    storageMock.__setRefreshToken(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshAccessToken()).rejects.toThrow('No refresh token');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageMock.storeTokens).not.toHaveBeenCalled();
  });

  it('ne réutilise pas l’ancien jeton après une déconnexion', async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: 'access-frais', refreshToken: 'refresh-tourne' }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshAccessToken()).resolves.toBe('access-frais');
    await clearStoredTokens();
    await expect(refreshAccessToken()).rejects.toThrow('No refresh token');
    expect(await getStoredRefreshToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejette une réponse arrivée après la déconnexion sans réécrire les jetons', async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    vi.stubGlobal('fetch', fetchMock);

    const pending = refreshAccessToken();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await clearStoredTokens();
    gate.resolve({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'access-perime', refreshToken: 'refresh-perime' }),
    } as Response);

    await expect(pending).rejects.toThrow('Session changed during refresh');
    expect(storageMock.storeTokens).not.toHaveBeenCalled();
    expect(await getStoredRefreshToken()).toBeNull();
  });

  it('n’écrit aucun jeton dans les journaux, en succès comme en échec', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ accessToken: 'access-secret', refreshToken: 'refresh-secret' }),
      } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await refreshAccessToken();
    await expect(refreshAccessToken()).rejects.toThrow('Refresh failed (500)');
    for (const spy of [log, warn, error, debug, info]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
