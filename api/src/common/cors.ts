/**
 * Origines autorisées pour le web (HTTP et WebSocket).
 *
 * Source unique de la règle, partagée entre `main.ts` (CORS HTTP) et les
 * gateways Socket.IO : la même allowlist `CORS_ORIGINS`, les mêmes cas.
 *
 * - Les applications mobiles n'envoient pas d'en-tête `Origin` : elles
 *   passent toujours (aucune origine à vérifier).
 * - Le client web servi par la même API doit déclarer son origine dans
 *   `CORS_ORIGINS` ; toute autre page web est refusée, avec ou sans jeton.
 *   C'est ce qui empêche une page quelconque d'appeler l'API (ou d'ouvrir
 *   un socket) avec les identifiants d'un visiteur connecté.
 */
export function allowedOriginsFromEnv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  return !origin || allowedOrigins.includes(origin);
}

/**
 * Fonction d'origine au format `cors` / Socket.IO : autorise sans
 * d'en-tête Origin (mobile), autorise les origines de `CORS_ORIGINS`,
 * refuse le reste. Lue à chaque handshake (et non figée au démarrage) pour
 * suivre un changement de configuration sans redémarrer le processus.
 */
export function corsOrigin(
  origin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void,
): void {
  const allowedOrigins = allowedOriginsFromEnv(process.env.CORS_ORIGINS);
  callback(null, isAllowedOrigin(origin, allowedOrigins));
}

/**
 * Garde-fou du handshake Socket.IO, tous transports confondus.
 *
 * L'option `cors` ne couvre que le polling : un navigateur peut ouvrir un
 * WebSocket depuis n'importe quelle origine (le WebSocket n'est pas soumis
 * au même-origin policy) et le transport `websocket` obtenait un 101 même
 * avec une origine interdite. L'authentification JWT reste exigée ensuite,
 * mais un serveur ne doit pas accepter la connexion d'une page web non
 * déclarée : `allowRequest` rejette le handshake avant toute montée en
 * version, sans en-tête Origin (mobile) toujours accepté.
 */
export function socketAllowRequest(
  req: { headers?: Record<string, string | string[] | undefined> },
  callback: (error: string | null | undefined, success: boolean) => void,
): void {
  const rawOrigin = req?.headers?.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  const allowedOrigins = allowedOriginsFromEnv(process.env.CORS_ORIGINS);
  if (isAllowedOrigin(origin, allowedOrigins)) {
    callback(null, true);
    return;
  }
  callback('Origin not allowed', false);
}
