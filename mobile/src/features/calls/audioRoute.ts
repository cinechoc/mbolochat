import { DeviceEventEmitter, type EmitterSubscription } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import InCallManager from 'react-native-incall-manager';

/** Étiquette du verrou d'écran : un seul appel à la fois dans l'application. */
const KEEP_AWAKE_TAG = 'mbolochat-call';

/**
 * Routage audio de l'appel : écouteur/haut-parleur, capteur de proximité et
 * focus audio du système. Toutes les erreurs natives sont avalées : un build
 * sans InCallManager ne doit pas empêcher l'appel WebRTC de fonctionner.
 */

let started = false;
let proximitySubscription: EmitterSubscription | null = null;
let onProximity: ((near: boolean) => void) | null = null;

export function startCallAudio(listener?: (near: boolean) => void): void {
  onProximity = listener ?? null;
  try {
    // `auto` active le capteur de proximité (écran éteint près de l'oreille).
    InCallManager.start({ media: 'audio' });
    started = true;
  } catch {
    started = false;
  }
  // L'écran reste allumé hors proximité ; le capteur l'éteint à l'oreille.
  void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
  proximitySubscription?.remove();
  proximitySubscription = DeviceEventEmitter.addListener(
    'Proximity',
    (event: { isNear?: boolean }) => onProximity?.(Boolean(event?.isNear)),
  );
}

export function stopCallAudio(): void {
  proximitySubscription?.remove();
  proximitySubscription = null;
  onProximity = null;
  if (!started) {
    return;
  }
  started = false;
  deactivateKeepAwake(KEEP_AWAKE_TAG);
  try {
    InCallManager.stop();
  } catch {
    /* module absent ou déjà arrêté */
  }
}

/** Force l'écouteur (`false`) ou le haut-parleur (`true`). */
export function setSpeakerphone(enabled: boolean): void {
  try {
    InCallManager.setForceSpeakerphoneOn(enabled);
  } catch {
    /* module absent */
  }
}
