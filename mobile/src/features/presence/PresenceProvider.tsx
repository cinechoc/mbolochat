import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/lib/auth-context';
import { connectSocket, onConnection } from '@/lib/socket';

import { configurePresence, resetPresence } from './presenceStore';

const HEARTBEAT_MS = 25_000;
const INACTIVE_GRACE_MS = 1_500;

/**
 * Un seul fournisseur pour la session : entrée/sortie de veille, battements et
 * réabonnement après reconnexion. Aucun timer ne tourne en arrière-plan.
 */
export function PresenceProvider() {
  const { token, loading } = useAuth();
  const [active, setActive] = useState(AppState.currentState === 'active');

  useEffect(() => {
    let inactiveTimer: ReturnType<typeof setTimeout> | null = null;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        if (inactiveTimer) {
          clearTimeout(inactiveTimer);
          inactiveTimer = null;
        }
        setActive(true);
        return;
      }
      if (state === 'background') {
        if (inactiveTimer) {
          clearTimeout(inactiveTimer);
          inactiveTimer = null;
        }
        setActive(false);
        return;
      }
      if (state === 'inactive') {
        if (inactiveTimer) clearTimeout(inactiveTimer);
        inactiveTimer = setTimeout(() => {
          inactiveTimer = null;
          setActive(false);
        }, INACTIVE_GRACE_MS);
      }
    });
    return () => {
      if (inactiveTimer) clearTimeout(inactiveTimer);
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (loading || !token) {
      resetPresence();
      return;
    }
    configurePresence(token);
    return () => resetPresence();
  }, [loading, token]);

  useEffect(() => {
    if (loading || !token || !active) return;

    const socket = connectSocket(token);
    const offConnection = onConnection((connected) => {
      if (connected) socket.emit('presence:foreground');
    });
    const heartbeat = setInterval(() => {
      if (socket.connected) socket.emit('presence:heartbeat');
    }, HEARTBEAT_MS);

    return () => {
      clearInterval(heartbeat);
      offConnection();
      if (socket.connected) socket.emit('presence:background');
    };
  }, [active, loading, token]);

  return null;
}
