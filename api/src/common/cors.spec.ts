import { afterEach, describe, expect, it } from 'vitest';

import { allowedOriginsFromEnv, corsOrigin, isAllowedOrigin, socketAllowRequest } from './cors.js';

describe('allowedOriginsFromEnv', () => {
  it('découpe et nettoie la liste CORS_ORIGINS', () => {
    expect(allowedOriginsFromEnv(' http://localhost:8081 , https://chat.example ')).toEqual([
      'http://localhost:8081',
      'https://chat.example',
    ]);
  });

  it('renvoie une liste vide sans configuration', () => {
    expect(allowedOriginsFromEnv(undefined)).toEqual([]);
    expect(allowedOriginsFromEnv('')).toEqual([]);
    expect(allowedOriginsFromEnv(' , ')).toEqual([]);
  });
});

describe('isAllowedOrigin', () => {
  it('autorise sans en-tête Origin (application mobile)', () => {
    expect(isAllowedOrigin(undefined, [])).toBe(true);
  });

  it('autorise une origine déclarée, refuse toute autre page web', () => {
    const allowed = ['http://localhost:8081'];
    expect(isAllowedOrigin('http://localhost:8081', allowed)).toBe(true);
    expect(isAllowedOrigin('https://malveillant.example', allowed)).toBe(false);
    expect(isAllowedOrigin('https://malveillant.example', [])).toBe(false);
  });

  it('refuse les origines null, malformées ou non déclarées', () => {
    const allowed = ['http://localhost:8081'];
    // `Origin: null` (fichier local, iframe sandboxée, redirection) : rejeté.
    expect(isAllowedOrigin('null', allowed)).toBe(false);
    expect(isAllowedOrigin('pas-une-url', allowed)).toBe(false);
    expect(isAllowedOrigin('http://localhost:8081/', allowed)).toBe(false);
    expect(isAllowedOrigin('https://localhost:8081', allowed)).toBe(false);
  });

  it('traite une chaîne vide comme une origine absente (mobile)', () => {
    // Un navigateur n'envoie jamais d'Origin vide ; un client non navigateur
    // qui omet l'en-tête reste soumis à l'authentification JWT.
    expect(isAllowedOrigin('', [])).toBe(true);
  });
});

describe('corsOrigin', () => {
  const previous = process.env.CORS_ORIGINS;

  const call = (origin: string | undefined) =>
    new Promise<boolean>((resolve) => {
      corsOrigin(origin, (_error, allow) => resolve(allow === true));
    });

  afterEach(() => {
    if (previous === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = previous;
  });

  it('lit CORS_ORIGINS à chaque appel (socket : HTTP et WS alignés)', async () => {
    process.env.CORS_ORIGINS = 'http://localhost:8081';
    await expect(call('http://localhost:8081')).resolves.toBe(true);
    await expect(call('https://malveillant.example')).resolves.toBe(false);
    await expect(call(undefined)).resolves.toBe(true);
    process.env.CORS_ORIGINS = '';
    await expect(call('http://localhost:8081')).resolves.toBe(false);
  });
});

describe('socketAllowRequest', () => {
  const previous = process.env.CORS_ORIGINS;

  const call = (headers: Record<string, string>) =>
    new Promise<{ error: string | null | undefined; success: boolean }>((resolve) => {
      socketAllowRequest({ headers }, (error, success) => resolve({ error, success }));
    });

  afterEach(() => {
    if (previous === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = previous;
  });

  it('rejette le handshake websocket d’une origine non déclarée, autorise mobile et origine déclarée', async () => {
    process.env.CORS_ORIGINS = 'http://localhost:8081';
    await expect(call({ origin: 'https://malveillant.example' })).resolves.toEqual({
      error: 'Origin not allowed',
      success: false,
    });
    await expect(call({ origin: 'http://localhost:8081' })).resolves.toEqual({
      error: null,
      success: true,
    });
    await expect(call({})).resolves.toEqual({ error: null, success: true });
    // Origines null / malformées : rejetées comme toute origine non déclarée.
    await expect(call({ origin: 'null' })).resolves.toEqual({
      error: 'Origin not allowed',
      success: false,
    });
    await expect(call({ origin: 'pas-une-url' })).resolves.toEqual({
      error: 'Origin not allowed',
      success: false,
    });
  });

  it('accepte un en-tête Origin en tableau en ne lisant que la première valeur', async () => {
    process.env.CORS_ORIGINS = 'http://localhost:8081';
    const headers = { origin: ['http://localhost:8081', 'https://malveillant.example'] };
    await expect(
      new Promise<{ error: string | null | undefined; success: boolean }>((resolve) => {
        socketAllowRequest({ headers }, (error, success) => resolve({ error, success }));
      }),
    ).resolves.toEqual({ error: null, success: true });
  });
});
