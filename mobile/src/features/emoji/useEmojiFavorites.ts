import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'chat.emoji.favorites.v1';
const MAX_FAVORITES = 64;

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
      const valid = parsed.filter((value): value is string => typeof value === 'string');
      publish([...memory, ...valid.filter((emoji) => !memory.includes(emoji))].slice(0, MAX_FAVORITES));
    }
  } catch {
    /* stockage illisible : on repart de zéro */
  }
}

/** Emoji favoris persistés localement, partagés entre les composants. */
export function useEmojiFavorites() {
  const [favorites, setFavorites] = useState<string[]>(memory);

  useEffect(() => {
    listeners.add(setFavorites);
    void loadOnce();
    return () => {
      listeners.delete(setFavorites);
    };
  }, []);

  const toggle = useCallback((emoji: string) => {
    const next = memory.includes(emoji)
      ? memory.filter((value) => value !== emoji)
      : [emoji, ...memory].slice(0, MAX_FAVORITES);
    publish(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  return { favorites, toggle };
}

/** Vide les favoris, par exemple à la déconnexion. */
export async function resetEmojiFavorites(): Promise<void> {
  publish([]);
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    /* stockage indisponible : la mémoire est déjà vide */
  }
}
