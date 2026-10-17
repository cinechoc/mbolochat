import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { clearStoredToken, getStoredToken, storeToken } from './token-storage';
import type { User } from './types';

interface AuthState {
  token: string | null;
  user: User | null;
  loading: boolean;
  signIn: (token: string, user: User) => Promise<void>;
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
        const stored = await getStoredToken();
        if (stored) {
          const me = await api.me(stored);
          if (!cancelled) {
            setToken(stored);
            setUser(me);
          }
        }
      } catch {
        await clearStoredToken();
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
      signIn: async (newToken, newUser) => {
        await storeToken(newToken);
        setToken(newToken);
        setUser(newUser);
      },
      signOut: async () => {
        await clearStoredToken();
        setToken(null);
        setUser(null);
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
