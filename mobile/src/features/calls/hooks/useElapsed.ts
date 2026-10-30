import { useEffect, useState } from 'react';

/**
 * Temps écoulé depuis `startedAt`, mesuré hors du rendu : `Date.now()` n'est
 * jamais appelé pendant le rendu et seul ce composant se re-rend au tic.
 */
export function useElapsed(startedAt: number | null, active: boolean, intervalMs = 500): number {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!active || !startedAt) {
      return;
    }
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), intervalMs);
    return () => clearInterval(timer);
  }, [active, startedAt, intervalMs]);

  return elapsedMs;
}

/** `3:07`, la base du minuteur d'appel et des messages système de fin d'appel. */
export function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
