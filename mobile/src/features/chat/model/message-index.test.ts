import { describe, expect, it } from 'vitest';

import { fullSort, type MergeableMessage } from './merge';
import { MessageIndex } from './message-index';

interface Item extends MergeableMessage {
  body: string;
}

const item = (id: string, createdAt: string, body = ''): Item => ({
  id,
  clientId: null,
  createdAt,
  body,
});

/** Générateur déterministe (LCG) : mêmes séquences à chaque exécution. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

describe('MessageIndex', () => {
  it('insère dans l’ordre chronologique et remplace par identifiant', () => {
    const index = new MessageIndex<Item>();
    index.upsert(item('b', '2026-01-01T00:00:02.000Z', 'deux'));
    index.upsert(item('a', '2026-01-01T00:00:01.000Z', 'un'));
    index.upsert(item('b', '2026-01-01T00:00:03.000Z', 'deux bis'));
    expect(index.values().map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(index.get('b')?.body).toBe('deux bis');
  });

  it('respecte l’ordre d’insertion pour des horodatages égaux', () => {
    const index = new MessageIndex<Item>();
    index.upsert(item('a', '2026-01-01T00:00:01.000Z'));
    index.upsert(item('b', '2026-01-01T00:00:01.000Z'));
    index.upsert(item('c', '2026-01-01T00:00:01.000Z'));
    expect(index.values().map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('retire un message et signale les identifiants inconnus', () => {
    const index = new MessageIndex<Item>([item('a', '2026-01-01T00:00:01.000Z')]);
    expect(index.remove('a')).toBe(true);
    expect(index.remove('a')).toBe(false);
    expect(index.size).toBe(0);
  });

  it('équivaut à un tri complet après une séquence aléatoire d’upserts', () => {
    const random = lcg(20261113);
    const index = new MessageIndex<Item>();
    const latest = new Map<string, Item>();
    for (let step = 0; step < 400; step += 1) {
      const id = `m-${random() % 40}`;
      const second = random() % 50;
      const value = item(id, `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`, `étape ${step}`);
      index.upsert(value);
      latest.set(id, value);
      if (step % 25 === 24) {
        const expected = fullSort([...latest.values()]);
        // Même ensemble d'identifiants ; l'ordre exact des horodatages égaux
        // n'est pas une garantie du modèle (tri stable côté référence).
        expect([...index.values()].map((entry) => entry.id).sort()).toEqual(
          expected.map((entry) => entry.id).sort(),
        );
        const times = index.values().map((entry) => entry.createdAt);
        expect(times).toEqual([...times].sort());
      }
    }
  });

  it('équivaut à un tri complet après des suppressions', () => {
    const random = lcg(42);
    const index = new MessageIndex<Item>();
    const latest = new Map<string, Item>();
    for (let step = 0; step < 120; step += 1) {
      const id = `m-${random() % 20}`;
      index.upsert(item(id, `2026-01-01T00:00:${String(random() % 30).padStart(2, '0')}.000Z`));
      latest.set(id, index.get(id) as Item);
      if (step % 10 === 9) {
        const victim = `m-${random() % 20}`;
        index.remove(victim);
        latest.delete(victim);
        expect([...index.values()].map((entry) => entry.id).sort()).toEqual(
          fullSort([...latest.values()])
            .map((entry) => entry.id)
            .sort(),
        );
      }
    }
  });

  it('conserve des horodatages non décroissants après chaque insertion', () => {
    const random = lcg(7);
    const index = new MessageIndex<Item>();
    for (let step = 0; step < 200; step += 1) {
      index.upsert(
        item(`m-${step}`, `2026-01-01T00:00:${String(random() % 60).padStart(2, '0')}.000Z`),
      );
    }
    const times = index.values().map((entry) => entry.createdAt);
    expect(times).toEqual([...times].sort());
  });
});
