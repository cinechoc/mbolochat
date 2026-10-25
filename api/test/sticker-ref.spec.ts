import { describe, expect, it } from 'vitest';
import { isMessageType, isValidStickerRef } from '../src/chat/sticker-ref.js';

describe('isValidStickerRef', () => {
  it('accepte les références du catalogue', () => {
    expect(isValidStickerRef('mbolo/merci')).toBe(true);
    expect(isValidStickerRef('mon-pack/sticker_1')).toBe(true);
  });

  it('refuse les majuscules, les séparateurs et les segments vides', () => {
    expect(isValidStickerRef('Mbolo/merci')).toBe(false);
    expect(isValidStickerRef('mbolo')).toBe(false);
    expect(isValidStickerRef('mbolo/merci/extra')).toBe(false);
    expect(isValidStickerRef('/merci')).toBe(false);
    expect(isValidStickerRef('mbolo/')).toBe(false);
    expect(isValidStickerRef('mbolo merci')).toBe(false);
  });

  it('refuse les segments trop longs ou non textuels', () => {
    expect(isValidStickerRef(`${'a'.repeat(41)}/merci`)).toBe(false);
    expect(isValidStickerRef(`mbolo/${'b'.repeat(61)}`)).toBe(false);
    expect(isValidStickerRef(42)).toBe(false);
    expect(isValidStickerRef(null)).toBe(false);
  });
});

describe('isMessageType', () => {
  it('accepte uniquement text et sticker', () => {
    expect(isMessageType('text')).toBe(true);
    expect(isMessageType('sticker')).toBe(true);
    expect(isMessageType('image')).toBe(false);
    expect(isMessageType(undefined)).toBe(false);
  });
});
