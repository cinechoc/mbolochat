#!/usr/bin/env node
/**
 * Construit le registre MboloChat à partir du catalogue Unicode de l'app.
 *
 * Entrées :
 *   src/features/emoji/generated/emoji-catalog.json  (généré par gen-emoji-catalog.mjs)
 *   scripts/mbolo-emoji-art-map.json                 (correspondances manuelles)
 *   scripts/mbolo-emoji-face-sources.json            (portraits tête seule)
 *   assets/mbolo-emoji/{,large/}<art>.webp           (stickers 2D optimisés)
 *   assets/emoji-faces/{,large/}<art>.webp           (portraits tête seule)
 *   node_modules/emojibase-data/fr/data.json         (sous-groupes Unicode)
 *
 * Sorties :
 *   src/features/emoji/mboloEmojiData.generated.ts
 *   src/features/emoji/mboloEmojiAssets.generated.ts
 *   docs/MBOLO-EMOJI-COVERAGE.md
 *   docs/MBOLO-EMOJI-MISSING.csv
 *   docs/MBOLO-EMOJI-MISSING-BASE.csv
 *   docs/MBOLO-EMOJI-FACES.md
 *   docs/MBOLO-EMOJI-FACES.csv
 *   docs/MBOLO-EMOJI-FACES-MISSING.csv
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'src/features/emoji/generated/emoji-catalog.json');
const ART_MAP = path.join(ROOT, 'scripts/mbolo-emoji-art-map.json');
const ART_DIR = path.join(ROOT, 'assets/mbolo-emoji');
const FACE_DIR = path.join(ROOT, 'assets/emoji-faces');
const FACE_MANIFEST = path.join(ROOT, 'scripts/mbolo-emoji-face-sources.json');
const FULL_DATA = path.join(ROOT, 'node_modules/emojibase-data/fr/data.json');
const GROUP_META = path.join(ROOT, 'node_modules/emojibase-data/meta/groups.json');
const STICKER_ASSETS = path.join(ROOT, 'src/features/stickers/panther2dAssets.generated.ts');
const GEN_DATA = path.join(ROOT, 'src/features/emoji/mboloEmojiData.generated.ts');
const GEN_ASSETS = path.join(ROOT, 'src/features/emoji/mboloEmojiAssets.generated.ts');
const DOCS = path.join(ROOT, '..', 'docs');
const COVERAGE_MD = path.join(DOCS, 'MBOLO-EMOJI-COVERAGE.md');
const MISSING_CSV = path.join(DOCS, 'MBOLO-EMOJI-MISSING.csv');
const MISSING_BASE_CSV = path.join(DOCS, 'MBOLO-EMOJI-MISSING-BASE.csv');
const FACES_MD = path.join(DOCS, 'MBOLO-EMOJI-FACES.md');
const FACES_CSV = path.join(DOCS, 'MBOLO-EMOJI-FACES.csv');
const FACES_MISSING_CSV = path.join(DOCS, 'MBOLO-EMOJI-FACES-MISSING.csv');

const UNICODE_VERSION = '18.0';
const CLDR_VERSION = '49 beta 1';

const GROUPS = [
  { num: 0, id: 'smileys', label: 'Smileys et émotions', iconKey: '1f642', iconChar: '🙂' },
  { num: 1, id: 'people', label: 'Gestes et personnes', iconKey: '1f44b', iconChar: '👋' },
  { num: 3, id: 'nature', label: 'Animaux et nature', iconKey: '1f436', iconChar: '🐾' },
  { num: 4, id: 'food', label: 'Nourriture et boissons', iconKey: '1f354', iconChar: '🍔' },
  { num: 6, id: 'activities', label: 'Activités', iconKey: '26bd', iconChar: '⚽' },
  { num: 5, id: 'travel', label: 'Voyages et lieux', iconKey: '1f697', iconChar: '✈️' },
  { num: 7, id: 'objects', label: 'Objets', iconKey: '1f4a1', iconChar: '💡' },
  { num: 8, id: 'symbols', label: 'Symboles', iconKey: '2764', iconChar: '❤️' },
  { num: 9, id: 'flags', label: 'Drapeaux', iconKey: '1f3f3', iconChar: '🏳️' },
];
const GROUP_BY_NUM = new Map(GROUPS.map((group) => [group.num, group]));

/** Visages de réaction humanoïdes : sous-groupes face-smiling…face-negative. */
const HUMAN_SUBGROUPS = new Set([
  'face-smiling',
  'face-affection',
  'face-tongue',
  'face-hand',
  'face-neutral-skeptical',
  'face-sleepy',
  'face-unwell',
  'face-hat',
  'face-glasses',
  'face-concerned',
  'face-negative',
]);

const SKIN_LABELS = new Map([
  [0x1f3fb, 'peau claire'],
  [0x1f3fc, 'peau moyennement claire'],
  [0x1f3fd, 'peau médiane'],
  [0x1f3fe, 'peau moyennement foncée'],
  [0x1f3ff, 'peau foncée'],
]);

function toEmojiKey(emoji) {
  const parts = [];
  for (const ch of emoji.replace(/\uFE0F/g, '')) {
    parts.push(ch.codePointAt(0).toString(16));
  }
  return parts.join('-');
}

function codePoints(sequence) {
  return [...sequence].map((ch) => ch.codePointAt(0));
}

function classify(sequence) {
  const points = codePoints(sequence);
  if (points.some((point) => SKIN_LABELS.has(point))) return 'skin-tone';
  if (points.some((point) => point >= 0xe0020 && point <= 0xe007f)) return 'tag-flag';
  if (points.length === 2 && points.every((point) => point >= 0x1f1e6 && point <= 0x1f1ff)) return 'flag';
  if (points.includes(0x200d)) return 'zwj';
  if (points.includes(0x20e3)) return 'keycap';
  return 'base';
}

function skinLabels(sequence) {
  return codePoints(sequence)
    .map((point) => SKIN_LABELS.get(point))
    .filter(Boolean);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function mdCell(value) {
  return String(value).replace(/\|/g, '\\|');
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

const catalog = readJson(CATALOG);
const artMap = readJson(ART_MAP);
const faceManifest = readJson(FACE_MANIFEST);
const fullData = readJson(FULL_DATA);
const subgroupNames = readJson(GROUP_META).subgroups;
const fullByKey = new Map(fullData.map((entry) => [toEmojiKey(entry.emoji), entry]));
const stickerIds = [...fs.readFileSync(STICKER_ASSETS, 'utf8').matchAll(/'([a-z0-9-]+)': require/g)].map(
  (match) => match[1],
);
const faceIds = fs.existsSync(FACE_DIR)
  ? fs.readdirSync(FACE_DIR).filter((name) => name.endsWith('.webp')).map((name) => name.slice(0, -5))
  : [];
ensure(stickerIds.length > 0, 'Aucun sticker panthère trouvé.');
ensure(faceIds.length === faceManifest.length, 'Le manifeste facial et les assets ne correspondent pas.');
const faceManifestById = new Map(faceManifest.map((face) => [face.id, face]));
for (const face of faceManifest) {
  ensure(faceIds.includes(face.id), `Portrait facial manquant : ${face.id}`);
  // Source : sticker du pack 2D, ou dessin dédié (dir relatif optionnel, Vague 2).
  ensure(
    stickerIds.includes(face.source) ||
      fs.existsSync(path.join(ROOT, face.dir ?? '', `${face.source}.png`)),
    `Source sticker inconnue : ${face.source}`,
  );
}

function faceInfo(sequence) {
  const full = fullByKey.get(toEmojiKey(sequence));
  const subgroup = full ? subgroupNames[String(full.subgroup)] ?? null : null;
  let kind = null;
  if (HUMAN_SUBGROUPS.has(subgroup)) kind = 'human';
  else if (subgroup === 'face-costume') kind = 'costume';
  else if (subgroup === 'cat-face') kind = 'cat';
  else if (subgroup === 'monkey-face') kind = 'monkey';
  return { faceKind: kind, faceSubgroup: subgroup };
}

const artMapKeys = Object.keys(artMap);
const allArtIds = new Set([...stickerIds, ...faceIds]);
// Le catalogue généré utilise `u` ; on accepte aussi `unicode` pour rester tolérant.
const baseByKey = new Map();
for (const item of catalog.entries) {
  const sequence = item.unicode ?? item.u;
  baseByKey.set(toEmojiKey(sequence), { ...item, sequence });
}
for (const key of artMapKeys) {
  ensure(baseByKey.has(key), `Clé d'art inconnue dans le catalogue : ${key}`);
  const artId = artMap[key];
  ensure(allArtIds.has(artId), `Illustration inconnue : ${artId}`);
  const folder = artId.startsWith('face-') ? FACE_DIR : ART_DIR;
  ensure(fs.existsSync(path.join(folder, `${artId}.webp`)), `Asset manquant : ${folder}/${artId}.webp`);
  ensure(
    fs.existsSync(path.join(folder, 'large', `${artId}.webp`)),
    `Asset large manquant : ${folder}/large/${artId}.webp`,
  );
}
for (const id of stickerIds) {
  for (const folder of [ART_DIR, path.join(ART_DIR, 'large')]) {
    ensure(fs.existsSync(path.join(folder, `${id}.webp`)), `Asset manquant : ${folder}/${id}.webp`);
  }
}
for (const id of faceIds) {
  for (const folder of [FACE_DIR, path.join(FACE_DIR, 'large')]) {
    ensure(fs.existsSync(path.join(folder, `${id}.webp`)), `Asset manquant : ${folder}/${id}.webp`);
  }
}

const entries = [];
const seenSequences = new Set();
const seenKeys = new Set();

function pushEntry(entry) {
  ensure(!seenSequences.has(entry.char), `Séquence dupliquée : ${entry.char}`);
  ensure(!seenKeys.has(entry.key), `Clé dupliquée : ${entry.key}`);
  seenSequences.add(entry.char);
  seenKeys.add(entry.key);
  entries.push(entry);
}

for (const item of catalog.entries) {
  const sequence = item.unicode ?? item.u;
  const group = GROUP_BY_NUM.get(item.g);
  if (!group) continue;
  const key = toEmojiKey(sequence);
  const artId = artMap[key] ?? null;
  const face = faceInfo(sequence);
  ensure(
    !(face.faceKind && artId && !artId.startsWith('face-')),
    `Un visage ne peut pas utiliser un sticker entier : ${key} -> ${artId}`,
  );
  ensure(
    !(artId?.startsWith('face-') && !face.faceKind),
    `Un portrait facial ne peut pas illustrer un non-visage : ${key} -> ${artId}`,
  );
  const baseKeywords = Array.isArray(item.t) ? [...new Set(item.t.filter(Boolean))] : [];
  pushEntry({
    char: sequence,
    key,
    name: item.l,
    group: group.id,
    keywords: baseKeywords,
    artId,
    coverage: artId ? 'illustrated' : 'unicode-fallback',
    variantKind: classify(sequence),
    variantOf: null,
    codePoints: codePoints(sequence).length,
    sharedArt: false,
    faceKind: face.faceKind,
    faceSubgroup: face.faceSubgroup,
  });

  for (const skin of item.s ?? []) {
    const labels = skinLabels(skin);
    const skinKey = toEmojiKey(skin);
    const skinArt = artMap[skinKey] ?? null;
    ensure(
      !(face.faceKind && skinArt && !skinArt.startsWith('face-')),
      `Un visage ne peut pas utiliser un sticker entier : ${skinKey} -> ${skinArt}`,
    );
    ensure(
      !(skinArt?.startsWith('face-') && !face.faceKind),
      `Un portrait facial ne peut pas illustrer un non-visage : ${skinKey} -> ${skinArt}`,
    );
    pushEntry({
      char: skin,
      key: skinKey,
      name: labels.length ? `${item.l} — ${labels.join(' / ')}` : item.l,
      group: group.id,
      keywords: [...new Set([...baseKeywords, ...labels, 'peau', 'teint', 'skin tone'])],
      artId: skinArt,
      coverage: skinArt ? 'illustrated' : 'unicode-fallback',
      variantKind: 'skin-tone',
      variantOf: key,
      codePoints: codePoints(skin).length,
      sharedArt: false,
      faceKind: face.faceKind,
      faceSubgroup: face.faceSubgroup,
    });
  }
}

const artCounts = new Map();
for (const entry of entries) {
  if (!entry.artId) continue;
  artCounts.set(entry.artId, (artCounts.get(entry.artId) ?? 0) + 1);
}
for (const entry of entries) {
  entry.sharedArt = Boolean(entry.artId && (artCounts.get(entry.artId) ?? 0) > 1);
}

const illustrated = entries.filter((entry) => entry.coverage === 'illustrated');
const fallback = entries.filter((entry) => entry.coverage === 'unicode-fallback');
const missingBase = fallback.filter((entry) => entry.variantKind !== 'skin-tone');
const missingSkins = fallback.filter((entry) => entry.variantKind === 'skin-tone');
const mappedArtAssets = [...artCounts.keys()].sort();
const sharedArtAssets = [...artCounts.entries()].filter(([, count]) => count > 1);
const variantKinds = {
  base: 0,
  'skin-tone': 0,
  zwj: 0,
  flag: 0,
  'tag-flag': 0,
  keycap: 0,
};
for (const entry of entries) variantKinds[entry.variantKind] += 1;
const categories = GROUPS.map((group) => {
  const list = entries.filter((entry) => entry.group === group.id);
  return {
    id: group.id,
    label: group.label,
    total: list.length,
    illustrated: list.filter((entry) => entry.coverage === 'illustrated').length,
    fallback: list.filter((entry) => entry.coverage === 'unicode-fallback').length,
  };
});
const faceEntries = entries.filter((entry) => entry.faceKind);
const faceBaseOf = (kind) =>
  entries.filter((entry) => entry.faceKind === kind && entry.variantOf === null).length;
const faceSeqOf = (kind) => entries.filter((entry) => entry.faceKind === kind).length;
const humanEntries = entries.filter((entry) => entry.faceKind === 'human');
const humanIllustrated = humanEntries.filter((entry) => entry.coverage === 'illustrated').length;
const faces = {
  totalBase: faceEntries.filter((entry) => entry.variantOf === null).length,
  totalSequences: faceEntries.length,
  humanBase: faceBaseOf('human'),
  humanSequences: faceSeqOf('human'),
  humanIllustrated,
  humanFallback: faceSeqOf('human') - humanIllustrated,
  costumeBase: faceBaseOf('costume'),
  costumeSequences: faceSeqOf('costume'),
  catBase: faceBaseOf('cat'),
  catSequences: faceSeqOf('cat'),
  monkeyBase: faceBaseOf('monkey'),
  monkeySequences: faceSeqOf('monkey'),
};
const stats = {
  unicodeVersion: UNICODE_VERSION,
  source: {
    package: 'emojibase-data',
    version: catalog.source.version,
    locale: catalog.source.locale,
    cldr: CLDR_VERSION,
  },
  baseEntries: catalog.entries.length,
  skinVariants: entries.length - catalog.entries.length,
  totalSequences: entries.length,
  distinctKeys: seenKeys.size,
  illustrated: illustrated.length,
  unicodeFallback: fallback.length,
  artAssets: stickerIds.length + faceIds.length,
  mappedArtAssets: mappedArtAssets.length,
  sharedArtAssets: sharedArtAssets.length,
  sharedIllustrations: entries.filter((entry) => entry.sharedArt).length,
  categories,
  variantKinds,
  faces,
};

const json = (value) => JSON.stringify(value);
const entryLines = entries.map(
  (entry) =>
    `  entry({ char: ${json(entry.char)}, key: ${json(entry.key)}, name: ${json(entry.name)}, group: ${json(entry.group)}, keywords: ${json(entry.keywords)}, artId: ${entry.artId ? json(entry.artId) : 'null'}, coverage: ${json(entry.coverage)}, variantKind: ${json(entry.variantKind)}, variantOf: ${entry.variantOf ? json(entry.variantOf) : 'null'}, codePoints: ${entry.codePoints}, sharedArt: ${entry.sharedArt}, faceKind: ${entry.faceKind ? json(entry.faceKind) : 'null'}, faceSubgroup: ${entry.faceSubgroup ? json(entry.faceSubgroup) : 'null'} }),`,
);

fs.writeFileSync(
  GEN_DATA,
  `// FICHIER GÉNÉRÉ par scripts/build-mbolo-emoji-registry.mjs : ne pas modifier à la main.
import type {
  MboloEmojiEntry,
  MboloEmojiGroupMeta,
  MboloEmojiStats,
} from './mboloEmojiSchema';

export const MBOLO_EMOJI_VERSION = ${json(UNICODE_VERSION)};
export const MBOLO_EMOJI_SOURCE = ${json(stats.source)};

export const MBOLO_EMOJI_GROUP_META: MboloEmojiGroupMeta[] = ${JSON.stringify(
    GROUPS.map(({ id, label, iconKey, iconChar }) => ({ id, label, iconKey, iconChar })),
    null,
    2,
  )};

// Fabrique typée : évite que TypeScript infère une union géante pour 3 583 entrées.
const entry = (value: MboloEmojiEntry): MboloEmojiEntry => value;

export const MBOLO_EMOJI_ENTRIES: MboloEmojiEntry[] = [
${entryLines.join('\n')}
];

export const MBOLO_EMOJI_STATS: MboloEmojiStats = ${JSON.stringify(stats, null, 2)};
`,
);

const artLines = [
  ...stickerIds.map(
    (id) => `  ${json(id)}: require('../../../assets/mbolo-emoji/${id}.webp') as number,`,
  ),
  ...faceIds.map(
    (id) => `  ${json(id)}: require('../../../assets/emoji-faces/${id}.webp') as number,`,
  ),
].join('\n');
const largeLines = [
  ...stickerIds.map(
    (id) => `  ${json(id)}: require('../../../assets/mbolo-emoji/large/${id}.webp') as number,`,
  ),
  ...faceIds.map(
    (id) => `  ${json(id)}: require('../../../assets/emoji-faces/large/${id}.webp') as number,`,
  ),
].join('\n');
const sourceLines = [...artMapKeys]
  .sort()
  .map((key) => `  ${json(key)}: MBOLO_EMOJI_ART_SOURCES[${json(artMap[key])}],`)
  .join('\n');
const largeSourceLines = [...artMapKeys]
  .sort()
  .map((key) => `  ${json(key)}: MBOLO_EMOJI_ART_LARGE_SOURCES[${json(artMap[key])}],`)
  .join('\n');

fs.writeFileSync(
  GEN_ASSETS,
  `// FICHIER GÉNÉRÉ par scripts/build-mbolo-emoji-registry.mjs : ne pas modifier à la main.
import type { ImageSourcePropType } from 'react-native';

export const MBOLO_EMOJI_ART_SOURCES: Record<string, ImageSourcePropType> = {
${artLines}
};

export const MBOLO_EMOJI_ART_LARGE_SOURCES: Record<string, ImageSourcePropType> = {
${largeLines}
};

/** Raccourci par clé d'emoji (celle utilisée par le parseur et le panneau). */
export const EMOJI_SOURCES: Record<string, ImageSourcePropType> = {
${sourceLines}
};

export const EMOJI_LARGE_SOURCES: Record<string, ImageSourcePropType> = {
${largeSourceLines}
};
`,
);

const date = new Date().toISOString().slice(0, 10);
const categoryRows = categories
  .map(
    (category) =>
      `| ${mdCell(category.label)} | ${category.total} | ${category.illustrated} | ${category.fallback} |`,
  )
  .join('\n');
const mappingRows = illustrated
  .map(
    (entry) =>
      `| ${mdCell(entry.char)} | \`${entry.key}\` | ${mdCell(entry.name)} | \`${entry.artId}\` | ${entry.sharedArt ? 'oui' : '—'} |`,
  )
  .join('\n');
const sharedRows = sharedArtAssets
  .map(([artId, count]) => {
    const keys = illustrated
      .filter((entry) => entry.artId === artId)
      .map((entry) => `${entry.char} (\`${entry.key}\`)`)
      .join(', ');
    return `| \`${artId}\` | ${count} | ${keys} |`;
  })
  .join('\n');
const groupLabel = new Map(GROUPS.map((group) => [group.id, group.label]));
const artFiles = [
  ...stickerIds.map((id) => ({ id, kind: 'sticker', dir: ART_DIR })),
  ...faceIds.map((id) => ({ id, kind: 'portrait', dir: FACE_DIR })),
];
const artAssetRows = artFiles
  .map(({ id, kind, dir }) => {
    const keys = illustrated
      .filter((entry) => entry.artId === id)
      .map((entry) => `${entry.char} \`${entry.key}\``)
      .join(', ');
    const small = fs.statSync(path.join(dir, `${id}.webp`)).size;
    const large = fs.statSync(path.join(dir, 'large', `${id}.webp`)).size;
    return `| \`${id}\` | ${kind} | ${(small / 1024).toFixed(1)} Ko | ${(large / 1024).toFixed(1)} Ko | ${keys || '—'} |`;
  })
  .join('\n');
const illustratedFaces = illustrated.filter((entry) => entry.faceKind === 'human');
const facePrototypeRows = illustratedFaces
  .map((entry) => {
    const source = faceManifestById.get(entry.artId)?.source ?? '—';
    return `| ${mdCell(entry.char)} | \`${entry.key}\` | ${mdCell(entry.name)} | \`${entry.artId}\` | \`${source}\` |`;
  })
  .join('\n');
const faceMissing = entries.filter(
  (entry) => entry.faceKind === 'human' && entry.coverage === 'unicode-fallback',
);
const faceCsvHeader =
  'face_kind,in_scope,categorie,sequence,cle,nom,artId,couverture,variante,base\n';
const faceRowFor = (entry) =>
  [
    csvCell(entry.faceKind),
    entry.faceKind === 'human' ? 'oui' : 'non',
    csvCell(groupLabel.get(entry.group) ?? entry.group),
    csvCell(entry.char),
    csvCell(entry.key),
    csvCell(entry.name),
    csvCell(entry.artId ?? ''),
    csvCell(entry.coverage),
    csvCell(entry.variantKind),
    csvCell(entry.variantOf ?? ''),
  ].join(',');
const oldFaceKeys = [
  '1f600','1f601','1f602','1f603','1f604','1f606','1f60a','1f60d','1f615','1f618',
  '1f61e','1f620','1f621','1f622','1f628','1f629','1f62a','1f62b','1f62d','1f62e',
  '1f631','1f633','1f634','1f642','1f914','1f917','1f923','1f929','1f970','1f973','1f97a',
];
const oldFaceStickers = [
  'sourire','fou-rire','yeux-en-coeur','confusion','bisous','tristesse','colere','choc',
  'fatigue','sommeil','chagrin','surprise','timidite','reflexion','calin','fete','sil-te-plait',
];
const missingBaseExamples = GROUPS.map((group) => {
  const examples = missingBase
    .filter((entry) => entry.group === group.id)
    .slice(0, 6)
    .map((entry) => `${entry.char} ${entry.name}`)
    .join(', ');
  return `- **${group.label}** : ${examples || '—'}`;
}).join('\n');

fs.mkdirSync(DOCS, { recursive: true });
fs.writeFileSync(
  COVERAGE_MD,
  `# Couverture des emojis MboloChat

Généré le ${date} par \`scripts/build-mbolo-emoji-registry.mjs\`.

## Version retenue

- **Emoji ${UNICODE_VERSION}** — jeu \`${catalog.source.package}@${catalog.source.version}\` (locale \`${catalog.source.locale}\`, CLDR ${CLDR_VERSION}).
- Source d'inventaire : \`src/features/emoji/generated/emoji-catalog.json\`, produit par \`scripts/gen-emoji-catalog.mjs\`.

## Chiffres exacts

| Mesure | Valeur |
| --- | ---: |
| Entrées de base | ${stats.baseEntries} |
| Variantes de peau | ${stats.skinVariants} |
| **Séquences inventoriées** | **${stats.totalSequences}** |
| Clés normalisées distinctes | ${stats.distinctKeys} |
| Séquences illustrées | ${stats.illustrated} |
| Séquences en repli Unicode | ${stats.unicodeFallback} |
| Illustrations 2D disponibles | ${stats.artAssets} |
| Illustrations réellement mappées | ${stats.mappedArtAssets} |
| Illustrations partagées par plusieurs séquences | ${stats.sharedArtAssets} |
| Séquences utilisant une illustration partagée | ${stats.sharedIllustrations} |

Les variantes par genre, les séquences ZWJ, les drapeaux, les tag-flags et les keycaps sont inclus dans les entrées de base ; les tons de peau sont les ${stats.skinVariants} variantes supplémentaires.

## Visages (étape 1)

| Mesure | Valeur |
| --- | ---: |
| Visages au sens Unicode (face-* + chat/singe) | ${stats.faces.totalBase} |
| **Visages de réaction humanoïdes** | **${stats.faces.humanBase}** |
| Portraits tête seule illustrés | ${stats.faces.humanIllustrated} |
| Visages humanoïdes encore en repli Unicode | ${stats.faces.humanFallback} |
| Visages costume / chat / singe (hors périmètre) | ${stats.faces.costumeBase} / ${stats.faces.catBase} / ${stats.faces.monkeyBase} |

Les 25 cœurs et 15 émotions du groupe Smileys ne sont pas des visages et ne sont pas modifiés à cette étape.

### Prototype tête seule (${stats.faces.humanIllustrated})

| Emoji | Clé | Nom | Portrait | Source sticker |
| --- | --- | --- | --- | --- |
${facePrototypeRows}

Les portraits sont dans \`assets/emoji-faces/\` ; les stickers complets restent dans \`assets/stickers/mbolo-panther-2d/\` et \`assets/mbolo-emoji/\`. Aucun visage n'utilise un sticker entier.

## Couverture par catégorie

| Catégorie | Séquences | Illustrées | Repli Unicode |
| --- | ---: | ---: | ---: |
${categoryRows}

## Règle de repli

Une séquence sans \`artId\` est **conservée et affichée en Unicode classique**, jamais remplacée arbitrairement. Le texte du message n'est pas modifié : le rendu est une couche d'affichage. Les séquences avec \`artId\` utilisent l'illustration panthère locale indiquée.

## Correspondances illustrées (${illustrated.length})

| Emoji | Clé | Nom | Illustration | Partagée |
| --- | --- | --- | --- | --- |
${mappingRows}

## Illustrations partagées

| Illustration | Séquences | Emojis |
| --- | ---: | --- |
${sharedRows}

## Assets disponibles (${artFiles.length})

Les fichiers sont des WebP 96 px (inline/panneau) et 192 px (emoji seul). Les portraits sont des têtes seules dérivées des expressions 2D existantes ; les stickers sont les illustrations complètes.

| Illustration | Type | 96 px | 192 px | Emojis mappés |
| --- | --- | ---: | ---: | --- |
${artAssetRows}

## Illustrations restantes

- **${missingBase.length} séquences hors tons de peau** sans illustration (visages, gestes, animaux, nourriture, objets, symboles, drapeaux, ZWJ, keycaps…).
- **${missingSkins.length} variantes de peau** sans illustration dédiée.
- **${faceMissing.length} visages de réaction humanoïdes** sans portrait dédié ; ${stats.faces.costumeBase + stats.faces.catBase + stats.faces.monkeyBase} autres visages (costume/chat/singe) sont hors périmètre de l'étape 1.

La liste exhaustive est dans \`docs/MBOLO-EMOJI-MISSING.csv\`. La liste exploitable pour produire une illustration par concept de base est dans \`docs/MBOLO-EMOJI-MISSING-BASE.csv\` (${missingBase.length} lignes). Le suivi facial est dans \`docs/MBOLO-EMOJI-FACES.csv\` et la liste des ${faceMissing.length} visages restants dans \`docs/MBOLO-EMOJI-FACES-MISSING.csv\`.

Quelques exemples restants :

${missingBaseExamples}

## Génération d'images

Le générateur d'images de l'environnement a renvoyé **HTTP 403** : aucune nouvelle illustration n'a été générée. Les ${stats.artAssets} assets disponibles sont des optimisations/recadrages des illustrations 2D existantes ; ils ne prétendent pas couvrir les ${stats.totalSequences} séquences. Les ${stats.faces.humanIllustrated} portraits faciaux sont des têtes seules découpées et nettoyées depuis les stickers 2D, avec un dossier et des identifiers séparés. Les illustrations manquantes doivent être produites puis déclarées dans \`scripts/mbolo-emoji-art-map.json\`.

## Régénération

\`\`\`bash
cd mobile
npm run gen:emoji-catalog      # après mise à jour de emojibase-data
python3 scripts/build-mbolo-emoji-art.py
python3 scripts/build-mbolo-emoji-faces.py
npm run gen:mbolo-emoji
\`\`\`
`,
);

const csvHeader = 'categorie,sequence,cle,nom,variante,base,points_de_code\n';
const rowFor = (entry) =>
  [
    csvCell(groupLabel.get(entry.group) ?? entry.group),
    csvCell(entry.char),
    csvCell(entry.key),
    csvCell(entry.name),
    csvCell(entry.variantKind),
    csvCell(entry.variantOf ?? ''),
    entry.codePoints,
  ].join(',');
fs.writeFileSync(MISSING_CSV, csvHeader + fallback.map(rowFor).join('\n') + '\n');
fs.writeFileSync(MISSING_BASE_CSV, csvHeader + missingBase.map(rowFor).join('\n') + '\n');
fs.writeFileSync(FACES_CSV, faceCsvHeader + faceEntries.map(faceRowFor).join('\n') + '\n');
fs.writeFileSync(FACES_MISSING_CSV, faceCsvHeader + faceMissing.map(faceRowFor).join('\n') + '\n');

const replacedFaceKeys = illustratedFaces.map((entry) => entry.key);
const fallbackOldFaceKeys = oldFaceKeys.filter((key) => !replacedFaceKeys.includes(key));
fs.writeFileSync(
  FACES_MD,
  `# Visages MboloChat — étape 1

Généré le ${date} par \`scripts/build-mbolo-emoji-registry.mjs\`.

## Périmètre

- **${stats.faces.humanBase} visages de réaction humanoïdes** : sous-groupes Unicode face-smiling, face-affection, face-tongue, face-hand, face-neutral-skeptical, face-sleepy, face-unwell, face-hat, face-glasses, face-concerned, face-negative.
- **${stats.faces.costumeBase} face-costume + ${stats.faces.catBase} cat-face + ${stats.faces.monkeyBase} monkey-face** : visages hors périmètre pour cette étape, non modifiés.
- 25 cœurs et 15 émotions du groupe Smileys ne sont pas des visages ; ils ne sont pas concernés par cette étape.

## Prototype tête seule (${stats.faces.humanIllustrated})

| Emoji | Clé | Nom | Portrait | Source sticker |
| --- | --- | --- | --- | --- |
${facePrototypeRows}

Les portraits sont des fichiers séparés dans \`assets/emoji-faces/\` (96 px et 192 px WebP), et ne sont pas des stickers complets redimensionnés. Les stickers d'origine restent dans \`assets/stickers/mbolo-panther-2d/\`.

## Ancien état facial (audit)

Avant cette étape, **${oldFaceKeys.length} correspondances faciales** existaient, **toutes avec un sticker complet** (non conforme à la règle tête seule) :

- Clés : ${oldFaceKeys.map((key) => `\`${key}\``).join(', ')}.
- Illustrations stickers utilisées : ${oldFaceStickers.map((id) => `\`${id}\``).join(', ')}.
- ${replacedFaceKeys.length} clés sont remplacées par un portrait tête seule.
- ${fallbackOldFaceKeys.length} clés passent en repli Unicode : ${fallbackOldFaceKeys.map((key) => `\`${key}\``).join(', ')}.
- Aucun asset sticker n'a été supprimé.

## Reste à faire

- **${faceMissing.length} visages humanoïdes** sont encore en repli Unicode : \`docs/MBOLO-EMOJI-FACES-MISSING.csv\`.
- Le suivi complet des ${stats.faces.totalBase} visages (y compris costume/chat/singe) est dans \`docs/MBOLO-EMOJI-FACES.csv\`.
- Prototype validé le 2026-10-27 (recadrages tête seule). Suite : production par vagues selon \`docs/MBOLO-EMOJI-FACES-PLAN.md\` — ${faceMissing.length} visages restants.

## Méthode et limites

Le générateur d'images a renvoyé **HTTP 403** : aucun nouveau dessin n'a été généré. Les ${stats.faces.humanIllustrated} portraits sont des recadrages tête seule des expressions 2D existantes. Avec l'étape 1B, le cadrage est homogène et programmatique : contenu (tête + socle, ou détail expressif validé) à 86 % de la largeur du canevas carré, bas ancré à 83 %, centrage horizontal. Détails conservés quand ils portent la signification : larmes de rire et de chagrin, patte sous le menton (réflexion, endormi), goutte de sueur (fatigue), rougissement (timidité), Zzz du sommeil (endormi). \`face-choc\` garde ses oreilles déployées (marges latérales réduites au minimum source) ; \`face-endormi\` est extrait par un masque polygonal adouci qui épouse la tête couchée et retire le corps (canevas contraint par la hauteur : tête apparente à 72 % de largeur). Les fichiers sont séparés des stickers, en WebP avec alpha, sans rendu 3D ni halo blanc.

## Vérifications

\`\`\`bash
cd mobile
node --test tests/mboloEmojiFaces.test.mjs tests/emojiUtils.test.mjs tests/emojiSearch.test.mjs tests/mboloEmojiRegistry.test.mjs
npx tsc --noEmit
npx expo lint
\`\`\`
`,
);

console.log(`Registre : ${stats.totalSequences} séquences (${stats.baseEntries} base + ${stats.skinVariants} peaux)`);
console.log(`Illustrées : ${stats.illustrated} / ${stats.totalSequences} ; repli Unicode : ${stats.unicodeFallback}`);
console.log(`Visages : ${stats.faces.humanBase} humains (${stats.faces.humanIllustrated} portraits, ${stats.faces.humanFallback} repli) ; ${stats.faces.costumeBase} costume, ${stats.faces.catBase} chat, ${stats.faces.monkeyBase} singe hors périmètre`);
console.log(`Assets : ${stats.artAssets} disponibles (${stickerIds.length} stickers + ${faceIds.length} portraits), ${stats.mappedArtAssets} mappés, ${stats.sharedArtAssets} partagés`);
console.log(`Manquantes : ${missingBase.length} hors peau + ${missingSkins.length} variantes de peau`);
console.log(`Écrit : ${path.relative(ROOT, GEN_DATA)}`);
console.log(`Écrit : ${path.relative(ROOT, GEN_ASSETS)}`);
console.log(`Écrit : ${path.relative(ROOT, COVERAGE_MD)}`);
console.log(`Écrit : ${path.relative(ROOT, MISSING_CSV)}`);
console.log(`Écrit : ${path.relative(ROOT, MISSING_BASE_CSV)}`);
console.log(`Écrit : ${path.relative(ROOT, FACES_MD)}`);
console.log(`Écrit : ${path.relative(ROOT, FACES_CSV)}`);
console.log(`Écrit : ${path.relative(ROOT, FACES_MISSING_CSV)}`);
