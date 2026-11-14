import { describe, expect, it } from 'vitest';

import { placeFloatingBar } from './message-overlay-layout';

const base = {
  windowWidth: 400,
  windowHeight: 800,
  safeTop: 24,
  barWidth: 280,
  barHeight: 52,
};

describe('placement de la barre de réactions', () => {
  it('centre la barre au-dessus de la bulle', () => {
    expect(
      placeFloatingBar({
        ...base,
        anchor: { x: 160, y: 420, width: 180, height: 80 },
      }),
    ).toEqual({ left: 110, top: 360 });
  });

  it('borne la barre aux deux bords de l’écran', () => {
    expect(
      placeFloatingBar({
        ...base,
        anchor: { x: 0, y: 420, width: 40, height: 40 },
      }).left,
    ).toBe(8);
    expect(
      placeFloatingBar({
        ...base,
        anchor: { x: 390, y: 420, width: 10, height: 40 },
      }).left,
    ).toBe(112);
  });

  it('passe sous la bulle quand il n’y a pas de place au-dessus', () => {
    expect(
      placeFloatingBar({
        ...base,
        anchor: { x: 160, y: 40, width: 180, height: 70 },
      }),
    ).toEqual({ left: 110, top: 118 });
  });

  it('reste au-dessus du menu quand la bulle est basse', () => {
    expect(
      placeFloatingBar({
        ...base,
        anchor: { x: 160, y: 650, width: 180, height: 80 },
        menuTop: 450,
      }),
    ).toEqual({ left: 110, top: 390 });
  });

  it('reste visible sans ancre mesurée', () => {
    const placement = placeFloatingBar({ ...base, anchor: null });
    expect(placement.left).toBe(60);
    expect(placement.top).toBe(300);
  });
});
