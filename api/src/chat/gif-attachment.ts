import { type MessageAttachment } from '../db/schema.js';

/**
 * Validation d'une pièce jointe GIF externe (GIPHY).
 *
 * Le client appelle GIPHY directement (exigence des GIPHY API Terms of
 * Service : « Do not proxy requests to GIPHY ») et nous transmet l'URL du
 * média choisi. Le serveur ne relaie jamais GIPHY : il valide uniquement que
 * l'URL expédiée est bien celle d'un média des CDN GIPHY, jamais altérée ni
 * re-hébergée. Une URL d'un autre domaine serait une faille (charge utile
 * arbitraire servie par l'app) — allowlist stricte obligatoire.
 */

/** `media.giphy.com` ou les variantes indexées `media0..mediaN.giphy.com`. */
const MEDIA_HOST_PATTERN = /^media\d*\.giphy\.com$/;

const MAX_URL_LENGTH = 2048;
const MAX_DIMENSION = 4096;
const MAX_LENGTH = {
  giphyId: 64,
  title: 120,
  username: 64,
};

export class InvalidGifAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGifAttachmentError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** HTTPS + host allowlist ; le chemin et les query params restent intacts. */
function isAllowedMediaUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  return MEDIA_HOST_PATTERN.test(parsed.hostname);
}

/** Entier strictement positif, borné. */
function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return undefined;
  }
  if (value <= 0 || value > MAX_DIMENSION) {
    return undefined;
  }
  return value;
}

/** Texte court sans caractères de contrôle. */
function shortText(value: unknown, maxLength: number, pattern?: RegExp): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // On retire les caractères de contrôle, invisibles ou accidentels.
    if (code < 0x20 || code === 0x7f) continue;
    cleaned += char;
  }
  const normalized = cleaned.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    return undefined;
  }
  if (pattern && !pattern.test(normalized)) {
    return undefined;
  }
  return normalized;
}

/**
 * Normalise le payload `gif` d'un `message:send`. Lève
 * `InvalidGifAttachmentError` dès qu'une règle n'est pas respectée.
 */
export function normalizeGifAttachment(input: unknown): MessageAttachment {
  if (!isPlainObject(input)) {
    throw new InvalidGifAttachmentError('Pièce jointe GIF invalide');
  }
  const { url } = input;
  // Les clients peuvent transmettre `stillUrl: null` (champ absent côté GIPHY).
  const stillUrl =
    typeof input.stillUrl === 'string' && input.stillUrl.length > 0 ? input.stillUrl : undefined;
  if (!isAllowedMediaUrl(url)) {
    throw new InvalidGifAttachmentError('URL GIF non autorisée');
  }
  if (stillUrl !== undefined && !isAllowedMediaUrl(stillUrl)) {
    throw new InvalidGifAttachmentError('URL aperçu non autorisée');
  }
  const width = positiveInt(input.width);
  const height = positiveInt(input.height);
  if (input.width !== undefined && width === undefined) {
    throw new InvalidGifAttachmentError('Dimensions GIF invalides');
  }
  if (input.height !== undefined && height === undefined) {
    throw new InvalidGifAttachmentError('Dimensions GIF invalides');
  }
  const giphyId = shortText(input.giphyId, MAX_LENGTH.giphyId, /^[\w-]+$/);
  const title = shortText(input.title, MAX_LENGTH.title);
  const username = shortText(input.username, MAX_LENGTH.username);
  const sticker = input.sticker === true;
  return {
    type: 'GIF',
    // Format du bundle messagerie de GIPHY : WebP animé (transparence pour les
    // stickers, poids réduit pour les pleins cadre).
    mime: sticker ? 'image/webp' : 'image/gif',
    url,
    size: 0,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    sticker,
    ...(giphyId !== undefined ? { giphyId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(stillUrl !== undefined ? { stillUrl } : {}),
  };
}
