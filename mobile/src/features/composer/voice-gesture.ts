/**
 * Machine à états du geste d'enregistrement vocal (façon Snapchat).
 *
 * Le PanResponder du compositeur traduit le toucher brut en événements purs ;
 * `reduceVoiceGesture` décide du moment où la capture démarre (seuil d'appui
 * long), des zones de glissement (gauche = annuler, haut = verrouiller) et de
 * l'effet du relâchement (envoi immédiat, annulation, verrouillage). Toute la
 * logique testable vit ici : le composant ne garde que le branchement aux refs
 * et aux effets natifs (enregistreur, haptique, rendu).
 */

/** Durée d'appui avant que la capture démarre. */
export const LONG_PRESS_MS = 300;
/** Distance (px) à parcourir sur l'axe dominant pour armer une zone. */
export const SLIDE_TRIGGER_PX = 60;

export type VoiceGestureZone = 'none' | 'cancel' | 'lock';

export type VoiceGestureState = {
  /** Le doigt est posé mais le seuil d'appui long n'est pas atteint. */
  phase: 'idle' | 'arming' | 'recording';
  zone: VoiceGestureZone;
};

export type VoiceGestureEvent =
  | { type: 'press' }
  /** Progression de l'appui : `heldMs` est écoulé depuis la pose du doigt. */
  | { type: 'tick'; heldMs: number }
  /** Glissement ; `dy` négatif = vers le haut, `dx` négatif = vers la gauche. */
  | { type: 'move'; dx: number; dy: number }
  /** Relâchement ; `forceCancel` quand le système reprend le toucher. */
  | { type: 'release'; forceCancel?: boolean };

export type VoiceGestureEffect =
  | 'none'
  /** Le seuil d'appui long est atteint : démarrer la capture. */
  | 'start'
  /** Entrée en zone d'annulation (gauche). */
  | 'enterCancel'
  /** Entrée en zone de verrouillage (haut). */
  | 'enterLock'
  /** Retour de zone : l'onde reprend ses couleurs. */
  | 'leaveZone'
  /** Relâchement hors zone : envoyer la note. */
  | 'send'
  /** Relâchement en zone d'annulation (ou toucher repris) : jeter la note. */
  | 'cancel'
  /** Relâchement en zone de verrouillage : passer en mains libres. */
  | 'lock';

export function initialVoiceGesture(): VoiceGestureState {
  return { phase: 'idle', zone: 'none' };
}

/** Zone désignée par un glissement, décidée sur l'axe dominant. */
export function voiceSlideZone(dx: number, dy: number): VoiceGestureZone {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < SLIDE_TRIGGER_PX && ady < SLIDE_TRIGGER_PX) return 'none';
  if (adx >= ady) return dx <= -SLIDE_TRIGGER_PX ? 'cancel' : 'none';
  return dy <= -SLIDE_TRIGGER_PX ? 'lock' : 'none';
}

export function reduceVoiceGesture(
  state: VoiceGestureState,
  event: VoiceGestureEvent,
): { next: VoiceGestureState; effect: VoiceGestureEffect } {
  switch (event.type) {
    case 'press':
      if (state.phase !== 'idle') return { next: state, effect: 'none' };
      return { next: { phase: 'arming', zone: 'none' }, effect: 'none' };
    case 'tick':
      if (state.phase !== 'arming' || event.heldMs < LONG_PRESS_MS) {
        return { next: state, effect: 'none' };
      }
      return { next: { phase: 'recording', zone: 'none' }, effect: 'start' };
    case 'move': {
      if (state.phase !== 'recording') return { next: state, effect: 'none' };
      const zone = voiceSlideZone(event.dx, event.dy);
      if (zone === state.zone) return { next: state, effect: 'none' };
      const effect: VoiceGestureEffect =
        zone === 'cancel' ? 'enterCancel' : zone === 'lock' ? 'enterLock' : 'leaveZone';
      return { next: { phase: 'recording', zone }, effect };
    }
    case 'release': {
      if (state.phase === 'arming') return { next: initialVoiceGesture(), effect: 'none' };
      if (state.phase !== 'recording') return { next: state, effect: 'none' };
      const done = initialVoiceGesture();
      if (event.forceCancel || state.zone === 'cancel') return { next: done, effect: 'cancel' };
      if (state.zone === 'lock') return { next: done, effect: 'lock' };
      return { next: done, effect: 'send' };
    }
  }
}
