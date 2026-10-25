import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deleteBackward,
  emojiOnlyCount,
  insertAt,
  splitEmoji,
} from '../src/features/emoji/emojiUtils.ts';

test('splitEmoji : emoji simple', () => {
  assert.deepEqual(splitEmoji('😀'), [{ type: 'emoji', value: '😀', key: '1f600' }]);
});

test('splitEmoji : ton de peau', () => {
  assert.deepEqual(splitEmoji('👍🏽'), [
    { type: 'emoji', value: '👍🏽', key: '1f44d-1f3fd' },
  ]);
});

test('splitEmoji : séquence ZWJ', () => {
  assert.deepEqual(splitEmoji('👨‍👩‍👧'), [
    { type: 'emoji', value: '👨‍👩‍👧', key: '1f468-200d-1f469-200d-1f467' },
  ]);
});

test('splitEmoji : drapeau', () => {
  assert.deepEqual(splitEmoji('🇫🇷'), [
    { type: 'emoji', value: '🇫🇷', key: '1f1eb-1f1f7' },
  ]);
});

test('splitEmoji : clavier 1️⃣', () => {
  assert.deepEqual(splitEmoji('1️⃣'), [
    { type: 'emoji', value: '1️⃣', key: '31-20e3' },
  ]);
});

test('splitEmoji : texte sans emoji', () => {
  assert.deepEqual(splitEmoji('Bonjour'), [{ type: 'text', value: 'Bonjour' }]);
});

test('splitEmoji : texte mixte', () => {
  assert.deepEqual(splitEmoji('Bonjour 😀 !'), [
    { type: 'text', value: 'Bonjour ' },
    { type: 'emoji', value: '😀', key: '1f600' },
    { type: 'text', value: ' !' },
  ]);
});

test('emojiOnlyCount : 0 pour vide ou texte', () => {
  assert.equal(emojiOnlyCount(''), 0);
  assert.equal(emojiOnlyCount('   '), 0);
  assert.equal(emojiOnlyCount('Bonjour'), 0);
});

test('emojiOnlyCount : 1 à 3 emoji, y compris espacés', () => {
  assert.equal(emojiOnlyCount('😀'), 1);
  assert.equal(emojiOnlyCount('😀 😃'), 2);
  assert.equal(emojiOnlyCount('😀😃😄'), 3);
});

test('emojiOnlyCount : 4 emoji ou emoji + texte → 0', () => {
  assert.equal(emojiOnlyCount('😀😃😄😁'), 0);
  assert.equal(emojiOnlyCount('😀 salut'), 0);
});

test('insertAt : insertion au milieu', () => {
  assert.deepEqual(insertAt('bonjour', 3, 3, '😀'), { text: 'bon😀jour', cursor: 5 });
});

test('insertAt : remplace la sélection', () => {
  assert.deepEqual(insertAt('abcd', 1, 3, 'X'), { text: 'aXd', cursor: 2 });
});

test('insertAt : borne la sélection à la fin', () => {
  assert.deepEqual(insertAt('abc', 10, 10, 'Z'), { text: 'abcZ', cursor: 4 });
});

test('deleteBackward : supprime une paire de substitution entière', () => {
  assert.deepEqual(deleteBackward('a😀', 3, 3), { text: 'a', cursor: 1 });
});

test('deleteBackward : supprime un emoji composé ZWJ entier', () => {
  assert.deepEqual(deleteBackward('x👨‍👩‍👧', 9, 9), { text: 'x', cursor: 1 });
});

test('deleteBackward : supprime un ton de peau entier', () => {
  assert.deepEqual(deleteBackward('x👍🏽', 5, 5), { text: 'x', cursor: 1 });
});

test('deleteBackward : supprime la sélection', () => {
  assert.deepEqual(deleteBackward('abcdef', 1, 4), { text: 'aef', cursor: 1 });
});

test('deleteBackward : au début du texte', () => {
  assert.deepEqual(deleteBackward('abc', 0, 0), { text: 'abc', cursor: 0 });
});

test('deleteBackward : caractère simple', () => {
  assert.deepEqual(deleteBackward('abc', 3, 3), { text: 'ab', cursor: 2 });
});

test('deleteBackward : caractère après un emoji', () => {
  assert.deepEqual(deleteBackward('a😀b', 4, 4), { text: 'a😀', cursor: 3 });
});
