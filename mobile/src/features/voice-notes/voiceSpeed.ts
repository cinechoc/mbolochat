import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

export const VOICE_SPEEDS = [1, 1.5, 2] as const;
export type VoiceSpeed = (typeof VOICE_SPEEDS)[number];

const STORAGE_KEY = 'mbolo.voice.playback-speed.v1';

let current: VoiceSpeed = 1;
let loaded = false;
let opening: Promise<VoiceSpeed> | null = null;
const listeners = new Set<() => void>();

function isVoiceSpeed(value: unknown): value is VoiceSpeed {
  return typeof value === 'number' && VOICE_SPEEDS.includes(value as VoiceSpeed);
}

/** Valeur mémorisée normalisée ; toute valeur absente ou invalide retombe à 1x. */
export function parseVoiceSpeed(value: unknown): VoiceSpeed {
  if (isVoiceSpeed(value)) return value;
  if (typeof value !== 'string') return 1;
  const parsed = Number(value.trim().replace(',', '.'));
  return isVoiceSpeed(parsed) ? parsed : 1;
}

/** Vitesse suivante dans la boucle 1x → 1,5x → 2x → 1x. */
export function nextVoiceSpeed(speed: VoiceSpeed): VoiceSpeed {
  const index = VOICE_SPEEDS.indexOf(speed);
  return VOICE_SPEEDS[(index + 1) % VOICE_SPEEDS.length];
}

export function getVoiceSpeed(): VoiceSpeed {
  return current;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

export async function loadVoiceSpeed(): Promise<VoiceSpeed> {
  if (loaded) return current;
  if (opening) return opening;
  opening = (async () => {
    try {
      current = parseVoiceSpeed(await AsyncStorage.getItem(STORAGE_KEY));
    } catch {
      current = 1;
    } finally {
      loaded = true;
      opening = null;
    }
    notify();
    return current;
  })();
  return opening;
}

export async function setVoiceSpeed(speed: VoiceSpeed): Promise<void> {
  loaded = true;
  current = speed;
  notify();
  try {
    await AsyncStorage.setItem(STORAGE_KEY, String(speed));
  } catch {
    // La préférence reste valable pour la session.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Seule la pastille de la bulle active lit ce store : pas de rendu de liste. */
export function useVoiceSpeed(): VoiceSpeed {
  return useSyncExternalStore(subscribe, getVoiceSpeed, () => 1);
}
