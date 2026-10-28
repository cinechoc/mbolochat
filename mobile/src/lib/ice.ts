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
