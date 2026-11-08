import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';

import { fr } from '@/i18n/fr';
import { useAuth } from '@/lib/auth-context';
import {
  claimKeysLostNotice,
  describeE2eeFailure,
  getE2eeInitState,
  subscribeE2eeInit,
} from './initState';
import { runE2eeInit } from './initRunner';
import { isE2eeEnabled } from './policy';

/**
 * Prépare les clés E2EE au login, sans interface visible.
 *
 * Une erreur d'initialisation n'est plus avalée : elle est enregistrée dans
 * l'état partagé (que l'écran chiffré consulte) et signalée une seule fois par
 * échec distinct, avec une reprise possible. Rien n'est jamais marqué « prêt »
 * quand la base chiffrée ou les clés n'ont pas pu être chargées.
 */
export function E2eeBootstrapGate() {
  const { token } = useAuth();
  const state = useSyncExternalStore(subscribeE2eeInit, getE2eeInitState, getE2eeInitState);
  const alertedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!token || !isE2eeEnabled()) return;
    let cancelled = false;
    void runE2eeInit(token).then((result) => {
      if (!cancelled && claimKeysLostNotice(result?.recovered)) {
        Alert.alert(fr.e2ee.keysLostTitle, fr.e2ee.keysLostBody);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!state || state.status === 'idle' || state.status === 'pending' || state.status === 'ready') {
      alertedRef.current = null;
      return;
    }
    const signature = `${state.status}:${state.failure}`;
    if (alertedRef.current === signature) return;
    alertedRef.current = signature;
    const { title, body } = describeE2eeFailure(state.failure);
    Alert.alert(title, body, [
      { text: fr.e2ee.initLater, style: 'cancel' },
      {
        text: fr.e2ee.retry,
        onPress: () => {
          if (!token) return;
          alertedRef.current = null;
          void runE2eeInit(token, { force: true });
        },
      },
    ]);
  }, [state, token]);

  return null;
}
