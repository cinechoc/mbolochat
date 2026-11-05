import { fromByteArray, toByteArray } from 'base64-js';

/**
 * Encodage du texte clair qui entre dans l'enveloppe Olm.
 *
 * Le noyau ne manipule que des octets ; `encodeText` transforme une chaîne JS en
 * base64 par une voie qui préserve les octets UTF-8 (pas `btoa`, qui casse dès
 * qu'un caractère dépasse un octet), et `decodeText` fait l'inverse.
 *
 * Deux versions coexistent dans l'enveloppe :
 * - `v:1` texte : `{v:1, text}` — le format historique de M2, à ne jamais casser ;
 * - `v:2` média : `{v:2, kind:'media', media, thumb?, caption?}` — la référence du
 *   ciphertext et sa clé, décrites ci-dessous.
 */

/** Référence d'un blob chiffré telle qu'elle voyage dans l'enveloppe Olm. */
export interface EncryptedBlob {
  /** Identifiant de l'upload chiffré (servi par `GET /uploads/:id`). */
  uploadId: string;
  /** Clé du fichier, base64 — ne quitte jamais le chiffré Olm. */
  fileKey: string;
  /** Nonce de la construction STREAM, base64. */
  nonce: string;
  /** Empreinte SHA-256 du clair, hexadécimale, pour détecter une altération. */
  sha256: string;
  /** Taille du clair, en octets. */
  size: number;
}

/** Description d'un média chiffré : ce qu'il faut pour l'afficher et le lire. */
export interface EncryptedMedia {
  /** Nature d'affichage (pilote la bulle : image, vidéo, audio, document). */
  type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';
  /** Type MIME du clair (image/jpeg…), jamais celui du ciphertext. */
  mime: string;
  /** Nom d'origine, pour les documents. */
  name?: string;
  width?: number;
  height?: number;
  /** Durée d'un vocal ou d'une vidéo, en millisecondes. */
  duration?: number;
  /** Forme d'onde d'un vocal (0..1), comme en clair. Non chiffrée en soi. */
  waveform?: number[];
  /** Blob du média lui-même. */
  blob: EncryptedBlob;
  /** Blob de la vignette, s'il existe (photo, vidéo). */
  thumb?: EncryptedBlob;
}

export type ParsedPayload =
  | { kind: 'text'; text: string }
  | { kind: 'media'; media: EncryptedMedia; caption: string };

export type PayloadError = 'invalid_payload' | 'unsupported_version';

export class InvalidPayloadError extends Error {
  constructor(readonly reason: PayloadError) {
    super(reason);
  }
}

/** Chaîne UTF-8 → base64, octet pour octet. */
export function encodeText(value: string): string {
  const encoded = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === '%') {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index));
    }
  }
  return fromByteArray(Uint8Array.from(bytes));
}

/** base64 → chaîne UTF-8. */
export function decodeText(value: string): string {
  const bytes = toByteArray(value);
  let encoded = '';
  for (const byte of bytes) {
    encoded += `%${byte.toString(16).padStart(2, '0')}`;
  }
  return decodeURIComponent(encoded);
}

/** Sérialise le contenu `v:1` d'un message texte. */
export function buildTextV1(text: string): string {
  return encodeText(JSON.stringify({ v: 1, text }));
}

/** Sérialise le contenu `v:2` d'un média chiffré. */
export function buildMediaV2(media: EncryptedMedia, caption = ''): string {
  return encodeText(JSON.stringify({ v: 2, kind: 'media', media, caption }));
}

function isBlob(value: unknown): value is EncryptedBlob {
  if (!value || typeof value !== 'object') return false;
  const blob = value as Record<string, unknown>;
  return (
    typeof blob.uploadId === 'string' &&
    typeof blob.fileKey === 'string' &&
    typeof blob.nonce === 'string' &&
    typeof blob.sha256 === 'string' &&
    typeof blob.size === 'number'
  );
}

const MEDIA_TYPES = new Set(['IMAGE', 'VIDEO', 'AUDIO', 'FILE']);

function isMedia(value: unknown): value is EncryptedMedia {
  if (!value || typeof value !== 'object') return false;
  const media = value as Record<string, unknown>;
  if (typeof media.type !== 'string' || !MEDIA_TYPES.has(media.type)) return false;
  if (typeof media.mime !== 'string') return false;
  if (!isBlob(media.blob)) return false;
  if (media.thumb !== undefined && !isBlob(media.thumb)) return false;
  return true;
}

/**
 * Sérialise une description de média pour la base locale chiffrée. Les clés du
 * fichier y sont incluses : c'est la seule copie qui permet de re-déchiffrer
 * plus tard, et elle ne vit que dans la base SQLCipher.
 */
export function encodeMediaMeta(media: EncryptedMedia): string {
  return JSON.stringify(media);
}

/** Relit une description de média stockée, ou `null` si elle est illisible. */
export function decodeMediaMeta(raw: string | null | undefined): EncryptedMedia | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isMedia(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Décode le contenu d'une enveloppe. Lève `InvalidPayloadError` sur tout ce qui
 * n'est ni un texte v1 ni un média v2 reconnu : un payload d'une version future
 * ne doit jamais être interprété à moitié.
 */
export function parsePayload(plaintextB64: string): ParsedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(plaintextB64));
  } catch {
    throw new InvalidPayloadError('invalid_payload');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new InvalidPayloadError('invalid_payload');
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.v === 1) {
    if (typeof envelope.text !== 'string') {
      throw new InvalidPayloadError('invalid_payload');
    }
    return { kind: 'text', text: envelope.text };
  }
  if (envelope.v === 2) {
    if (envelope.kind !== 'media' || !isMedia(envelope.media)) {
      throw new InvalidPayloadError('invalid_payload');
    }
    const caption = typeof envelope.caption === 'string' ? envelope.caption : '';
    return { kind: 'media', media: envelope.media, caption };
  }
  throw new InvalidPayloadError('unsupported_version');
}
