import { describe, expect, it } from 'vitest';

import {
  computeSafetyNumber,
  formatSafetyNumber,
  normalizeScannedSafetyNumber,
  safetyNumberQrPayload,
  sha256Hex,
} from './safetyNumber';

describe('code de sécurité — SHA-256 et forme', () => {
  it('reproduit les vecteurs SHA-256 connus', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('produit 60 chiffres et un QR qui contient la même valeur', () => {
    const code = computeSafetyNumber('local-key', 'peer-key');
    expect(code).toMatch(/^\d{60}$/);
    expect(formatSafetyNumber(code).replace(/ /g, '')).toBe(code);
    expect(formatSafetyNumber(code).split(' ')).toHaveLength(12);
    expect(normalizeScannedSafetyNumber(safetyNumberQrPayload(code))).toBe(code);
    expect(normalizeScannedSafetyNumber(formatSafetyNumber(code))).toBe(code);
  });
});

describe('code de sécurité — indépendance et changement de clé', () => {
  it('donne le même code des deux côtés, quel que soit l’ordre', () => {
    const alice = 'alice-identity-public';
    const bob = 'bob-identity-public';
    expect(computeSafetyNumber(alice, bob)).toBe(computeSafetyNumber(bob, alice));
  });

  it('change dès qu’une clé d’identité change', () => {
    const before = computeSafetyNumber('alice-identity-public', 'bob-identity-public');
    const after = computeSafetyNumber('alice-identity-public', 'bob-identity-rotated');
    expect(after).not.toBe(before);
  });

  it('refuse une clé vide ou un code hors format', () => {
    expect(() => computeSafetyNumber('', 'bob')).toThrow();
    expect(formatSafetyNumber('123')).toBe('');
    expect(normalizeScannedSafetyNumber('pas-un-code')).toBeNull();
  });
});
