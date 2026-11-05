import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import * as VideoThumbnails from 'expo-video-thumbnails';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import { ensureSocket } from '@/lib/socket';
import type { ConversationSummary, Message } from '@/lib/types';
import {
  renameLocalMessage,
  saveLocalMessage,
  type E2eeAccountRow,
  type StoredE2eeMessage,
} from './db';
import type { EncryptedBlob, EncryptedMedia } from './payload';
import { buildMediaV2, encodeMediaMeta } from './payload';
import { encryptEnvelope } from './text';
import { fileSystemPath, releaseStage, reserveStage } from './mediaStore';

/**
 * Envoi d'un média chiffré de bout en bout (M3).
 *
 * Le serveur ne reçoit que du ciphertext et un identifiant ; la clé du fichier,
 * son empreinte et sa nature voyagent dans l'enveloppe Olm (`v:2`). Les clairs —
 * photo réduite, copie du document, vignette — ne vivent que dans un dossier de
 * travail sous le cache, et disparaissent dans tous les cas à la fin de l'envoi.
 */

/** Plafonds du **clair**, vérifiés avant tout chiffrement (plan M3). */
export const MAX_PLAINTEXT_BYTES = {
  image: 10 * 1024 * 1024,
  video: 40 * 1024 * 1024,
  file: 25 * 1024 * 1024,
  audio: 15 * 1024 * 1024,
} as const;

/** Réduction appliquée aux photos avant chiffrement (EXIF/GPS retirés). */
export const PHOTO_MAX_EDGE = 1600;
export const THUMB_MAX_EDGE = 320;

export type E2eeMediaKind = 'image' | 'video' | 'audio' | 'file';

export interface E2eeMediaAsset {
  uri: string;
  kind: E2eeMediaKind;
  mime: string;
  name: string;
  size?: number | null;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Note vocale : forme d'onde, hors chiffrement, comme en clair. */
  waveform?: number[];
}

const BLOB_KIND: Record<E2eeMediaKind, EncryptedMedia['type']> = {
  image: 'IMAGE',
  video: 'VIDEO',
  audio: 'AUDIO',
  file: 'FILE',
};

function newStageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function newClientId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Taille réelle d'un fichier local, ou `null` s'il est illisible. */
function sizeOf(uri: string): number | null {
  try {
    const size = new File(uri).size;
    return size > 0 ? size : null;
  } catch {
    return null;
  }
}

/** Ré-encode une photo en JPEG ≤ 1600 px : réduit la taille et **retire EXIF/GPS**. */
async function reducePhoto(uri: string, output: File): Promise<{ uri: string; width: number; height: number }> {
  const context = ImageManipulator.manipulate(uri, { maxWidth: PHOTO_MAX_EDGE });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({
    compress: 0.8,
    format: SaveFormat.JPEG,
  });
  const file = new File(saved.uri);
  // On garde le fichier manipulé dans notre dossier de travail : le rendu est
  // en cache, mais c'est *nous* qui devons savoir quand il disparaît.
  if (file.uri !== output.uri) {
    await file.move(output);
  }
  return { uri: output.uri, width: saved.width, height: saved.height };
}

/** Vignette d'image ou de vidéo, en fichier local, prête à chiffrer. */
async function buildThumbnail(
  asset: E2eeMediaAsset,
  output: File,
): Promise<{ uri: string; width: number; height: number } | null> {
  if (asset.kind === 'image') {
    const context = ImageManipulator.manipulate(asset.uri, { maxWidth: THUMB_MAX_EDGE });
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({ compress: 0.7, format: SaveFormat.JPEG });
    const file = new File(saved.uri);
    if (file.uri !== output.uri) await file.move(output);
    return { uri: output.uri, width: saved.width, height: saved.height };
  }
  if (asset.kind === 'video') {
    const thumb = await VideoThumbnails.getThumbnailAsync(asset.uri, {
      quality: 0.7,
      time: 0,
    });
    const file = new File(thumb.uri);
    if (file.uri !== output.uri) await file.move(output);
    return { uri: output.uri, width: thumb.width, height: thumb.height };
  }
  return null;
}

/** Chiffre un clair et renvoie sa référence, clé et nonce compris. */
async function encryptBlob(plain: string, output: File): Promise<Omit<EncryptedBlob, 'uploadId'>> {
  const result = await MboloCrypto.encryptFile(fileSystemPath(plain), fileSystemPath(output.uri));
  return {
    fileKey: result.file_key_b64,
    nonce: result.nonce_b64,
    sha256: result.sha256_hex,
    size: result.plaintext_size,
  };
}

/** Nature déclarée au serveur, pour l'affichage côté destinataire. */
function serverKind(kind: E2eeMediaKind): string {
  return BLOB_KIND[kind];
}

export interface SendEncryptedMediaInput {
  token: string;
  db: Parameters<typeof saveLocalMessage>[0];
  account: E2eeAccountRow;
  conversation: ConversationSummary;
  currentUserId: string;
  currentUserName: string;
  asset: E2eeMediaAsset;
  caption?: string;
  allowKeyChange?: boolean;
}

export interface SendEncryptedMediaResult {
  clientId: string;
  serverMessage: Message;
  stored: StoredE2eeMessage;
}

/**
 * Chiffre le média et sa vignette, les téléverse, puis envoie l'enveloppe `v:2`.
 * L'ordre compte : on ne déclare un blob au destinataire qu'une fois qu'il est
 * bel et bien sur le serveur. En cas d'échec, tout le travail intermédiaire est
 * effacé — jamais de clair qui survit à un envoi raté.
 */
export async function sendEncryptedMedia(
  input: SendEncryptedMediaInput,
): Promise<SendEncryptedMediaResult> {
  const stageId = newStageId();
  const stage = reserveStage(stageId);
  try {
    const limit = MAX_PLAINTEXT_BYTES[input.asset.kind];
    const declared = input.asset.size ?? sizeOf(input.asset.uri);
    if (declared !== null && declared > limit) {
      throw new Error('media_too_large');
    }

    // 1. Clairs de travail : photo réduite (EXIF retirés), ou copie telle quelle.
    let plainUri = input.asset.uri;
    let width = input.asset.width;
    let height = input.asset.height;
    if (input.asset.kind === 'image') {
      const reduced = await reducePhoto(input.asset.uri, new File(stage, 'photo.jpg'));
      plainUri = reduced.uri;
      width = reduced.width;
      height = reduced.height;
    }
    const plainSize = sizeOf(plainUri);
    if (plainSize === null) {
      throw new Error('media_unreadable');
    }
    if (plainSize > limit) {
      throw new Error('media_too_large');
    }

    // 2. Vignette, quand il y en a une.
    const thumbPlain = await buildThumbnail(input.asset, new File(stage, 'thumb.jpg'));

    // 3. Chiffrement : média puis vignette, chacun sa clé et son nonce.
    const mediaCipherFile = new File(stage, 'media.bin');
    const mediaCipher = await encryptBlob(plainUri, mediaCipherFile);
    const thumbCipherFile = new File(stage, 'thumb.bin');
    const thumbCipher = thumbPlain ? await encryptBlob(thumbPlain.uri, thumbCipherFile) : null;

    // 4. Téléversement des ciphertexts, rattachés à la conversation déclarée.
    const mediaUpload = await api.uploadMedia(input.token, {
      uri: mediaCipherFile.uri,
      fileName: input.asset.name,
      mimeType: 'application/octet-stream',
      encrypted: true,
      conversationId: input.conversation.id,
      kind: serverKind(input.asset.kind),
    });
    const thumbUpload = thumbCipher
      ? await api.uploadMedia(input.token, {
          uri: thumbCipherFile.uri,
          mimeType: 'application/octet-stream',
          encrypted: true,
          conversationId: input.conversation.id,
          kind: 'IMAGE',
        })
      : null;

    // 5. Enveloppe Olm `v:2` : type, dimensions, clés et identifiants.
    const media: EncryptedMedia = {
      type: BLOB_KIND[input.asset.kind],
      mime: input.asset.mime,
      name: input.asset.name,
      width: width ? Math.round(width) : undefined,
      height: height ? Math.round(height) : undefined,
      duration: input.asset.durationMs ? Math.round(input.asset.durationMs) : undefined,
      waveform:
        input.asset.kind === 'audio' && input.asset.waveform?.length
          ? input.asset.waveform
          : undefined,
      blob: { ...mediaCipher, uploadId: mediaUpload.id },
    };
    if (thumbPlain && thumbCipher && thumbUpload) {
      media.thumb = { ...thumbCipher, uploadId: thumbUpload.id };
    }
    const caption = input.caption?.trim() ?? '';

    const encrypted = await encryptEnvelope({
      token: input.token,
      db: input.db,
      account: input.account,
      conversation: input.conversation,
      currentUserId: input.currentUserId,
      plaintext: buildMediaV2(media, caption),
      allowKeyChange: input.allowKeyChange ?? false,
    });

    const clientId = newClientId();
    const provisional: StoredE2eeMessage = {
      id: clientId,
      conversation_id: input.conversation.id,
      sender_id: input.currentUserId,
      sender_name: input.currentUserName,
      body: caption,
      created_at: new Date().toISOString(),
      client_id: clientId,
      mine: 1,
      media_meta: encodeMediaMeta(media),
    };
    await saveLocalMessage(input.db, provisional);

    const socket = await ensureSocket(input.token);
    try {
      const result = (await socket.timeout(60000).emitWithAck('message:send', {
        conversationId: input.conversation.id,
        content: '',
        encryption: 'v1',
        payload: encrypted.payload,
        payloadType: encrypted.payloadType,
        attachmentId: mediaUpload.id,
        clientId,
      })) as Message | { error?: string };
      if ('error' in result && result.error) {
        throw new Error(result.error);
      }
      const serverMessage = result as Message;
      await renameLocalMessage(input.db, clientId, serverMessage.id);
      const stored: StoredE2eeMessage = {
        ...provisional,
        id: serverMessage.id,
        created_at: serverMessage.createdAt,
      };
      return { clientId, serverMessage, stored };
    } catch (cause) {
      await input.db
        .runAsync('DELETE FROM e2ee_messages WHERE id = ?', clientId)
        .catch(() => undefined);
      throw cause;
    }
  } finally {
    // Toujours : clair, vignette et ciphertexts sont dans le dossier de travail.
    releaseStage(stageId);
  }
}
