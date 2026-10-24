/**
 * Ordre et limite des émojis récents/favoris, sans dépendance d'exécution :
 * la logique seule est testée dans tests/emoji-helpers.test.mjs, la
 * persistance vit dans emoji-store.ts.
 */

export const RECENTS_CAP = 48;
/** Bandeau horizontal : on n'affiche pas plus, la grille « Récents » reprend tout. */
export const RECENTS_STRIP_CAP = 18;

/** Déplace (ou ajoute) le glyphe en tête, puis borne l'historique. */
export function pushRecent(list: readonly string[], glyph: string, cap = RECENTS_CAP): string[] {
  const rest = list.filter((item) => item !== glyph);
  return [glyph, ...rest].slice(0, cap);
}

/** Favoris : borne volontairement large, l'utilisateur garde la main. */
export function pushFavorite(list: readonly string[], glyph: string, cap = 64): string[] {
  return [...list, glyph].slice(0, cap);
}

export function removeFavorite(list: readonly string[], glyph: string): string[] {
  return list.filter((item) => item !== glyph);
}
