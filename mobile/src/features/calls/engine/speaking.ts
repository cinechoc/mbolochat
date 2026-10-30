/** Détection de parole : moyenne glissante, hystérésis et confirmation sur deux mesures. */
export const SPEAKING_ON = 0.035;
export const SPEAKING_OFF = 0.02;
/** Part de la nouvelle mesure dans la moyenne (0 = figé, 1 = brut). */
export const SPEAKING_SMOOTHING = 0.4;
/** Mesures consécutives nécessaires pour changer d'état (700 ms par mesure). */
export const SPEAKING_HOLD = 2;

export interface SpeakingState {
  speaking: boolean;
  level: number;
  /** Mesures consécutives au-dessus du seuil haut. */
  on: number;
  /** Mesures consécutives sous le seuil bas. */
  off: number;
}

export const IDLE_SPEAKING: SpeakingState = { speaking: false, level: 0, on: 0, off: 0 };

/** Moyenne exponentielle du niveau : lisse les pics de bruit isolés. */
export function smoothLevel(previous: number, sample: number): number {
  if (!Number.isFinite(sample) || sample < 0) {
    return previous;
  }
  return previous + SPEAKING_SMOOTHING * (sample - previous);
}

/**
 * Met à jour l'état de parole d'un participant. Un pic isolé ne suffit pas :
 * il faut deux mesures de suite pour allumer l'anneau, et deux mesures calmes
 * pour l'éteindre. Sans ça, l'anneau clignote au moindre souffle.
 */
export function updateSpeaking(state: SpeakingState, sample: number): SpeakingState {
  const level = smoothLevel(state.level, sample);

  if (!state.speaking) {
    // Allumage sur le niveau lissé : un pic isolé ne suffit pas.
    const on = level > SPEAKING_ON ? state.on + 1 : 0;
    return { speaking: on >= SPEAKING_HOLD, level, on, off: 0 };
  }
  // Extinction sur la mesure brute : sinon la moyenne garde l'anneau allumé
  // plusieurs secondes après la fin de la phrase.
  const off = sample < SPEAKING_OFF ? state.off + 1 : 0;
  return { speaking: off < SPEAKING_HOLD, level, on: 0, off };
}
