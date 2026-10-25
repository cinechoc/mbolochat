import { useCallback, useEffect, useState } from 'react';
// Si le projet utilise un autre stockage (MMKV, SecureStore…), adapte uniquement ce fichier.
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'chat.emoji.recents.v1';
const MAX_RECENTS = 24;

let memory: string[] = [];
let loadStarted = false;
const listeners = new Set<(value: string[]) => void>();

function publish(next: string[]) {
  memory = next;
  listeners.forEach((listener) => listener(memory));
}

async function loadOnce() {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const valid = parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENTS);
      // On garde ce qui a pu être ajouté pendant le chargement.
      publish([...memory, ...valid.filter((e) => !memory.includes(e))].slice(0, MAX_RECENTS));
    }
  } catch {
    /* stockage illisible : on repart de zéro */
  }
}

/** Vide l'historique local, par exemple à la déconnexion. */
export async function resetRecentEmoji(): Promise<void> {
  publish([]);
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    /* stockage indisponible : la mémoire est déjà vide */
  }
}

/** Emoji récemment utilisés, partagés entre tous les composants et conservés entre les sessions. */
export function useRecentEmoji() {
  const [recents, setRecents] = useState<string[]>(memory);

  useEffect(() => {
    listeners.add(setRecents);
    void loadOnce();
    return () => {
      listeners.delete(setRecents);
    };
  }, []);

  const push = useCallback((emoji: string) => {
    publish([emoji, ...memory.filter((e) => e !== emoji)].slice(0, MAX_RECENTS));
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(memory)).catch(() => {});
  }, []);

  return { recents, push };
}
