import { describe, expect, it } from 'vitest';

import { guardDirectCall } from './directCallGuard';

describe('guardDirectCall', () => {
  it('refuse un appel direct vers une conversation chiffrée', () => {
    expect(
      guardDirectCall({ type: 'DIRECT', e2eeSince: '2026-01-01T00:00:00.000Z' }),
    ).toBe('encrypted');
  });

  it('autorise un appel direct en clair', () => {
    expect(guardDirectCall({ type: 'DIRECT', e2eeSince: null })).toBe('allow');
  });

  it('ne bloque pas un groupe, même marqué chiffré', () => {
    expect(
      guardDirectCall({ type: 'GROUP', e2eeSince: '2026-01-01T00:00:00.000Z' }),
    ).toBe('allow');
  });
});
