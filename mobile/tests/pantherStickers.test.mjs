import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { PANTHER_2D_STICKERS } from '../src/features/stickers/panther2dCatalog.generated.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packDir = resolve(here, '../assets/stickers/mbolo-panther-2d');
const legacyPackDir = resolve(here, '../assets/stickers/mbolo-panther');
const featuresDir = resolve(here, '../src/features/stickers');

const EXPECTED_IDS = [
  'bonjour',
  'salut',
  'au-revoir',
  'merci',
  'sil-te-plait',
  'ok',
  'oui',
  'non',
  'amour',
  'bisous',
  'calin',
  'je-taime',
  'fou-rire',
  'sourire',
  'tristesse',
  'chagrin',
  'colere',
  'surprise',
  'choc',
  'timidite',
  'reflexion',
  'confusion',
  'fatigue',
  'sommeil',
  'bonne-nuit',
  'fete',
  'bravo',
  'courage',
  'pouce-leve',
  'yeux-en-coeur',
];

test('la nouvelle collection contient exactement les 30 expressions demandées', () => {
  assert.equal(PANTHER_2D_STICKERS.length, 30);
  assert.deepEqual(
    PANTHER_2D_STICKERS.map((sticker) => sticker.id).sort(),
    [...EXPECTED_IDS].sort(),
  );
  assert.equal(new Set(PANTHER_2D_STICKERS.map((sticker) => sticker.id)).size, 30);
  assert.equal(new Set(PANTHER_2D_STICKERS.map((sticker) => sticker.name)).size, 30);
  for (const sticker of PANTHER_2D_STICKERS) {
    assert.ok(sticker.name.length > 0, `nom manquant pour ${sticker.id}`);
    assert.ok(sticker.tags.length >= 3, `mots-clés insuffisants pour ${sticker.id}`);
    assert.match(sticker.alt, /^Panthère Mbolo : /);
  }
});

test('le manifeste livré est identique au catalogue TypeScript', () => {
  const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, PANTHER_2D_STICKERS);
});

test('chaque sticker est un PNG 512×512 à vrai canal alpha, distinct et sans liseré blanc', async () => {
  const hashes = new Set();
  for (const sticker of PANTHER_2D_STICKERS) {
    const file = join(packDir, `${sticker.id}.png`);
    assert.ok(statSync(file).size > 0, `fichier absent : ${file}`);
    assert.ok(statSync(file).size < 100 * 1024, `fichier trop lourd : ${sticker.id}`);

    const meta = await sharp(file).metadata();
    assert.equal(meta.format, 'png', `${sticker.id} n'est pas un PNG`);
    assert.equal(meta.width, 512);
    assert.equal(meta.height, 512);
    assert.equal(meta.hasAlpha, true, `${sticker.id} doit avoir un canal alpha réel`);

    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];

    let transparent = 0;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] === 0) transparent += 1;
    }
    const ratio = transparent / (info.width * info.height);
    assert.ok(ratio > 0.2 && ratio < 0.9, `${sticker.id} : transparence douteuse (${ratio})`);

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
    let halo = 0;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const alpha = alphaAt(x, y);
        if (alpha > 8) {
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

    // Un pixel blanc opaque collé au fond trahirait un halo ou un reste de fond.
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const p = (y * info.width + x) * 4;
        if (data[p + 3] === 0) continue;
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];
        if (Math.min(r, g, b) < 235 || Math.max(r, g, b) - Math.min(r, g, b) > 12) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= info.width || ny >= info.height) continue;
          if (alphaAt(nx, ny) === 0) {
            halo += 1;
            break;
          }
        }
      }
    }
    assert.equal(halo, 0, `${sticker.id} : liseré blanc opaque au contact du fond`);

    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.equal(hashes.has(hash), false, `${sticker.id} duplique une autre illustration`);
    hashes.add(hash);
  }
});

test('chaque illustration est déclarée dans les sources Metro', () => {
  const sources = readFileSync(join(featuresDir, 'panther2dAssets.generated.ts'), 'utf8');
  for (const sticker of PANTHER_2D_STICKERS) {
    assert.ok(
      sources.includes(
        `'${sticker.id}': require('../../../assets/stickers/mbolo-panther-2d/${sticker.id}.png')`,
      ),
      `require manquant pour ${sticker.id}`,
    );
  }
});

test('le sélecteur expose le nouveau pack et conserve les anciennes références', () => {
  const catalog = readFileSync(join(featuresDir, 'stickerPacks.ts'), 'utf8');
  assert.match(catalog, /export const STICKER_PACKS: StickerPack\[\] = \[PANTHER_2D_PACK\];/);
  assert.match(catalog, /id: 'mbolo-panther-2d'/);
  assert.match(catalog, /const LEGACY_PANTHER_PACK/);
  assert.match(catalog, /id: 'mbolo-panther'/);
  assert.match(catalog, /const LEGACY_MBOLO_PACK/);
  assert.match(catalog, /id: 'mbolo'/);
  assert.match(catalog, /STICKER_INDEX\.get\(ref\) \?\? LEGACY_STICKER_INDEX\.get\(ref\)/);
});

test('les 26 illustrations historiques restent livrées pour les anciens messages', () => {
  const manifest = JSON.parse(readFileSync(join(legacyPackDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.length, 26);
  for (const sticker of manifest) {
    const file = join(legacyPackDir, `${sticker.id}.png`);
    assert.ok(existsSync(file), `ancien asset manquant : ${sticker.id}`);
    assert.ok(statSync(file).size > 0, `ancien asset vide : ${sticker.id}`);
  }
});
