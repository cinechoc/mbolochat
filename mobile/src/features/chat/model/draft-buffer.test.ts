import { describe, expect, it, vi } from 'vitest';

import { createDraftBuffer, type DraftScheduler } from './draft-buffer';

function fakeScheduler() {
  let callback: (() => void) | null = null;
  let handle = 0;
  const scheduler: DraftScheduler = {
    schedule: (next, _delay) => {
      callback = next;
      handle += 1;
      return handle;
    },
    cancel: () => {
      callback = null;
    },
  };
  return {
    scheduler,
    run: () => {
      const current = callback;
      callback = null;
      current?.();
    },
  };
}

describe('createDraftBuffer', () => {
  it('n’écrit que la dernière valeur après le délai', () => {
    const save = vi.fn();
    const { scheduler, run } = fakeScheduler();
    const buffer = createDraftBuffer({ save, scheduler });
    buffer.set('a');
    buffer.set('ab');
    buffer.set('abc');
    expect(save).not.toHaveBeenCalled();
    run();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('abc');
  });

  it('flush écrit immédiatement et annule le minuteur', () => {
    const save = vi.fn();
    const { scheduler, run } = fakeScheduler();
    const buffer = createDraftBuffer({ save, scheduler });
    buffer.set('brouillon');
    buffer.flush();
    expect(save).toHaveBeenCalledWith('brouillon');
    run();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('ne réécrit pas une valeur déjà vidée', () => {
    const save = vi.fn();
    const { scheduler } = fakeScheduler();
    const buffer = createDraftBuffer({ save, scheduler });
    buffer.set('x');
    buffer.flush();
    buffer.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('dispose annule l’écriture en attente', () => {
    const save = vi.fn();
    const { scheduler, run } = fakeScheduler();
    const buffer = createDraftBuffer({ save, scheduler });
    buffer.set('perdu');
    buffer.dispose();
    run();
    expect(save).not.toHaveBeenCalled();
    expect(buffer.pending()).toBeNull();
  });
});
