import { describe, expect, it } from 'vitest';

import { isE2eeEnabled } from './enabled.js';

describe('isE2eeEnabled', () => {
  it('active le chiffrement quand la variable est absente ou vide', () => {
    expect(isE2eeEnabled(undefined)).toBe(true);
    expect(isE2eeEnabled('')).toBe(true);
  });

  it('accepte toutes les écritures d’activation', () => {
    expect(isE2eeEnabled('1')).toBe(true);
    expect(isE2eeEnabled('true')).toBe(true);
    expect(isE2eeEnabled(' ON ')).toBe(true);
  });

  it('ne se coupe que sur une désactivation explicite', () => {
    expect(isE2eeEnabled('0')).toBe(false);
    expect(isE2eeEnabled('false')).toBe(false);
    expect(isE2eeEnabled('off')).toBe(false);
    expect(isE2eeEnabled('no')).toBe(false);
  });
});
