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

/** Aperçu de lien transmis dans l'enveloppe Olm, jamais au serveur. */
export interface EncryptedLinkPreview {
  url: string;
  host: string;
  title: string;
  description: string;
  imageUrl?: string;
}

export type ParsedPayload =
  | {
      kind: 'text';
      text: string;
      replyTo?: string;
      silent?: true;
      viewOnce?: true;
      preview?: EncryptedLinkPreview;
    }
  | { kind: 'media'; media: EncryptedMedia; caption: string; replyTo?: string }
  | { kind: 'sticker'; stickerRef: string; replyTo?: string }
  | {
      kind: 'reaction';
      targetId: string;
      reaction: ReactionRef;
      action: 'add' | 'remove';
    }
  | { kind: 'delete'; targetId: string }
  | { kind: 'ephemeral'; ttlSeconds: EphemeralTtl; version: number }
  | { kind: 'edit'; targetId: string; revision: number; text: string };

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

export const MAX_TEXT_V8_LENGTH = 4_000;
export const MAX_PREVIEW_URL_LENGTH = 2_048;
export const MAX_PREVIEW_HOST_LENGTH = 253;
export const MAX_PREVIEW_TITLE_LENGTH = 90;
export const MAX_PREVIEW_DESCRIPTION_LENGTH = 180;

function isHttpUrl(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function isBoundedText(value: unknown, maxLength: number, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0);
}

/** Valide un aperçu reçu avant tout usage. Les clés sont fermées. */
export function isEncryptedLinkPreview(value: unknown): value is EncryptedLinkPreview {
  if (!value || typeof value !== 'object') return false;
  const preview = value as Record<string, unknown>;
  const keys = ['url', 'host', 'title', 'description'];
  if (Object.hasOwn(preview, 'imageUrl')) keys.push('imageUrl');
  if (!hasExactKeys(preview, keys)) return false;
  return (
    isHttpUrl(preview.url, MAX_PREVIEW_URL_LENGTH) &&
    isBoundedText(preview.host, MAX_PREVIEW_HOST_LENGTH, false) &&
    isBoundedText(preview.title, MAX_PREVIEW_TITLE_LENGTH) &&
    isBoundedText(preview.description, MAX_PREVIEW_DESCRIPTION_LENGTH) &&
    (preview.imageUrl === undefined ||
      isHttpUrl(preview.imageUrl, MAX_PREVIEW_URL_LENGTH))
  );
}

export interface TextV8Options {
  replyTo?: string;
  silent?: boolean;
  viewOnce?: boolean;
  preview?: EncryptedLinkPreview | null;
}

/**
 * Sérialise un texte riche en `v:8`. Le format `v:1` reste utilisé quand aucun
 * champ supplémentaire n'est présent, afin de ne pas changer les octets des
 * messages historiques.
 */
export function buildTextV8(text: string, options: TextV8Options = {}): string {
  if (
    typeof text !== 'string' ||
    text.length < 1 ||
    text.length > MAX_TEXT_V8_LENGTH ||
    (options.replyTo !== undefined && !isValidControlTarget(options.replyTo)) ||
    (options.silent !== undefined && options.silent !== true) ||
    (options.viewOnce !== undefined && options.viewOnce !== true) ||
    (options.preview != null && !isEncryptedLinkPreview(options.preview))
  ) {
    throw new InvalidPayloadError('invalid_payload');
  }
  const payload: Record<string, unknown> = { v: 8, kind: 'text', text };
  if (options.replyTo) payload.replyTo = options.replyTo;
  if (options.silent === true) payload.silent = true;
  if (options.viewOnce === true) payload.viewOnce = true;
  if (options.preview) payload.preview = options.preview;
  return encodeText(JSON.stringify(payload));
}

/** Relit un aperçu stocké dans SQLCipher, ou `null` s'il est absent/illisible. */
export function decodePreviewMeta(raw: string | null | undefined): EncryptedLinkPreview | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isEncryptedLinkPreview(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
export const MAX_EDIT_REVISION = 5;
export const MAX_EDIT_TEXT_LENGTH = 4_000;
export const EDIT_WINDOW_MS = 15 * 60 * 1_000;
export const EPHEMERAL_TTLS = [0, 86_400, 604_800] as const;
export type EphemeralTtl = (typeof EPHEMERAL_TTLS)[number];

export function isEphemeralTtl(value: unknown): value is EphemeralTtl {
  return typeof value === 'number' && (EPHEMERAL_TTLS as readonly number[]).includes(value);
}

function isValidEditText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_EDIT_TEXT_LENGTH
  );
}

function isValidEditRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_EDIT_REVISION;
}

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

/** Sérialise le contenu `v:6` du réglage éphémère de conversation. */
export function buildEphemeralV6(ttlSeconds: EphemeralTtl, version: number): string {
  if (!isEphemeralTtl(ttlSeconds) || !Number.isSafeInteger(version) || version <= 0) {
    throw new InvalidPayloadError('invalid_payload');
  }
  return encodeText(JSON.stringify({ v: 6, kind: 'ephemeral', ttlSeconds, version }));
}

/** Sérialise une modification de texte `v:7`, réservée à l'auteur de la cible. */
export function buildEditV7(targetId: string, revision: number, text: string): string {
  if (
    !isValidControlTarget(targetId) ||
    !isValidEditRevision(revision) ||
    !isValidEditText(text)
  ) {
    throw new InvalidPayloadError('invalid_payload');
  }
  return encodeText(JSON.stringify({ v: 7, kind: 'edit', targetId, revision, text }));
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
  if (envelope.v === 6) {
    if (
      !hasExactKeys(envelope, ['v', 'kind', 'ttlSeconds', 'version']) ||
      envelope.kind !== 'ephemeral' ||
      !isEphemeralTtl(envelope.ttlSeconds) ||
      !Number.isSafeInteger(envelope.version) ||
      (envelope.version as number) <= 0
    ) {
      throw new InvalidPayloadError('invalid_payload');
    }
    return {
      kind: 'ephemeral',
      ttlSeconds: envelope.ttlSeconds,
      version: envelope.version as number,
    };
  }
  if (envelope.v === 7) {
    if (
      !hasExactKeys(envelope, ['v', 'kind', 'targetId', 'revision', 'text']) ||
      envelope.kind !== 'edit' ||
      !isValidControlTarget(envelope.targetId) ||
      !isValidEditRevision(envelope.revision) ||
      !isValidEditText(envelope.text)
    ) {
      throw new InvalidPayloadError('invalid_payload');
    }
    return {
      kind: 'edit',
      targetId: envelope.targetId,
      revision: envelope.revision,
      text: envelope.text,
    };
  }
  if (envelope.v === 8) {
    const allowed = [
      'v',
      'kind',
      'text',
      ...(Object.hasOwn(envelope, 'replyTo') ? ['replyTo'] : []),
      ...(Object.hasOwn(envelope, 'silent') ? ['silent'] : []),
      ...(Object.hasOwn(envelope, 'viewOnce') ? ['viewOnce'] : []),
      ...(Object.hasOwn(envelope, 'preview') ? ['preview'] : []),
    ];
    if (
      !hasExactKeys(envelope, allowed) ||
      envelope.kind !== 'text' ||
      !isBoundedText(envelope.text, MAX_TEXT_V8_LENGTH, false) ||
      (envelope.replyTo !== undefined && !isValidControlTarget(envelope.replyTo)) ||
      (envelope.silent !== undefined && envelope.silent !== true) ||
      (envelope.viewOnce !== undefined && envelope.viewOnce !== true) ||
      (envelope.preview !== undefined && !isEncryptedLinkPreview(envelope.preview))
    ) {
      throw new InvalidPayloadError('invalid_payload');
    }
    return {
      kind: 'text',
      text: envelope.text,
      ...(typeof envelope.replyTo === 'string' ? { replyTo: envelope.replyTo } : {}),
      ...(envelope.silent === true ? { silent: true as const } : {}),
      ...(envelope.viewOnce === true ? { viewOnce: true as const } : {}),
      ...(isEncryptedLinkPreview(envelope.preview) ? { preview: envelope.preview } : {}),
    };
  }
  throw new InvalidPayloadError('unsupported_version');
}
