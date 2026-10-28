import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { Vibration } from 'react-native';

/**
 * Sonneries d'appel : un seul lecteur natif à la fois (boucle) + vibration.
 * Les WAV sont générés localement (assets/sounds) : aucune dépendance réseau.
 */

const SOURCES = {
  incoming: require('../../../assets/sounds/ringtone.wav') as number,
  outgoing: require('../../../assets/sounds/ringback.wav') as number,
};

let player: AudioPlayer | null = null;

export function stopRing(): void {
  try {
    player?.pause();
    player?.remove();
  } catch {
    /* déjà libéré */
  }
  player = null;
  Vibration.cancel();
}

async function start(kind: 'incoming' | 'outgoing'): Promise<void> {
  stopRing();
  try {
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const next = createAudioPlayer(SOURCES[kind]);
    next.loop = true;
    next.play();
    player = next;
    if (kind === 'incoming') {
      // Deux impulsions puis pause, en boucle, comme une sonnerie de téléphone.
      Vibration.vibrate([0, 700, 500], true);
    }
  } catch {
    /* sonnerie non bloquante : l'appel reste visible à l'écran */
  }
}

export const startIncomingRing = () => start('incoming');
export const startOutgoingRing = () => start('outgoing');
