import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/lib/auth-context';
import { captureCity } from '@/lib/location';

/**
 * Le serveur applique lui-même le délai de 24 h et l'anti-téléportation. Ce
 * throttle évite simplement de redemander la position à chaque retour au
 * premier plan ; il laisse aussi passer un déménagement dans la journée.
 */
const ATTEMPT_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Après un échec (réseau, GPS indisponible), on retente sans insister. */
const FAILURE_RETRY_MS = 15 * 60 * 1000;
const STORAGE_PREFIX = 'mbolo.location.last-attempt.';

async function readLastAttempt(userId: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_PREFIX + userId);
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

async function writeLastAttempt(userId: string, at: number): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_PREFIX + userId, String(at));
  } catch {
    // Le throttle est une optimisation : un échec d'écriture ne doit rien bloquer.
  }
}

/**
 * Détection silencieuse de la ville : aucune demande de permission, aucun
 * bouton. Tant que l'accès n'est pas accordé depuis les paramètres, chaque
 * tentative s'arrête d'elle-même.
 */
export function CityAutoDetector() {
  const { token, user, loading } = useAuth();
  const userId = user?.id ?? null;
  const inFlight = useRef(false);
  const retryAfterFailureAt = useRef(0);

  useEffect(() => {
    if (loading || !token || !userId) {
      return;
    }

    let cancelled = false;

    const attempt = async () => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      try {
        const last = await readLastAttempt(userId);
        if (cancelled || Date.now() - last < ATTEMPT_INTERVAL_MS) {
          return;
        }
        if (Date.now() < retryAfterFailureAt.current) {
          return;
        }
        const status = await captureCity(token);
        if (cancelled) {
          return;
        }
        // Permission refusée ou module absent : l'état peut changer à tout
        // moment (activation dans les paramètres), donc on ne throttle pas.
        if (status === 'denied' || status === 'unavailable') {
          return;
        }
        if (status === 'failed') {
          retryAfterFailureAt.current = Date.now() + FAILURE_RETRY_MS;
          return;
        }
        await writeLastAttempt(userId, Date.now());
      } finally {
        inFlight.current = false;
      }
    };

    void attempt();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void attempt();
      }
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [loading, token, userId]);

  return null;
}
