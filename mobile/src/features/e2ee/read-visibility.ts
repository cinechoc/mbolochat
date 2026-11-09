import type { E2eeListRow } from './rows';

/**
 * Lecture réelle : « Ouvert » n'est déclaré que pour les messages
 * effectivement visibles à l'écran.
 *
 * La liste suit les messages étrangers réellement affichés ; un message
 * simplement chargé en mémoire (hors viewport) ou reçu en arrière-plan ne
 * compte jamais comme lu. Sans traçage de viewport, le serveur ne saurait
 * pas non plus distinguer « lu » de « chargé ».
 */

/** La bulle doit être visible à moitié avant de compter comme lue. */
export const READ_VISIBILITY_PERCENT = 50;
/** Délai minimal de maintien à l'écran (stabilité pendant le défilement). */
export const READ_VISIBILITY_MIN_TIME_MS = 400;

/**
 * Eléments produits par `onViewableItemsChanged` : `key` + `item` suffisent.
 */
export interface ViewableRow {
  key: string;
  item: E2eeListRow;
}

/**
 * Identifiants des messages étrangers réellement visibles : séparateurs de
 * date/heure, messages propres et messages illisibles non déchiffrés exclus.
 * Dédupliqués, sans ordre significatif.
 */
export function visibleForeignMessageIds(viewable: readonly ViewableRow[]): string[] {
  const ids: string[] = [];
  for (const view of viewable ?? []) {
    const row = view?.item;
    if (!row || row.type !== 'message') continue;
    if (row.message.mine !== 0) continue;
    if (typeof row.message.id !== 'string' || row.message.id.length === 0) continue;
    if (!ids.includes(row.message.id)) ids.push(row.message.id);
  }
  return ids;
}
