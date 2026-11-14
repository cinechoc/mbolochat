import { describe, expect, it } from 'vitest';

import {
  initialVoiceGesture,
  LONG_PRESS_MS,
  reduceVoiceGesture,
  voiceSlideZone,
} from './voice-gesture';

/** Enchaîne des événements et renvoie la suite des effets produits. */
function run(startState = initialVoiceGesture(), ...events: Parameters<typeof reduceVoiceGesture>[1][]) {
  let state = startState;
  const effects = [];
  for (const event of events) {
    const result = reduceVoiceGesture(state, event);
    state = result.next;
    effects.push(result.effect);
  }
  return { state, effects };
}

describe('geste vocal — seuil d’appui long', () => {
  it('un tap court ne démarre rien et n’envoie rien', () => {
    const { effects } = run(initialVoiceGesture(), { type: 'press' }, { type: 'release' });
    expect(effects).toEqual(['none', 'none']);
  });

  it('la capture démarre exactement au seuil d’appui long', () => {
    const { effects } = run(
      initialVoiceGesture(),
      { type: 'press' },
      { type: 'tick', heldMs: LONG_PRESS_MS - 1 },
      { type: 'tick', heldMs: LONG_PRESS_MS },
    );
    expect(effects).toEqual(['none', 'none', 'start']);
  });

  it('un glissement pendant l’armement est ignoré', () => {
    const { state, effects } = run(
      initialVoiceGesture(),
      { type: 'press' },
      { type: 'move', dx: -120, dy: 0 },
      { type: 'release' },
    );
    expect(effects).toEqual(['none', 'none', 'none']);
    expect(state.phase).toBe('idle');
  });

  it('relâcher après démarrage sans zone envoie immédiatement', () => {
    const { effects } = run(
      initialVoiceGesture(),
      { type: 'press' },
      { type: 'tick', heldMs: LONG_PRESS_MS },
      { type: 'release' },
    );
    expect(effects).toEqual(['none', 'start', 'send']);
  });
});

describe('geste vocal — zones de glissement', () => {
  it('la zone se décide sur l’axe dominant', () => {
    expect(voiceSlideZone(-70, -50)).toBe('cancel');
    expect(voiceSlideZone(-50, -70)).toBe('lock');
    expect(voiceSlideZone(70, -50)).toBe('none'); // à droite : rien
    expect(voiceSlideZone(-70, 50)).toBe('cancel');
    expect(voiceSlideZone(-50, 70)).toBe('none'); // vers le bas : rien
    expect(voiceSlideZone(-30, -30)).toBe('none'); // sous le seuil
  });

  it('glisser à gauche arme l’annulation ; relâcher jette la note', () => {
    const { effects } = run(
      initialVoiceGesture(),
      { type: 'press' },
      { type: 'tick', heldMs: LONG_PRESS_MS },
      { type: 'move', dx: -80, dy: 0 },
      { type: 'release' },
    );
    expect(effects).toEqual(['none', 'start', 'enterCancel', 'cancel']);
  });

  it('glisser vers le haut arme le verrouillage ; relâcher passe en mains libres', () => {
    const { effects } = run(
      initialVoiceGesture(),
      { type: 'press' },
      { type: 'tick', heldMs: LONG_PRESS_MS },
      { type: 'move', dx: 0, dy: -90 },
      { type: 'release' },
    );
    expect(effects).toEqual(['none', 'start', 'enterLock', 'lock']);
  });

  it('sortir de la zone restaure l’envoi au relâchement', () => {
    const { effects } = run(
      initialVoiceGesture(),
      { type: 'press' },
      { type: 'tick', heldMs: LONG_PRESS_MS },
      { type: 'move', dx: -80, dy: 0 },
      { type: 'move', dx: -10, dy: 0 },
      { type: 'release' },
    );
    expect(effects).toEqual(['none', 'start', 'enterCancel', 'leaveZone', 'send']);
  });

  it('le toucher repris par le système annule, même hors zone', () => {
    const { effects } = run(
      initialVoiceGesture(),
      { type: 'press' },
      { type: 'tick', heldMs: LONG_PRESS_MS },
      { type: 'release', forceCancel: true },
    );
    expect(effects).toEqual(['none', 'start', 'cancel']);
  });

  it('après un effet terminal, la machine revient à l’état initial', () => {
    const { state } = run(
      initialVoiceGesture(),
      { type: 'press' },
      { type: 'tick', heldMs: LONG_PRESS_MS },
      { type: 'move', dx: 0, dy: -90 },
      { type: 'release' },
    );
    expect(state).toEqual(initialVoiceGesture());
  });
});
