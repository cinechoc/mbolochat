import { describe, expect, it } from 'vitest';

import {
  INITIAL_SCROLL_STATE,
  countUnseen,
  resetScrollState,
  scrollStateForOffset,
} from './scroll-state';

describe('scroll-state', () => {
  it('reste en bas sous le seuil', () => {
    expect(scrollStateForOffset(0, 3)).toEqual({ atBottom: true, showJump: false, unseen: 0 });
    expect(scrollStateForOffset(32, 3).atBottom).toBe(true);
  });

  it('affiche la pastille au-delà du seuil de retour', () => {
    expect(scrollStateForOffset(321)).toEqual({
      atBottom: false,
      showJump: true,
      unseen: 0,
    });
    expect(scrollStateForOffset(100).showJump).toBe(false);
  });

  it('compte les arrivages seulement quand on n’est pas en bas', () => {
    const away = { atBottom: false, showJump: true, unseen: 0 };
    expect(countUnseen(away, 2)).toEqual({ ...away, unseen: 2 });
    expect(countUnseen(away, 0)).toBe(away);
    const bottom = { atBottom: true, showJump: false, unseen: 0 };
    expect(countUnseen(bottom, 2)).toBe(bottom);
  });

  it('remet tout à zéro au retour en bas', () => {
    expect(resetScrollState()).toEqual(INITIAL_SCROLL_STATE);
  });
});
