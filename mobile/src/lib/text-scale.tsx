import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type TextSize = 'small' | 'normal' | 'large';

type TextScaleContextValue = {
  size: TextSize;
  factor: number;
  setSize: (size: TextSize) => void;
};

const STORAGE_KEY = 'mbolo.text-size';
const FACTORS: Record<TextSize, number> = { small: 0.9, normal: 1, large: 1.15 };
const TextScaleContext = createContext<TextScaleContextValue | null>(null);

/** Taille du texte de l'application, appliquée aux composants de texte. */
export function TextScaleProvider({ children }: { children: ReactNode }) {
  const [size, setStored] = useState<TextSize>('normal');

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(STORAGE_KEY).then((value) => {
      if (!cancelled && (value === 'small' || value === 'normal' || value === 'large')) {
        setStored(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setSize = useCallback((next: TextSize) => {
    setStored(next);
    void AsyncStorage.setItem(STORAGE_KEY, next);
  }, []);

  const value = useMemo<TextScaleContextValue>(
    () => ({ size, factor: FACTORS[size], setSize }),
    [size, setSize],
  );

  return <TextScaleContext.Provider value={value}>{children}</TextScaleContext.Provider>;
}

export function useTextScale(): TextScaleContextValue {
  return useContext(TextScaleContext) ?? { size: 'normal', factor: 1, setSize: () => {} };
}
