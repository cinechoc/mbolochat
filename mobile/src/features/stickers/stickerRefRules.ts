/**
 * Règle **unique** de validité d'une référence de sticker (« pack/id »).
 *
 * Elle est partagée par le catalogue embarqué (résolution d'un sticker à
 * afficher) et par le payload E2EE `v:3` : une seule expression régulière,
 * donc aucune divergence possible entre ce que l'application accepte d'envoyer
 * et ce que le parser reconnaît à la réception.
 *
 * Ce module n'importe rien — surtout pas les assets — pour rester utilisable
 * par la logique pure (tests Node) comme par l'écran.
 */
export const STICKER_REF_PATTERN = /^[a-z0-9_-]{1,40}\/[a-z0-9_-]{1,60}$/;

/**
 * Vrai si la chaîne a exactement la forme `pack/sticker-id` : minuscules,
 * chiffres, `_` et `-`, un seul séparateur, longueurs bornées. Une URL, un
 * chemin relatif ou une donnée encodée ne peuvent donc pas passer.
 */
export function isValidStickerRef(ref: string): boolean {
  return STICKER_REF_PATTERN.test(ref);
}
