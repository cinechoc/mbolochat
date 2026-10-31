import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

export type ThemePreference = 'system' | 'light' | 'dark';

type ThemeContextValue = {
  preference: ThemePreference;
  scheme: 'light' | 'dark';
  setPreference: (preference: ThemePreference) => void;
};

const STORAGE_KEY = 'mbolo.theme-preference';
const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Préférence d'apparence de l'app : système par défaut, ou forcée. */
export function ThemePreferenceProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  const [preference, setStored] = useState<ThemePreference>('system');

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(STORAGE_KEY).then((value) => {
      if (!cancelled && (value === 'light' || value === 'dark' || value === 'system')) {
        setStored(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setStored(next);
    void AsyncStorage.setItem(STORAGE_KEY, next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      scheme: preference === 'system' ? system : preference,
      setPreference,
    }),
    [preference, system, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemePreference(): ThemeContextValue {
  const context = useContext(ThemeContext);
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  return context ?? { preference: 'system', scheme: system, setPreference: () => {} };
}
