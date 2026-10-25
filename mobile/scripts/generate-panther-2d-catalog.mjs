#!/usr/bin/env node
/**
 * Enregistre les 30 illustrations du pack « Panthère Mbolo 2D » dans le
 * catalogue TypeScript, les sources Metro et le manifeste d'assets.
 *
 *   node scripts/generate-panther-2d-catalog.mjs
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const packId = 'mbolo-panther-2d';
const packDir = join(mobile, 'assets', 'stickers', packId);

const STICKERS = [
  {
    id: 'bonjour',
    name: 'Bonjour',
    tags: ['bonjour', 'salut', 'hello', 'coucou', 'mbolo'],
  },
  {
    id: 'salut',
    name: 'Salut',
    tags: ['salut', 'coucou', 'hello', 'wave', 'main'],
  },
  {
    id: 'au-revoir',
    name: 'Au revoir',
    tags: ['au revoir', 'bye', 'salut', 'depart', 'a bientot'],
  },
  {
    id: 'merci',
    name: 'Merci',
    tags: ['merci', 'remercier', 'thanks', 'reconnaissance'],
  },
  {
    id: 'sil-te-plait',
    name: "S'il te plaît",
    tags: ['s il te plait', 'please', 'demande', 'faveur'],
  },
  {
    id: 'ok',
    name: 'OK',
    tags: ['ok', 'd accord', 'oui', 'valide', 'parfait'],
  },
  {
    id: 'oui',
    name: 'Oui',
    tags: ['oui', 'yes', 'accord', 'valide'],
  },
  {
    id: 'non',
    name: 'Non',
    tags: ['non', 'no', 'refus', 'pas d accord'],
  },
  {
    id: 'amour',
    name: 'Amour',
    tags: ['amour', 'coeur', 'love', 'aime'],
  },
  {
    id: 'bisous',
    name: 'Bisous',
    tags: ['bisou', 'bisous', 'kiss', 'coeur', 'amour'],
  },
  {
    id: 'calin',
    name: 'Câlin',
    tags: ['calin', 'câlin', 'hug', 'tendresse', 'bras'],
  },
  {
    id: 'je-taime',
    name: "Je t'aime",
    tags: ['je t aime', 'amour', 'love', 'coeur'],
  },
  {
    id: 'fou-rire',
    name: 'Fou rire',
    tags: ['rire', 'fou rire', 'lol', 'mdr', 'hilarant'],
  },
  {
    id: 'sourire',
    name: 'Petit sourire',
    tags: ['sourire', 'smile', 'content', 'doux'],
  },
  {
    id: 'tristesse',
    name: 'Tristesse',
    tags: ['triste', 'sad', 'chagrin', 'peine'],
  },
  {
    id: 'chagrin',
    name: 'Gros chagrin',
    tags: ['chagrin', 'pleurs', 'pleure', 'cry', 'larmes'],
  },
  {
    id: 'colere',
    name: 'Colère',
    tags: ['colere', 'angry', 'fache', 'boude', 'grrr'],
  },
  {
    id: 'surprise',
    name: 'Surprise',
    tags: ['surprise', 'wow', 'etonne', 'oh'],
  },
  {
    id: 'choc',
    name: 'Choc',
    tags: ['choc', 'shock', 'stupeur', 'incroyable'],
  },
  {
    id: 'timidite',
    name: 'Timidité',
    tags: ['timide', 'shy', 'gene', 'rouge', 'pudeur'],
  },
  {
    id: 'reflexion',
    name: 'Réflexion',
    tags: ['reflexion', 'pense', 'think', 'idee'],
  },
  {
    id: 'confusion',
    name: 'Confusion',
    tags: ['confusion', 'perdu', 'question', 'comprends pas'],
  },
  {
    id: 'fatigue',
    name: 'Fatigue',
    tags: ['fatigue', 'tired', 'creve', 'cafe', 'reveil'],
  },
  {
    id: 'sommeil',
    name: 'Sommeil',
    tags: ['sommeil', 'dodo', 'dormir', 'sleep', 'nuit'],
  },
  {
    id: 'bonne-nuit',
    name: 'Bonne nuit',
    tags: ['bonne nuit', 'nuit', 'dodo', 'sleep', 'lune'],
  },
  {
    id: 'fete',
    name: 'Fête',
    tags: ['fete', 'party', 'anniversaire', 'celebration', 'youpi'],
  },
  {
    id: 'bravo',
    name: 'Bravo',
    tags: ['bravo', 'felicitations', 'applaudissement', 'super', 'bien joue'],
  },
  {
    id: 'courage',
    name: 'Courage',
    tags: ['courage', 'force', 'encouragement', 'fonce', 'vas y'],
  },
  {
    id: 'pouce-leve',
    name: 'Pouce levé',
    tags: ['pouce leve', 'thumb up', 'super', 'ok', 'bravo'],
  },
  {
    id: 'yeux-en-coeur',
    name: 'Yeux en cœur',
    tags: ['yeux en coeur', 'amour', 'love', 'coeur', 'admiratif'],
  },
];

for (const sticker of STICKERS) {
  const file = join(packDir, `${sticker.id}.png`);
  if (!existsSync(file)) {
    throw new Error(`Illustration manquante : ${file}`);
  }
}

const catalog = STICKERS.map((sticker) => ({
  ...sticker,
  alt: `Panthère Mbolo : ${sticker.name}`,
}));

const catalogSource = `// FICHIER GÉNÉRÉ par scripts/generate-panther-2d-catalog.mjs : ne pas modifier à la main.
export type Panther2DStickerId =
${catalog.map((sticker) => `  | '${sticker.id}'`).join('\n')};

export type Panther2DStickerMeta = {
  id: Panther2DStickerId;
  name: string;
  tags: string[];
  alt: string;
};

export const PANTHER_2D_STICKERS: Panther2DStickerMeta[] = ${JSON.stringify(catalog, null, 2)};
`;

const assetsSource = `// FICHIER GÉNÉRÉ par scripts/generate-panther-2d-catalog.mjs : ne pas modifier à la main.
import type { ImageSourcePropType } from 'react-native';

import type { Panther2DStickerId } from './panther2dCatalog.generated';

export const PANTHER_2D_SOURCES: Record<Panther2DStickerId, ImageSourcePropType> = {
${catalog
  .map(
    (sticker) =>
      `  '${sticker.id}': require('../../../assets/stickers/${packId}/${sticker.id}.png'),`,
  )
  .join('\n')}
};
`;

const featuresDir = join(mobile, 'src', 'features', 'stickers');
writeFileSync(join(featuresDir, 'panther2dCatalog.generated.ts'), catalogSource);
writeFileSync(join(featuresDir, 'panther2dAssets.generated.ts'), assetsSource);
writeFileSync(join(packDir, 'manifest.json'), `${JSON.stringify(catalog, null, 2)}\n`);

console.log(`${catalog.length} stickers enregistrés dans ${packId}.`);
