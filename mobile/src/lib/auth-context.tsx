import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { cache } from './cache';
import { isTransientSessionError } from './auth-restore';
import { resetEmojiFavorites } from '@/features/emoji/useEmojiFavorites';
import { resetRecentEmoji } from '@/features/emoji/useRecentEmoji';
import { resetStickerLibrary } from '@/features/stickers/stickerLibrary';
import { sweepSecureMedia } from '@/features/e2ee/mediaStore';
import { resetE2eeInitState } from '@/features/e2ee/initState';
import { activateLocalStore } from './store';
import { syncPushToken, ensurePushRegistration, getExistingPushToken } from './push';
import { disconnectSocket } from './socket';
import { announcePresenceLogout } from '@/features/presence/presenceStore';
import {
  clearStoredTokens,
  getCachedUser,
  getCachedAccessToken,
  getStoredAccessToken,
  getStoredRefreshToken,
  storeCachedUser,
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
      const restoreOffline = async (
        accessToken: string,
        cachedUser: User | null,
      ): Promise<boolean> => {
        if (!cachedUser) return false;
        await cache.prepareForUser(cachedUser.id);
        await activateLocalStore(cachedUser.id).catch(() => undefined);
        if (!cancelled) {
          setToken(getCachedAccessToken() ?? accessToken);
          setUser(cachedUser);
        }
        return true;
      };
      try {
        const stored = await getStoredAccessToken();
        const cachedUser = await getCachedUser();
        if (stored) {
          try {
            const me = await api.me(stored);
            await storeCachedUser(me);
            if (!cancelled) {
              await cache.prepareForUser(me.id);
              await activateLocalStore(me.id).catch(() => undefined);
              // `me` a pu rafraîchir le jeton : l'état doit garder le plus récent.
              setToken(getCachedAccessToken() ?? stored);
              setUser(me);
            }
          } catch (error) {
            if (isTransientSessionError(error) && (await restoreOffline(stored, cachedUser))) {
              return;
            }
            const rt = await getStoredRefreshToken();
            if (!rt) {
              if (isTransientSessionError(error) && (await restoreOffline(stored, cachedUser))) {
                return;
              }
              await clearStoredTokens();
              return;
            }
            try {
              const refreshed = await api.refresh(rt);
              await storeTokens(refreshed.accessToken, refreshed.refreshToken ?? rt);
              const me = await api.me(refreshed.accessToken);
              await storeCachedUser(me);
              if (!cancelled) {
                await cache.prepareForUser(me.id);
                await activateLocalStore(me.id).catch(() => undefined);
                setToken(refreshed.accessToken);
                setUser(me);
              }
            } catch (refreshError) {
              if (
                isTransientSessionError(refreshError) &&
                (await restoreOffline(stored, cachedUser))
              ) {
                return;
              }
              await clearStoredTokens();
            }
          }
        } else {
          const rt = await getStoredRefreshToken();
          if (!rt) {
            await clearStoredTokens();
            return;
          }
          try {
            const refreshed = await api.refresh(rt);
            await storeTokens(refreshed.accessToken, refreshed.refreshToken ?? rt);
            const me = await api.me(refreshed.accessToken);
            await storeCachedUser(me);
            if (!cancelled) {
              await cache.prepareForUser(me.id);
              await activateLocalStore(me.id).catch(() => undefined);
              setToken(refreshed.accessToken);
              setUser(me);
            }
          } catch (refreshError) {
            if (isTransientSessionError(refreshError)) {
              return;
            }
            await clearStoredTokens();
          }
        }
      } catch {
        // Le stockage sécurisé lui-même a échoué : ne pas détruire une session
        // potentiellement valide sur une erreur locale transitoire.
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
        await cache.prepareForUser(newUser.id);
        await activateLocalStore(newUser.id).catch(() => undefined);
        await storeTokens(newToken, newRefresh);
        await storeCachedUser(newUser);
        setToken(newToken);
        setUser(newUser);
        // Premier login : demande la permission puis associe l'appareil.
        if (newUser.notificationsEnabled) {
          void ensurePushRegistration(newToken, { requestPermission: true });
        }
      },
      setUser: (u: User) => {
        setUser(u);
        void storeCachedUser(u);
      },
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
        resetE2eeInitState();
        // Le cache et la file restent attachés à ce compte : une reconnexion du
        // même utilisateur retrouve son état. Au prochain compte, ils sont
        // nettoyés avant que son identité soit publiée à l'interface.
        await cache.flush();
        // Un clair de média lu par ce compte ne doit pas survivre à la
        // déconnexion, même si l'appareil reste allumé.
        sweepSecureMedia();
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
