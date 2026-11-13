import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

const FLAG_KEY = 'mbolo.dev.unified-chat';

let cached: boolean | null = null;
const listeners = new Set<(enabled: boolean) => void>();

function notify(): void {
  for (const listener of listeners) {
    listener(cached === true);
  }
}

/**
 * Drapeau de développement de l'écran unifié.
 *
 * Désactivé par défaut, stocké localement (AsyncStorage) : l'activer ne
 * demande aucun rebuild. Aucune interface utilisateur normale ne l'expose ;
 * la route `/dev-flags` est réservée à `__DEV__`.
 */
export function getUnifiedChatFlagSync(): boolean {
  return cached === true;
}

export async function loadUnifiedChatFlag(): Promise<boolean> {
  try {
    cached = (await AsyncStorage.getItem(FLAG_KEY)) === '1';
  } catch {
    cached = false;
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
