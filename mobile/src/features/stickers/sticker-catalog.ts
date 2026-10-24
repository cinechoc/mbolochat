/**
 * Catalogue des stickers embarqués dans l'application.
 *
 * Toute nouvelle planche s'ajoute ici : un pack, une catégorie, des mots-clés
 * et un `require` statique. Les écrans ne connaissent jamais les chemins
 * d'images : ils passent par les identifiants stables du catalogue.
 */

import { findStickerMatches } from './sticker-search';

export type StickerCategoryId = 'expressions' | 'animaux' | 'reactions';
/** Les stickers personnels forment une catégorie à part dans le sélecteur. */
export type StickerCategoryScope = StickerCategoryId | 'personnels';

export interface StickerCategory {
  id: StickerCategoryId;
  label: string;
}

export const STICKER_CATEGORIES: StickerCategory[] = [
  { id: 'expressions', label: 'Expressions' },
  { id: 'animaux', label: 'Animaux' },
  { id: 'reactions', label: 'Réactions' },
];

export interface StickerPack {
  id: string;
  name: string;
  description: string;
  /** Pack livré avec l'application (aucun téléchargement requis). */
  bundled: boolean;
}

export interface Sticker {
  /** Identifiant global stable, transmis avec le message. */
  id: string;
  name: string;
  packId: string;
  category: StickerCategoryScope;
  tags: string[];
  /**
   * Ressource bundlée (module Metro) ou fichier personnel persisté. Le
   * sélecteur et la bulle passent cette valeur telle quelle à `expo-image`.
   */
  source: number | { uri: string };
  mime: string;
  width: number;
  height: number;
  /** Horodatage de création, pour les stickers personnels. */
  createdAt?: number;
}

export const MBOLO_PACK: StickerPack = {
  id: 'mbolo-originals',
  name: 'Mbolo Originals',
  description: 'Le pack signature Mbolo — 20 illustrations originales.',
  bundled: true,
};

export const PERSONAL_PACK: StickerPack = {
  id: 'mes-stickers',
  name: 'Mes stickers',
  description: 'Tes images recadrées, conservées sur cet appareil.',
  bundled: false,
};

export const STICKER_PACKS: StickerPack[] = [MBOLO_PACK, PERSONAL_PACK];

type CatalogEntry = Omit<Sticker, 'id' | 'packId' | 'source' | 'mime' | 'width' | 'height'> & {
  file: string;
};

const PACK_ID = MBOLO_PACK.id;

/**
 * Les `require` doivent rester littéraux : Metro les résout à la compilation.
 * Le manifeste (scripts/generate-stickers.mjs) documente les mêmes noms.
 */
const PACK_ASSETS: Record<string, number> = {
  joyeux: require('../../../assets/stickers/mbolo-originals/joyeux.png'),
  'fou-rire': require('../../../assets/stickers/mbolo-originals/fou-rire.png'),
  amour: require('../../../assets/stickers/mbolo-originals/amour.png'),
  surprise: require('../../../assets/stickers/mbolo-originals/surprise.png'),
  triste: require('../../../assets/stickers/mbolo-originals/triste.png'),
  'en-colere': require('../../../assets/stickers/mbolo-originals/en-colere.png'),
  timide: require('../../../assets/stickers/mbolo-originals/timide.png'),
  'clin-doeil': require('../../../assets/stickers/mbolo-originals/clin-doeil.png'),
  fatigue: require('../../../assets/stickers/mbolo-originals/fatigue.png'),
  bravo: require('../../../assets/stickers/mbolo-originals/bravo.png'),
  'chat-calin': require('../../../assets/stickers/mbolo-originals/chat-calin.png'),
  'chien-content': require('../../../assets/stickers/mbolo-originals/chien-content.png'),
  'panda-dodo': require('../../../assets/stickers/mbolo-originals/panda-dodo.png'),
  'lapin-amour': require('../../../assets/stickers/mbolo-originals/lapin-amour.png'),
  'grenouille-ok': require('../../../assets/stickers/mbolo-originals/grenouille-ok.png'),
  'perroquet-salut': require('../../../assets/stickers/mbolo-originals/perroquet-salut.png'),
  merci: require('../../../assets/stickers/mbolo-originals/merci.png'),
  courage: require('../../../assets/stickers/mbolo-originals/courage.png'),
  'bonne-nuit': require('../../../assets/stickers/mbolo-originals/bonne-nuit.png'),
  cafe: require('../../../assets/stickers/mbolo-originals/cafe.png'),
};

const CATALOG_ENTRIES: CatalogEntry[] = [
  {
    file: 'joyeux',
    name: 'Joyeux',
    category: 'expressions',
    tags: ['joie', 'bonheur', 'sourire', 'content', 'happy'],
  },
  {
    file: 'fou-rire',
    name: 'Fou rire',
    category: 'expressions',
    tags: ['rire', 'drôle', 'lol', 'mdr', 'hilarant'],
  },
  {
    file: 'amour',
    name: 'Amour',
    category: 'expressions',
    tags: ['cœur', 'coeur', 'amour', 'aime', 'love'],
  },
  {
    file: 'surprise',
    name: 'Surprise',
    category: 'expressions',
    tags: ['surprise', 'choc', 'wow', 'étonné', 'oh'],
  },
  {
    file: 'triste',
    name: 'Triste',
    category: 'expressions',
    tags: ['triste', 'pleure', 'peine', 'chagrin', 'sad'],
  },
  {
    file: 'en-colere',
    name: 'En colère',
    category: 'expressions',
    tags: ['colère', 'fâché', 'rage', 'grrr', 'angry'],
  },
  {
    file: 'timide',
    name: 'Timide',
    category: 'expressions',
    tags: ['timide', 'gêné', 'rouge', 'pudeur', 'shy'],
  },
  {
    file: 'clin-doeil',
    name: 'Clin d’œil',
    category: 'expressions',
    tags: ['clin', 'œil', 'complicité', 'wink', 'malin'],
  },
  {
    file: 'fatigue',
    name: 'Fatigué',
    category: 'expressions',
    tags: ['fatigue', 'sommeil', 'crevé', 'dodo', 'tired'],
  },
  {
    file: 'bravo',
    name: 'Bravo',
    category: 'expressions',
    tags: ['bravo', 'félicitations', 'gagné', 'youpi', 'victoire'],
  },
  {
    file: 'chat-calin',
    name: 'Chat câlin',
    category: 'animaux',
    tags: ['chat', 'minou', 'câlin', 'mignon', 'cat'],
  },
  {
    file: 'chien-content',
    name: 'Chien content',
    category: 'animaux',
    tags: ['chien', 'toutou', 'content', 'mignon', 'dog'],
  },
  {
    file: 'panda-dodo',
    name: 'Panda dodo',
    category: 'animaux',
    tags: ['panda', 'dormir', 'dodo', 'nuit', 'sleep'],
  },
  {
    file: 'lapin-amour',
    name: 'Lapin amoureux',
    category: 'animaux',
    tags: ['lapin', 'amour', 'cœur', 'mignon', 'bunny'],
  },
  {
    file: 'grenouille-ok',
    name: 'Grenouille OK',
    category: 'animaux',
    tags: ['grenouille', 'ok', 'd’accord', 'oui', 'frog'],
  },
  {
    file: 'perroquet-salut',
    name: 'Perroquet salut',
    category: 'animaux',
    tags: ['perroquet', 'salut', 'bonjour', 'coucou', 'mbolo'],
  },
  {
    file: 'merci',
    name: 'Merci',
    category: 'reactions',
    tags: ['merci', 'remercier', 'reconnaissance', 'thanks'],
  },
  {
    file: 'courage',
    name: 'Courage',
    category: 'reactions',
    tags: ['courage', 'force', 'encouragement', 'bravo', 'fonce'],
  },
  {
    file: 'bonne-nuit',
    name: 'Bonne nuit',
    category: 'reactions',
    tags: ['nuit', 'bonne nuit', 'dormir', 'rêve', 'bye'],
  },
  {
    file: 'cafe',
    name: 'Café',
    category: 'reactions',
    tags: ['café', 'pause', 'boire', 'réveil', 'coffee'],
  },
];

export const STICKERS: Sticker[] = CATALOG_ENTRIES.map((entry) => ({
  id: `${PACK_ID}.${entry.file}`,
  name: entry.name,
  packId: PACK_ID,
  category: entry.category,
  tags: entry.tags,
  source: PACK_ASSETS[entry.file],
  mime: 'image/png',
  width: 512,
  height: 512,
}));

const BY_ID = new Map(STICKERS.map((sticker) => [sticker.id, sticker]));

export function stickerById(id: string): Sticker | undefined {
  return BY_ID.get(id);
}

export function stickersInCategory(category: StickerCategoryId): Sticker[] {
  return STICKERS.filter((sticker) => sticker.category === category);
}

export function stickersInPack(packId: string, pool: Sticker[] = STICKERS): Sticker[] {
  return pool.filter((sticker) => sticker.packId === packId);
}

/**
 * Recherche insensible aux accents sur le nom et les mots-clés. Le pool peut
 * inclure les stickers personnels : le sélecteur cherche dans tout ce qu'il
 * affiche, sans requête réseau.
 */
export function findStickers(query: string, limit = 60, pool: Sticker[] = STICKERS): Sticker[] {
  return findStickerMatches(pool, query, limit);
}
