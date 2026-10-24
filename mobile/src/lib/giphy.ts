/**
 * Client GIPHY — appels directs depuis l'application.
 *
 * Les GIPHY API Terms of Service interdisent de proxifier les appels API ou les
 * chargements de médias (« All requests to GIPHY should be made directly from
 * the client ») : la clé bêta vit donc côté client et est traitée comme
 * publique par nature (révocable depuis le dashboard, plafonnée à 100 appels/h).
 * Le serveur ne relaie jamais GIPHY ; il valide seulement les URLs expédiées.
 */

import type { GifSendPayload } from './types';

const GIPHY_BASE = 'https://api.giphy.com/v1';

export const GIPHY_KEY_ENV = 'EXPO_PUBLIC_GIPHY_API_KEY';

/**
 * Clé définie dans `mobile/.env` (`EXPO_PUBLIC_GIPHY_API_KEY=…`). Elle part
 * dans le bundle comme toute clé client GIPHY — sa validité est plafonnée par
 * le quota bêta, pas par le secret.
 */
export const GIPHY_API_KEY: string =
  (process.env.EXPO_PUBLIC_GIPHY_API_KEY as string | undefined) ?? '';

export type GiphyFeed = 'gifs' | 'stickers';
export type GiphyMode = 'trending' | 'search';

/** Paramètres du bundle « messagerie » : rendus légers, sans clips ni restitutions lourdes. */
export const GIPHY_BUNDLE = 'messaging_non_clips';
export const GIPHY_LANG = 'fr';
export const GIPHY_RATING = 'g';

/** Un GIF prêt pour la grille et pour l'envoi. */
export interface GifPanelItem {
  id: string;
  /** Tuile de grille : rendu 100 px (WebP animé). */
  gridUrl: string;
  gridWidth: number;
  gridHeight: number;
  /** Aperçu statique affiché pendant le chargement réseau de la tuile. */
  gridStillUrl: string | null;
  /** Rendu d'envoi et d'affichage en conversation : rendu 200 px (WebP). */
  sendUrl: string;
  sendWidth: number;
  sendHeight: number;
  /** Aperçu statique (placeholder de la bulle en conversation). */
  stillUrl: string | null;
  username: string | null;
  title: string | null;
  /** Pingbacks analytics : URLs exactes renvoyées par GIPHY, jamais altérées. */
  onclick: string | null;
  onsent: string | null;
}

interface GiphyRendition {
  url?: string;
  width?: string;
  height?: string;
  webp?: string;
}

interface GiphyRawItem {
  id?: string;
  title?: string;
  username?: string;
  user?: { username?: string } | null;
  analytics?: {
    onclick?: { url?: string } | null;
    onsent?: { url?: string } | null;
  } | null;
  images?: Record<string, GiphyRendition | undefined>;
}

/** Construit l'URL d'endpoint — pure, testée sans réseau. */
export function buildGiphyUrl(options: {
  feed: GiphyFeed;
  mode: GiphyMode;
  apiKey: string;
  q?: string;
  limit: number;
  offset: number;
  customerId?: string;
}): string {
  const params = new URLSearchParams({
    api_key: options.apiKey,
    limit: String(Math.max(1, Math.min(options.limit, 50))),
    offset: String(Math.max(0, options.offset)),
    bundle: GIPHY_BUNDLE,
    lang: GIPHY_LANG,
    rating: GIPHY_RATING,
  });
  if (options.mode === 'search' && options.q) {
    params.set('q', options.q);
  }
  if (options.customerId) {
    params.set('customer_id', options.customerId);
  }
  return `${GIPHY_BASE}/${options.feed}/${options.mode}?${params.toString()}`;
}

function pixel(value: string | undefined, fallback: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Rendu WebP de préférence (transparence + poids), GIF sinon — URL intacte. */
function webP(rendition: GiphyRendition | undefined): string | undefined {
  return rendition?.webp || rendition?.url || undefined;
}

/**
 * Normalise un objet GIF renvoyé par GIPHY. Renvoie `null` pour un objet
 * incomplet (sans rendu exploitable) : on le retire, sans jamais réordonner
 * le reste — exigence GIPHY.
 */
export function toPanelItem(raw: GiphyRawItem): GifPanelItem | null {
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) return null;
  const images = raw.images;
  if (!images) return null;

  const grid = webP(images.fixed_width_small);
  if (!grid) return null;
  const gridWidth = pixel(images.fixed_width_small?.width, 100);
  const send = webP(images.fixed_width) ?? grid;
  const gridStill = images.fixed_width_small_still?.url;
  const stillFull = images.fixed_width_still?.url ?? gridStill;

  return {
    id,
    gridUrl: grid,
    gridWidth,
    gridHeight: pixel(images.fixed_width_small?.height, Math.round(gridWidth / 1.4)),
    gridStillUrl: typeof gridStill === 'string' && gridStill.startsWith('https') ? gridStill : null,
    sendUrl: send,
    sendWidth: pixel(images.fixed_width?.width, gridWidth * 2),
    sendHeight: pixel(images.fixed_width?.height, 200),
    stillUrl:
      typeof stillFull === 'string' && stillFull.startsWith('https') ? stillFull : null,
    username:
      (typeof raw.user?.username === 'string' && raw.user.username) ||
      (typeof raw.username === 'string' && raw.username) ||
      null,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null,
    onclick: raw.analytics?.onclick?.url ?? null,
    onsent: raw.analytics?.onsent?.url ?? null,
  };
}

export class GiphyError extends Error {
  /** Statut HTTP : 429 = quota bêta atteint (100 appels/h), 0 = réseau. */
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GiphyError';
    this.status = status;
  }
}

/**
 * Requête directe api.giphy.com : Trending ou Search, pour GIFs ou Stickers.
 * Les items incomplets sont retirés ; l'ordre renvoyé par GIPHY est conservé.
 */
export async function fetchGiphyFeed(options: {
  feed: GiphyFeed;
  mode: GiphyMode;
  q?: string;
  limit: number;
  offset: number;
  apiKey: string;
  customerId?: string;
}): Promise<GifPanelItem[]> {
  if (!options.apiKey) {
    throw new GiphyError(0, 'Clé GIPHY manquante');
  }
  const url = buildGiphyUrl(options);
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new GiphyError(0, 'Connexion à GIPHY impossible');
  }
  if (!response.ok) {
    throw new GiphyError(
      response.status,
      response.status === 429
        ? 'Quota GIPHY atteint (100 appels/h en bêta). Réessaie plus tard.'
        : 'GIPHY est indisponible pour le moment.',
    );
  }
  let payload: { data?: GiphyRawItem[] };
  try {
    payload = (await response.json()) as { data?: GiphyRawItem[] };
  } catch {
    throw new GiphyError(0, 'Réponse GIPHY illisible');
  }
  const items = payload.data;
  if (!Array.isArray(items)) {
    throw new GiphyError(0, 'Réponse GIPHY inattendue');
  }
  return items
    .map((raw) => toPanelItem(raw))
    .filter((item): item is GifPanelItem => item !== null);
}

/** Pingbacks analytics déjà déclenchés : un seul départ par URL. */
const pings = new Set<string>();

/**
 * Pingback analytics GIPHY (`onsent` recommandé à l'envoi, `onclick` à la
 * sélection). L'URL est celle retournée par l'API, augmentée seulement des
 * params officiels `customer_id` et `ts`. Silencieux : un ping perdu ne doit
 * jamais perturber l'envoi d'un message.
 */
export async function pingGiphy(url: string | null | undefined, customerId?: string): Promise<void> {
  if (!url) return;
  const key = customerId ? `${url}|${customerId}` : url;
  if (pings.has(key)) return;
  pings.add(key);
  try {
    const target = new URL(url);
    if (customerId) {
      target.searchParams.append('customer_id', customerId);
    }
    target.searchParams.append('ts', String(Date.now()));
    void fetch(target.toString()).catch(() => {});
  } catch {
    // URL analytics malformée : on renonce, sans conséquence utilisateur.
  }
}

/** Payload prêt pour la file d'envoi (outbox), à partir d'un item de panel. */
export function gifPayloadOf(item: GifPanelItem): GifSendPayload {
  return {
    url: item.sendUrl,
    width: item.sendWidth,
    height: item.sendHeight,
    giphyId: item.id,
    username: item.username ?? undefined,
    title: item.title ?? undefined,
    stillUrl: item.stillUrl ?? undefined,
  };
}
