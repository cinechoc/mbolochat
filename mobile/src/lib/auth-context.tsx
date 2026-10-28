import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { cache } from './cache';
import { resetEmojiFavorites } from '@/features/emoji/useEmojiFavorites';
import { resetRecentEmoji } from '@/features/emoji/useRecentEmoji';
import { resetStickerLibrary } from '@/features/stickers/stickerLibrary';
import { resetLocalStore } from './store';
import { syncPushToken, ensurePushRegistration, getExistingPushToken } from './push';
import { disconnectSocket } from './socket';
import { announcePresenceLogout } from '@/features/presence/presenceStore';
import {
  clearStoredTokens,
  getCachedAccessToken,
  getStoredAccessToken,
  getStoredRefreshToken,
  storeTokens,
} from './token-storage';
import type { User } from './types';

interface AuthState {
  token: string | null;
  user: User | null;
  loading: boolean;
  signIn: (accessToken: string, refreshToken: string, user: User) => Promise<void>;
  setUser: (user: User) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // À chaque session restaurée, on rafraîchit le jeton push (et l'adresse
  // de l'API que l'appareil utilise pour les photos de notification).
  useEffect(() => {
    if (!token) {
      return;
    }
    void syncPushToken(token);
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Le cache disque est chargé avant tout affichage : les pages s'ouvrent
      // ensuite instantanément, avec leur contenu déjà prêt.
      await cache.hydrate();
      try {
        const stored = await getStoredAccessToken();
        if (stored) {
          const me = await api.me(stored);
          if (!cancelled) {
            // `me` a pu rafraîchir le jeton : l'état doit garder le plus récent.
            setToken(getCachedAccessToken() ?? stored);
            setUser(me);
          }
        }
      } catch {
        const rt = await getStoredRefreshToken();
        if (rt) {
          try {
            const refreshed = await api.refresh(rt);
            const me = await api.me(refreshed.accessToken);
            if (!cancelled) {
              await storeTokens(refreshed.accessToken, refreshed.refreshToken ?? rt);
              setToken(refreshed.accessToken);
              setUser(me);
            }
          } catch {
            await clearStoredTokens();
          }
        } else {
          await clearStoredTokens();
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      token,
      user,
      loading,
      signIn: async (newToken, newRefresh, newUser) => {
        await storeTokens(newToken, newRefresh);
        setToken(newToken);
        setUser(newUser);
        // Premier login : demande la permission puis associe l'appareil.
        if (newUser.notificationsEnabled) {
          void ensurePushRegistration(newToken, { requestPermission: true });
        }
      },
      setUser: (u: User) => setUser(u),
      signOut: async () => {
        // Ne laisser derrière soi le jeton d'aucun appareil partagé.
        try {
          const pushToken = await getExistingPushToken();
          if (token && pushToken) {
            await api.removePushToken(token, pushToken);
          }
        } catch {
          // ignore : le logout ne doit pas être bloqué par le réseau
        }
        const rt = await getStoredRefreshToken();
        try {
          if (token) await api.logout(rt ?? undefined, token);
        } catch {
          // ignore
        }
        await announcePresenceLogout();
        await clearStoredTokens();
        disconnectSocket();
        setToken(null);
        setUser(null);
        cache.flush();
        void cache.clear();
        // La file d'envoi, le curseur et l'historique d'émojis appartiennent à
        // ce compte : ils ne doivent pas passer sur le suivant.
        void resetLocalStore();
        void resetRecentEmoji();
        void resetEmojiFavorites();
        void resetStickerLibrary();
      },
    }),
    [token, user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return context;
}
