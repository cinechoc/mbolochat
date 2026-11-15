import { describe, expect, it } from 'vitest';

import { isTransientSessionError } from './auth-restore';

describe('isTransientSessionError', () => {
  it('préserve la session quand le réseau ou le serveur est indisponible', () => {
    expect(isTransientSessionError({ status: 0 })).toBe(true);
    expect(isTransientSessionError({ status: 408 })).toBe(true);
    expect(isTransientSessionError({ status: 429 })).toBe(true);
    expect(isTransientSessionError({ status: 503 })).toBe(true);
  });

  it('laisse effacer les jetons sur un refus explicite', () => {
    expect(isTransientSessionError({ status: 400 })).toBe(false);
    expect(isTransientSessionError({ status: 401 })).toBe(false);
    expect(isTransientSessionError({ status: 403 })).toBe(false);
    expect(isTransientSessionError(new Error('network'))).toBe(false);
  });
});
