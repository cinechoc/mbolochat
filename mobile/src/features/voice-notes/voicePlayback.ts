import { useSyncExternalStore } from 'react';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

/**
 * Lecture des notes vocales.
 *
 * Un SEUL lecteur natif pour toute l'app (au lieu d'un lecteur par bulle) :
 * - jamais deux notes en même temps (comme WeChat) ;
 * - mémoire maîtrisée dans une longue FlatList, même sur un téléphone modeste.
 */

export type PlaybackState = {
  id: string | null;
  playing: boolean;
  positionMs: number;
  durationMs: number;
};

const IDLE: PlaybackState = { id: null, playing: false, positionMs: 0, durationMs: 0 };

let state: PlaybackState = IDLE;
let player: AudioPlayer | null = null;
let subscription: { remove: () => void } | null = null;
let finished = false;
const listeners = new Set<() => void>();

function setState(patch: Partial<PlaybackState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function stopVoicePlayback() {
  subscription?.remove();
  subscription = null;
  try {
    player?.pause();
    player?.remove();
  } catch {
    /* déjà libéré */
  }
  player = null;
  finished = false;
  setState(IDLE);
}

/** Charge la note sans démarrer la lecture. */
async function loadVoicePlayer(
  id: string,
  uri: string,
  durationHintMs: number,
): Promise<AudioPlayer> {
  await stopVoicePlayback();
  await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });

  const next = createAudioPlayer({ uri }, { updateInterval: 100 });
  player = next;
  setState({ id, playing: false, positionMs: 0, durationMs: durationHintMs });

  subscription = next.addListener('playbackStatusUpdate', (s) => {
    if (player !== next) return; // événement d'un ancien lecteur
    if (s.didJustFinish) {
      finished = true;
      setState({ playing: false, positionMs: 0 });
      return;
    }
    setState({
      playing: s.playing,
      positionMs: Math.round((s.currentTime ?? 0) * 1000),
      durationMs: s.duration && s.duration > 0 ? Math.round(s.duration * 1000) : durationHintMs,
    });
  });

  return next;
}

/**
 * Lit / met en pause la note `id`.
 * Si une autre note jouait, elle est arrêtée.
 * Retourne true si la lecture vient de démarrer (utile pour marquer "écouté").
 */
export async function toggleVoicePlayback(
  id: string,
  uri: string,
  durationHintMs: number,
): Promise<boolean> {
  // Même note : pause / reprise / relecture depuis le début.
  if (state.id === id && player) {
    if (player.playing) {
      player.pause();
      return false;
    }
    if (finished) {
      await player.seekTo(0);
      finished = false;
    }
    player.play();
    return false;
  }

  // Autre note : on charge sans jouer, puis on démarre.
  const next = await loadVoicePlayer(id, uri, durationHintMs);
  next.play();
  return true;
}

/** Attend le chargement du fichier avant un seek (sinon le seek est ignoré). */
function waitUntilLoaded(player: AudioPlayer, timeoutMs = 3000): Promise<boolean> {
  if (player.isLoaded) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    let subscription: { remove: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      subscription?.remove();
      if (timer) clearTimeout(timer);
      resolve(loaded);
    };
    subscription = player.addListener('playbackStatusUpdate', (status) => {
      if (status.isLoaded) finish(true);
    });
    timer = setTimeout(() => finish(player.isLoaded), timeoutMs);
  });
}

/**
 * Place la lecture à `ratio` (0..1) de la note `id`.
 * Si la note n'est pas la note active, elle est chargée sans être lancée.
 * L'état lecture/pause est toujours conservé.
 */
export async function seekVoicePlayback(
  id: string,
  uri: string,
  durationHintMs: number,
  ratio: number,
): Promise<void> {
  const r = Math.min(1, Math.max(0, ratio));
  const wasActive = state.id === id && !!player;
  if (!wasActive) await loadVoicePlayer(id, uri, durationHintMs); // charge SANS jouer
  const current = player;
  if (!current) return;
  const wasPlaying = wasActive && current.playing; // lu AVANT le seek
  if (!current.isLoaded) {
    await waitUntilLoaded(current);
  }
  if (player !== current) return; // une autre note a remplacé le lecteur
  const totalMs = state.durationMs > 0 ? state.durationMs : durationHintMs;
  const targetMs = Math.round(totalMs * r);
  finished = false;
  await current.seekTo(targetMs / 1000);
  setState({ positionMs: targetMs });
  if (wasPlaying && !current.playing) current.play(); // ne reprend que si ça jouait
}

/**
 * État de lecture d'UNE bulle. Les bulles inactives reçoivent toujours le même
 * objet IDLE : elles ne se re-rendent donc pas pendant qu'une autre note joue.
 */
export function useVoicePlayback(id: string): PlaybackState {
  return useSyncExternalStore(
    subscribe,
    () => (state.id === id ? state : IDLE),
    () => IDLE,
  );
}
