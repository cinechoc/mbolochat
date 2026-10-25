#!/usr/bin/env node
/**
 * Génère le pack d'emoji de l'app à partir de Microsoft Fluent Emoji (style 3D, licence MIT).
 *
 * Usage :
 *   node scripts/build-emoji-pack.mjs \
 *     --src  /chemin/vers/fluentui-emoji/assets \
 *     --out  mobile/assets/emoji \
 *     --gen  mobile/src/features/emoji \
 *     [--size 64] [--quality 82] [--max 1100]
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
const SIZE = Number(args.size ?? 64);
const QUALITY = Number(args.quality ?? 82);
const MAX = Number(args.max ?? 1100);

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

const groupsOut = GROUPS.map((g) => ({ id: g.id, label: g.label, iconKey: g.iconKey, emojis: [] }));
const missing = [];
let total = 0;

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(GEN, { recursive: true });

/* ----------------------------- 3. Conversion ----------------------------- */
let bytes = 0;
for (const char of ordered) {
  if (total >= MAX) break;
  if (isSkinTone(char)) continue; // le ton de peau par défaut suffit
  const info = byEmoji[char];
  if (!info) continue;
  const groupIndex = GROUPS.findIndex((g) => g.source === info.group);
  if (groupIndex === -1) continue; // drapeaux et autres groupes exclus volontairement

  const key = toEmojiKey(char);
  const png = fluent.get(key);
  if (!png) {
    missing.push(char);
    continue;
  }
  const target = path.join(OUT, `${key}.webp`);
  await sharp(png)
    .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: QUALITY, alphaQuality: 90 })
    .toFile(target);
  bytes += fs.statSync(target).size;
  groupsOut[groupIndex].emojis.push({ char, key, name: info.name ?? key });
  total += 1;
}

/* ----------------------------- 4. Fichiers TypeScript ----------------------------- */
const rel = path.relative(GEN, OUT).split(path.sep).join('/');
const keys = groupsOut.flatMap((g) => g.emojis.map((e) => e.key));
const assets =
  '// FICHIER GÉNÉRÉ par scripts/build-emoji-pack.mjs : ne pas modifier à la main.\n' +
  'export const EMOJI_SOURCES: Record<string, number> = {\n' +
  keys.map((k) => `  '${k}': require('${rel}/${k}.webp'),`).join('\n') +
  '\n};\n';
fs.writeFileSync(path.join(GEN, 'emojiAssets.generated.ts'), assets);

const data =
  '// FICHIER GÉNÉRÉ par scripts/build-emoji-pack.mjs : ne pas modifier à la main.\n' +
  `export const EMOJI_GROUPS = ${JSON.stringify(groupsOut.filter((g) => g.emojis.length), null, 1)};\n`;
fs.writeFileSync(path.join(GEN, 'emojiData.generated.ts'), data);

/* Licence MIT de Fluent Emoji : à conserver avec les images. */
const license = path.join(SRC, '..', 'LICENSE');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(OUT, 'LICENSE-fluent-emoji.txt'));

console.log(`Emoji générés : ${total} (${(bytes / 1024 / 1024).toFixed(1)} Mo)`);
console.log(`Emoji sans image Fluent : ${missing.length}`);
if (bytes > 6 * 1024 * 1024) console.warn('Poids > 6 Mo : réduis --max, --size ou --quality.');
