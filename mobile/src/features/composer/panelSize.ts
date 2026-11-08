/**
 * Dimensionnement des panneaux du compositeur.
 *
 * Le panneau d'emojis/stickers **imite la hauteur du clavier** : c'est le
 * comportement attendu, le clavier et la grille occupent la même place et la
 * conversation ne saute pas quand on bascule de l'un à l'autre.
 *
 * Le panneau « + », lui, n'a aucune raison d'occuper cette hauteur : il ne
 * contient que quelques tuiles. Il **épouse son contenu** et se contente d'un
 * plafond (la hauteur du clavier), au-delà duquel il défile. Avant, il était
 * rendu dans une `View` de hauteur fixe : trois tuiles flottaient en haut d'une
 * zone vide de près de 300 px.
 */

/** Hauteur du clavier retenue quand on ne la connaît pas encore. */
export const DEFAULT_PANEL_HEIGHT = 290;

/** Le panneau d'emojis reste lisible même sur petit écran. */
export const MIN_EMOJI_PANEL_HEIGHT = 240;

/** Plancher du panneau « + » : ses tuiles ne doivent pas être écrasées. */
export const MIN_ATTACH_PANEL_HEIGHT = 116;

/** Hauteur de référence d'un panneau collé au clavier (emojis, stickers). */
export function keyboardPanelHeight(keyboardHeight: number): number {
  return Math.max(
    MIN_EMOJI_PANEL_HEIGHT,
    keyboardHeight > 0 ? keyboardHeight : DEFAULT_PANEL_HEIGHT,
  );
}

/**
 * Plafond du panneau « + » : il ne dépasse jamais la place qu'occuperait le
 * clavier (plus la zone sûre du bas). Sa hauteur réelle, elle, vient de son
 * contenu — d'où le `maxHeight` et non un `height`.
 */
export function attachPanelCap(keyboardHeight: number, bottomInset: number): number {
  return Math.max(MIN_ATTACH_PANEL_HEIGHT, keyboardPanelHeight(keyboardHeight) + bottomInset);
}
