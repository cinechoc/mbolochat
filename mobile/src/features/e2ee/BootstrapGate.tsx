import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Alert, AppState } from 'react-native';

import { fr } from '@/i18n/fr';
import { useAuth } from '@/lib/auth-context';
import {
  claimKeysLostNotice,
  describeE2eeFailure,
  getE2eeInitState,
  resetE2eeInitState,
  subscribeE2eeInit,
} from './initState';
import { runE2eeInit } from './initRunner';
import { wakeE2eeOutboxRecovery } from './outboxRecovery';
import { isE2eeEnabled } from './policy';

/** Reprise automatique : courte au début, plafonnée pour ne pas vider la batterie. */
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000];

/**
 * Prépare les clés E2EE au login, sans interface visible.
 *
 * Une erreur d'initialisation n'est plus avalée : elle est enregistrée dans
 * l'état partagé (que l'écran chiffré consulte) et signalée une seule fois par
 * échec distinct, avec une reprise possible. Rien n'est jamais marqué « prêt »
 * quand la base chiffrée ou les clés n'ont pas pu être chargées.
 */
export function E2eeBootstrapGate() {
  const { token, user } = useAuth();
  const userId = user?.id;
  const state = useSyncExternalStore(subscribeE2eeInit, getE2eeInitState, getE2eeInitState);
  const alertedRef = useRef<string | null>(null);

  // Déconnexion : aucun état « prêt » ne doit survivre au compte suivant.
  useEffect(() => {
    if (!token) resetE2eeInitState();
  }, [token]);

  useEffect(() => {
    alertedRef.current = null;
    if (!token || !userId || !isE2eeEnabled()) return;
    let cancelled = false;
    let attempt = 0;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = (delay: number) => {
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, delay);
    };

    const run = async (): Promise<void> => {
      if (cancelled || running) return;
      running = true;
      try {
        // Sans `force`, une initialisation déjà en cours est partagée : deux
        // écrans ne peuvent pas ouvrir et publier les clés en parallèle.
        const result = await runE2eeInit(token, userId);
        if (cancelled) return;
        if (claimKeysLostNotice(result?.recovered)) {
          Alert.alert(fr.e2ee.keysLostTitle, fr.e2ee.keysLostBody);
        }
        if (result?.disabled || getE2eeInitState().status === 'ready') {
          attempt = 0;
          if (!result?.disabled) wakeE2eeOutboxRecovery();
          return;
        }
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        attempt += 1;
        schedule(delay);
      } finally {
        running = false;
      }
    };

    void run();
    // Retour d'application : le réseau a pu revenir depuis l'échec.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active' || cancelled) return;
      attempt = 0;
      if (!running) void run();
    });
    return () => {
      cancelled = true;
      clearTimer();
      subscription.remove();
    };
  }, [token, userId]);

  useEffect(() => {
    if (!state || state.status === 'idle' || state.status === 'ready') {
      alertedRef.current = null;
      return;
    }
    // Une reprise automatique repasse par `pending` : ne pas réafficher une
    // alerte toutes les secondes. Le bouton « Réessayer » remet le compteur à
    // zéro explicitement.
    if (state.status === 'pending') return;
    const signature = `${state.status}:${state.failure}`;
    if (alertedRef.current === signature) return;
    alertedRef.current = signature;
    const { title, body } = describeE2eeFailure(state.failure);
    Alert.alert(title, body, [
      { text: fr.e2ee.initLater, style: 'cancel' },
      {
        text: fr.e2ee.retry,
        onPress: () => {
          if (!token || !userId) return;
          alertedRef.current = null;
          void runE2eeInit(token, userId, { force: true });
        },
      },
    ]);
  }, [state, token, userId]);

  return null;
}
