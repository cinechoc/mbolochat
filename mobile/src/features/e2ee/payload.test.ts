import { describe, expect, it } from 'vitest';

import {
  buildMediaV2,
  buildTextV1,
  decodeMediaMeta,
  decodeText,
  encodeMediaMeta,
  encodeText,
  InvalidPayloadError,
  parsePayload,
  type EncryptedMedia,
} from './payload';

const blob = (id: string) => ({
  uploadId: id,
  fileKey: 'Zm9vYmFy',
  nonce: 'bm9uY2U',
  sha256: 'ab'.repeat(32),
  size: 1234,
});

const media: EncryptedMedia = {
  type: 'IMAGE',
  mime: 'image/jpeg',
  name: 'photo.jpg',
  width: 1600,
  height: 1200,
  blob: blob('media-1'),
  thumb: { ...blob('thumb-1'), size: 88 },
};

describe('encodeText / decodeText', () => {
  it('préserve les octets d une chaîne UTF-8, accents et emoji compris', () => {
    const value = 'Message chiffré — éàü 🐆 中';
    expect(decodeText(encodeText(value))).toBe(value);
  });

  it('produit le base64 attendu pour un texte ASCII simple', () => {
    // « abc » en JSON v1, tel que l'encodeur le sérialise.
    const encoded = buildTextV1('abc');
    expect(decodeText(encoded)).toBe('{"v":1,"text":"abc"}');
  });
});

describe('parsePayload — texte v1', () => {
  it('relit un texte v1 inchangé (non-régression M2)', () => {
    const parsed = parsePayload(buildTextV1('bonjour'));
    expect(parsed).toEqual({ kind: 'text', text: 'bonjour' });
  });

  it('accepte un texte vide', () => {
    expect(parsePayload(buildTextV1(''))).toEqual({ kind: 'text', text: '' });
  });
});

describe('parsePayload — média v2', () => {
  it('fait l aller-retour complet média + vignette + légende', () => {
    const parsed = parsePayload(buildMediaV2(media, 'ma photo'));
    expect(parsed.kind).toBe('media');
    if (parsed.kind !== 'media') return;
    expect(parsed.caption).toBe('ma photo');
    expect(parsed.media).toEqual(media);
    expect(parsed.media.blob.uploadId).toBe('media-1');
    expect(parsed.media.thumb?.uploadId).toBe('thumb-1');
  });

  it('accepte un média sans légende ni vignette', () => {
    const bare: EncryptedMedia = {
      type: 'FILE',
      mime: 'application/pdf',
      blob: blob('file-1'),
    };
    const parsed = parsePayload(buildMediaV2(bare));
    expect(parsed.kind).toBe('media');
    if (parsed.kind !== 'media') return;
    expect(parsed.caption).toBe('');
    expect(parsed.media.thumb).toBeUndefined();
  });
});

describe('media_meta — référence stockée dans la base chiffrée', () => {
  it('fait l aller-retour complet, clés du fichier comprises', () => {
    expect(decodeMediaMeta(encodeMediaMeta(media))).toEqual(media);
  });

  it('renvoie null pour une entrée absente ou illisible', () => {
    expect(decodeMediaMeta(null)).toBeNull();
    expect(decodeMediaMeta(undefined)).toBeNull();
    expect(decodeMediaMeta('')).toBeNull();
    expect(decodeMediaMeta('{ pas du json')).toBeNull();
    expect(decodeMediaMeta(JSON.stringify({ type: 'IMAGE' }))).toBeNull();
  });
});

describe('parsePayload — refus', () => {
  it('rejette une version inconnue au lieu de la deviner', () => {
    const future = encodeText(JSON.stringify({ v: 3, kind: 'media' }));
    expect(() => parsePayload(future)).toThrow(InvalidPayloadError);
    try {
      parsePayload(future);
    } catch (error) {
      expect((error as InvalidPayloadError).reason).toBe('unsupported_version');
    }
  });

  it('rejette un v2 sans nature média', () => {
    const payload = encodeText(JSON.stringify({ v: 2, kind: 'audio' }));
    expect(() => parsePayload(payload)).toThrow(InvalidPayloadError);
  });

  it('rejette un média sans blob valide', () => {
    const payload = encodeText(
      JSON.stringify({ v: 2, kind: 'media', media: { type: 'IMAGE', mime: 'image/jpeg' } }),
    );
    expect(() => parsePayload(payload)).toThrow(InvalidPayloadError);
  });

  it('rejette un blob auquel il manque un champ', () => {
    const payload = encodeText(
      JSON.stringify({
        v: 2,
        kind: 'media',
        media: {
          type: 'IMAGE',
          mime: 'image/jpeg',
          blob: { uploadId: 'x', fileKey: 'y', nonce: 'z' },
        },
      }),
    );
    expect(() => parsePayload(payload)).toThrow(InvalidPayloadError);
  });

  it('rejette un base64 qui ne décode pas en JSON', () => {
    expect(() => parsePayload(encodeText('pas du json'))).toThrow(InvalidPayloadError);
  });

  it('rejette une charge utile non-objet', () => {
    expect(() => parsePayload(encodeText('42'))).toThrow(InvalidPayloadError);
    expect(() => parsePayload(encodeText('null'))).toThrow(InvalidPayloadError);
  });
});
