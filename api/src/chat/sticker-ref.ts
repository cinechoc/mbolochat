/**
 * Référence d'un sticker : « pack/sticker », en minuscules, chiffres, « _ » ou
 * « - ». Même règle que `isValidStickerRef` côté mobile : un identifiant
 * accepté ici doit exister tel quel dans le catalogue embarqué.
 */
export const STICKER_REF_PATTERN = /^[a-z0-9_-]{1,40}\/[a-z0-9_-]{1,60}$/;

export type MessageType = 'text' | 'sticker';

export function isValidStickerRef(value: unknown): value is string {
  return typeof value === 'string' && STICKER_REF_PATTERN.test(value);
}

export function isMessageType(value: unknown): value is MessageType {
  return value === 'text' || value === 'sticker';
}
