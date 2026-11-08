import { describe, expect, it } from 'vitest';

import { createDraftQueue } from './draftQueue';

/** Laisse tourner quelques tours de boucle pour observer la file. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Écriture contrôlée : enregistre l'ordre des appels et ne se termine que
 * lorsque le test la libère, pour simuler une écriture SQLCipher lente.
 */
function controlledWriter() {
  const written: string[] = [];
  const gates: (() => void)[] = [];
  const write = (value: string) => {
    written.push(value);
    return new Promise<void>((resolve) => gates.push(resolve));
  };
  return {
    write,
    written,
    release: () => gates.shift()?.(),
    releaseAll: () => {
      while (gates.length > 0) gates.shift()?.();
    },
  };
}

describe('createDraftQueue — brouillons chiffrés', () => {
  it('une rafale de frappes aboutit à une seule écriture : la dernière valeur', async () => {
    const writer = controlledWriter();
    const queue = createDraftQueue(writer.write);
    queue.enable();

    queue.set('a');
    queue.set('ab');
    queue.set('abc');
    await tick();

    // Les valeurs intermédiaires n'écrasent pas la dernière saisie.
    expect(writer.written).toEqual(['abc']);
    writer.releaseAll();
    await queue.idle();
  });

  it('une écriture lente ne peut pas écraser une saisie plus récente', async () => {
    const writer = controlledWriter();
    const queue = createDraftQueue(writer.write);
    queue.enable();

    queue.set('a');
    await tick();
    expect(writer.written).toEqual(['a']); // 'a' est en vol

    queue.set('ab');
    queue.set('abc');
    writer.release(); // 'a' se termine après la saisie de 'abc'
    await tick();

    expect(writer.written).toEqual(['a', 'abc']);
    writer.releaseAll();
    await queue.idle();
    // Aucune écriture d'une valeur ancienne après la plus récente.
    expect(writer.written[writer.written.length - 1]).toBe('abc');
  });

  it("n'écrit rien avant le chargement du brouillon stocké", async () => {
    const writer = controlledWriter();
    const queue = createDraftQueue(writer.write);

    queue.set('brouillon');
    await tick();
    expect(writer.written).toEqual([]);
    expect(queue.pending()).toBe('brouillon');

    queue.enable();
    await tick();
    expect(writer.written).toEqual(['brouillon']);
    writer.releaseAll();
    await queue.idle();
  });

  it('le chargement ne réécrit pas le brouillon quand rien n’a été saisi', async () => {
    const writer = controlledWriter();
    const queue = createDraftQueue(writer.write);

    queue.enable();
    await queue.idle();
    // Restaurer un texte ne déclenche aucune sauvegarde.
    expect(writer.written).toEqual([]);
  });

  it('la dernière saisie gagne même après le vidage du champ', async () => {
    const writer = controlledWriter();
    const queue = createDraftQueue(writer.write);
    queue.enable();

    queue.set('texte');
    queue.set('');
    await tick();

    expect(writer.written).toEqual(['']);
    writer.releaseAll();
    await queue.idle();
  });

  it('une écriture en échec ne bloque pas les suivantes', async () => {
    const written: string[] = [];
    const write = (value: string) => {
      written.push(value);
      return value === 'ko' ? Promise.reject(new Error('write_failed')) : Promise.resolve();
    };
    const queue = createDraftQueue(write);
    queue.enable();

    queue.set('ko');
    await queue.idle();
    queue.set('ok');
    await queue.idle();

    expect(written).toEqual(['ko', 'ok']);
  });

  it('un long historique de frappes se termine toujours sur la dernière valeur', async () => {
    const writer = controlledWriter();
    const queue = createDraftQueue(writer.write);
    queue.enable();

    let text = '';
    for (let index = 0; index < 50; index += 1) {
      text += String.fromCharCode(97 + (index % 26));
      queue.set(text);
      // Libère les écritures au fil de l'eau, comme une base réelle.
      await tick();
      writer.releaseAll();
    }
    await tick();
    writer.releaseAll();
    await queue.idle();

    expect(writer.written[writer.written.length - 1]).toBe(text);
    expect(text.length).toBe(50);
  });
});
