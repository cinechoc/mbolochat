import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import * as VideoThumbnails from 'expo-video-thumbnails';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import { ensureSocket } from '@/lib/socket';
import type { ConversationSummary, Message } from '@/lib/types';
import {
  loadLocalMessage,
  renameLocalMessage,
  saveLocalMessage,
  updateLocalMessageMedia,
  type E2eeAccountRow,
  type StoredE2eeMessage,
} from './db';
import type { EncryptedBlob, EncryptedMedia } from './payload';
import {
  advanceMediaPreparation,
  createMediaPreparation,
  deleteMediaPreparation,
  loadMediaPreparation,
  mediaUploadKey,
  noteMediaPreparationError,
} from './mediaPrep';
import { buildMediaV2, decodeMediaMeta, encodeMediaMeta } from './payload';
import { E2eeAlreadySentError, encryptEnvelope } from './text';
import {
  loadOutboxMediaRefs,
  loadPersistedEnvelope,
  markEnvelopeSent,
  type OutgoingEnvelope,
} from './atomic';
import {
  durableMediaUri,
  fileSystemPath,
  releaseStage,
  removeDurableMediaIfUnreferenced,
  reserveStage,
  storeDurableMedia,
  verifyDurableMedia,
} from './mediaStore';

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
  /** Id du message cité par cette réponse, chiffré dans l'enveloppe Olm. */
  replyToId?: string | null;
}

export interface SendEncryptedMediaResult {
  clientId: string;
  serverMessage: Message;
  stored: StoredE2eeMessage;
}

/** Émission réseau de l'enveloppe média, partagée par l'envoi et la reprise. */
async function emitMediaMessage(input: {
  token: string;
  conversationId: string;
  envelope: OutgoingEnvelope;
  attachmentId: string;
  clientId: string;
}): Promise<Message> {
  const socket = await ensureSocket(input.token);
  const result = (await socket.timeout(60000).emitWithAck('message:send', {
    conversationId: input.conversationId,
    content: '',
    encryption: 'v1',
    payload: input.envelope.payload,
    payloadType: input.envelope.payloadType,
    attachmentId: input.attachmentId,
    clientId: input.clientId,
  })) as Message | { error?: string };
  if ('error' in result && result.error) {
    throw new Error(result.error);
  }
  return result as Message;
}

/**
 * Après un envoi accepté : les références durables sont retirées de SQLCipher,
 * puis les fichiers disparaissent **si plus rien ne les référence**.
 *
 * L'identifiant d'upload est conservé sur la ligne : il décrit toujours le blob
 * du message, même une fois le ciphertext local évincé.
 */
async function releaseDurableAfterSend(
  db: SendEncryptedMediaInput['db'],
  mediaId: string,
  messageId: string,
): Promise<void> {
  await updateLocalMessageMedia(db, messageId, {
    localCipherUri: null,
    localThumbCipherUri: null,
  });
  await removeDurableMediaIfUnreferenced(db, mediaId);
}

/**
 * Chiffre le média et sa vignette, les téléverse, puis envoie l'enveloppe `v:2`.
 *
 * L'ordre est celui qui rend un arrêt brutal récupérable :
 *
 * 1. clairs de travail et chiffrement (cache, jetable) ;
 * 2. **journal de préparation** — identité, clés et conversation, avant tout
 *    fichier durable ;
 * 3. ciphertexts **durables** (le clair n'est jamais écrit là), vérifiés ;
 * 4. téléversement des blobs, chaque identifiant persisté dès réception ;
 * 5. SQLCipher : message provisoire et références durables ;
 * 6. enveloppe Olm journalisée (`S1` + `E` d'un seul tenant) ;
 * 7. émission, puis nettoyage contrôlé.
 *
 * Le journal de préparation (étape 2) est ce qui distingue cette version de la
 * précédente : une coupure aux étapes 3 à 5 laisse désormais de quoi retrouver
 * le média, ses clés et son identifiant d'upload, alors qu'avant seuls des
 * fichiers orphelins subsistaient.
 *
 * En cas d'échec, la bulle provisoire est toujours retirée : elle ne doit
 * jamais rester visible sans enveloppe journalisée derrière. Le ciphertext
 * durable et le journal de préparation, eux, sont conservés — ils permettent
 * une reprise, ils ne se recréent pas.
 */
export async function sendEncryptedMedia(
  input: SendEncryptedMediaInput,
): Promise<SendEncryptedMediaResult> {
  const stageId = newStageId();
  const stage = reserveStage(stageId);
  // Même valeur pour le message, pour le média durable et pour la préparation :
  // journal, ligne SQLCipher et fichier se retrouvent sans table de
  // correspondance.
  const clientId = newClientId();
  let preparationCreated = false;
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

    // 4. Journal de préparation **avant** le premier fichier durable : c'est lui
    //    qui donne un nom retrouvable au dossier, et qui garde les clés si
    //    l'application meurt avant l'écriture du message.
    const descriptor = (uploadId: string, thumbUploadId: string): EncryptedMedia => {
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
        blob: { ...mediaCipher, uploadId },
      };
      if (thumbCipher) media.thumb = { ...thumbCipher, uploadId: thumbUploadId };
      return media;
    };
    // Les identifiants d'upload valent `''` tant que le serveur n'a pas répondu :
    // les colonnes `attachment_id`/`thumb_upload_id` font foi entre-temps.
    await createMediaPreparation(input.db, {
      clientId,
      conversationId: input.conversation.id,
      mediaMeta: encodeMediaMeta(descriptor('', '')),
    });
    preparationCreated = true;

    // 5. Stockage durable des **ciphertexts** uniquement, puis contrôle. Les
    //    références ne sont écrites qu'après vérification : une préparation ne
    //    désigne jamais un fichier incomplet.
    const durableMedia = await storeDurableMedia({ id: clientId, sourceUri: mediaCipherFile.uri });
    const durableThumb = thumbCipher
      ? await storeDurableMedia({
          id: clientId,
          kind: 'thumb',
          sourceUri: thumbCipherFile.uri,
        })
      : null;
    if (
      !verifyDurableMedia({ id: clientId, expectedSize: durableMedia.size }).ok ||
      (durableThumb && !verifyDurableMedia({ id: clientId, kind: 'thumb', expectedSize: durableThumb.size }).ok)
    ) {
      throw new Error('media_storage_failed');
    }
    await advanceMediaPreparation(input.db, clientId, {
      state: 'stored',
      localCipherUri: durableMedia.uri,
      localThumbCipherUri: durableThumb?.uri ?? null,
    });

    // 6. Téléversement des ciphertexts, rattachés à la conversation déclarée.
    //    Chaque identifiant obtenu est persisté avant l'étape suivante : une
    //    coupure ne peut pas perdre un blob déjà déposé chez le serveur.
    const mediaUpload = await api.uploadMedia(input.token, {
      uri: durableMedia.uri,
      fileName: input.asset.name,
      mimeType: 'application/octet-stream',
      encrypted: true,
      conversationId: input.conversation.id,
      kind: serverKind(input.asset.kind),
      // Même clé à chaque tentative : un rejeu ne crée pas de second blob.
      idempotencyKey: mediaUploadKey(clientId, 'media'),
    });
    await advanceMediaPreparation(input.db, clientId, { attachmentId: mediaUpload.id });
    const thumbUpload = durableThumb
      ? await api.uploadMedia(input.token, {
          uri: durableThumb.uri,
          mimeType: 'application/octet-stream',
          encrypted: true,
          conversationId: input.conversation.id,
          kind: 'IMAGE',
          idempotencyKey: mediaUploadKey(clientId, 'thumb'),
        })
      : null;
    if (thumbUpload) {
      await advanceMediaPreparation(input.db, clientId, { thumbUploadId: thumbUpload.id });
    }

    // 7. Description définitive du média : mêmes clés, identifiants réels.
    const media = descriptor(mediaUpload.id, thumbUpload?.id ?? '');
    const mediaMeta = encodeMediaMeta(media);
    await advanceMediaPreparation(input.db, clientId, { state: 'uploaded', mediaMeta });
    const caption = input.caption?.trim() ?? '';

    // 8. SQLCipher : la ligne du message porte les références durables.
    const provisional: StoredE2eeMessage = {
      id: clientId,
      conversation_id: input.conversation.id,
      sender_id: input.currentUserId,
      sender_name: input.currentUserName,
      body: caption,
      created_at: new Date().toISOString(),
      client_id: clientId,
      mine: 1,
      media_meta: mediaMeta,
      quote_id: null,
    };
    await saveLocalMessage(input.db, provisional);
    await updateLocalMessageMedia(input.db, clientId, {
      localCipherUri: durableMedia.uri,
      localThumbCipherUri: durableThumb?.uri ?? null,
      uploadId: mediaUpload.id,
      thumbUploadId: thumbUpload?.id ?? null,
    });
    await advanceMediaPreparation(input.db, clientId, { state: 'message' });

    // 9. Journal d'envoi : l'enveloppe et ses références, atomiquement avec S1.
    const envelope = await encryptEnvelope({
      token: input.token,
      db: input.db,
      account: input.account,
      conversation: input.conversation,
      currentUserId: input.currentUserId,
      plaintext: buildMediaV2(media, caption),
      allowKeyChange: input.allowKeyChange ?? false,
      clientId,
      attachmentId: mediaUpload.id,
      mediaMeta,
      quoteId: null,
    });
    await advanceMediaPreparation(input.db, clientId, { state: 'journaled' });

    // 10. Émission, puis nettoyage contrôlé.
    const serverMessage = await emitMediaMessage({
      token: input.token,
      conversationId: input.conversation.id,
      envelope,
      attachmentId: mediaUpload.id,
      clientId,
    });
    await renameLocalMessage(input.db, clientId, serverMessage.id);
    await markEnvelopeSent(input.db, clientId, serverMessage.id);
    // Le journal de préparation disparaît **avant** la purge des fichiers :
    // sinon il les retiendrait lui-même.
    await deleteMediaPreparation(input.db, clientId);
    await releaseDurableAfterSend(input.db, clientId, serverMessage.id);
    return {
      clientId,
      serverMessage,
      stored: {
        ...provisional,
        id: serverMessage.id,
        created_at: serverMessage.createdAt,
      },
    };
  } catch (cause) {
    await cleanUpFailedSend(input.db, clientId, preparationCreated, cause);
    throw cause;
  } finally {
    // Toujours : clairs et ciphertexts de travail du cache disparaissent ; seul
    // le stockage durable survit.
    releaseStage(stageId);
  }
}

/**
 * Nettoyage d'un envoi qui a échoué, quelle qu'en soit l'étape.
 *
 * La bulle provisoire est **toujours** retirée : elle ne doit jamais rester
 * visible alors que rien ne garantit qu'elle sera envoyée. C'est
 * particulièrement vrai pour un échec de `encryptEnvelope`, qui laissait avant
 * cette étape une bulle sans enveloppe ni journal.
 *
 * Le ciphertext durable et le journal de préparation ne sont **jamais** touchés
 * ici : ils sont la reprise. Seul `abandonMediaPreparation` les libère.
 */
async function cleanUpFailedSend(
  db: SendEncryptedMediaInput['db'],
  clientId: string,
  preparationCreated: boolean,
  cause: unknown,
): Promise<void> {
  try {
    // `client_id` couvre le cas où la ligne a déjà été renommée côté serveur.
    await db.runAsync(
      'DELETE FROM e2ee_messages WHERE id = ? OR client_id = ?',
      clientId,
      clientId,
    );
  } catch {
    // Base indisponible : rien de plus à tenter, l'erreur d'origine prime.
  }
  if (!preparationCreated) return;
  try {
    // L'état ne doit jamais prétendre plus que ce qui est persisté : si la
    // ligne de message vient d'être retirée et qu'aucune enveloppe n'est
    // journalisée, la préparation redescend à l'étape réellement atteinte.
    // La classification, elle, s'appuie toujours sur `messagePresent`.
    const preparation = await loadMediaPreparation(db, clientId);
    if (
      preparation &&
      !preparation.messagePresent &&
      preparation.outboxState === null &&
      (preparation.state === 'message' || preparation.state === 'journaled')
    ) {
      await advanceMediaPreparation(db, clientId, { state: 'uploaded' });
    }
    await noteMediaPreparationError(
      db,
      clientId,
      cause instanceof Error ? cause.message : String(cause),
    );
  } catch {
    // La préparation reste lisible même sans la note d'erreur.
  }
}

export interface ResumeEncryptedMediaInput {
  token: string;
  db: SendEncryptedMediaInput['db'];
  account: E2eeAccountRow;
  conversation: ConversationSummary;
  currentUserId: string;
  currentUserName: string;
  /** Entrée de journal à reprendre. */
  clientId: string;
}

/**
 * Reprend un envoi média interrompu après le journal.
 *
 * Le ciphertext durable et l'enveloppe journalisée sont réutilisés tels quels :
 * aucun nouveau chiffrement, aucun nouveau téléversement. Si l'enveloppe manque
 * (interruption entre SQLCipher et journal), elle est reconstruite à partir des
 * clés déjà stockées dans `media_meta`, sans retoucher au fichier.
 *
 * Un fichier durable absent lève `durable_file_missing` : une reprise ne
 * rapporte jamais un succès sur un média qu'elle ne peut pas envoyer.
 */
export async function resumeEncryptedMedia(
  input: ResumeEncryptedMediaInput,
): Promise<SendEncryptedMediaResult> {
  const refs = await loadOutboxMediaRefs(input.db, input.clientId);
  if (!refs) {
    throw new Error('media_not_journaled');
  }
  if (refs.state === 'sent') {
    throw new E2eeAlreadySentError(input.clientId, null);
  }
  const media = decodeMediaMeta(refs.mediaMeta);
  if (!media) {
    throw new Error('media_not_journaled');
  }
  if (!refs.attachmentId) {
    // Le téléversement n'a jamais abouti : reprendre exigerait une idempotence
    // de `/uploads`, qui n'existe pas encore (hors périmètre).
    throw new Error('media_upload_missing');
  }
  if (!durableMediaUri(input.clientId) || (media.thumb && !durableMediaUri(input.clientId, 'thumb'))) {
    throw new Error('durable_file_missing');
  }

  const previous = await loadLocalMessage(input.db, input.clientId);
  const stored = await loadPersistedEnvelope(input.db, input.clientId);
  const envelope =
    stored.status === 'none'
      ? // Interruption entre SQLCipher et journal : même média, mêmes clés.
        await encryptEnvelope({
          token: input.token,
          db: input.db,
          account: input.account,
          conversation: input.conversation,
          currentUserId: input.currentUserId,
          plaintext: buildMediaV2(media, previous?.body ?? ''),
          allowKeyChange: false,
          clientId: input.clientId,
          attachmentId: refs.attachmentId,
          mediaMeta: refs.mediaMeta,
          quoteId: null,
          resumeFailed: true,
        })
      : stored.envelope;

  const serverMessage = await emitMediaMessage({
    token: input.token,
    conversationId: input.conversation.id,
    envelope,
    attachmentId: refs.attachmentId,
    clientId: input.clientId,
  });

  const provisional: StoredE2eeMessage =
    previous ?? {
      id: input.clientId,
      conversation_id: input.conversation.id,
      sender_id: input.currentUserId,
      sender_name: input.currentUserName,
      body: '',
      created_at: new Date().toISOString(),
      client_id: input.clientId,
      mine: 1,
      media_meta: refs.mediaMeta,
      quote_id: null,
    };
  await saveLocalMessage(input.db, provisional);
  await renameLocalMessage(input.db, input.clientId, serverMessage.id);
  await markEnvelopeSent(input.db, input.clientId, serverMessage.id);
  // Comme à l'envoi : la préparation disparaît avant la purge, sinon elle
  // retiendrait elle-même le ciphertext qu'on vient d'envoyer.
  await deleteMediaPreparation(input.db, input.clientId);
  await releaseDurableAfterSend(input.db, input.clientId, serverMessage.id);
  return {
    clientId: input.clientId,
    serverMessage,
    stored: {
      ...provisional,
      id: serverMessage.id,
      created_at: serverMessage.createdAt,
    },
  };
}
