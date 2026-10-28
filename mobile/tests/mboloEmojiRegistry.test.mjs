import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MBOLO_EMOJI_ENTRIES,
  MBOLO_EMOJI_GROUP_META,
  MBOLO_EMOJI_SOURCE,
  MBOLO_EMOJI_STATS,
  MBOLO_EMOJI_VERSION,
} from '../src/features/emoji/mboloEmojiData.generated.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');
const ART_MAP = JSON.parse(readFileSync(path.join(ROOT, 'scripts/mbolo-emoji-art-map.json'), 'utf8'));
const ENTRIES_BY_KEY = new Map(MBOLO_EMOJI_ENTRIES.map((entry) => [entry.key, entry]));

function keyOf(sequence) {
  return [...sequence.replace(/\uFE0F/g, '')]
    .map((char) => char.codePointAt(0).toString(16))
    .join('-');
}

test('le registre couvre exactement l’inventaire Emoji 18.0', () => {
  assert.equal(MBOLO_EMOJI_VERSION, '18.0');
  assert.equal(MBOLO_EMOJI_SOURCE.version, '18.0.0');
  assert.equal(MBOLO_EMOJI_STATS.baseEntries, 1923);
  assert.equal(MBOLO_EMOJI_STATS.skinVariants, 1660);
  assert.equal(MBOLO_EMOJI_STATS.totalSequences, 3583);
  assert.equal(MBOLO_EMOJI_STATS.distinctKeys, 3583);
  assert.equal(MBOLO_EMOJI_STATS.illustrated, 123);
  assert.equal(MBOLO_EMOJI_STATS.unicodeFallback, 3460);
  assert.equal(MBOLO_EMOJI_STATS.artAssets, 135);
  assert.equal(MBOLO_EMOJI_STATS.mappedArtAssets, 117);
  assert.equal(MBOLO_EMOJI_STATS.sharedArtAssets, 5);
  assert.equal(MBOLO_EMOJI_STATS.sharedIllustrations, 11);
  assert.equal(MBOLO_EMOJI_STATS.variantKinds['skin-tone'], 1660);
  assert.deepEqual(MBOLO_EMOJI_STATS.faces, {
    totalBase: 132,
    totalSequences: 132,
    humanBase: 112,
    humanSequences: 112,
    humanIllustrated: 110,
    humanFallback: 2,
    costumeBase: 8,
    costumeSequences: 8,
    catBase: 9,
    catSequences: 9,
    monkeyBase: 3,
    monkeySequences: 3,
  });
  assert.equal(MBOLO_EMOJI_ENTRIES.length, MBOLO_EMOJI_STATS.totalSequences);
});

test('chaque séquence a un état de couverture et un visage cohérents', () => {
  const sequences = new Set();
  const keys = new Set();
  const groupIds = new Set(MBOLO_EMOJI_GROUP_META.map((group) => group.id));
  const faceKinds = new Set([null, 'human', 'costume', 'cat', 'monkey']);

  for (const entry of MBOLO_EMOJI_ENTRIES) {
    assert.ok(entry.char.length > 0);
    assert.ok(entry.key.length > 0);
    assert.ok(entry.name.length > 0);
    assert.ok(groupIds.has(entry.group), `groupe inconnu : ${entry.group}`);
    assert.ok(entry.coverage === 'illustrated' || entry.coverage === 'unicode-fallback');
    assert.equal(Boolean(entry.artId), entry.coverage === 'illustrated');
    assert.equal(entry.codePoints, Array.from(entry.char).length);
    assert.equal(entry.key, keyOf(entry.char));
    assert.equal(entry.variantKind === 'skin-tone', entry.variantOf !== null);
    assert.ok(faceKinds.has(entry.faceKind), `faceKind inconnu : ${entry.faceKind}`);
    if (entry.faceKind) {
      assert.ok(entry.faceSubgroup, `sous-groupe facial absent : ${entry.key}`);
      if (entry.artId) {
        assert.ok(entry.artId.startsWith('face-'), `visage illustré par un sticker : ${entry.key}`);
      }
    }
    if (entry.artId?.startsWith('face-')) {
      assert.equal(entry.faceKind, 'human', `portrait facial hors visage : ${entry.key}`);
    }
    if (entry.coverage === 'unicode-fallback') {
      assert.equal(entry.sharedArt, false);
    }
    assert.ok(!sequences.has(entry.char), `séquence dupliquée : ${entry.char}`);
    assert.ok(!keys.has(entry.key), `clé dupliquée : ${entry.key}`);
    sequences.add(entry.char);
    keys.add(entry.key);
  }

  assert.equal(sequences.size, 3583);
  assert.equal(keys.size, 3583);
});

test('les séquences composées, variantes et prototypes faciaux sont cohérents', () => {
  const expected = {
    '1f602': { artId: 'face-fou-rire', variant: 'base' },
    '1f642': { artId: 'face-sourire', variant: 'base' },
    '1f62a': { artId: 'face-fatigue', variant: 'base' },
    '1f634': { artId: 'face-endormi', variant: 'base' },
    '2764': { artId: 'amour', variant: 'base' },
    '1f44d-1f3fd': { artId: null, variant: 'skin-tone', base: '1f44d' },
    '1f468-200d-1f469-200d-1f467': { artId: null, variant: 'zwj' },
    '1f1eb-1f1f7': { artId: null, variant: 'flag' },
    '31-20e3': { artId: null, variant: 'keycap' },
    '1fae0': { artId: 'face-fond', variant: 'base' },
    '1f622': { artId: 'face-pleure', variant: 'base' },
    '1f973': { artId: 'face-fete', variant: 'base' },
    '1f917': { artId: 'face-calin-ouvert', variant: 'base' },
    '1f600': { artId: 'face-rieur', variant: 'base' },
  };

  for (const [key, values] of Object.entries(expected)) {
    const entry = ENTRIES_BY_KEY.get(key);
    assert.ok(entry, `séquence absente : ${key}`);
    assert.equal(entry.artId, values.artId, key);
    assert.equal(entry.variantKind, values.variant, key);
    if (values.base) assert.equal(entry.variantOf, values.base, key);
  }
});

test('le mapping artistique sépare portraits faciaux et stickers', () => {
  assert.equal(Object.keys(ART_MAP).length, 123);
  assert.equal(new Set(Object.values(ART_MAP)).size, 117);

  for (const [key, artId] of Object.entries(ART_MAP)) {
    const entry = ENTRIES_BY_KEY.get(key);
    assert.ok(entry, `clé mappée absente du registre : ${key}`);
    assert.equal(entry.coverage, 'illustrated');
    assert.equal(entry.artId, artId);
    const dir = artId.startsWith('face-')
      ? path.join(ROOT, 'assets/emoji-faces')
      : path.join(ROOT, 'assets/mbolo-emoji');
    assert.ok(readFileSync(path.join(dir, `${artId}.webp`)).length > 0, `asset 96 px manquant : ${artId}`);
    assert.ok(
      readFileSync(path.join(dir, 'large', `${artId}.webp`)).length > 0,
      `asset 192 px manquant : ${artId}`,
    );
  }

  for (const entry of MBOLO_EMOJI_ENTRIES.filter((item) => item.artId)) {
    assert.equal(ART_MAP[entry.key], entry.artId, `mapping incohérent : ${entry.key}`);
  }

  const stickerFiles = readdirSync(path.join(ROOT, 'assets/mbolo-emoji')).filter((name) => name.endsWith('.webp'));
  const faceFiles = readdirSync(path.join(ROOT, 'assets/emoji-faces')).filter((name) => name.endsWith('.webp'));
  assert.equal(stickerFiles.length, 30);
  assert.equal(faceFiles.length, 105);
  assert.ok(stickerFiles.includes('au-revoir.webp'), 'asset sticker non mappé attendu');
});

test('les rapports de couverture et les listes faciales sont complets', () => {
  const lines = (file) => readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines(path.join(REPO, 'docs/MBOLO-EMOJI-MISSING.csv')).length - 1, 3460);
  assert.equal(lines(path.join(REPO, 'docs/MBOLO-EMOJI-MISSING-BASE.csv')).length - 1, 1800);
  assert.equal(lines(path.join(REPO, 'docs/MBOLO-EMOJI-FACES.csv')).length - 1, 132);
  assert.equal(lines(path.join(REPO, 'docs/MBOLO-EMOJI-FACES-MISSING.csv')).length - 1, 2);

  const missing = readFileSync(path.join(REPO, 'docs/MBOLO-EMOJI-MISSING.csv'), 'utf8');
  assert.ok(missing.includes('"🦄"'), 'la licorne manquante doit être listée');
  assert.ok(missing.includes('"👍🏽"'), 'la variante de peau manquante doit être listée');

  const faces = readFileSync(path.join(REPO, 'docs/MBOLO-EMOJI-FACES.csv'), 'utf8');
  assert.ok(faces.includes('"😭"') && faces.includes('face-chagrin'));
  assert.ok(faces.includes('"💀"') && faces.includes('unicode-fallback'));
  const faceMissing = readFileSync(path.join(REPO, 'docs/MBOLO-EMOJI-FACES-MISSING.csv'), 'utf8');
  assert.ok(faceMissing.includes('"💀"'));
  assert.ok(!faceMissing.includes('face-chagrin'));

  const coverage = readFileSync(path.join(REPO, 'docs/MBOLO-EMOJI-COVERAGE.md'), 'utf8');
  assert.match(coverage, /Emoji 18\.0/);
  assert.match(coverage, /3583/);
  assert.match(coverage, /3460/);
  assert.match(coverage, /HTTP 403/);

  const faceDoc = readFileSync(path.join(REPO, 'docs/MBOLO-EMOJI-FACES.md'), 'utf8');
  assert.match(faceDoc, /112 visages/);
  assert.match(faceDoc, /2 visages/);
  assert.match(faceDoc, /31 correspondances faciales/);
  assert.match(faceDoc, /Prototype tête seule \(110\)/);
  assert.match(faceDoc, /17/);
  assert.match(faceDoc, /HTTP 403/);
});
