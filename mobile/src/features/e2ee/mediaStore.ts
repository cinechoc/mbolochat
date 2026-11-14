import { toByteArray } from 'base64-js';
import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { refreshAccessToken } from '@/lib/token-refresh';
import { isUnauthorizedDownload } from './downloadError';
import { API_URL } from '@/lib/config';
import {
  isDurableMediaReferenced,
  loadMessageMediaRefs,
  updateLocalMessageMedia,
  type LocalMediaUpdate,
} from './db';
import type { EncryptedBlob } from './payload';

/**
 * Deux dossiers, deux usages, tous deux privés à l'application :
 *
 * - `mbolo-e2ee-media` : les clairs **lus** (déchiffrés depuis le serveur), sous
 *   le domaine documentaire (déjà exclu de la sauvegarde Android par
 *   `withNoBackup.js`). Hors cache parce que le système ne doit pas pouvoir
 *   évincer un fichier pendant la lecture ; mais rien n'y survit à la fermeture
 *   du média, à un démarrage suivant un plantage, à la déconnexion ou à la
 *   réinitialisation d'identité.
 * - `mbolo-e2ee-stage` : les clairs **à envoyer** (photo réduite, copie du
 *   fichier d'origine) et leurs ciphertexts, le temps de l'import. Dans le cache,
 *   car ils ne servent qu'une fois ; supprimés dans tous les cas à la fin.
 *
 * Un sous-dossier par média : le clair et son ciphertext sont supprimés
 * ensemble, sans risquer d'effacer le voisin. `sweepSecureMedia()` vide les
 * deux dossiers d'un coup : c'est la seule fonction à appeler aux points de
 * nettoyage (démarrage, déconnexion, perte d'identité).
 */
export const SECURE_MEDIA_DIRECTORY = 'mbolo-e2ee-media';
export const MEDIA_STAGE_DIRECTORY = 'mbolo-e2ee-stage';

/**
 * Stockage **durable** des médias chiffrés qui n'ont pas encore abouti.
 *
 * Le dossier `mbolo-e2ee-media` ne survit pas à un démarrage, c'est voulu : il
 * ne contient que des clairs déchiffrés le temps d'une lecture. Un média à
 * envoyer, lui, doit survivre à un redémarrage : une fois le clair supprimé, le
 * ciphertext est la **seule** copie récupérable du fichier, et la reprise de
 * l'outbox en a besoin.
 *
 * `mbolo-e2ee-media-durable` vit sous le domaine documentaire (déjà exclu de la
 * sauvegarde Android par `withNoBackup.js`) et n'est **jamais** vidé par
 * `sweepSecureMedia()`, qui est appelé à chaque démarrage. Seul
 * `sweepDurableMedia()` l'efface : à réserver à une déconnexion ou une
 * réinitialisation d'identité, jamais au démarrage.
 *
 * Le dossier durable ne contient que du ciphertext : aucun clair, aucune clé,
 * aucun métadata sensible. Le lien média → message vit dans SQLCipher
 * (`e2ee_messages.local_cipher_uri`), pas ici.
 */
export const DURABLE_MEDIA_DIRECTORY = 'mbolo-e2ee-media-durable';

/** Noms fixes dans le dossier d'un média : un fichier, un rôle, pas de liste. */
export const DURABLE_MEDIA_NAMES = {
  media: 'cipher.bin',
  thumb: 'thumb-cipher.bin',
} as const;

export type DurableMediaKind = keyof typeof DURABLE_MEDIA_NAMES;

const CIPHER_NAME = 'cipher.bin';
const PLAIN_NAME = 'plain';

/** Un identifiant d'upload ne doit jamais pouvoir sortir de son dossier. */
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error('invalid_media_id');
  }
  return id;
}

/** Chemin système (sans schéma `file://`) attendu par la frontière native. */
export function fileSystemPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

/** Extension du clair, pour que la visionneuse reconnaisse le format. */
export function extensionForMime(mime: string): string {
  const clean = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-m4v': 'm4v',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
  };
  return map[clean] ?? 'bin';
}

function mediaRoot(): Directory {
  return new Directory(Paths.document, SECURE_MEDIA_DIRECTORY);
}

function stageRoot(): Directory {
  return new Directory(Paths.cache, MEDIA_STAGE_DIRECTORY);
}

/** Crée le dossier du média et le renvoie : chemin des temporaires de ce média. */
export function reserveMedia(id: string): Directory {
  const directory = new Directory(mediaRoot(), safeId(id));
  directory.create({ intermediates: true, idempotent: true });
  return directory;
}

/** Fichier à l'intérieur du dossier d'un média. */
export function mediaFile(id: string, name: string): File {
  return new File(reserveMedia(id), name);
}

/** Supprime le dossier d'un média : ciphertext et clair partent ensemble. */
export function releaseMedia(id: string): void {
  const directory = new Directory(mediaRoot(), safeId(id));
  if (directory.exists) {
    directory.delete();
  }
}

/** Zone de travail de l'envoi : un sous-dossier par import, jamais partagé. */
export function reserveStage(id: string): Directory {
  const directory = new Directory(stageRoot(), safeId(id));
  directory.create({ intermediates: true, idempotent: true });
  return directory;
}

export function stageFile(id: string, name: string): File {
  return new File(reserveStage(id), name);
}

/** Supprime le dossier de travail d'un import, quoi qu'il arrive. */
export function releaseStage(id: string): void {
  const directory = new Directory(stageRoot(), safeId(id));
  if (directory.exists) {
    directory.delete();
  }
}

/** Efface **tous** les temporaires de médias — jamais de clair qui traîne. */
export function sweepSecureMedia(): void {
  for (const directory of [mediaRoot(), stageRoot()]) {
    if (directory.exists) {
      directory.delete();
    }
  }
}

export interface OpenForViewInput {
  token: string;
  /** Référence du blob chiffré, telle qu'elle a voyagé dans l'enveloppe Olm. */
  blob: EncryptedBlob;
  /** Type MIME du clair, pour nommer le fichier déchiffré. */
  mime: string;
}

async function downloadCiphertext(
  id: string,
  destination: File,
  token: string,
): Promise<void> {
  const url = `${API_URL}/uploads/${encodeURIComponent(id)}`;
  const options = (accessToken: string) => ({
    headers: { Authorization: `Bearer ${accessToken}` },
    idempotent: true,
  });
  try {
    await File.downloadFileAsync(url, destination, options(token));
  } catch (cause) {
    if (!isUnauthorizedDownload(cause)) throw cause;
    if (destination.exists) destination.delete();
    const refreshed = await refreshAccessToken();
    await File.downloadFileAsync(url, destination, options(refreshed));
  }
}

/**
 * Rend un média lisible : télécharge son ciphertext, le déchiffre dans le
 * dossier privé et renvoie l'URI locale. Toute erreur — réseau, empreinte
 * invalide, clé refusée — laisse le dossier propre : jamais de clair partiel.
 */
export async function openForView(input: OpenForViewInput): Promise<string> {
  const id = safeId(input.blob.uploadId);
  const directory = reserveMedia(id);
  const cipher = new File(directory, CIPHER_NAME);
  const plain = new File(directory, `${PLAIN_NAME}.${extensionForMime(input.mime)}`);
  try {
    await downloadCiphertext(id, cipher, input.token);
    await MboloCrypto.decryptFile(
      fileSystemPath(cipher.uri),
      fileSystemPath(plain.uri),
      toByteArray(input.blob.fileKey),
      toByteArray(input.blob.nonce),
      input.blob.sha256,
    );
    return plain.uri;
  } catch (cause) {
    releaseMedia(id);
    throw cause;
  }
}

/** Referme un média lu : le clair et son ciphertext disparaissent ensemble. */
export function closeMedia(id: string): void {
  releaseMedia(id);
}

export interface ThumbnailInput {
  token: string;
  blob: EncryptedBlob;
  mime: string;
}

/**
 * Vignette déchiffrée, gardée **en mémoire** seulement (data URI). Le fichier
 * temporaire est relu puis effacé dans la foulée : contrairement au média
 * complet, une vignette n'a aucune raison de laisser une trace sur le disque,
 * même brève.
 */
export async function loadThumbnailDataUrl(input: ThumbnailInput): Promise<string> {
  const id = safeId(input.blob.uploadId);
  const directory = reserveMedia(id);
  const cipher = new File(directory, CIPHER_NAME);
  const plain = new File(directory, `${PLAIN_NAME}.${extensionForMime(input.mime)}`);
  try {
    await downloadCiphertext(id, cipher, input.token);
    await MboloCrypto.decryptFile(
      fileSystemPath(cipher.uri),
      fileSystemPath(plain.uri),
      toByteArray(input.blob.fileKey),
      toByteArray(input.blob.nonce),
      input.blob.sha256,
    );
    const base64 = await plain.base64();
    return `data:${input.mime};base64,${base64}`;
  } finally {
    // Dans tous les cas : la vignette vit en mémoire, pas sur le disque.
    releaseMedia(id);
  }
}


/* -------------------------------------------------------------------------- */
/* Stockage durable des ciphertexts                                            */
/* -------------------------------------------------------------------------- */

const DURABLE_KINDS = Object.keys(DURABLE_MEDIA_NAMES) as DurableMediaKind[];

/** Suffixe des écritures en cours : jamais lu, toujours nettoyable. */
const PARTIAL_SUFFIX = '.part';

/**
 * Écritures durables en cours dans ce processus.
 *
 * `sweepDurablePartials()` supprime les `.part` : lancé pendant une écriture, il
 * arracherait le temporaire d'un écrivain vivant. Le balayage s'abstient donc
 * tant qu'une écriture est en vol.
 */
let durableWritesInFlight = 0;

/** Vrai tant qu'une écriture durable n'est pas terminée (sert aussi aux tests). */
export function durableWriteInFlight(): boolean {
  return durableWritesInFlight > 0;
}

function durableRoot(): Directory {
  return new Directory(Paths.document, DURABLE_MEDIA_DIRECTORY);
}

function durableDirectory(id: string): Directory {
  return new Directory(durableRoot(), safeId(id));
}

/**
 * Identifiant de média : aléatoire et non séquentiel, pour qu'un nom de fichier
 * ne dise rien du contenu ni de l'ordre des envois. La confidentialité repose
 * sur le dossier privé et SQLCipher, pas sur ce nom.
 */
export function newDurableMediaId(): string {
  const chunk = () => Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `${Date.now().toString(36)}${chunk()}${chunk()}`.replace(/[^A-Za-z0-9_-]/g, '');
}

/** Jeton unique par tentative d'écriture : deux écrivains ne se marchent pas dessus. */
function attemptToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Fichier complet et non vide : la seule définition d'un média utilisable. */
function isComplete(file: File, expectedSize: number): boolean {
  try {
    return file.exists && file.size === expectedSize && file.size > 0;
  } catch {
    return false;
  }
}

export interface StoreDurableMediaInput {
  id: string;
  /** Ciphertext produit localement, souvent dans le dossier de travail en cache. */
  sourceUri: string;
  kind?: DurableMediaKind;
  /** Taille attendue ; à défaut, celle de la source au moment de la copie. */
  expectedSize?: number | null;
  /** Remplacer un fichier déjà présent (nouvel envoi du même média). */
  overwrite?: boolean;
}

export interface StoredDurableMedia {
  id: string;
  kind: DurableMediaKind;
  uri: string;
  size: number;
  /** `true` quand le fichier valide était déjà là : aucune écriture faite. */
  reused: boolean;
}

/**
 * Copie un ciphertext dans le dossier durable, puis le renomme en place.
 *
 * L'écriture passe par un `.part` propre à la tentative : une interruption
 * laisse un temporaire que rien ne lit, jamais un fichier final tronqué. Le
 * renommage final est atomique à l'intérieur d'un même dossier, donc un lecteur
 * voit soit l'ancien fichier complet, soit le nouveau, jamais un mélange.
 *
 * Idempotent : un fichier déjà présent et de la bonne taille est réutilisé sans
 * réécriture (sauf `overwrite`).
 */
export async function storeDurableMedia(
  input: StoreDurableMediaInput,
): Promise<StoredDurableMedia> {
  const kind = input.kind ?? 'media';
  const id = safeId(input.id);
  const source = new File(input.sourceUri);
  if (!source.exists) {
    throw new Error('durable_source_missing');
  }
  const expected = input.expectedSize ?? source.size;
  if (!expected || expected <= 0) {
    throw new Error('durable_source_empty');
  }

  const directory = durableDirectory(id);
  directory.create({ intermediates: true, idempotent: true });
  const target = new File(directory, DURABLE_MEDIA_NAMES[kind]);

  if (!input.overwrite && isComplete(target, expected)) {
    return { id, kind, uri: target.uri, size: target.size, reused: true };
  }

  const partial = new File(directory, `${DURABLE_MEDIA_NAMES[kind]}.${attemptToken()}${PARTIAL_SUFFIX}`);
  // Le chemin du temporaire est mémorisé **avant** le renommage : `File.move()`
  // mute l'instance (son `uri` devient la destination), donc s'en servir après
  // coup reviendrait à supprimer le fichier qu'on vient d'écrire.
  const partialUri = partial.uri;
  durableWritesInFlight += 1;
  let moved = false;
  try {
    await source.copy(partial, { overwrite: true });
    if (!isComplete(partial, expected)) {
      throw new Error('durable_write_incomplete');
    }
    await partial.move(target, { overwrite: true });
    moved = true;
  } finally {
    // Seul un temporaire non renommé est effacé : aucun `.part` ne survit à la
    // tentative, et un renommage réussi n'est jamais annulé.
    if (!moved) {
      try {
        const leftover = new File(partialUri);
        if (leftover.exists) leftover.delete();
      } catch {
        // Un temporaire récalcitrant sera balayé au démarrage suivant.
      }
    }
    durableWritesInFlight -= 1;
  }
  // Contrôle sur une instance fraîche : `target` a été construit avant le
  // renommage et ne reflète pas l'état obtenu.
  const written = new File(target.uri);
  if (!isComplete(written, expected)) {
    throw new Error('durable_write_incomplete');
  }
  return { id, kind, uri: written.uri, size: written.size, reused: false };
}

/** Chemin visé pour un média, sans créer ni vérifier quoi que ce soit. */
export function durableMediaFileUri(id: string, kind: DurableMediaKind = 'media'): string {
  return new File(durableDirectory(id), DURABLE_MEDIA_NAMES[kind]).uri;
}

/**
 * URI d'un média durable **utilisable**, ou `null`.
 *
 * Un fichier absent, vide ou illisible n'est jamais renvoyé : un temporaire ou
 * un reste d'écriture interrompue ne peut donc pas être présenté comme un média
 * valide.
 */
export function durableMediaUri(
  id: string,
  kind: DurableMediaKind = 'media',
): string | null {
  try {
    const file = new File(durableDirectory(id), DURABLE_MEDIA_NAMES[kind]);
    return file.exists && file.size > 0 ? file.uri : null;
  } catch {
    return null;
  }
}

export function durableMediaSize(
  id: string,
  kind: DurableMediaKind = 'media',
): number | null {
  try {
    const file = new File(durableDirectory(id), DURABLE_MEDIA_NAMES[kind]);
    return file.exists && file.size > 0 ? file.size : null;
  } catch {
    return null;
  }
}

export interface VerifyDurableMediaInput {
  id: string;
  kind?: DurableMediaKind;
  /** Taille attendue ; sans elle, seule l'existence non vide est vérifiée. */
  expectedSize?: number | null;
}

/**
 * Contrôle d'intégrité d'un média déjà stocké.
 *
 * La taille est la seule empreinte disponible sans recalculer un hachage du
 * ciphertext ; elle suffit à détecter une troncature, et le renommage atomique
 * garantit qu'un fichier final a été écrit en entier.
 */
export function verifyDurableMedia(input: VerifyDurableMediaInput): {
  ok: boolean;
  reason?: 'missing' | 'empty' | 'size_mismatch';
} {
  const kind = input.kind ?? 'media';
  const file = (() => {
    try {
      return new File(durableDirectory(input.id), DURABLE_MEDIA_NAMES[kind]);
    } catch {
      return null;
    }
  })();
  if (!file || !file.exists) return { ok: false, reason: 'missing' };
  if (file.size <= 0) return { ok: false, reason: 'empty' };
  if (input.expectedSize != null && file.size !== input.expectedSize) {
    return { ok: false, reason: 'size_mismatch' };
  }
  return { ok: true };
}

/** Supprime un média durable. `all` (défaut) emporte média et vignette. */
export function removeDurableMedia(
  id: string,
  kind: DurableMediaKind | 'all' = 'all',
): void {
  const directory = durableDirectory(id);
  if (kind === 'all') {
    if (directory.exists) directory.delete();
    return;
  }
  const file = new File(directory, DURABLE_MEDIA_NAMES[kind]);
  if (file.exists) file.delete();
  // Dossier devenu vide : inutile de le garder.
  try {
    if (!directory.list().length) directory.delete();
  } catch {
    // Un dossier non vide reste : rien à nettoyer.
  }
}

/**
 * Efface les écritures interrompues (`.part`) de tous les médias.
 *
 * À n'appeler qu'au démarrage, avant tout envoi : un temporaire vivant
 * appartiendrait sinon à une écriture en cours. Les fichiers finaux, eux, ne
 * sont jamais touchés.
 */
export function sweepDurablePartials(): void {
  // Une écriture en vol tient un `.part` légitime : on ne balaie pas.
  if (durableWritesInFlight > 0) return;
  const root = durableRoot();
  if (!root.exists) return;
  for (const entry of root.list()) {
    if (!(entry instanceof Directory)) continue;
    for (const child of entry.list()) {
      if (!(child instanceof File)) continue;
      if (!child.uri.endsWith(PARTIAL_SUFFIX)) continue;
      try {
        child.delete();
      } catch {
        // Réessayé au démarrage suivant.
      }
    }
  }
}

/**
 * Efface **tous** les médias durables.
 *
 * Réservé à la déconnexion ou à la réinitialisation d'identité : à un démarrage,
 * ces fichiers sont justement ce qu'il faut conserver.
 */
export function sweepDurableMedia(): void {
  const root = durableRoot();
  if (root.exists) root.delete();
}

/**
 * Retrouve l'identifiant et le rôle d'un média à partir de son URI.
 *
 * Renvoie `null` pour tout chemin qui ne désigne pas exactement un fichier de
 * média durable : une URI de cache, un chemin relatif ou une traversée de
 * répertoire ne peuvent pas être confondus avec une référence valide.
 */
export function durableMediaIdFromUri(
  uri: string,
): { id: string; kind: DurableMediaKind } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return null;
  }
  const marker = `/${DURABLE_MEDIA_DIRECTORY}/`;
  const index = decoded.lastIndexOf(marker);
  if (index < 0) return null;
  const segments = decoded.slice(index + marker.length).split('/');
  if (segments.length !== 2) return null;
  const [id, name] = segments;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  const kind = DURABLE_KINDS.find((candidate) => DURABLE_MEDIA_NAMES[candidate] === name);
  return kind ? { id, kind } : null;
}


/* -------------------------------------------------------------------------- */
/* Lien média durable ↔ message (SQLCipher)                                    */
/* -------------------------------------------------------------------------- */

export interface AttachDurableMediaInput {
  db: SQLiteDatabase;
  /** Message local, provisoire (`clientId`) ou confirmé (id serveur). */
  messageId: string;
  mediaId: string;
  kind?: DurableMediaKind;
  /** Identifiant serveur du blob, dès qu'il existe. */
  uploadId?: string | null;
}

/**
 * Rattache un média durable à un message : l'URI interne et l'identifiant
 * d'upload vivent dans SQLCipher, sur la ligne du message.
 *
 * C'est le **seul** endroit où le lien est écrit : l'entrée d'outbox désigne le
 * même message par son `client_id`, il n'y a donc pas de troisième copie des
 * métadonnées à tenir à jour. Le fichier doit exister : on ne référence jamais
 * une URI qui ne mène à rien.
 */
export async function attachDurableMedia(input: AttachDurableMediaInput): Promise<number> {
  const kind = input.kind ?? 'media';
  const uri = durableMediaUri(input.mediaId, kind);
  if (!uri) {
    throw new Error('durable_file_missing');
  }
  const patch: LocalMediaUpdate = {};
  if (kind === 'media') {
    patch.localCipherUri = uri;
    if (input.uploadId !== undefined) patch.uploadId = input.uploadId;
  } else {
    patch.localThumbCipherUri = uri;
    if (input.uploadId !== undefined) patch.thumbUploadId = input.uploadId;
  }
  return updateLocalMessageMedia(input.db, input.messageId, patch);
}

export interface MessageDurableMedia {
  media: { id: string; uri: string } | null;
  thumb: { id: string; uri: string } | null;
  /**
   * Références présentes dans SQLCipher dont le fichier a disparu. À traiter
   * comme un média perdu (nouveau téléversement), jamais comme un média valide.
   */
  missing: DurableMediaKind[];
}

/**
 * État du média durable d'un message, fichier vérifié à la lecture.
 *
 * Une référence SQLCipher sans fichier n'est **pas** renvoyée comme média : elle
 * est signalée dans `missing`, pour que l'appelant sache qu'il n'a rien de
 * récupérable localement.
 */
export async function loadMessageDurableMedia(
  db: SQLiteDatabase,
  messageId: string,
): Promise<MessageDurableMedia> {
  const refs = await loadMessageMediaRefs(db, messageId);
  const result: MessageDurableMedia = { media: null, thumb: null, missing: [] };
  if (!refs) return result;
  const refsByKind: Record<DurableMediaKind, string | null> = {
    media: refs.local_cipher_uri,
    thumb: refs.local_thumb_cipher_uri,
  };
  for (const kind of DURABLE_KINDS) {
    const stored = refsByKind[kind];
    if (!stored) continue;
    const parsed = durableMediaIdFromUri(stored);
    const uri = parsed ? durableMediaUri(parsed.id, parsed.kind) : null;
    if (!parsed || !uri) {
      result.missing.push(kind);
      continue;
    }
    result[kind] = { id: parsed.id, uri };
  }
  return result;
}

/** Identifiants de médias présents dans le stockage durable. */
export function listDurableMediaIds(): string[] {
  const root = durableRoot();
  if (!root.exists) return [];
  const ids: string[] = [];
  for (const entry of root.list()) {
    if (!(entry instanceof Directory)) continue;
    const segments = decodeURIComponent(entry.uri).split('/');
    const id = segments[segments.length - 1];
    if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id)) ids.push(id);
  }
  return ids.sort();
}

/**
 * Supprime un média durable **seulement** s'il n'est plus référencé.
 *
 * Un envoi encore en cours, une entrée d'outbox non aboutie ou un message qui
 * pointe le fichier suffisent à le conserver : la suppression n'est jamais la
 * conséquence directe d'un échec réseau.
 */
export async function removeDurableMediaIfUnreferenced(
  db: SQLiteDatabase,
  id: string,
): Promise<boolean> {
  if (await isDurableMediaReferenced(db, id, DURABLE_MEDIA_DIRECTORY)) {
    return false;
  }
  removeDurableMedia(id);
  return true;
}

/**
 * Repère et retire les ciphertexts qu'aucun message ni envoi ne référence.
 *
 * Ce sont les restes d'une interruption entre l'écriture du fichier et celle de
 * la base. Aucun fichier référencé n'est touché, et le balayage est refusé tant
 * qu'une écriture est en cours.
 */
export async function pruneOrphanDurableMedia(db: SQLiteDatabase): Promise<string[]> {
  if (durableWritesInFlight > 0) return [];
  const removed: string[] = [];
  for (const id of listDurableMediaIds()) {
    if (await isDurableMediaReferenced(db, id, DURABLE_MEDIA_DIRECTORY)) continue;
    removeDurableMedia(id);
    removed.push(id);
  }
  return removed;
}
