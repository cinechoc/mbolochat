import { describe, expect, it } from 'vitest';

import {
  InvalidStickerAttachmentError,
  normalizeStickerAttachment,
} from '../src/chat/sticker-attachment.js';

describe('normalizeStickerAttachment', () => {
  it('conserve des identifiants opaques et nettoie le nom', () => {
    expect(
      normalizeStickerAttachment({
        id: 'mbolo.joyeux',
        packId: 'mbolo-originals',
        name: '  Joyeux  ',
      }),
    ).toEqual({ id: 'mbolo.joyeux', packId: 'mbolo-originals', name: 'Joyeux' });
    expect(
      normalizeStickerAttachment({ id: '123e4567-e89b-12d3', packId: 'personal' }),
    ).toEqual({ id: '123e4567-e89b-12d3', packId: 'personal' });
  });

  it('retire les caractères de contrôle du nom', () => {
    expect(
      normalizeStickerAttachment({
        id: 'a',
        packId: 'p',
        name: 'Coucou\u0000\n toi',
      }),
    ).toEqual({ id: 'a', packId: 'p', name: 'Coucou toi' });
  });

  it('refuse tout identifiant qui pourrait désigner un chemin', () => {
    for (const input of [
      null,
      [],
      {},
      { id: '', packId: 'p' },
      { id: '../x', packId: 'p' },
      { id: 'a', packId: 'p/q' },
      { id: 'a b', packId: 'p' },
      { id: 'a'.repeat(81), packId: 'p' },
      { id: 42, packId: 'p' },
    ]) {
      expect(() => normalizeStickerAttachment(input)).toThrow(InvalidStickerAttachmentError);
    }
  });
});
