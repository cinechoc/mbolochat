import { describe, expect, it } from 'vitest';

import {
  defaultScheduledAt,
  isValidScheduledAt,
  normalizedSendOptions,
} from './send-options';

const NOW = new Date('2026-11-14T10:03:20.000Z');

describe('options d’envoi', () => {
  it('refuse une programmation passée ou trop lointaine', () => {
    expect(isValidScheduledAt('2026-11-14T10:03:59.000Z', NOW)).toBe(false);
    expect(isValidScheduledAt('2027-11-14T10:03:20.000Z', NOW)).toBe(false);
    expect(isValidScheduledAt('pas-une-date', NOW)).toBe(false);
  });

  it('accepte une date future et la normalise', () => {
    const input = { viewOnce: true, silent: false, scheduledAt: '2026-11-14T12:00:00.000Z' };
    expect(normalizedSendOptions(input, NOW)).toEqual({
      viewOnce: true,
      scheduledAt: '2026-11-14T12:00:00.000Z',
    });
  });

  it('propose une heure ronde dans le futur', () => {
    expect(defaultScheduledAt(NOW)).toEqual(new Date('2026-11-14T11:05:00.000Z'));
  });
});
