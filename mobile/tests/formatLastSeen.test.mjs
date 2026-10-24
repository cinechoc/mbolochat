import assert from 'node:assert/strict';
import test from 'node:test';

import { formatLastSeen } from '../src/features/presence/formatLastSeen.ts';

const at = (year, month, day, hour, minute, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second);

test('en ligne prioritaire', () => {
  assert.equal(formatLastSeen(null, at(2026, 10, 23, 12, 0), true), 'en ligne');
});

test('aucune donnée', () => {
  assert.equal(formatLastSeen(null, at(2026, 10, 23, 12, 0)), '');
  assert.equal(formatLastSeen(undefined, at(2026, 10, 23, 12, 0)), '');
  assert.equal(formatLastSeen('invalide', at(2026, 10, 23, 12, 0)), '');
});

test('moins d’une minute et limite 59 s / 60 s', () => {
  const now = at(2026, 10, 23, 12, 0);
  assert.equal(formatLastSeen(at(2026, 10, 23, 11, 59, 1), now), "vu à l'instant");
  assert.equal(formatLastSeen(at(2026, 10, 23, 11, 59, 0), now), 'vu il y a 1 min');
  assert.equal(formatLastSeen(at(2026, 10, 23, 11, 0, 1), now), 'vu il y a 59 min');
  assert.equal(formatLastSeen(at(2026, 10, 23, 11, 0, 0), now), 'vu il y a 1 h');
});

test('heures relatives jusqu’à 5 h 59', () => {
  const now = at(2026, 10, 23, 12, 0);
  assert.equal(formatLastSeen(at(2026, 10, 23, 7, 0, 1), now), 'vu il y a 4 h');
  assert.equal(formatLastSeen(at(2026, 10, 23, 6, 0, 1), now), 'vu il y a 5 h');
  assert.equal(formatLastSeen(at(2026, 10, 23, 6, 0, 0), now), "vu aujourd'hui à 06:00");
});

test('6 h aujourd’hui et 6 h en franchissant minuit', () => {
  assert.equal(
    formatLastSeen(at(2026, 10, 23, 14, 0), at(2026, 10, 23, 20, 0)),
    "vu aujourd'hui à 14:00",
  );
  assert.equal(
    formatLastSeen(at(2026, 10, 22, 20, 0), at(2026, 10, 23, 2, 0)),
    'vu hier à 20:00',
  );
});

test('hier et changement de jour à minuit', () => {
  assert.equal(
    formatLastSeen(at(2026, 10, 22, 14, 32), at(2026, 10, 23, 15, 0)),
    'vu hier à 14:32',
  );
  assert.equal(
    formatLastSeen(at(2026, 10, 22, 23, 50), at(2026, 10, 23, 0, 10)),
    'vu il y a 20 min',
  );
});

test('2 à 6 jours : jour de la semaine en toutes lettres', () => {
  // 2026-10-23 est un vendredi ; 21 octobre = mercredi, 17 octobre = samedi.
  assert.equal(
    formatLastSeen(at(2026, 10, 21, 14, 32), at(2026, 10, 23, 12, 0)),
    'vu mercredi à 14:32',
  );
  assert.equal(
    formatLastSeen(at(2026, 10, 17, 14, 32), at(2026, 10, 23, 12, 0)),
    'vu samedi à 14:32',
  );
  assert.equal(
    formatLastSeen(at(2026, 10, 16, 14, 32), at(2026, 10, 23, 12, 0)),
    'vu le 16/10/2026',
  );
});

test('ancien : date complète avec zéros', () => {
  assert.equal(
    formatLastSeen(at(2026, 3, 3, 9, 5), at(2026, 10, 23, 12, 0)),
    'vu le 03/03/2026',
  );
});

test('date future tolérée comme instant', () => {
  assert.equal(
    formatLastSeen(at(2026, 10, 23, 12, 5), at(2026, 10, 23, 12, 0)),
    "vu à l'instant",
  );
});
