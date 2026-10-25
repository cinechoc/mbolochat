import assert from 'node:assert/strict';
import test from 'node:test';

import { EMOJI_GROUPS } from '../src/features/emoji/emojiData.generated.ts';
import {
  normalizeEmojiSearch,
  searchEmojis,
} from '../src/features/emoji/emojiSearch.ts';

const fixture = [
  {
    id: 'smileys',
    label: 'Smileys',
    iconKey: '1f600',
    emojis: [
      {
        char: '❤️',
        key: '2764',
        name: 'cœur rouge',
        keywords: ['amour', 'cœur', 'sentiment', 'red heart'],
      },
      {
        char: '😀',
        key: '1f600',
        name: 'visage rieur',
        keywords: ['content', 'grand sourire', 'grinning face'],
      },
    ],
  },
  {
    id: 'flags',
    label: 'Drapeaux',
    iconKey: '1f3f3',
    iconChar: '🏳️',
    emojis: [
      {
        char: '🇫🇷',
        key: '1f1eb-1f1f7',
        name: 'drapeau : France',
        keywords: ['drapeau', 'france', 'flag: France'],
      },
    ],
  },
];

test('normalizeEmojiSearch : accents et ligatures', () => {
  assert.equal(normalizeEmojiSearch('  Cœur  ROUGE '), 'coeur rouge');
  assert.equal(normalizeEmojiSearch('Drapeau : France'), 'drapeau : france');
  assert.equal(normalizeEmojiSearch('Garçon'), 'garcon');
});

test('recherche : cœur sans accent et insensible à la casse', () => {
  const results = searchEmojis(fixture, 'COEUR');
  assert.equal(results[0]?.key, '2764');
});

test('recherche : drapeau par pays', () => {
  const results = searchEmojis(fixture, 'france');
  assert.equal(results[0]?.key, '1f1eb-1f1f7');
});

test('recherche : mots multiples, vide et sans résultat', () => {
  assert.equal(searchEmojis(fixture, 'visage sourire')[0]?.key, '1f600');
  assert.deepEqual(searchEmojis(fixture, '   '), []);
  assert.deepEqual(searchEmojis(fixture, 'introuvable'), []);
});

test('catalogue réel : les favoris de recherche sont présents', () => {
  const heart = searchEmojis(EMOJI_GROUPS, 'coeur');
  assert.ok(heart.some((emoji) => emoji.key === '2764'), 'cœur introuvable');

  const france = searchEmojis(EMOJI_GROUPS, 'france');
  assert.ok(france.some((emoji) => emoji.key === '1f1eb-1f1f7'), 'drapeau France introuvable');

  const flags = EMOJI_GROUPS.find((group) => group.id === 'flags');
  assert.ok(flags && flags.emojis.length >= 200, 'catégorie drapeaux absente');
});
