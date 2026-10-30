/**
 * Référence d'un sticker : « pack/sticker », en minuscules, chiffres, « _ » ou
 * « - ». Même règle que `isValidStickerRef` côté mobile : un identifiant
 * accepté ici doit exister tel quel dans le catalogue embarqué.
 */
export const STICKER_REF_PATTERN = /^[a-z0-9_-]{1,40}\/[a-z0-9_-]{1,60}$/;

/** Types stockés en base : `call` et `system` sont réservés au serveur. */
export type MessageType = 'text' | 'sticker' | 'call' | 'system';

/** Types qu'un client peut réellement envoyer. */
export type ClientMessageType = 'text' | 'sticker';

export function isValidStickerRef(value: unknown): value is string {
  return typeof value === 'string' && STICKER_REF_PATTERN.test(value);
}

export function isMessageType(value: unknown): value is ClientMessageType {
  return value === 'text' || value === 'sticker';
}
