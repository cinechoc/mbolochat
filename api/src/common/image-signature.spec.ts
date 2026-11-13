import { describe, expect, it } from 'vitest';

import { detectImageKind, isStrictBase64 } from './image-signature.js';

// Signatures minimales des trois formats acceptés (en-têtes seuls : le
// serveur ne décode jamais l'image, il ne lit que ces octets).
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1');

describe('detectImageKind', () => {
  it('détecte JPEG, PNG et WebP et en déduit l’extension canonique', () => {
    expect(detectImageKind(JPEG)).toEqual({ kind: 'jpeg', extension: 'jpg' });
    expect(detectImageKind(PNG)).toEqual({ kind: 'png', extension: 'png' });
    expect(detectImageKind(WEBP)).toEqual({ kind: 'webp', extension: 'webp' });
  });

  it('refuse les SVG et HTML déguisés, quel que soit le MIME annoncé', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const html = Buffer.from('<!DOCTYPE html><html><body>piège</body></html>');
    expect(detectImageKind(svg)).toBeNull();
    expect(detectImageKind(html)).toBeNull();
  });

  it('refuse les autres formats (GIF, texte) et les buffers trop courts', () => {
    expect(detectImageKind(Buffer.from('GIF89a', 'latin1'))).toBeNull();
    expect(detectImageKind(Buffer.from('RIFF\x00\x00\x00\x00AVI ', 'latin1'))).toBeNull();
    expect(detectImageKind(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageKind(Buffer.alloc(0))).toBeNull();
  });
});

describe('isStrictBase64', () => {
  it('accepte un base64 canonique, avec ou sans padding', () => {
    expect(isStrictBase64(Buffer.from('hello world').toString('base64'))).toBe(true);
    expect(isStrictBase64('QQ==')).toBe(true);
    expect(isStrictBase64('QUE=')).toBe(true);
  });

  it('rejette les caractères invalides et les longueurs incohérentes', () => {
    expect(isStrictBase64('QQ==\n')).toBe(false);
    expect(isStrictBase64('a b c=')).toBe(false);
    expect(isStrictBase64('QQ=')).toBe(false);
    expect(isStrictBase64('****')).toBe(false);
    expect(isStrictBase64('QUJDRA')).toBe(false);
  });
});
