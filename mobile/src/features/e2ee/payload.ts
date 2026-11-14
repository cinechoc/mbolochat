import { fromByteArray, toByteArray } from 'base64-js';

import { isReactionRef, type ReactionRef } from '../stickers/reactionRules';
import { isValidStickerRef } from '../stickers/stickerRefRules';

/**
 * Encodage du texte clair qui entre dans l'enveloppe Olm.
 *
 * Le noyau ne manipule que des octets ; `encodeText` transforme une chaîne JS en
 * base64 par une voie qui préserve les octets UTF-8 (pas `btoa`, qui casse dès
 * qu'un caractère dépasse un octet), et `decodeText` fait l'inverse.
 *
 * Trois versions coexistent dans l'enveloppe :
 * - `v:1` texte : `{v:1, text}` — le format historique de M2, à ne jamais casser ;
 * - `v:2` média : `{v:2, kind:'media', media, thumb?, caption?}` — la référence du
 *   ciphertext et sa clé, décrites ci-dessous ;
 * - `v:3` sticker de catalogue : `{v:3, kind:'sticker', stickerRef, replyTo?}` —
 *   une **référence** stable (`pack/id`), jamais un fichier, une URL ou un binaire.
 *   La résolution vers une image appartient à la couche d'affichage.
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
  | { kind: 'text'; text: string; replyTo?: string }
  | { kind: 'media'; media: EncryptedMedia; caption: string; replyTo?: string }
  | { kind: 'sticker'; stickerRef: string; replyTo?: string }
  | {
      kind: 'reaction';
      targetId: string;
      reaction: ReactionRef;
      action: 'add' | 'remove';
    }
  | { kind: 'delete'; targetId: string };

/**
 * Motifs d'un contenu **authentifié mais illisible**. Liste fermée : elle sert
 * aussi de valeur persistée (`e2ee_messages.unreadable_reason`), donc jamais de
 * message d'exception ni de fragment du payload.
 */
export type PayloadError = 'invalid_payload' | 'invalid_encoding' | 'unsupported_version';

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

/** Sérialise le contenu `v:1` d'un message texte. `replyTo` reste optionnel : son
 * absence préserve le format historique `{v:1,text}` au bit près. */
export function buildTextV1(text: string, replyTo?: string): string {
  return encodeText(JSON.stringify(replyTo ? { v: 1, text, replyTo } : { v: 1, text }));
}

/** Sérialise le contenu `v:2` d'un média chiffré. */
export function buildMediaV2(media: EncryptedMedia, caption = '', replyTo?: string): string {
  return encodeText(
    JSON.stringify(replyTo ? { v: 2, kind: 'media', media, caption, replyTo } : { v: 2, kind: 'media', media, caption }),
  );
}

/**
 * Sérialise le contenu `v:3` d'un sticker de catalogue.
 *
 * Seuls trois champs existent : la version, la nature et la **référence**. Rien
 * d'autre n'est jamais écrit — ni URL, ni chemin, ni donnée binaire — et
 * `replyTo` n'apparaît que s'il est fourni, comme pour `v:1`.
 *
 * Une référence mal formée est refusée à la construction : envoyer une valeur
 * que le parser rejetterait produirait un message indéchiffrable chez le pair.
 */
export function buildStickerV3(stickerRef: string, replyTo?: string): string {
  if (!isValidStickerRef(stickerRef)) {
    throw new InvalidPayloadError('invalid_payload');
  }
  return encodeText(
    JSON.stringify(
      replyTo ? { v: 3, kind: 'sticker', stickerRef, replyTo } : { v: 3, kind: 'sticker', stickerRef },
    ),
  );
}

export type ReactionAction = 'add' | 'remove';

/** Identifiant serveur/local admissible dans une référence de contenu. */
export function isValidControlTarget(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Sérialise le contenu `v:4` d'une réaction chiffrée. */
export function buildReactionV4(
  targetId: string,
  reaction: ReactionRef,
  action: ReactionAction,
): string {
  if (!isValidControlTarget(targetId) || !isReactionRef(reaction)) {
    throw new InvalidPayloadError('invalid_payload');
  }
  return encodeText(
    JSON.stringify({ v: 4, kind: 'reaction', targetId, reaction, action }),
  );
}

/** Sérialise le contenu `v:5` d'une suppression pour tous. */
export function buildDeleteV5(targetId: string): string {
  if (!isValidControlTarget(targetId)) {
    throw new InvalidPayloadError('invalid_payload');
  }
  return encodeText(JSON.stringify({ v: 5, kind: 'delete', targetId }));
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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
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
  let json: string;
  try {
    json = decodeText(plaintextB64);
  } catch {
    // base64 tronqué ou séquence UTF-8 impossible : le contenu a bien été
    // déchiffré et authentifié, mais ne peut pas être lu. Motif distinct, pour
    // ne pas le confondre avec un JSON valide mais hors contrat.
    throw new InvalidPayloadError('invalid_encoding');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidPayloadError('invalid_payload');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new InvalidPayloadError('invalid_payload');
  }
  const envelope = parsed as Record<string, unknown>;
  const replyTo = typeof envelope.replyTo === 'string' ? envelope.replyTo : undefined;
  if (envelope.v === 1) {
    if (typeof envelope.text !== 'string') {
      throw new InvalidPayloadError('invalid_payload');
    }
    return replyTo ? { kind: 'text', text: envelope.text, replyTo } : { kind: 'text', text: envelope.text };
  }
  if (envelope.v === 2) {
    if (envelope.kind !== 'media' || !isMedia(envelope.media)) {
      throw new InvalidPayloadError('invalid_payload');
    }
    const caption = typeof envelope.caption === 'string' ? envelope.caption : '';
    return replyTo
      ? { kind: 'media', media: envelope.media, caption, replyTo }
      : { kind: 'media', media: envelope.media, caption };
  }
  if (envelope.v === 3) {
    // Nouveau format : rien à préserver, donc validation stricte. Un `replyTo`
    // qui n'est pas une chaîne est refusé plutôt que silencieusement ignoré.
    if (envelope.kind !== 'sticker') {
      throw new InvalidPayloadError('invalid_payload');
    }
    if (envelope.replyTo !== undefined && typeof envelope.replyTo !== 'string') {
      throw new InvalidPayloadError('invalid_payload');
    }
    // Une référence bien formée mais absente du catalogue local reste valide :
    // c'est l'affichage qui décidera du repli. Les champs supplémentaires
    // (`url`, `data`, `bytes`, `path`…) sont ignorés : ils ne sont jamais lus.
    if (typeof envelope.stickerRef !== 'string' || !isValidStickerRef(envelope.stickerRef)) {
      throw new InvalidPayloadError('invalid_payload');
    }
    const cited = typeof envelope.replyTo === 'string' ? envelope.replyTo : undefined;
    return cited
      ? { kind: 'sticker', stickerRef: envelope.stickerRef, replyTo: cited }
      : { kind: 'sticker', stickerRef: envelope.stickerRef };
  }
  if (envelope.v === 4) {
    if (
      !hasExactKeys(envelope, ['v', 'kind', 'targetId', 'reaction', 'action']) ||
      envelope.kind !== 'reaction' ||
      !isValidControlTarget(envelope.targetId) ||
      !isReactionRef(envelope.reaction) ||
      (envelope.action !== 'add' && envelope.action !== 'remove')
    ) {
      throw new InvalidPayloadError('invalid_payload');
    }
    return {
      kind: 'reaction',
      targetId: envelope.targetId,
      reaction: envelope.reaction,
      action: envelope.action,
    };
  }
  if (envelope.v === 5) {
    if (
      !hasExactKeys(envelope, ['v', 'kind', 'targetId']) ||
      envelope.kind !== 'delete' ||
      !isValidControlTarget(envelope.targetId)
    ) {
      throw new InvalidPayloadError('invalid_payload');
    }
    return { kind: 'delete', targetId: envelope.targetId };
  }
  throw new InvalidPayloadError('unsupported_version');
}
