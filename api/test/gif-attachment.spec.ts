import { describe, expect, it } from 'vitest';

import { InvalidGifAttachmentError, normalizeGifAttachment } from '../src/chat/gif-attachment.js';

describe('normalizeGifAttachment', () => {
  it('accepte une URL média GIPHY conforme et normalise les champs', () => {
    const attachment = normalizeGifAttachment({
      url: 'https://media1.giphy.com/media/abc123/200w.webp?cid=9dbb',
      width: 200,
      height: 156,
      sticker: true,
      giphyId: 'abc123',
      username: 'lilcat',
      title: 'Cat says hi',
      stillUrl: 'https://media1.giphy.com/media/abc123/200w_s.gif',
    });
    expect(attachment).toEqual({
      type: 'GIF',
      mime: 'image/webp',
      url: 'https://media1.giphy.com/media/abc123/200w.webp?cid=9dbb',
      size: 0,
      width: 200,
      height: 156,
      sticker: true,
      giphyId: 'abc123',
      username: 'lilcat',
      title: 'Cat says hi',
      stillUrl: 'https://media1.giphy.com/media/abc123/200w_s.gif',
    });
  });

  it('refuse tout ce qui n est pas media*.giphy.com en HTTPS', () => {
    for (const url of [
      'http://media1.giphy.com/media/abc123/200w.webp', // pas HTTPS
      'https://evil.example.com/media/abc123/200w.webp', // domaine arbitraire
      'https://giphy.com/media/abc123/200w.webp', // page publique, pas CDN
      'https://mediaX.giphy.com/media/x/1.gif', // index invalide
      'not a url',
      42,
      undefined,
    ]) {
      expect(() => normalizeGifAttachment({ url })).toThrow(InvalidGifAttachmentError);
    }
  });

  it('refuse un aperçu hors allowlist ou des dimensions fantaisistes', () => {
    expect(() =>
      normalizeGifAttachment({
        url: 'https://media1.giphy.com/media/a/1.webp',
        stillUrl: 'https://evil.example.com/a_s.gif',
      }),
    ).toThrow(InvalidGifAttachmentError);
    expect(() =>
      normalizeGifAttachment({
        url: 'https://media1.giphy.com/media/a/1.webp',
        width: 9999,
        height: 10,
      }),
    ).toThrow(InvalidGifAttachmentError);
    expect(() =>
      normalizeGifAttachment({
        url: 'https://media1.giphy.com/media/a/1.webp',
        width: 'wide' as unknown as number,
      }),
    ).toThrow(InvalidGifAttachmentError);
  });

  it('tolère stillUrl null, champs manquants, et borne les textes', () => {
    const attachment = normalizeGifAttachment({
      url: 'https://media1.giphy.com/media/a/1.webp',
      stillUrl: null,
      giphyId: 'a',
      title: 'x'.repeat(121),
      username: ''.padEnd(0),
    });
    expect(attachment.type).toBe('GIF');
    expect(attachment.stillUrl).toBeUndefined();
    expect(attachment.title).toBeUndefined(); // trop long : absent
    expect(attachment.username).toBeUndefined();
  });

  it('n est pas un objet : refus net', () => {
    expect(() => normalizeGifAttachment('https://media1.giphy.com/media/a/1.webp')).toThrow(
      InvalidGifAttachmentError,
    );
    expect(() => normalizeGifAttachment(null)).toThrow(InvalidGifAttachmentError);
    expect(() => normalizeGifAttachment([1, 2])).toThrow(InvalidGifAttachmentError);
  });

  it('nettoie les caractères de contrôle des textes', () => {
    const attachment = normalizeGifAttachment({
      url: 'https://media1.giphy.com/media/a/1.webp',
      title: 'Cat\u0000 says\u007F hi',
    });
    expect(attachment.title).toBe('Cat says hi');
  });
});
