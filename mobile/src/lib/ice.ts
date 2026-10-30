/**
 * Serveurs ICE du client : STUN + TURN lus depuis l'environnement, jamais en
 * dur. Remplacer Metered par un coturn dédié = changer `mobile/.env`.
 */
export interface IceServerConfig {
  urls: string;
  username?: string;
  credential?: string;
}

const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

function listFromEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

import { API_URL } from './config';

const CACHE_FALLBACK_MS = 6 * 60 * 60 * 1000;
const CACHE_REFRESH_RATIO = 0.8;

let cached: { servers: IceServerConfig[]; expiresAt: number } | null = null;

/**
 * Serveurs STUN/TURN servis par l'API (identifiants jamais embarqués).
 * Cache mémoire honorant le TTL annoncé, avec repli sur la dernière valeur
 * connue puis sur la configuration locale si le serveur est injoignable.
 */
export async function ensureIceServers(token: string): Promise<IceServerConfig[]> {
  if (cached && cached.expiresAt > Date.now()) {
    return cached.servers;
  }
  try {
    const response = await fetch(`${API_URL}/calls/ice-servers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`ice-servers ${response.status}`);
    }
    const body = (await response.json()) as { ttlMs?: number; servers?: IceServerConfig[] };
    if (Array.isArray(body.servers) && body.servers.length > 0) {
      cached = {
        servers: body.servers,
        // Rafraîchi à 80 % du TTL : jamais de crédits expirés en plein appel.
        expiresAt:
          Date.now() +
          Math.min(body.ttlMs ?? CACHE_FALLBACK_MS, CACHE_FALLBACK_MS) * CACHE_REFRESH_RATIO,
      };
      return cached.servers;
    }
  } catch {
    /* hors-ligne : on garde la dernière configuration connue */
  }
  return cached?.servers ?? buildIceServers();
}

/** Repli local (développement hors serveur) : STUN publics uniquement. */
export function buildIceServers(): IceServerConfig[] {
  const stunUrls = listFromEnv(process.env.EXPO_PUBLIC_STUN_URLS);
  const servers: IceServerConfig[] = (stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS).map(
    (urls) => ({ urls }),
  );

  const turnUrls = listFromEnv(
    process.env.EXPO_PUBLIC_TURN_URLS ?? process.env.EXPO_PUBLIC_TURN_URL,
  );
  const username = process.env.EXPO_PUBLIC_TURN_USERNAME;
  const credential = process.env.EXPO_PUBLIC_TURN_CREDENTIAL;
  if (turnUrls.length > 0 && username && credential) {
    for (const urls of turnUrls) {
      servers.push({ urls, username, credential });
    }
  }
  return servers;
}
