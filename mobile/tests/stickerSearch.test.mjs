import assert from 'node:assert/strict';
import test from 'node:test';

import { searchStickerEntries } from '../src/features/stickers/stickerSearch.ts';

const fixture = [
  { name: 'Amour', tags: ['panthère', 'coeur', 'love'] },
  { name: 'Fou rire', tags: ['panthère', 'rire', 'lol'] },
  { name: 'Pouce levé', tags: ['panthère', 'thumb up', 'bravo'] },
  { name: 'Mon chat', tags: ['personnel', 'photo'] },
];

test('recherche de sticker : accents et casse ignorés', () => {
  assert.deepEqual(
    searchStickerEntries(fixture, 'COEUR').map((entry) => entry.name),
    ['Amour'],
  );
  assert.deepEqual(
    searchStickerEntries(fixture, 'pouce leve').map((entry) => entry.name),
    ['Pouce levé'],
  );
});

test('recherche de sticker : plusieurs mots et identité panthère', () => {
  assert.deepEqual(
    searchStickerEntries(fixture, 'fou rire').map((entry) => entry.name),
    ['Fou rire'],
  );
  assert.equal(searchStickerEntries(fixture, 'panthere').length, 3);
});

test('recherche de sticker : requête vide et sans résultat', () => {
  assert.equal(searchStickerEntries(fixture, '   ').length, fixture.length);
  assert.deepEqual(searchStickerEntries(fixture, 'introuvable'), []);
});
