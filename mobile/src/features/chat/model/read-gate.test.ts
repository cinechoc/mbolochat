import { describe, expect, it } from 'vitest';

import { canMarkEncryptedRead } from './read-gate';

const base = {
  mode: 'e2ee' as const,
  focused: true,
  appActive: true,
  ready: true,
  visibleIds: ['message-1'],
};

describe('canMarkEncryptedRead', () => {
  it('autorise seulement écran consulté, app active, prêt et messages visibles', () => {
    expect(canMarkEncryptedRead(base)).toBe(true);
    expect(canMarkEncryptedRead({ ...base, focused: false })).toBe(false);
    expect(canMarkEncryptedRead({ ...base, appActive: false })).toBe(false);
    expect(canMarkEncryptedRead({ ...base, ready: false })).toBe(false);
    expect(canMarkEncryptedRead({ ...base, visibleIds: [] })).toBe(false);
  });

  it('ne s’applique jamais aux autres modes', () => {
    expect(canMarkEncryptedRead({ ...base, mode: 'classic' })).toBe(false);
    expect(canMarkEncryptedRead({ ...base, mode: 'blocked' })).toBe(false);
    expect(canMarkEncryptedRead({ ...base, mode: 'pending' })).toBe(false);
  });
});
