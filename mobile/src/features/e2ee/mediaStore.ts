import { toByteArray } from 'base64-js';
import { Directory, File, Paths } from 'expo-file-system';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { API_URL } from '@/lib/config';
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
    await File.downloadFileAsync(`${API_URL}/uploads/${encodeURIComponent(id)}`, cipher, {
      headers: { Authorization: `Bearer ${input.token}` },
      idempotent: true,
    });
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
    await File.downloadFileAsync(`${API_URL}/uploads/${encodeURIComponent(id)}`, cipher, {
      headers: { Authorization: `Bearer ${input.token}` },
      idempotent: true,
    });
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
