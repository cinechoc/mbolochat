import { describe, expect, it } from 'vitest';

import { classifyQuality } from './PeerStats';
import {
  IDLE_SPEAKING,
  SPEAKING_ON,
  SPEAKING_SMOOTHING,
  smoothLevel,
  updateSpeaking,
} from './speaking';

describe('classifyQuality', () => {
  it('considère un lien sain comme bon', () => {
    expect(classifyQuality({ lossRatio: 0, jitterMs: 10, roundTripMs: 80 })).toBe('good');
  });

  it('passe en moyen dès 2 % de perte ou 60 ms de gigue', () => {
    expect(classifyQuality({ lossRatio: 0.03, jitterMs: 10, roundTripMs: 80 })).toBe('medium');
    expect(classifyQuality({ lossRatio: 0.01, jitterMs: 70, roundTripMs: 80 })).toBe('medium');
    expect(classifyQuality({ lossRatio: 0.01, jitterMs: 10, roundTripMs: 300 })).toBe('medium');
  });

  it('passe en faible à 8 % de perte, 120 ms de gigue ou 400 ms d’aller-retour', () => {
    expect(classifyQuality({ lossRatio: 0.09, jitterMs: 10, roundTripMs: 80 })).toBe('weak');
    expect(classifyQuality({ lossRatio: 0, jitterMs: 130, roundTripMs: 80 })).toBe('weak');
    expect(classifyQuality({ lossRatio: 0, jitterMs: 10, roundTripMs: 450 })).toBe('weak');
  });

  it('ignore un aller-retour inconnu', () => {
    expect(classifyQuality({ lossRatio: 0, jitterMs: 10, roundTripMs: null })).toBe('good');
  });
});

describe('détection de parole', () => {
  it('lisse une mesure isolée vers la moyenne', () => {
    expect(smoothLevel(0, 1)).toBeCloseTo(SPEAKING_SMOOTHING);
  });

  it('n’allume pas l’anneau sur un pic isolé', () => {
    const once = updateSpeaking(IDLE_SPEAKING, 1);
    expect(once.level).toBeGreaterThan(SPEAKING_ON);
    expect(once.speaking).toBe(false);
    const twice = updateSpeaking(once, 1);
    expect(twice.speaking).toBe(true);
  });

  it('attend deux mesures calmes pour éteindre', () => {
    let state = updateSpeaking(IDLE_SPEAKING, 1);
    state = updateSpeaking(state, 1);
    expect(state.speaking).toBe(true);
    state = updateSpeaking(state, 0);
    expect(state.speaking).toBe(true);
    state = updateSpeaking(state, 0);
    expect(state.speaking).toBe(false);
  });

  it('ignore une mesure invalide', () => {
    expect(smoothLevel(0.5, Number.NaN)).toBe(0.5);
    expect(smoothLevel(0.5, -1)).toBe(0.5);
  });
});
