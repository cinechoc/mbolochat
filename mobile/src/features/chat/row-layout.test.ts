import { describe, expect, it } from 'vitest';

import { bubbleMaxWidth, messageRowLayout, ROW_AVATAR_SIZE } from './row-layout';

describe('disposition WeChat des rangées', () => {
  it('message reçu : avatar à gauche, bulle alignée à gauche', () => {
    const layout = messageRowLayout(false, false);
    expect(layout).toMatchObject({
      avatar: 'left',
      spacer: 'none',
      align: 'flex-start',
      bubbleFirst: false,
    });
  });

  it('message envoyé : avatar à droite, bulle alignée à droite', () => {
    const layout = messageRowLayout(true, false);
    expect(layout).toMatchObject({
      avatar: 'right',
      spacer: 'none',
      align: 'flex-end',
      bubbleFirst: true,
    });
  });

  it('continuation reçue : pas d’avatar, place réservée à gauche', () => {
    const layout = messageRowLayout(false, true);
    expect(layout).toMatchObject({
      avatar: 'none',
      spacer: 'left',
      align: 'flex-start',
      bubbleFirst: false,
    });
  });

  it('continuation envoyée : pas d’avatar, place réservée à droite', () => {
    const layout = messageRowLayout(true, true);
    expect(layout).toMatchObject({
      avatar: 'none',
      spacer: 'right',
      align: 'flex-end',
      bubbleFirst: true,
    });
  });

  it('la place de l’avatar est toujours réservée, même sans avatar dessiné', () => {
    for (const mine of [true, false]) {
      const side = mine ? 'right' : 'left';
      const first = messageRowLayout(mine, false);
      const next = messageRowLayout(mine, true);
      // L'avatar n'est dessiné qu'une fois par groupe, mais sa colonne existe
      // toujours : sans cela les bulles se décaleraient d'une ligne à l'autre.
      expect(first.avatar).toBe(side);
      expect(first.spacer).toBe('none');
      expect(next.avatar).toBe('none');
      expect(next.spacer).toBe(side);
    }
  });
});

describe('largeur maximale des bulles', () => {
  const measure = (windowWidth: number) =>
    bubbleMaxWidth({ windowWidth, horizontalPadding: 8 });

  it('réserve la place de l’avatar et les marges de la liste', () => {
    const width = measure(414);
    const available = 414 - 2 * 8 - ROW_AVATAR_SIZE - 8;
    expect(width).toBeLessThanOrEqual(available);
    expect(width).toBeGreaterThanOrEqual(160);
  });

  it('ne dépasse jamais la largeur utile, quel que soit l’écran', () => {
    for (const windowWidth of [320, 360, 414, 480, 768, 1024]) {
      const width = measure(windowWidth);
      expect(width).toBeLessThanOrEqual(windowWidth - 2 * 8 - ROW_AVATAR_SIZE - 8);
      expect(width).toBeGreaterThan(0);
    }
  });

  it('grandit avec l’écran sans devenir démesurée', () => {
    expect(measure(320)).toBeLessThan(measure(414));
    expect(measure(414)).toBeLessThan(measure(1024));
    // Bornée par la cible de 70 % : elle ne colle jamais au bord droit.
    expect(measure(1024)).toBeLessThanOrEqual(Math.round(1024 * 0.7));
  });

  it('écran minuscule : la bulle garde une largeur lisible', () => {
    const width = bubbleMaxWidth({ windowWidth: 200, horizontalPadding: 8 });
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(200 - 2 * 8 - ROW_AVATAR_SIZE - 8);
  });
});
