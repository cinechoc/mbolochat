import { describe, expect, it } from 'vitest';

import { MIN_AGE, calculateAge, isMinor, isPlausibleBirthday } from './age.js';

describe('calculateAge', () => {
  it('compte l’anniversaire du jour comme passé', () => {
    expect(calculateAge('2000-05-10', new Date('2026-05-10T12:00:00Z'))).toBe(26);
    expect(calculateAge('2000-05-10', new Date('2026-05-09T12:00:00Z'))).toBe(25);
  });

  it('gère un 29 février les années non bissextiles (fêté le 28)', () => {
    expect(calculateAge('2004-02-29', new Date('2026-02-27T12:00:00Z'))).toBe(21);
    expect(calculateAge('2004-02-29', new Date('2026-02-28T12:00:00Z'))).toBe(22);
    expect(calculateAge('2004-02-29', new Date('2028-02-29T12:00:00Z'))).toBe(24);
  });

  it('rejette une date impossible ou absente', () => {
    expect(calculateAge(null)).toBeNull();
    expect(calculateAge('2001-02-29')).toBeNull();
    expect(calculateAge('2001-13-01')).toBeNull();
    expect(calculateAge('01/02/2001')).toBeNull();
  });

  it('accepte le jour même de l’âge minimum', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    expect(calculateAge('2013-06-01', now)).toBe(MIN_AGE);
    expect(isPlausibleBirthday('2013-06-01', now)).toBe(true);
    expect(isPlausibleBirthday('2013-06-02', now)).toBe(false);
  });

  it('détecte un mineur jusqu’à la veille des 18 ans', () => {
    expect(isMinor('2008-06-02', new Date('2026-06-01T12:00:00Z'))).toBe(true);
    expect(isMinor('2008-06-01', new Date('2026-06-01T12:00:00Z'))).toBe(false);
  });
});
