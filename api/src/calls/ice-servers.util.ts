/** Ordre des serveurs ICE : direct d'abord, relais UDP, TCP, puis TLS 443. */
export function iceRank(url: string): number {
  const value = url.trim().toLowerCase();
  if (value.startsWith('turns:')) {
    // TLS sur 443 : le seul détour qui passe quand l'UDP est bloqué.
    return 3;
  }
  if (value.startsWith('turn:')) {
    return value.includes('transport=tcp') ? 2 : 1;
  }
  return 0;
}

/**
 * Les réseaux mobiles bloquent souvent l'UDP : on essaye le direct, puis le
 * relais UDP, puis TCP, et le TLS en dernier recours. L'ordre est stable.
 */
export function orderIceUrls(urls: string[]): string[] {
  return urls
    .map((url, index) => ({ url, index, rank: iceRank(url) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.url);
}
