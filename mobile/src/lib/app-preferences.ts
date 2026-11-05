import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

export type AppPreferences = {
  /** Sonnerie et retour de sonnerie pendant les appels. */
  ringtone: boolean;
  /** Mode économie de données : la vidéo d'appel est désactivée. */
  callDataSaver: boolean;
  /** FLAG_SECURE sur les écrans de conversation chiffrée : l'aperçu
   * « applications récentes » et les captures montrent un écran neutre. */
  hideRecentsPreview: boolean;
  /** Médias chiffrés : télécharger la vignette automatiquement en Wi-Fi. */
  mediaAutoDownloadWifi: boolean;
  /** Médias chiffrés : télécharger la vignette automatiquement en données mobiles. */
  mediaAutoDownloadCellular: boolean;
};

const STORAGE_KEY = 'mbolo.app-preferences';
const DEFAULTS: AppPreferences = {
  ringtone: true,
  callDataSaver: false,
  hideRecentsPreview: true,
  // La vignette est petite : la charger d'office en Wi-Fi est un confort, en
  // données mobiles un choix explicite. Le fichier complet ne se charge jamais
  // sans un toucher, quel que soit le réglage.
  mediaAutoDownloadWifi: true,
  mediaAutoDownloadCellular: false,
};

let state: AppPreferences = DEFAULTS;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getAppPreferences(): AppPreferences {
  return state;
}

export async function loadAppPreferences(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as Partial<AppPreferences>;
    state = {
      ringtone: parsed.ringtone !== false,
      callDataSaver: parsed.callDataSaver === true,
      hideRecentsPreview: parsed.hideRecentsPreview !== false,
      mediaAutoDownloadWifi: parsed.mediaAutoDownloadWifi !== false,
      mediaAutoDownloadCellular: parsed.mediaAutoDownloadCellular === true,
    };
    emit();
  } catch {
    /* préférences illisibles : on garde les valeurs par défaut */
  }
}

export function setAppPreference<K extends keyof AppPreferences>(
  key: K,
  value: AppPreferences[K],
): void {
  state = { ...state, [key]: value };
  emit();
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function useAppPreference<K extends keyof AppPreferences>(
  key: K,
): [AppPreferences[K], (value: AppPreferences[K]) => void] {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state[key],
    () => state[key],
  );
  return [value, (next: AppPreferences[K]) => setAppPreference(key, next)];
}
