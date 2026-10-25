import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { PANTHER_STICKERS } from '../src/features/stickers/pantherCatalog.generated.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packDir = resolve(here, '../assets/stickers/mbolo-panther');
const featuresDir = resolve(here, '../src/features/stickers');

const EXPECTED_IDS = [
  'bonjour',
  'salut',
  'merci',
  'sil-te-plait',
  'ok',
  'oui',
  'non',
  'amour',
  'bisou',
  'calin',
  'joie',
  'fou-rire',
  'tristesse',
  'pleurs',
  'colere',
  'surprise',
  'choc',
  'timidite',
  'sommeil',
  'fatigue',
  'reflexion',
  'confusion',
  'fete',
  'encouragement',
  'pouce-leve',
  'au-revoir',
];

test('la collection contient les 26 expressions demandées', () => {
  assert.equal(PANTHER_STICKERS.length, 26);
  assert.deepEqual(PANTHER_STICKERS.map((sticker) => sticker.id).sort(), [...EXPECTED_IDS].sort());
  assert.equal(new Set(PANTHER_STICKERS.map((sticker) => sticker.id)).size, 26);
  assert.equal(new Set(PANTHER_STICKERS.map((sticker) => sticker.name)).size, 26);
  for (const sticker of PANTHER_STICKERS) {
    assert.ok(sticker.name.length > 0, `nom manquant pour ${sticker.id}`);
    assert.ok(sticker.tags.length >= 3, `mots-clés insuffisants pour ${sticker.id}`);
    assert.match(sticker.alt, /^Panthère Mbolo : /);
  }
});

test('le manifeste livré est identique au catalogue TypeScript', () => {
  const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, PANTHER_STICKERS);
});

test('chaque sticker est un PNG 512×512 transparent, valide et distinct', async () => {
  const hashes = new Set();
  for (const sticker of PANTHER_STICKERS) {
    const file = join(packDir, `${sticker.id}.png`);
    assert.ok(statSync(file).size > 0, `fichier absent : ${file}`);
    assert.ok(statSync(file).size < 100 * 1024, `fichier trop lourd : ${sticker.id}`);

    const meta = await sharp(file).metadata();
    assert.equal(meta.format, 'png', `${sticker.id} n'est pas un PNG`);
    assert.equal(meta.width, 512);
    assert.equal(meta.height, 512);
    assert.equal(meta.hasAlpha, true, `${sticker.id} doit avoir de la transparence`);

    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
    for (const [x, y] of [
      [0, 0],
      [info.width - 1, 0],
      [0, info.height - 1],
      [info.width - 1, info.height - 1],
    ]) {
      assert.equal(alphaAt(x, y), 0, `${sticker.id} : coin non transparent`);
    }
    assert.ok(alphaAt(info.width / 2, info.height / 2) > 0, `${sticker.id} : personnage invisible`);

    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        if (alphaAt(x, y) > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    for (const margin of [minX, minY, info.width - 1 - maxX, info.height - 1 - maxY]) {
      assert.ok(margin >= 8, `${sticker.id} : marge transparente insuffisante`);
    }

    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.equal(hashes.has(hash), false, `${sticker.id} duplique une autre illustration`);
    hashes.add(hash);
  }
});

test('chaque illustration est déclarée dans les sources Metro', () => {
  const sources = readFileSync(join(featuresDir, 'pantherAssets.generated.ts'), 'utf8');
  for (const sticker of PANTHER_STICKERS) {
    assert.ok(
      sources.includes(
        `'${sticker.id}': require('../../../assets/stickers/mbolo-panther/${sticker.id}.png')`,
      ),
      `require manquant pour ${sticker.id}`,
    );
  }
});

test('le rendu reste 2D, sans halo blanc ni dégradés de figurine', () => {
  const script = readFileSync(resolve(here, '../scripts/generate-panther-stickers.mjs'), 'utf8');
  assert.equal(script.includes('feMorphology'), false);
  assert.equal(script.includes('id="halo"'), false);
  assert.equal(script.includes('<linearGradient'), false);
  assert.equal(script.includes('<radialGradient'), false);
  assert.equal(script.includes('stroke="#FFF9F2"'), false);
});

test('les anciennes références restent résolues hors du sélecteur', () => {
  const catalog = readFileSync(join(featuresDir, 'stickerPacks.ts'), 'utf8');
  assert.match(catalog, /export const STICKER_PACKS: StickerPack\[\] = \[PANTHER_PACK\];/);
  assert.match(catalog, /const LEGACY_MBOLO_PACK/);
  assert.match(catalog, /id: 'mbolo'/);
  assert.match(catalog, /id: 'merci'/);
  assert.match(catalog, /STICKER_INDEX\.get\(ref\) \?\? LEGACY_STICKER_INDEX\.get\(ref\)/);
});
