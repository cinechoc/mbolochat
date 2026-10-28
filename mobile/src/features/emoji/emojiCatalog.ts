import { EMOJI_LARGE_SOURCES, EMOJI_SOURCES } from './mboloEmojiAssets.generated';
import {
  MBOLO_EMOJI_ENTRIES,
  MBOLO_EMOJI_GROUP_META,
  MBOLO_EMOJI_STATS,
  MBOLO_EMOJI_VERSION,
} from './mboloEmojiData.generated';
import type { EmojiCoverage, EmojiFaceKind, EmojiVariantKind } from './mboloEmojiSchema';

export type EmojiItem = {
  char: string;
  key: string;
  name: string;
  /** Mots-clés français/anglais pour la recherche. */
  keywords?: string[];
  /** Illustration panthère associée, null si repli Unicode. */
  artId?: string | null;
  coverage?: EmojiCoverage;
  variantKind?: EmojiVariantKind;
  variantOf?: string | null;
  sharedArt?: boolean;
  faceKind?: EmojiFaceKind | null;
  faceSubgroup?: string | null;
};

export type EmojiGroup = {
  id: string;
  label: string;
  iconKey: string;
  /** Caractère natif de l'onglet si le groupe n'a pas d'illustration Mbolo. */
  iconChar?: string;
  emojis: EmojiItem[];
};

const itemsByGroup = new Map<string, EmojiItem[]>();
const byKey = new Map<string, EmojiItem>();

// Emojis ajoutés après Unicode 14.0 (Android 13 et antérieurs : police sans
// glyphe → rendu tofu). Masqués tant qu'aucune illustration Mbolo n'existe.
// Source : unicode-emoji-json (versions) + bloc 1FAE8+ (ajouts 15.1 non listés).
// Les mains 🫱–🫶 (1FAF0–1FAF6) sont bien Unicode 14.0 et restent visibles.
const TOO_NEW_RANGES: Array<[number, number]> = [
  [0x1f6d8, 0x1f6d8], // éboulement, sans-fil
  [0x1f6dc, 0x1f6dc],
  [0x1fa75, 0x1fa77], // cœurs bleu clair, gris, rose
  [0x1fa87, 0x1fa8a], // maracas, flûte, harpe, trombone
  [0x1fa8e, 0x1fa8f], // coffre au trésor, pelle
  [0x1faad, 0x1faaf], // éventail, peigne afro, khanda
  [0x1fabb, 0x1fabf], // jacinthe, méduse, aile, arbre sans feuilles, oie
  [0x1fac6, 0x1fac6], // empreinte digitale
  [0x1fac8, 0x1fac8], // créature velue
  [0x1facd, 0x1facf], // orque, élan, âne
  [0x1fada, 0x1fadc], // gingembre, cosse, légume-racine
  [0x1fadf, 0x1fadf], // éclaboussure
  [0x1fae8, 0x1faef], // visages 15.0–15.1 (secoué, craquelé, nuage de colère…)
  [0x1faf7, 0x1faff], // mains qui poussent et suivants
];

// Séquences ZWJ introduites après Unicode 14.0 (les deux composants existent,
// mais la séquence n'a pas de glyphe). Variantes de teint retirées avant test.
const TOO_NEW_SEQUENCES = new Set([
  '1f344-200d-1f7eb', // champignon brun
  '1f34b-200d-1f7e9', // citron vert
  '1f426-200d-1f525', // phénix
  '1f426-200d-2b1b', // oiseau noir
  '1f9d1-200d-1f9d2', // parent + enfant
  '1f9d1-200d-1f9d2-200d-1f9d2', // parent + deux enfants
  '1f9d1-200d-1f9d1-200d-1f9d2', // deux parents + enfant
  '1f9d1-200d-1f9d1-200d-1f9d2-200d-1f9d2', // deux parents + deux enfants
  '1f9d1-200d-1fa70', // personne + appareil auditif
]);

const SKIN_TONES = new Set([0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff]);

function isTooNewForSystemFont(key: string): boolean {
  const cps = key.split('-').map((hex) => Number.parseInt(hex, 16));
  if (cps.some((cp) => TOO_NEW_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi))) return true;
  if (cps.some((cp) => cp === 0x200d)) {
    const stripped = cps
      .filter((cp) => !SKIN_TONES.has(cp))
      .map((cp) => cp.toString(16))
      .join('-');
    return TOO_NEW_SEQUENCES.has(stripped);
  }
  return false;
}

for (const entry of MBOLO_EMOJI_ENTRIES) {
  if (!entry.artId && isTooNewForSystemFont(entry.key)) continue;
  const item: EmojiItem = {
    char: entry.char,
    key: entry.key,
    name: entry.name,
    keywords: entry.keywords,
    artId: entry.artId,
    coverage: entry.coverage,
    variantKind: entry.variantKind,
    variantOf: entry.variantOf,
    sharedArt: entry.sharedArt,
    faceKind: entry.faceKind,
    faceSubgroup: entry.faceSubgroup,
  };
  const list = itemsByGroup.get(entry.group);
  if (list) {
    list.push(item);
  } else {
    itemsByGroup.set(entry.group, [item]);
  }
  if (!byKey.has(entry.key)) {
    byKey.set(entry.key, item);
  }
}

export const EMOJI_GROUPS: EmojiGroup[] = MBOLO_EMOJI_GROUP_META.map((group) => ({
  ...group,
  emojis: itemsByGroup.get(group.id) ?? [],
}));

export const EMOJI_BY_KEY: Map<string, EmojiItem> = byKey;

export { EMOJI_LARGE_SOURCES, EMOJI_SOURCES, MBOLO_EMOJI_STATS, MBOLO_EMOJI_VERSION };
