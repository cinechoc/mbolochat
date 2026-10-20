import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { cache } from './cache';
import {
  clearStoredTokens,
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await getStoredAccessToken();
        if (stored) {
          const me = await api.me(stored);
          if (!cancelled) {
            setToken(stored);
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
      },
      setUser: (u: User) => setUser(u),
      signOut: async () => {
        const rt = await getStoredRefreshToken();
        try {
          if (token) await api.logout(rt ?? undefined, token);
        } catch {
          // ignore
        }
        await clearStoredTokens();
        setToken(null);
        setUser(null);
        cache.clear();
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
