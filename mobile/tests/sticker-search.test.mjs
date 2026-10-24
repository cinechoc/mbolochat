import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findStickerMatches,
  foldStickerText,
} from '../src/features/stickers/sticker-search.ts';

const STICKERS = [
  { id: '1', name: 'Café', tags: ['pause', 'réveil', 'coffee'] },
  { id: '2', name: 'Fou rire', tags: ['rire', 'mdr'] },
  { id: '3', name: 'Chat câlin', tags: ['minou', 'mignon'] },
  { id: '4', name: 'Cœur', tags: ['amour', 'love'] },
];

test('pli : accents, ligatures et casse sont neutralisés', () => {
  assert.equal(foldStickerText('  Café  '), 'cafe');
  assert.equal(foldStickerText('CŒUR'), 'coeur');
  assert.equal(foldStickerText('En colère'), 'en colere');
});

test('recherche par nom, mot-clé et sans accent', () => {
  assert.deepEqual(
    findStickerMatches(STICKERS, 'cafe').map((sticker) => sticker.id),
    ['1'],
  );
  assert.deepEqual(
    findStickerMatches(STICKERS, 'MDR').map((sticker) => sticker.id),
    ['2'],
  );
  assert.deepEqual(
    findStickerMatches(STICKERS, 'coeur').map((sticker) => sticker.id),
    ['4'],
  );
});

test('recherche vide et plafond de résultats', () => {
  assert.deepEqual(findStickerMatches(STICKERS, '   '), []);
  assert.equal(findStickerMatches(STICKERS, 'a', 2).length, 2);
});
