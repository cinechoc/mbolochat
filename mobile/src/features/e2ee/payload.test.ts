import { describe, expect, it } from 'vitest';

import {
  buildMediaV2,
  buildStickerV3,
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

  it('sans replyTo, garde le format historique au bit près', () => {
    // Non-régression : l'absence de citation ne doit pas ajouter de champ.
    expect(decodeText(buildTextV1('abc'))).toBe('{"v":1,"text":"abc"}');
  });

  it('transporte replyTo quand une réponse cite un message', () => {
    const parsed = parsePayload(buildTextV1('bonjour', 'msg-42'));
    expect(parsed).toEqual({ kind: 'text', text: 'bonjour', replyTo: 'msg-42' });
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

  it('transporte replyTo dans une réponse à un média', () => {
    const parsed = parsePayload(buildMediaV2(media, 'ma photo', 'msg-7'));
    expect(parsed.kind).toBe('media');
    if (parsed.kind !== 'media') return;
    expect(parsed.replyTo).toBe('msg-7');
    expect(parsed.media).toEqual(media);
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
    // v3 est reconnu depuis 1.3b : la version « du futur » est désormais v5.
    const future = encodeText(JSON.stringify({ v: 5, kind: 'media' }));
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

describe('parsePayload — sticker v3', () => {
  const REF = 'mbolo-panther-2d/amour';

  it('fait l aller-retour d un sticker sans replyTo', () => {
    expect(parsePayload(buildStickerV3(REF))).toEqual({ kind: 'sticker', stickerRef: REF });
  });

  it('fait l aller-retour d un sticker avec replyTo', () => {
    expect(parsePayload(buildStickerV3(REF, 'msg-42'))).toEqual({
      kind: 'sticker',
      stickerRef: REF,
      replyTo: 'msg-42',
    });
  });

  it('n ajoute aucune propriété facultative au JSON sérialisé', () => {
    // Format exact, au bit près : trois clés seulement.
    expect(decodeText(buildStickerV3(REF))).toBe(
      '{"v":3,"kind":"sticker","stickerRef":"mbolo-panther-2d/amour"}',
    );
    expect(decodeText(buildStickerV3(REF, 'm-1'))).toBe(
      '{"v":3,"kind":"sticker","stickerRef":"mbolo-panther-2d/amour","replyTo":"m-1"}',
    );
    expect(Object.keys(JSON.parse(decodeText(buildStickerV3(REF))))).toEqual([
      'v',
      'kind',
      'stickerRef',
    ]);
  });

  it('accepte une référence bien formée absente du catalogue local', () => {
    // Pack livré plus tard : le parser ne consulte pas le catalogue, il valide
    // la forme. L'affichage décidera du repli.
    const future = 'mbolo-panther-3d/inconnu-du-catalogue';
    const parsed = parsePayload(buildStickerV3(future));
    expect(parsed).toEqual({ kind: 'sticker', stickerRef: future });
  });

  it('rejette une URL HTTP à la place d une référence', () => {
    for (const bad of [
      'https://exemple.test/sticker.png',
      'http://exemple.test/a/b',
      'file:///data/user/0/sticker.png',
      'data:image/png;base64,AAAA',
    ]) {
      expect(() => buildStickerV3(bad)).toThrow(InvalidPayloadError);
      const payload = encodeText(
        JSON.stringify({ v: 3, kind: 'sticker', stickerRef: bad }),
      );
      expect(() => parsePayload(payload)).toThrow(InvalidPayloadError);
    }
  });

  it('rejette un chemin relatif ou absolu', () => {
    for (const bad of [
      '../stickers/amour.png',
      '../../etc/passwd',
      '/data/user/0/sticker.png',
      'pack/../secret',
      'pack/amour.png',
      'pack\\amour',
    ]) {
      const payload = encodeText(JSON.stringify({ v: 3, kind: 'sticker', stickerRef: bad }));
      expect(() => parsePayload(payload)).toThrow(InvalidPayloadError);
    }
  });

  it('rejette une référence à plusieurs séparateurs', () => {
    for (const bad of ['a/b/c', 'mbolo-panther-2d/amour/extra', '//', 'a//b']) {
      const payload = encodeText(JSON.stringify({ v: 3, kind: 'sticker', stickerRef: bad }));
      expect(() => parsePayload(payload)).toThrow(InvalidPayloadError);
    }
  });

  it('rejette une référence dépassant les longueurs autorisées', () => {
    const tooLongPack = `${'a'.repeat(41)}/amour`;
    const tooLongId = `pack/${'b'.repeat(61)}`;
    // Bornes hautes acceptées : 40 et 60.
    const maxRef = `${'a'.repeat(40)}/${'b'.repeat(60)}`;
    for (const bad of [tooLongPack, tooLongId, '', '/', 'pack/', '/amour']) {
      const payload = encodeText(JSON.stringify({ v: 3, kind: 'sticker', stickerRef: bad }));
      expect(() => parsePayload(payload)).toThrow(InvalidPayloadError);
    }
    expect(parsePayload(buildStickerV3(maxRef))).toEqual({
      kind: 'sticker',
      stickerRef: maxRef,
    });
  });

  it('rejette un replyTo qui n est pas une chaîne', () => {
    const payload = encodeText(
      JSON.stringify({ v: 3, kind: 'sticker', stickerRef: REF, replyTo: 42 }),
    );
    expect(() => parsePayload(payload)).toThrow(InvalidPayloadError);
    const object = encodeText(
      JSON.stringify({ v: 3, kind: 'sticker', stickerRef: REF, replyTo: { id: 'm-1' } }),
    );
    expect(() => parsePayload(object)).toThrow(InvalidPayloadError);
  });

  it('rejette toujours une version inconnue', () => {
    const future = encodeText(JSON.stringify({ v: 5, kind: 'sticker', stickerRef: REF }));
    expect(() => parsePayload(future)).toThrow(InvalidPayloadError);
    try {
      parsePayload(future);
    } catch (error) {
      expect((error as InvalidPayloadError).reason).toBe('unsupported_version');
    }
    // v4 aussi : aucune version non implémentée n'est interprétée.
    expect(() => parsePayload(encodeText(JSON.stringify({ v: 4, stickerRef: REF })))).toThrow(
      InvalidPayloadError,
    );
  });

  it('rejette un v3 dont la nature n est pas sticker', () => {
    for (const kind of ['text', 'media', 'gif', undefined]) {
      const payload = encodeText(JSON.stringify({ v: 3, kind, stickerRef: REF, text: 'salut' }));
      expect(() => parsePayload(payload)).toThrow(InvalidPayloadError);
    }
  });

  it('ignore les propriétés supplémentaires et ne les utilise jamais', () => {
    const payload = encodeText(
      JSON.stringify({
        v: 3,
        kind: 'sticker',
        stickerRef: REF,
        replyTo: 'msg-9',
        url: 'https://exemple.test/x.png',
        data: 'AAAA',
        bytes: [1, 2, 3],
        path: '../../secret.png',
      }),
    );
    const parsed = parsePayload(payload);
    // Le résultat ne contient que ce que le contrat prévoit : rien d'autre n'est
    // recopié, donc aucun champ ne peut être lu plus tard par l'affichage.
    expect(parsed).toEqual({ kind: 'sticker', stickerRef: REF, replyTo: 'msg-9' });
    expect(Object.keys(parsed).sort()).toEqual(['kind', 'replyTo', 'stickerRef']);
    expect(JSON.stringify(parsed)).not.toContain('https://');
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });
});

describe('non-régression v1 et v2 après l ajout de v3', () => {
  it('garde le format texte historique au bit près', () => {
    expect(decodeText(buildTextV1('bonjour'))).toBe('{"v":1,"text":"bonjour"}');
    expect(decodeText(buildTextV1('bonjour', 'msg-1'))).toBe(
      '{"v":1,"text":"bonjour","replyTo":"msg-1"}',
    );
    expect(parsePayload(buildTextV1('bonjour'))).toEqual({ kind: 'text', text: 'bonjour' });
  });

  it('relit le média v2 avec vignette, légende et replyTo', () => {
    const parsed = parsePayload(buildMediaV2(media, 'ma photo', 'msg-3'));
    expect(parsed).toEqual({
      kind: 'media',
      media,
      caption: 'ma photo',
      replyTo: 'msg-3',
    });
  });

  it('relit un média v2 nu (sans vignette ni légende)', () => {
    const bare: EncryptedMedia = { type: 'FILE', mime: 'application/pdf', blob: blob('f-1') };
    expect(parsePayload(buildMediaV2(bare))).toEqual({
      kind: 'media',
      media: bare,
      caption: '',
    });
  });

  it('laisse v1 et v2 tolérer un replyTo non chaîne, comme avant', () => {
    // Compatibilité : ces formats existent déjà en base, on ne change pas leur
    // lecture. Seul v3, qui n'a jamais été émis, est strict.
    const v1 = encodeText(JSON.stringify({ v: 1, text: 'salut', replyTo: 42 }));
    expect(parsePayload(v1)).toEqual({ kind: 'text', text: 'salut' });
    const v2 = encodeText(JSON.stringify({ v: 2, kind: 'media', media, replyTo: 7 }));
    expect(parsePayload(v2)).toEqual({ kind: 'media', media, caption: '' });
  });
});

/**
 * Lot A — classification des contenus **authentifiés mais illisibles**.
 * Le motif sert de valeur persistée (`e2ee_messages.unreadable_reason`) : il doit
 * rester dans une liste fermée et ne jamais véhiculer de donnée du payload.
 */
describe('motifs d’un contenu illisible', () => {
  const reasonOf = (payload: string): string | null => {
    try {
      parsePayload(payload);
      return null;
    } catch (error) {
      return error instanceof InvalidPayloadError ? error.reason : `autre:${String(error)}`;
    }
  };

  it('classe une version future en unsupported_version', () => {
    for (const version of [4, 5, 99]) {
      expect(reasonOf(encodeText(JSON.stringify({ v: version, text: 'futur' })))).toBe(
        'unsupported_version',
      );
    }
    // Une version sans contenu exploitable reste « non prise en charge ».
    expect(reasonOf(encodeText(JSON.stringify({ v: 4 })))).toBe('unsupported_version');
  });

  it('classe un JSON invalide en invalid_payload', () => {
    expect(reasonOf(encodeText('{pas du json'))).toBe('invalid_payload');
    expect(reasonOf(encodeText(''))).toBe('invalid_payload');
    expect(reasonOf(encodeText('"juste une chaîne"'))).toBe('invalid_payload');
  });

  it('classe un contrat inconnu en invalid_payload', () => {
    expect(reasonOf(encodeText(JSON.stringify({ v: 1 })))).toBe('invalid_payload');
    expect(reasonOf(encodeText(JSON.stringify({ v: 2, kind: 'photo' })))).toBe('invalid_payload');
    expect(
      reasonOf(encodeText(JSON.stringify({ v: 3, kind: 'sticker', stickerRef: 'pas/un ref!' }))),
    ).toBe('invalid_payload');
  });

  it('classe un encodage illisible en invalid_encoding', () => {
    // Octets non UTF-8 : le texte n'est même pas décodable.
    expect(reasonOf(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'))).toBe('invalid_encoding');
    // base64-js ignore les caractères étrangers : la chaîne se décode en texte
    // vide, donc en JSON invalide. Le motif reste celui du contrat.
    expect(reasonOf('####')).toBe('invalid_payload');
  });

  it('n’expose dans le motif aucune donnée du payload', () => {
    const marqueur = 'SECRET-DU-PAYLOAD-7';
    // Le message d'exception est le motif normalisé, rien d'autre.
    const reason = reasonOf(encodeText(JSON.stringify({ v: 4, text: marqueur })));
    expect(reason).toBe('unsupported_version');
    expect(String(reason)).not.toContain(marqueur);
  });
});
