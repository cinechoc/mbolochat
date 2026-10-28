import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MBOLO_EMOJI_ENTRIES,
  MBOLO_EMOJI_STATS,
} from '../src/features/emoji/mboloEmojiData.generated.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'scripts/mbolo-emoji-face-sources.json'), 'utf8'));
const ART_MAP = JSON.parse(readFileSync(path.join(ROOT, 'scripts/mbolo-emoji-art-map.json'), 'utf8'));
const BY_KEY = new Map(MBOLO_EMOJI_ENTRIES.map((entry) => [entry.key, entry]));

const PROTOTYPE = {
  '1f642': 'face-sourire',
  '1f602': 'face-fou-rire',
  '1f62d': 'face-chagrin',
  '1f61e': 'face-tristesse',
  '1f620': 'face-colere',
  '1f62e': 'face-surprise',
  '1f631': 'face-choc',
  '1f60d': 'face-yeux-en-coeur',
  '1f914': 'face-reflexion',
  '1f633': 'face-timidite',
  '1f62a': 'face-fatigue',
  '1f634': 'face-endormi',
  '1f615': 'face-confusion',
  '1f618': 'face-bisous',
  '1f973': 'face-fete',
  '1f60a': 'face-yeux-rieurs',
  '1f605': 'face-pardon',
  '1f632': 'face-stupefait',
  '1f971': 'face-baillement',
  '1f928': 'face-quoi',
  '1f60b': 'face-miam',
  '1f621': 'face-grrr',
  '1f612': 'face-bof',
  '1f617': 'face-bisou-leger',
  '1f60c': 'face-chill',
  '1f917': 'face-calin-ouvert',
};

const OLD_FACE_KEYS = [
  '1f600', '1f601', '1f602', '1f603', '1f604', '1f606', '1f60a', '1f60d',
  '1f615', '1f618', '1f61e', '1f620', '1f621', '1f622', '1f628', '1f629',
  '1f62a', '1f62b', '1f62d', '1f62e', '1f631', '1f633', '1f634', '1f642',
  '1f914', '1f917', '1f923', '1f929', '1f970', '1f973', '1f97a',
];

const OLD_FACE_STICKERS = [
  'sourire', 'fou-rire', 'yeux-en-coeur', 'confusion', 'bisous', 'tristesse',
  'colere', 'choc', 'fatigue', 'sommeil', 'chagrin', 'surprise', 'timidite',
  'reflexion', 'calin', 'fete', 'sil-te-plait',
];

test('le périmètre facial et les comptes sont exacts', () => {
  assert.equal(MBOLO_EMOJI_STATS.faces.totalBase, 132);
  assert.equal(MBOLO_EMOJI_STATS.faces.totalSequences, 132);
  assert.equal(MBOLO_EMOJI_STATS.faces.humanBase, 112);
  assert.equal(MBOLO_EMOJI_STATS.faces.humanSequences, 112);
  assert.equal(MBOLO_EMOJI_STATS.faces.humanIllustrated, 110);
  assert.equal(MBOLO_EMOJI_STATS.faces.humanFallback, 2);
  assert.equal(MBOLO_EMOJI_STATS.faces.costumeBase, 8);
  assert.equal(MBOLO_EMOJI_STATS.faces.catBase, 9);
  assert.equal(MBOLO_EMOJI_STATS.faces.monkeyBase, 3);

  const human = MBOLO_EMOJI_ENTRIES.filter((entry) => entry.faceKind === 'human');
  assert.equal(human.length, 112);
  assert.equal(human.filter((entry) => entry.coverage === 'illustrated').length, 110);
  assert.equal(human.filter((entry) => entry.coverage === 'unicode-fallback').length, 2);
});

test('les 110 portraits utilisent uniquement des portraits tête seule', () => {
  assert.equal(Object.keys(PROTOTYPE).length, 26);
  assert.equal(MANIFEST.length, 105);
  const manifestById = new Map(MANIFEST.map((face) => [face.id, face]));

  for (const [key, artId] of Object.entries(PROTOTYPE)) {
    const entry = BY_KEY.get(key);
    assert.ok(entry, `visage absent : ${key}`);
    assert.equal(entry.faceKind, 'human');
    assert.equal(entry.coverage, 'illustrated');
    assert.equal(entry.artId, artId);
    assert.ok(artId.startsWith('face-'));
    assert.ok(manifestById.has(artId), `portrait absent du manifeste : ${artId}`);
    assert.ok(
      readFileSync(path.join(ROOT, 'assets/emoji-faces', `${artId}.webp`)).length > 0,
      `portrait 96 px manquant : ${artId}`,
    );
    assert.ok(
      readFileSync(path.join(ROOT, 'assets/emoji-faces/large', `${artId}.webp`)).length > 0,
      `portrait 192 px manquant : ${artId}`,
    );
  }

  const faceFiles = readdirSync(path.join(ROOT, 'assets/emoji-faces')).filter((name) => name.endsWith('.webp'));
  assert.equal(faceFiles.length, 105);
  for (const id of Object.keys(PROTOTYPE).map((key) => PROTOTYPE[key])) {
    assert.ok(faceFiles.includes(`${id}.webp`));
  }
});

test('aucun visage ne réutilise un sticker entier', () => {
  const faceEntries = MBOLO_EMOJI_ENTRIES.filter((entry) => entry.faceKind);
  assert.equal(faceEntries.length, 132);

  for (const entry of faceEntries) {
    if (entry.artId) {
      assert.ok(entry.artId.startsWith('face-'), `${entry.key} utilise ${entry.artId}`);
    }
  }

  for (const key of OLD_FACE_KEYS) {
    const entry = BY_KEY.get(key);
    assert.ok(entry, `ancienne clé faciale absente : ${key}`);
    assert.ok(entry.artId === null || entry.artId.startsWith('face-'), `${key} utilise ${entry.artId}`);
    assert.ok(!OLD_FACE_STICKERS.includes(entry.artId), `${key} réutilise le sticker ${entry.artId}`);
  }

  const replaced = OLD_FACE_KEYS.filter((key) => BY_KEY.get(key)?.artId?.startsWith('face-'));
  const fallback = OLD_FACE_KEYS.filter((key) => BY_KEY.get(key)?.artId === null);
  assert.equal(replaced.length, 31);
  assert.equal(fallback.length, 0);
});

test('les anciens stickers restent disponibles mais séparés', () => {
  const stickerFiles = readdirSync(path.join(ROOT, 'assets/mbolo-emoji')).filter((name) => name.endsWith('.webp'));
  assert.equal(stickerFiles.length, 30);
  for (const sticker of OLD_FACE_STICKERS) {
    assert.ok(stickerFiles.includes(`${sticker}.webp`), `sticker historique supprimé : ${sticker}`);
  }

  // Les stickers peuvent encore illustrer des catégories non faciales.
  assert.equal(BY_KEY.get('1f389')?.artId, 'fete');
  assert.equal(BY_KEY.get('1f64b')?.artId, 'salut');
});

test('les visages hors périmètre ne sont pas modifiés et restent en repli', () => {
  for (const kind of ['costume', 'cat', 'monkey']) {
    const entries = MBOLO_EMOJI_ENTRIES.filter((entry) => entry.faceKind === kind);
    assert.ok(entries.length > 0, kind);
    for (const entry of entries) {
      assert.equal(entry.coverage, 'unicode-fallback', `${kind}/${entry.key}`);
      assert.equal(entry.artId, null, `${kind}/${entry.key}`);
    }
  }
});

test('le mapping facial reste conforme et les assets sont présents', () => {
  for (const [key, artId] of Object.entries(ART_MAP)) {
    if (!artId.startsWith('face-')) continue;
    assert.ok(BY_KEY.get(key)?.faceKind === 'human', `portrait non facial : ${key}`);
    assert.equal(BY_KEY.get(key)?.artId, artId);
    assert.ok(readFileSync(path.join(ROOT, 'assets/emoji-faces', `${artId}.webp`)).length > 0);
  }
});
