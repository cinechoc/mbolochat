import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

const FLAG_KEY = 'mbolo.dev.unified-chat';
const DEFAULT_ENABLED = true;

let cached = DEFAULT_ENABLED;
const listeners = new Set<(enabled: boolean) => void>();

function notify(): void {
  for (const listener of listeners) {
    listener(cached);
  }
}

/**
 * Drapeau de développement de l'écran unifié.
 *
 * Activé par défaut, stocké localement (AsyncStorage) : le désactiver ne
 * demande aucun rebuild. Aucune interface utilisateur normale ne l'expose ;
 * la route `/dev-flags` est réservée à `__DEV__` et permet le retour à
 * l'ancien écran.
 */
export function getUnifiedChatFlagSync(): boolean {
  return cached;
}

export async function loadUnifiedChatFlag(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(FLAG_KEY);
    cached = stored === null ? DEFAULT_ENABLED : stored === '1';
  } catch {
    cached = DEFAULT_ENABLED;
  }
  notify();
  return cached;
}

export async function setUnifiedChatFlag(enabled: boolean): Promise<void> {
  cached = enabled;
  notify();
  try {
    await AsyncStorage.setItem(FLAG_KEY, enabled ? '1' : '0');
  } catch {
    // Le drapeau reste valable en mémoire pour la session.
  }
}

export function subscribeUnifiedChatFlag(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Valeur courante, chargée en arrière-plan au premier montage. */
export function useUnifiedChatFlag(): boolean {
  const [enabled, setEnabled] = useState(getUnifiedChatFlagSync());
  useEffect(() => {
    let active = true;
    void loadUnifiedChatFlag().then((value) => {
      if (active) setEnabled(value);
    });
    const off = subscribeUnifiedChatFlag((value) => {
      if (active) setEnabled(value);
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  return enabled;
}
