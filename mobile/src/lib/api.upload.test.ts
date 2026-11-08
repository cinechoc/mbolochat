import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Transport de la clé d'idempotence (`POST /uploads`).
 *
 * Le test ne vérifie pas la *dérivation* de la clé (couverte ailleurs) mais bien
 * les en-têtes **réellement construits** par les deux transports du client :
 * XHR (chemin nominal, avec progression) et `fetch` (repli quand XHR échoue).
 */

vi.mock('expo-file-system', () => ({
  File: class {
    constructor(public uri: string) {}
  },
}));

vi.mock('expo-device', () => ({ modelName: 'Test', deviceName: 'Test' }));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

vi.mock('./config', () => ({ API_URL: 'http://api.test' }));

vi.mock('./token-storage', () => ({
  getStoredRefreshToken: vi.fn(async () => null),
  storeTokens: vi.fn(async () => {}),
}));

interface Sent {
  url: string;
  headers: Record<string, string>;
  method: string;
}

/** Faux XHR : enregistre les en-têtes et le corps, puis répond ou échoue. */
class FakeXhr {
  static sent: Sent[] = [];
  static fail = false;
  upload = { onprogress: null as null | ((event: unknown) => void) };
  timeout = 0;
  status = 0;
  responseText = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private headers: Record<string, string> = {};
  private method = 'GET';
  private url = '';

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(): void {
    FakeXhr.sent.push({ url: this.url, headers: { ...this.headers }, method: this.method });
    if (FakeXhr.fail) {
      this.onerror?.();
      return;
    }
    this.status = 201;
    this.responseText = JSON.stringify({
      id: 'up-1',
      type: 'IMAGE',
      url: '/uploads/x.bin',
      mime: 'application/octet-stream',
      size: 3,
    });
    this.onload?.();
  }
}

const key = 'client-42:media';
const asset = {
  uri: 'file:///data/durable/cipher.bin',
  mimeType: 'application/octet-stream',
  fileName: 'photo.jpg',
  encrypted: true,
  conversationId: 'conv-1',
  kind: 'IMAGE',
  idempotencyKey: key,
};

describe('en-tête Idempotency-Key des téléversements', () => {
  const originalXhr = globalThis.XMLHttpRequest;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    FakeXhr.sent = [];
    FakeXhr.fail = false;
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
    // FormData est fourni par le runtime de test ; `File` est mocké plus haut.
    if (typeof globalThis.FormData === 'undefined') {
      vi.stubGlobal(
        'FormData',
        class {
          private readonly entries: [string, unknown][] = [];
          append(name: string, value: unknown) {
            this.entries.push([name, value]);
          }
        },
      );
    }
  });

  afterEach(() => {
    vi.stubGlobal('XMLHttpRequest', originalXhr);
    vi.stubGlobal('fetch', originalFetch);
    vi.resetModules();
  });

  it('le transport XHR pose la clé telle quelle', async () => {
    const { api } = await import('./api');
    const result = await api.uploadMedia('jeton', asset);

    expect(result.id).toBe('up-1');
    expect(FakeXhr.sent).toHaveLength(1);
    expect(FakeXhr.sent[0].url).toBe('http://api.test/uploads');
    expect(FakeXhr.sent[0].method).toBe('POST');
    expect(FakeXhr.sent[0].headers['Idempotency-Key']).toBe(key);
    expect(FakeXhr.sent[0].headers.Authorization).toBe('Bearer jeton');
  });

  it('le repli fetch conserve exactement la même clé', async () => {
    FakeXhr.fail = true;
    const calls: Sent[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        headers: { ...(init.headers as Record<string, string>) },
        method: String(init.method ?? 'GET'),
      });
      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 'up-1',
          type: 'IMAGE',
          url: '/uploads/x.bin',
          mime: 'application/octet-stream',
          size: 3,
        }),
      } as unknown as Response;
    });

    const { api } = await import('./api');
    const result = await api.uploadMedia('jeton', asset);

    expect(result.id).toBe('up-1');
    // XHR a bien été tenté avant le repli.
    expect(FakeXhr.sent).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://api.test/uploads');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Idempotency-Key']).toBe(key);
    expect(calls[0].headers.Authorization).toBe('Bearer jeton');
    // La clé n'a pas été réinventée par le repli.
    expect(calls[0].headers['Idempotency-Key']).toBe(
      FakeXhr.sent[0].headers['Idempotency-Key'],
    );
  });

  it('sans clé (mode clair), aucun en-tête n’est ajouté', async () => {
    const { api } = await import('./api');
    await api.uploadMedia('jeton', {
      uri: 'file:///data/photo.jpg',
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
    });

    expect(FakeXhr.sent[0].headers['Idempotency-Key']).toBeUndefined();
    expect(FakeXhr.sent[0].headers.Authorization).toBe('Bearer jeton');
  });
});
