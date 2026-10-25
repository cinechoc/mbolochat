#!/usr/bin/env node
/**
 * Génère le pack d'emoji de l'app à partir de Microsoft Fluent Emoji (style 3D, licence MIT).
 *
 * Usage :
 *   node scripts/build-emoji-pack.mjs \
 *     --src  /chemin/vers/fluentui-emoji/assets \
 *     --out  mobile/assets/emoji \
 *     --gen  mobile/src/features/emoji \
 *     [--size 96] [--quality 85] [--max 1700] [--large-size 192] [--large-quality 88]
 *
 * Sorties : <out>/<clé>.webp (96 px, tous les emoji) et <out>/large/<clé>.webp
 * (192 px, smileys + cœurs/mains/fêtes) pour les emoji envoyés seuls.
 *
 * Dépendances (devDependencies de scripts, JavaScript pur côté appli) :
 *   npm i -D sharp unicode-emoji-json
 *
 * Ce que fait le script :
 *  1. indexe les PNG 3D de Fluent Emoji par clé d'emoji ;
 *  2. parcourt les emoji dans l'ordre officiel Unicode (unicode-emoji-json) ;
 *  3. convertit chaque image en WebP (taille réduite, fond transparent) ;
 *  4. écrit emojiAssets.generated.ts et emojiData.generated.ts.
 *
 * ATTENTION : la structure du dépôt Fluent Emoji et le format de unicode-emoji-json
 * sont décrits ici de mémoire. Si le script échoue ou trouve très peu d'emoji,
 * inspecte les dossiers et ADAPTE findPng()/les imports : ne change pas toEmojiKey().
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(import.meta.url);

/* ----------------------------- Arguments ----------------------------- */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (!args.src || !args.out || !args.gen) {
  console.error('Usage: node scripts/build-emoji-pack.mjs --src <assets> --out <dossier webp> --gen <dossier ts>');
  process.exit(1);
}
const SRC = path.resolve(args.src);
const OUT = path.resolve(args.out);
const GEN = path.resolve(args.gen);
const SIZE = Number(args.size ?? 96); // 34 dp x 3 (écran très dense) = ~100 px : 64 px était trop flou
const QUALITY = Number(args.quality ?? 85);
const MAX = Number(args.max ?? 1700);
const LARGE_SIZE = Number(args['large-size'] ?? 192); // emoji envoyé seul (72 dp x 3 = 216 px)
const LARGE_QUALITY = Number(args['large-quality'] ?? 88);
const LARGE_OUT = path.join(path.resolve(args.out), 'large');

/** Emoji disponibles en grand format : tout le groupe « smileys » + ces clés (cœurs, mains, fêtes…). */
const LARGE_GROUP_IDS = new Set(['smileys']);
const LARGE_EXTRA_KEYS = new Set([
  '2764', '1f9e1', '1f49b', '1f49a', '1f499', '1f49c', '1f5a4', '1f90d', '1f90e',
  '1f496', '1f497', '1f493', '1f495', '1f49e', '1f498', '1f494', '1f44d', '1f44e',
  '1f44f', '1f64f', '1f44b', '1f91d', '1f64c', '1f4aa', '1f44c', '270c', '1f91e',
  '1f525', '1f389', '1f38a', '1f4af', '2728', '1f31f', '1f60e', '1f4a9', '1f480',
]);
const largeKeys = [];
const imageKeys = [];

/* ----------------- Clé d'emoji (IDENTIQUE à emojiUtils.toEmojiKey) ----------------- */
function toEmojiKey(emoji) {
  const parts = [];
  for (const ch of emoji.replace(/\uFE0F/g, '')) parts.push(ch.codePointAt(0).toString(16));
  return parts.join('-');
}
const isSkinTone = (emoji) => /[\u{1F3FB}-\u{1F3FF}]/u.test(emoji);

/* ----------------- Groupes de l'appli (ordre des onglets) ----------------- */
const GROUPS = [
  { id: 'smileys', label: 'Smileys', source: 'Smileys & Emotion', iconKey: '1f600' },
  { id: 'people', label: 'Gestes et personnes', source: 'People & Body', iconKey: '1f44b' },
  { id: 'nature', label: 'Animaux et nature', source: 'Animals & Nature', iconKey: '1f436' },
  { id: 'food', label: 'Nourriture', source: 'Food & Drink', iconKey: '1f354' },
  { id: 'activities', label: 'Activités', source: 'Activities', iconKey: '26bd' },
  { id: 'travel', label: 'Voyages', source: 'Travel & Places', iconKey: '1f697' },
  { id: 'objects', label: 'Objets', source: 'Objects', iconKey: '1f4a1' },
  { id: 'symbols', label: 'Symboles', source: 'Symbols', iconKey: '2764' },
  // Les drapeaux n'existent pas dans Fluent Emoji : ils restent en police native.
  { id: 'flags', label: 'Drapeaux', source: 'Flags', iconKey: '1f3f3', iconChar: '🏳️' },
];

/* ----------------------------- 1. Index Fluent ----------------------------- */
function findPng(dir) {
  for (const sub of ['3D', path.join('Default', '3D')]) {
    const folder = path.join(dir, sub);
    if (!fs.existsSync(folder)) continue;
    const file = fs.readdirSync(folder).find((n) => n.toLowerCase().endsWith('.png'));
    if (file) return path.join(folder, file);
  }
  return null;
}

const fluent = new Map(); // clé -> chemin du PNG
for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(SRC, entry.name);
  const metaPath = path.join(dir, 'metadata.json');
  if (!fs.existsSync(metaPath)) continue;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    continue;
  }
  const png = findPng(dir);
  if (png && meta.glyph) fluent.set(toEmojiKey(meta.glyph), png);
}
console.log(`Images Fluent indexées : ${fluent.size}`);
if (fluent.size < 500) {
  console.error('Trop peu d\'images trouvées : vérifie --src et la fonction findPng().');
  process.exit(1);
}

/* ----------------------------- 2. Ordre Unicode ----------------------------- */
const ordered = require('unicode-emoji-json/data-ordered-emoji.json');
const byEmoji = require('unicode-emoji-json/data-by-emoji.json');

/**
 * Noms et mots-clés français (emojibase-data, déjà en devDependencies) pour la
 * recherche du panneau. Aucune donnée n'est chargée à l'exécution de l'app.
 */
const frenchEmojis = require('emojibase-data/fr/compact.json');
const frenchByKey = new Map();
function emojibaseKey(hexcode) {
  return hexcode
    .split('-')
    .filter((part) => part.toUpperCase() !== 'FE0F')
    .map((part) => Number.parseInt(part, 16).toString(16))
    .join('-');
}
for (const item of frenchEmojis) {
  if (!item?.hexcode) continue;
  frenchByKey.set(emojibaseKey(item.hexcode), {
    label: typeof item.label === 'string' ? item.label : undefined,
    tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string') : [],
  });
}

const groupsOut = GROUPS.map((g) => ({
  id: g.id,
  label: g.label,
  iconKey: g.iconKey,
  ...(g.iconChar ? { iconChar: g.iconChar } : {}),
  emojis: [],
}));
const missing = [];
let total = 0;
let images = 0;

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(GEN, { recursive: true });

/* ----------------------------- 3. Conversion ----------------------------- */
let bytes = 0;
let largeBytes = 0;
for (const char of ordered) {
  if (isSkinTone(char)) continue; // le ton de peau par défaut suffit
  const info = byEmoji[char];
  if (!info) continue;
  const groupIndex = GROUPS.findIndex((g) => g.source === info.group);
  if (groupIndex === -1) continue;

  const key = toEmojiKey(char);
  const png = fluent.get(key);
  if (png && images < MAX) {
    const target = path.join(OUT, `${key}.webp`);
    await sharp(png)
      .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: QUALITY, alphaQuality: 90 })
      .toFile(target);
    bytes += fs.statSync(target).size;
    imageKeys.push(key);
    images += 1;

    if (LARGE_GROUP_IDS.has(GROUPS[groupIndex].id) || LARGE_EXTRA_KEYS.has(key)) {
      fs.mkdirSync(LARGE_OUT, { recursive: true });
      const largeTarget = path.join(LARGE_OUT, `${key}.webp`);
      await sharp(png)
        .resize(LARGE_SIZE, LARGE_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: LARGE_QUALITY, alphaQuality: 95 })
        .toFile(largeTarget);
      largeBytes += fs.statSync(largeTarget).size;
      largeKeys.push(key);
    }
  } else if (!png) {
    missing.push(char);
  }

  // Les emoji sans image restent au catalogue et sont rendus par la police système.
  const french = frenchByKey.get(key);
  const name = french?.label ?? info.name ?? key;
  const keywords = [
    ...new Set([...(french?.tags ?? []), info.name ?? ''].filter(Boolean)),
  ];
  groupsOut[groupIndex].emojis.push({
    char,
    key,
    name,
    ...(keywords.length > 0 ? { keywords } : {}),
  });
  total += 1;
}

/* ----------------------------- 4. Fichiers TypeScript ----------------------------- */
const rel = path.relative(GEN, OUT).split(path.sep).join('/');
const assets =
  '// FICHIER GÉNÉRÉ par scripts/build-emoji-pack.mjs : ne pas modifier à la main.\n' +
  'export const EMOJI_SOURCES: Record<string, number> = {\n' +
  imageKeys.map((k) => `  '${k}': require('${rel}/${k}.webp'),`).join('\n') +
  '\n};\n';
fs.writeFileSync(path.join(GEN, 'emojiAssets.generated.ts'), assets);

const data =
  '// FICHIER GÉNÉRÉ par scripts/build-emoji-pack.mjs : ne pas modifier à la main.\n' +
  `export const EMOJI_GROUPS = ${JSON.stringify(groupsOut.filter((g) => g.emojis.length), null, 1)};\n`;
fs.writeFileSync(path.join(GEN, 'emojiData.generated.ts'), data);

/* Licence MIT de Fluent Emoji : à conserver avec les images. */
const license = path.join(SRC, '..', 'LICENSE');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(OUT, 'LICENSE-fluent-emoji.txt'));

const largeAssets =
  '// FICHIER GÉNÉRÉ par scripts/build-emoji-pack.mjs : ne pas modifier à la main.\n' +
  '// Versions grand format (emoji envoyés seuls). Absent de cette liste = on utilise la version normale.\n' +
  'export const EMOJI_LARGE_SOURCES: Record<string, number> = {\n' +
  largeKeys.map((k) => `  '${k}': require('${rel}/large/${k}.webp'),`).join('\n') +
  '\n};\n';
fs.writeFileSync(path.join(GEN, 'emojiLargeAssets.generated.ts'), largeAssets);

console.log(`Emoji au catalogue : ${total}`);
console.log(`Images générées : ${imageKeys.length} (${(bytes / 1024 / 1024).toFixed(1)} Mo en ${SIZE} px)`);
console.log(`Grand format : ${largeKeys.length} (${(largeBytes / 1024 / 1024).toFixed(1)} Mo en ${LARGE_SIZE} px)`);
console.log(`Emoji rendus en natif : ${total - imageKeys.length} (dont ${missing.length} absents du dépôt Fluent)`);
const totalMb = (bytes + largeBytes) / 1024 / 1024;
if (totalMb > 12) console.warn(`Poids total ${totalMb.toFixed(1)} Mo > 12 Mo : réduis --size, --quality ou --large-size.`);
