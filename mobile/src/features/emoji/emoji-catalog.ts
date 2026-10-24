/**
 * Catalogue d'émojis généré depuis emojibase-data
 * (scripts/gen-emoji-catalog.mjs). La logique pure (pli, tons, suppression de
 * grappes) vit dans './emoji-text' et './emoji-history' : ce module ne garde
 * que le chargement des données et la recherche.
 */

import catalogRaw from './generated/emoji-catalog.json';
import { fold } from './emoji-text';

export interface EmojiEntry {
  /** Glyphe Unicode du choix de base. */
  u: string;
  /** Libellé français (emojibase-data). */
  l: string;
  /** Groupe emojibase ; 2 (« component ») et les indicateurs régionaux sont absents. */
  g: number;
  /** Balises de recherche, déjà pliées (minuscules, sans accent). */
  t?: string[];
  /** 1 si le glyphe est une séquence composée (famille, profession, couple…). */
  z?: 1;
  /** Variantes de tons de peau, index 0 = clair … 4 = foncé. */
  s?: string[];
}

/** Identifiants emojibase ; seule la présence dans le catalogue importe. */
export const EMOJI_GROUPS: { id: number; label: string; glyph: string }[] = [
  { id: 0, label: 'Émotions', glyph: '😀' },
  { id: 1, label: 'Personnes', glyph: '🧑' },
  { id: 3, label: 'Animaux', glyph: '🐶' },
  { id: 4, label: 'Nourriture', glyph: '🍔' },
  { id: 5, label: 'Voyages', glyph: '🚗' },
  { id: 6, label: 'Activités', glyph: '⚽' },
  { id: 7, label: 'Objets', glyph: '💡' },
  { id: 8, label: 'Symboles', glyph: '❤️' },
  { id: 9, label: 'Drapeaux', glyph: '🏁' },
];

let entriesCache: EmojiEntry[] | null = null;
let byGroupCache: Map<number, EmojiEntry[]> | null = null;
let indexCache: string[] | null = null;

export function getEmojiEntries(): EmojiEntry[] {
  if (entriesCache === null) {
    entriesCache = catalogRaw.entries as EmojiEntry[];
    // Index plat de recherche : libellé + balises, pliés une seule fois
    // (minuscules, accents retirés) au chargement du catalogue.
    indexCache = entriesCache.map((entry) => fold(`${entry.l} ${(entry.t ?? []).join(' ')}`));
    byGroupCache = new Map();
    for (const group of EMOJI_GROUPS) {
      byGroupCache.set(group.id, entriesCache.filter((entry) => entry.g === group.id));
    }
  }
  return entriesCache;
}

export function entriesInGroup(groupId: number): EmojiEntry[] {
  getEmojiEntries();
  return byGroupCache?.get(groupId) ?? [];
}

/**
 * Recherche par libellé et balises. `query` vide → liste vide : le panneau
 * n'affiche alors que la grille de catégorie en cours, pas tout le catalogue.
 * La borne évite de faire monter une liste énorme à partir d'une seule lettre.
 */
export function searchEmojis(query: string, limit = 120): EmojiEntry[] {
  getEmojiEntries();
  if (indexCache === null || entriesCache === null) {
    return [];
  }
  const needle = fold(query.trim());
  if (!needle) return [];
  const found: EmojiEntry[] = [];
  for (let i = 0; i < indexCache.length && found.length < limit; i += 1) {
    if (indexCache[i].includes(needle)) found.push(entriesCache[i]);
  }
  return found;
}
