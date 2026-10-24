import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fold,
  previousClusterIndex,
  toneVariant,
} from '../src/features/emoji/emoji-text.ts';
import {
  RECENTS_CAP,
  pushFavorite,
  pushRecent,
  removeFavorite,
} from '../src/features/emoji/emoji-history.ts';

test('pli : minuscules et accents retirés dans les deux sens', () => {
  assert.equal(fold('Café'), 'cafe');
  assert.equal(fold('Tête à l’Envers'), 'tete a l’envers');
  assert.equal(fold('BÊTE'), 'bete');
});

test('ton de peau : naturel, clair → foncé, garde-fous', () => {
  const plain = { u: '🐱' };
  assert.equal(toneVariant(plain, 3), '🐱');

  const hand = { u: '👋', s: ['👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'] };
  assert.equal(toneVariant(hand, 0), '👋');
  assert.equal(toneVariant(hand, 1), '👋🏻');
  assert.equal(toneVariant(hand, 3), '👋🏽');
  assert.equal(toneVariant(hand, 5), '👋🏿');
  // au-delà du nombre de variantes : on retombe sur la plus foncée, jamais une erreur
  assert.equal(toneVariant(hand, 99), '👋🏿');
  assert.equal(toneVariant({ u: '🧑', s: [] }, 2), '🧑');
});

test('⌫ supprime un caractère simple', () => {
  assert.equal(previousClusterIndex('bonjour', 7), 6);
  assert.equal(previousClusterIndex('bonjour', 1), 0);
  assert.equal(previousClusterIndex('bonjour', 0), 0);
});

test('⌫ supprime une famille composée d’un seul appui', () => {
  const family = '👨‍👩‍👦';
  assert.equal(previousClusterIndex(`ab${family}`, 9), 2);
  assert.equal(previousClusterIndex(family, 8), 0);
});

test('⌫ supprime un drapeau et un sous-drapeau entiers', () => {
  assert.equal(previousClusterIndex('🇫🇷', 4), 0);
  // 🏥 est une grappe différente qui suit : elle seule est supprimée
  assert.equal(previousClusterIndex('🇫🇷🏥', 6), 4);
  assert.equal(previousClusterIndex('🏴󠁧󠁢󠁥󠁮󠁧󠁿', 10), 0);
});

test('⌫ supprime un émoji à ton de peau suivi de ZWJ en un appui', () => {
  assert.equal(previousClusterIndex('👨🏻‍⚕️', 8), 0);
});

test('⌫ supprime une touche composée (1️⃣) en un appui', () => {
  assert.equal(previousClusterIndex('1️⃣', 3), 0);
});

test('⌫ en milieu de texte : seule la dernière grappe part', () => {
  // 'a b' + 👨‍👩‍👦 (10 unités) + 'c d' = 12 unités au total
  const text = 'ab👨‍👩‍👦cd';
  assert.equal(previousClusterIndex(text, 12), 11); // 'd' seul
  assert.equal(previousClusterIndex(text, 11), 10); // 'c' seul
  assert.equal(previousClusterIndex(text, 10), 2);  // la famille entière
  assert.equal(previousClusterIndex(text, 2), 1);
});

test('récents : dédoublonnés, uniques, bornés à 48', () => {
  let list = ['😀', '😂', '❤️'];
  list = pushRecent(list, '🚀');
  assert.deepEqual(list, ['🚀', '😀', '😂', '❤️']);
  list = pushRecent(list, '😀');
  assert.deepEqual(list, ['😀', '🚀', '😂', '❤️']);

  let grown = [];
  for (let i = 0; i < RECENTS_CAP + 10; i += 1) {
    grown = pushRecent(grown, `g${i}`);
  }
  assert.equal(grown.length, RECENTS_CAP);
  assert.equal(grown[0], `g${RECENTS_CAP + 9}`);
});

test('favoris : ajout borné puis retrait', () => {
  let list = ['😀'];
  list = [...pushFavorite(list, '😂')];
  assert.deepEqual(list, ['😀', '😂']);
  list = removeFavorite(list, '😀');
  assert.deepEqual(list, ['😂']);
  assert.deepEqual(removeFavorite(list, 'inconnu'), ['😂']);
});
