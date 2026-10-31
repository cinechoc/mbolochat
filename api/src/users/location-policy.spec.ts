import { describe, expect, it } from 'vitest';

import {
  CITY_REFRESH_MS,
  distanceKm,
  evaluateCityUpdate,
  type CityUpdateInput,
} from './location-policy.js';

const A = { latitude: 0, longitude: 0 };
const B = { latitude: 1, longitude: 0 }; // ~111 km
const C = { latitude: 3, longitude: 0 }; // ~333 km

function input(patch: Partial<CityUpdateInput> = {}): CityUpdateInput {
  const now = new Date('2026-10-31T12:00:00Z');
  return {
    hasCity: true,
    oldCity: 'Libreville',
    oldCountry: 'Gabon',
    oldUpdatedAt: new Date(now.getTime() - 60 * 60 * 1000),
    newCity: 'Port-Gentil',
    newCountry: 'Gabon',
    newCoords: B,
    oldCoords: A,
    now,
    ...patch,
  };
}

describe('distanceKm', () => {
  it('mesure une distance plausible', () => {
    expect(distanceKm(A, B)).toBeGreaterThan(110);
    expect(distanceKm(A, B)).toBeLessThan(112);
  });
});

describe('evaluateCityUpdate', () => {
  it('refuse une réponse sans ville', () => {
    expect(evaluateCityUpdate(input({ newCity: null })).reason).toBe('no-city');
  });

  it('accepte la première ville', () => {
    expect(evaluateCityUpdate(input({ hasCity: false, oldUpdatedAt: null }))).toEqual({
      accept: true,
      reason: 'first',
    });
  });

  it('ne change pas de ville pour la même ville (accents/casse ignorés)', () => {
    expect(
      evaluateCityUpdate(input({ newCity: 'LIBREVILLE', newCountry: 'gabon' })).reason,
    ).toBe('same-city');
  });

  it('refuse un déplacement proche avant 24 h', () => {
    expect(
      evaluateCityUpdate(input({ newCoords: { latitude: 0.5, longitude: 0 } })).reason,
    ).toBe('too-soon');
  });

  it('refuse un saut de plusieurs centaines de km en quelques minutes', () => {
    expect(
      evaluateCityUpdate(
        input({ newCoords: C, oldUpdatedAt: new Date('2026-10-31T11:55:00Z') }),
      ).reason,
    ).toBe('teleport');
  });

  it('accepte un déménagement notable après 30 minutes', () => {
    expect(
      evaluateCityUpdate(
        input({ newCoords: B, oldUpdatedAt: new Date('2026-10-31T11:25:00Z') }),
      ),
    ).toEqual({ accept: true, reason: 'moved' });
  });

  it('accepte une mise à jour après 24 h, même sans coordonnées de référence', () => {
    expect(
      evaluateCityUpdate(
        input({
          oldCoords: null,
          oldUpdatedAt: new Date(Date.now() - CITY_REFRESH_MS - 1000),
        }),
      ),
    ).toEqual({ accept: true, reason: 'daily' });
  });

  it('refuse sans référence de distance avant 24 h', () => {
    expect(
      evaluateCityUpdate(
        input({ oldCoords: null, oldUpdatedAt: new Date('2026-10-31T10:00:00Z') }),
      ).reason,
    ).toBe('too-soon');
  });
});
