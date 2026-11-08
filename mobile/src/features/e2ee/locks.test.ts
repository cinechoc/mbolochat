import { describe, expect, it } from 'vitest';

import {
  olmLockId,
  pendingAccountLocks,
  pendingOlmLocks,
  withAccountLock,
  withOlmLock,
} from './locks';

const session = { accountId: 'acc', peerUserId: 'peer-1', peerDeviceId: 'dev-1' };

/** Laisse tourner quelques tours de boucle pour observer l'état des tâches. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('withOlmLock — sérialisation par (compte, pair, appareil)', () => {
  it('deux opérations concurrentes sur la même session sont sérialisées', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withOlmLock(session, async () => {
      order.push('a:début');
      await firstGate;
      order.push('a:fin');
    });
    const second = withOlmLock(session, async () => {
      order.push('b:début');
      order.push('b:fin');
    });

    await tick();
    // La seconde tâche n'a pas commencé : elle attend la première.
    expect(order).toEqual(['a:début']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['a:début', 'a:fin', 'b:début', 'b:fin']);
  });

  it('deux sessions distinctes ne se bloquent pas', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const other = { ...session, peerDeviceId: 'dev-2' };
    const first = withOlmLock(session, async () => {
      order.push('session-1:début');
      await firstGate;
      order.push('session-1:fin');
    });
    await tick();

    // Autre appareil : doit pouvoir avancer alors que la première est bloquée.
    await withOlmLock(other, async () => {
      order.push('session-2:fin');
    });
    expect(order).toEqual(['session-1:début', 'session-2:fin']);

    releaseFirst();
    await first;
    expect(order).toEqual(['session-1:début', 'session-2:fin', 'session-1:fin']);
  });

  it('une tâche en échec libère la place sans bloquer la suivante', async () => {
    await expect(
      withOlmLock(session, async () => {
        throw new Error('échec du chiffrement');
      }),
    ).rejects.toThrow('échec du chiffrement');

    await expect(withOlmLock(session, async () => 'ok')).resolves.toBe('ok');
  });

  it('ne laisse aucune file en mémoire après la dernière tâche', async () => {
    const task = () => withOlmLock(session, async () => 'ok');
    await Promise.all([task(), task(), task()]);
    expect(pendingOlmLocks()).toBe(0);
  });

  it('la clé distingue le pair, l’appareil et le compte', () => {
    const base = olmLockId(session);
    expect(olmLockId({ ...session, peerDeviceId: 'dev-2' })).not.toBe(base);
    expect(olmLockId({ ...session, peerUserId: 'peer-2' })).not.toBe(base);
    expect(olmLockId({ ...session, accountId: 'acc-2' })).not.toBe(base);
  });
});

describe('withAccountLock — pickle global du compte', () => {
  it('sérialise deux mutations du même compte', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withAccountLock('acc-1', async () => {
      order.push('start:1');
      await gate;
      order.push('end:1');
    });
    const second = withAccountLock('acc-1', async () => {
      order.push('start:2');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['start:1']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['start:1', 'end:1', 'start:2']);
  });

  it('ne bloque pas les sessions du même compte', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withAccountLock('acc-1', () => gate);
    // Le verrou de compte n'est pas un verrou global de session.
    await expect(
      withOlmLock({ accountId: 'acc-1', peerUserId: 'peer-1', peerDeviceId: 'dev-1' }, async () => 'ok'),
    ).resolves.toBe('ok');
    release();
    await held;
  });

  it('libère la place après une erreur et ne fuit pas', async () => {
    await expect(withAccountLock('acc-1', async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(withAccountLock('acc-1', async () => 'ok')).resolves.toBe('ok');
    expect(pendingAccountLocks()).toBe(0);
  });
});
