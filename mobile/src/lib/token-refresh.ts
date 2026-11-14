import { API_URL } from './config';

/**
 * Rafraîchissement des jetons, isolé du module API complet.
 *
 * Les téléchargements de médias et le socket n'ont pas besoin de tout `api.ts`
 * (et de ses dépendances Expo) pour renouveler un access token. Ce module reste
 * volontairement léger et partage le verrou avec les appels API.
 */
let refreshInFlight: Promise<string> | null = null;

/** Échec de rafraîchissement explicite, sans jamais inclure un jeton. */
export class TokenRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenRefreshError';
  }
}

async function doRefresh(refreshToken: string, epoch: number): Promise<string> {
  const storage = await import('./token-storage');
  if (storage.getAuthSessionEpoch() !== epoch) {
    throw new TokenRefreshError('Session ended during refresh');
  }
  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    credentials: 'include',
  });
  if (!response.ok) {
    throw new TokenRefreshError(`Refresh failed (${response.status})`);
  }
  const data = (await response.json()) as { accessToken: string; refreshToken?: string };
  const currentRefresh = await storage.getStoredRefreshToken();
  // Une déconnexion (ou une nouvelle connexion) pendant l'appel réseau rend
  // cette réponse obsolète : la persister ressusciterait l'ancienne session.
  if (storage.getAuthSessionEpoch() !== epoch || currentRefresh !== refreshToken) {
    throw new TokenRefreshError('Session changed during refresh');
  }
  await storage.storeTokens(data.accessToken, data.refreshToken ?? refreshToken);
  return data.accessToken;
}

export async function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const storage = await import('./token-storage');
      const epoch = storage.getAuthSessionEpoch();
      const rt = await storage.getStoredRefreshToken();
      if (!rt) throw new TokenRefreshError('No refresh token');
      return await doRefresh(rt, epoch);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
