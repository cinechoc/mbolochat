/**
 * Génère le catalogue d'émojis utilisé par le panneau de saisie.
 *
 * Source : emojibase-data (locale française, jeu de données « evergreen »,
 * licence MIT). On ne garde que ce que le panneau consomme réellement —
 * glyphe, libellé, groupe, tons de peau, balises de recherche — dans l'ordre
 * canonique Unicode (tri du groupe puis de l'« order » du jeu).
 *
 * Ré-exédule avec : node scripts/gen-emoji-catalog.mjs (depuis mobile/)
 * Après une montée de version d'emojibase-data, ce script suffit.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'node_modules', 'emojibase-data', 'package.json'), 'utf8'));
const data = join(root, 'node_modules', 'emojibase-data');
const raw = JSON.parse(readFileSync(join(data, 'fr', 'compact.json'), 'utf8'));

/** Groupe 2 = « component » (indicateurs régionaux pré-rendus) : jamais montré. */
const HIDDEN_GROUPS = new Set([2]);

/** Chaque système Unicode liste finit toujours par ces non-glyphes. */
const isDroppable = (entry) => {
  if (entry.group === undefined) return true; // indicateurs régionaux A-Z
  if (HIDDEN_GROUPS.has(entry.group)) return true;
  return false;
};

const fold = (value) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const sortKey = (entry) =>
  [entry.group ?? 0, entry.order ?? 999999, entry.hexcode].map(String).join(':');

const seen = new Set();
const out = [];
for (const entry of [...raw].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))) {
  if (isDroppable(entry)) continue;
  if (seen.has(entry.hexcode)) continue;
  seen.add(entry.hexcode);

  const tags = [...new Set(entry.tags ?? [])]
    .slice(0, 10)
    .map(fold);
  const skins = (entry.skins ?? [])
    .slice(0, 5)
    .map((skin) => skin.unicode)
    .filter(Boolean);

  const compact = { u: entry.unicode, l: entry.label.normalize('NFC'), g: entry.group };
  if (tags.length > 0) compact.t = tags;
  if (entry.unicode?.includes('\u200D')) compact.z = 1; // séquence composée (famille, profession…)
  if (skins.length > 0) compact.s = skins;
  out.push(compact);
}

const catalog = {
  schema: 1,
  source: {
    package: 'emojibase-data',
    version: pkg.version,
    locale: 'fr',
  },
  entries: out,
};

const target = join(root, 'src', 'features', 'emoji', 'generated', 'emoji-catalog.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(catalog));

const grouped = {};
for (const entry of catalog.entries) grouped[entry.g] = (grouped[entry.g] ?? 0) + 1;
console.log(
  `emoji-catalog.json : ${out.length} entrées, ` +
    `${Object.entries(grouped).map(([g, n]) => `g${g}=${n}`).join(' ')}, ` +
    `${(JSON.stringify(catalog).length / 1024).toFixed(0)} Ko`,
);
