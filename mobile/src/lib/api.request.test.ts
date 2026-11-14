import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-file-system', () => ({
  File: class {
    constructor(public uri: string) {}
  },
}));

vi.mock('expo-device', () => ({ modelName: 'Test', deviceName: 'Test' }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('./config', () => ({ API_URL: 'http://api.test' }));

const storage = vi.hoisted(() => {
  let refreshToken: string | null = 'refresh-ancien';
  let epoch = 0;
  return {
    get refreshToken() {
      return refreshToken;
    },
    get epoch() {
      return epoch;
    },
    setTokens(access: string, refresh: string) {
      void access;
      refreshToken = refresh;
    },
    endSession() {
      refreshToken = null;
      epoch += 1;
    },
    reset() {
      refreshToken = 'refresh-ancien';
      epoch = 0;
    },
  };
});

vi.mock('./token-storage', () => ({
  getAuthSessionEpoch: () => storage.epoch,
  getStoredRefreshToken: async () => storage.refreshToken,
  storeTokens: async (access: string, refresh: string) => storage.setTokens(access, refresh),
}));

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function authorizationOf(init?: RequestInit): string | null {
  return (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
}

describe('api.request — rafraîchissement partagé', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    storage.reset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    vi.restoreAllMocks();
  });

  it('rafraîchit une fois puis rejoue une seule fois avec le nouveau jeton', async () => {
    const attempts: string[] = [];
    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/auth/refresh')) {
          refreshes += 1;
          return response(200, { accessToken: 'access-frais', refreshToken: 'refresh-tourne' });
        }
        attempts.push(authorizationOf(init) ?? '');
        if (authorizationOf(init) === 'Bearer access-ancien') {
          return response(401, { message: 'expired' });
        }
        return response(200, { id: 'conv-1' });
      }),
    );

    const { api } = await import('./api');
    await expect(api.getConversation('access-ancien', 'conv-1')).resolves.toMatchObject({
      id: 'conv-1',
    });
    expect(refreshes).toBe(1);
    expect(attempts).toEqual(['Bearer access-ancien', 'Bearer access-frais']);
  });

  it('ne boucle pas quand la nouvelle tentative est encore refusée', async () => {
    const attempts: string[] = [];
    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/auth/refresh')) {
          refreshes += 1;
          return response(200, { accessToken: 'access-frais', refreshToken: 'refresh-tourne' });
        }
        attempts.push(authorizationOf(init) ?? '');
        return response(401, { message: 'expired' });
      }),
    );

    const { api } = await import('./api');
    await expect(api.getConversation('access-ancien', 'conv-1')).rejects.toMatchObject({
      status: 401,
    });
    expect(refreshes).toBe(1);
    expect(attempts).toEqual(['Bearer access-ancien', 'Bearer access-frais']);
  });

  it('partage un seul rafraîchissement entre deux requêtes concurrentes', async () => {
    let releaseRefresh!: (value: Response) => void;
    const refreshGate = new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshes = 0;
    const attempts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/auth/refresh')) {
          refreshes += 1;
          return refreshGate;
        }
        const authorization = authorizationOf(init) ?? '';
        attempts.push(authorization);
        if (authorization === 'Bearer access-ancien') {
          return response(401, { message: 'expired' });
        }
        return response(200, { id: authorization });
      }),
    );

    const { api } = await import('./api');
    const first = api.getConversation('access-ancien', 'conv-1');
    const second = api.getConversation('access-ancien', 'conv-2');
    await vi.waitFor(() => {
      expect(attempts).toHaveLength(2);
      expect(refreshes).toBe(1);
    });
    releaseRefresh(response(200, { accessToken: 'access-frais', refreshToken: 'refresh-tourne' }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: 'Bearer access-frais' },
      { id: 'Bearer access-frais' },
    ]);
    expect(refreshes).toBe(1);
    expect(attempts).toEqual([
      'Bearer access-ancien',
      'Bearer access-ancien',
      'Bearer access-frais',
      'Bearer access-frais',
    ]);
  });
});
