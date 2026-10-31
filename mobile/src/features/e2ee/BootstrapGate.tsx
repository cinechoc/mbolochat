import { useEffect } from 'react';
import { Alert } from 'react-native';

import { fr } from '@/i18n/fr';
import { useAuth } from '@/lib/auth-context';
import { bootstrapE2ee } from './bootstrap';
import { isE2eeEnabled } from './policy';

/** Prépare les clés E2EE au login, sans aucune interface visible. */
export function E2eeBootstrapGate() {
  const { token } = useAuth();

  useEffect(() => {
    if (!token || !isE2eeEnabled()) {
      return;
    }
    let cancelled = false;
    void bootstrapE2ee(token)
      .then((result) => {
        if (!cancelled && result.recovered) {
          Alert.alert(fr.e2ee.keysLostTitle, fr.e2ee.keysLostBody);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);

  return null;
}
