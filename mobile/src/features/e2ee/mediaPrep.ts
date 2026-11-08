import { File } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

import { loadOutboxMediaRefs } from './atomic';
import { loadMessageMediaRefs, updateLocalMessageMedia } from './db';
import { removeDurableMediaIfUnreferenced } from './mediaStore';
import { decodeMediaMeta, type EncryptedMedia } from './payload';

/**
 * Clé d'idempotence d'un téléversement, dérivée de l'identité **durable** de la
 * préparation (`clientId`, écrit dans SQLCipher avant tout fichier et tout
 * envoi). Elle est donc stable après redémarrage, distincte pour le média et sa
 * vignette, et ne dépend d'aucune variable volatile.
 *
 * Le serveur s'en sert de clé primaire `(utilisateur, clé)` : rejouer la même
 * requête rend le même `attachmentId` sans créer un second blob.
 */
export type MediaUploadPart = 'media' | 'thumb';

export function mediaUploadKey(clientId: string, part: MediaUploadPart): string {
  return `${clientId}:${part}`;
}

/**
 * Journal de **préparation** d'un média chiffré.
 *
 * L'outbox ne peut pas jouer ce rôle : il n'existe qu'après la création de
 * l'enveloppe Olm, donc après le chiffrement et les téléversements. Une coupure
 * entre le stockage durable et le journal laissait auparavant un ciphertext et
 * des clés que plus rien ne reliait (fenêtres A, B et C de l'audit 1.2b).
 *
 * Cette table ne chiffre rien elle-même : elle vit **dans** SQLCipher, seule
 * copie des clés média. Aucune clé ne doit sortir d'ici (ni AsyncStorage, ni
 * log, ni fichier en clair).
 *
 * Le module ne reprend **rien** : il expose la lecture et la classification des
 * préparations incomplètes. Le branchement d'un worker, d'un écran ou d'une
 * reprise périodique est explicitement hors périmètre.
 */

/**
 * Étape de la préparation, pas un fait sur le message.
 *
 * Chaque valeur nomme un travail **accompli** : `stored` = le ciphertext a été
 * écrit et vérifié, `uploaded` = les blobs sont chez le serveur, `message` =
 * l'écriture de la ligne SQLCipher a été exécutée, `journaled` = l'enveloppe est
 * dans l'outbox.
 *
 * `message` ne prétend donc pas que la ligne existe encore : un échec ultérieur
 * la retire et la préparation redescend à `uploaded`. C'est `messagePresent`,
 * relu dans la base, qui dit la vérité et que la classification utilise.
 */
export type MediaPreparationState =
  | 'preparing'
  | 'stored'
  | 'uploaded'
  | 'message'
  | 'journaled'
  | 'abandoned';

/**
 * Ce que la préparation permet de faire, déduit des faits persistés (et non de
 * l'état déclaré, qui peut avoir été interrompu avant sa mise à jour).
 */
export type MediaPreparationOutcome =
  /** Tout est là pour continuer ; `next` dit ce qu'il reste à faire. */
  | { kind: 'recoverable'; next: 'journal' | 'emit' }
  /** Le ciphertext durable manque : rien ne peut être envoyé. */
  | { kind: 'durable_file_missing' }
  /** Les clés média sont absentes ou illisibles : le blob serait indéchiffrable. */
  | { kind: 'keys_missing' }
  /** Aucun identifiant d'upload : reprendre exigerait de retéléverser. */
  | { kind: 'upload_unconfirmed' }
  /** Message écrit dans SQLCipher, outbox absente : état reconstruit, pas d'envoi. */
  | { kind: 'message_without_outbox' }
  /** Préparation explicitement abandonnée. */
  | { kind: 'abandoned' }
  /** Enveloppe déjà acquittée par le serveur. */
  | { kind: 'already_sent' };

export interface MediaPreparation {
  clientId: string;
  conversationId: string;
  state: MediaPreparationState;
  /** Description du média (clés, nonces, dimensions), relue depuis SQLCipher. */
  media: EncryptedMedia | null;
  mediaMeta: string | null;
  localCipherUri: string | null;
  localThumbCipherUri: string | null;
  attachmentId: string | null;
  thumbUploadId: string | null;
  /** Le fichier durable du média est-il réellement sur le disque ? */
  mediaPresent: boolean;
  thumbPresent: boolean;
  /** Une ligne `e2ee_messages` existe-t-elle pour cet identifiant ? */
  messagePresent: boolean;
  /** État de l'outbox, ou `null` s'il n'y a pas d'enveloppe journalisée. */
  outboxState: 'pending' | 'sending' | 'sent' | 'failed' | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  outcome: MediaPreparationOutcome;
}

interface PrepRow {
  client_id: string;
  conversation_id: string;
  media_meta: string | null;
  local_cipher_uri: string | null;
  local_thumb_cipher_uri: string | null;
  attachment_id: string | null;
  thumb_upload_id: string | null;
  state: MediaPreparationState;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  client_id, conversation_id, media_meta, local_cipher_uri,
  local_thumb_cipher_uri, attachment_id, thumb_upload_id, state,
  attempts, last_error, created_at, updated_at
`;

/**
 * Crée la préparation **avant** tout fichier durable : c'est ce qui garantit
 * qu'un ciphertext ne peut jamais exister sans que son identité soit connue.
 *
 * `media_meta` porte déjà les clés ; les identifiants d'upload y valent `''`
 * tant que le serveur n'a pas répondu, et les colonnes dédiées font foi.
 */
export async function createMediaPreparation(
  db: SQLiteDatabase,
  input: {
    clientId: string;
    conversationId: string;
    mediaMeta: string;
    now?: string;
  },
): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  await db.runAsync(
    `INSERT INTO e2ee_media_prep
       (client_id, conversation_id, media_meta, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'preparing', 0, ?, ?)
     ON CONFLICT(client_id) DO NOTHING`,
    input.clientId,
    input.conversationId,
    input.mediaMeta,
    now,
    now,
  );
}

/**
 * Avance une préparation. Seules les colonnes fournies changent : une écriture
 * partielle ne peut pas effacer une information déjà persistée (par exemple un
 * `attachment_id` obtenu juste avant une coupure).
 */
export async function advanceMediaPreparation(
  db: SQLiteDatabase,
  clientId: string,
  patch: {
    state?: MediaPreparationState;
    mediaMeta?: string;
    localCipherUri?: string | null;
    localThumbCipherUri?: string | null;
    attachmentId?: string | null;
    thumbUploadId?: string | null;
    now?: string;
  },
): Promise<void> {
  const assignments: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of [
    ['state', patch.state],
    ['media_meta', patch.mediaMeta],
    ['local_cipher_uri', patch.localCipherUri],
    ['local_thumb_cipher_uri', patch.localThumbCipherUri],
    ['attachment_id', patch.attachmentId],
    ['thumb_upload_id', patch.thumbUploadId],
  ] as const) {
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    params.push(value);
  }
  if (assignments.length === 0) return;
  assignments.push('updated_at = ?');
  params.push(patch.now ?? new Date().toISOString(), clientId);
  await db.runAsync(
    `UPDATE e2ee_media_prep SET ${assignments.join(', ')} WHERE client_id = ?`,
    ...(params as never[]),
  );
}

/** Note l'échec courant sans changer l'état : relancer reste possible. */
export async function noteMediaPreparationError(
  db: SQLiteDatabase,
  clientId: string,
  error: string,
): Promise<void> {
  await db.runAsync(
    `UPDATE e2ee_media_prep
       SET attempts = attempts + 1, last_error = ?, updated_at = ?
     WHERE client_id = ?`,
    error,
    new Date().toISOString(),
    clientId,
  );
}

/**
 * Abandonne explicitement une préparation. La ligne reste (trace de ce qui a
 * échoué), mais elle ne retient plus les fichiers : `isDurableMediaReferenced`
 * ignore les états abandonnés, donc le ciphertext peut être purgé.
 */
export async function abandonMediaPreparation(
  db: SQLiteDatabase,
  clientId: string,
  reason: string,
): Promise<void> {
  await db.runAsync(
    `UPDATE e2ee_media_prep
       SET state = 'abandoned', last_error = ?, updated_at = ?
     WHERE client_id = ?`,
    reason,
    new Date().toISOString(),
    clientId,
  );
}

/** Supprime la ligne : utilisé quand l'envoi est acquitté et rien ne reste. */
/**
 * Achève le nettoyage d'une préparation dont l'envoi est **déjà acquitté**.
 *
 * Cas visé : coupure entre l'accusé de réception et la purge locale. L'outbox
 * est `sent`, donc il n'y a rien à réémettre — mais la ligne SQLCipher retient
 * encore ses références durables et le fichier reste sur disque, retenu par la
 * préparation elle-même.
 *
 * N'agit que si l'outbox dit `sent` : dans tous les autres cas la fonction ne
 * touche à rien et le dit. Aucune enveloppe n'est créée, rien n'est émis.
 */
export type FinalizeSentOutcome =
  | { kind: 'already_sent'; clearedMessageRefs: boolean; filesRemoved: boolean }
  | { kind: 'not_sent' }
  | { kind: 'no_preparation' };

export async function finalizeSentMediaPreparation(
  db: SQLiteDatabase,
  clientId: string,
): Promise<FinalizeSentOutcome> {
  const preparation = await loadMediaPreparation(db, clientId);
  if (!preparation) return { kind: 'no_preparation' };
  if (preparation.outboxState !== 'sent') return { kind: 'not_sent' };

  // Les identifiants d'upload restent : ils datent d'un message accepté.
  const clearedMessageRefs = preparation.messagePresent
    ? (await updateLocalMessageMedia(db, clientId, {
        localCipherUri: null,
        localThumbCipherUri: null,
      })) > 0
    : false;
  await deleteMediaPreparation(db, clientId);
  const filesRemoved = await removeDurableMediaIfUnreferenced(db, clientId);
  return { kind: 'already_sent', clearedMessageRefs, filesRemoved };
}

export async function deleteMediaPreparation(
  db: SQLiteDatabase,
  clientId: string,
): Promise<void> {
  await db.runAsync('DELETE FROM e2ee_media_prep WHERE client_id = ?', clientId);
}

/** Lit une préparation et la classe. `null` si l'identifiant est inconnu. */
export async function loadMediaPreparation(
  db: SQLiteDatabase,
  clientId: string,
): Promise<MediaPreparation | null> {
  const row = await db.getFirstAsync<PrepRow>(
    `SELECT ${SELECT_COLUMNS} FROM e2ee_media_prep WHERE client_id = ?`,
    clientId,
  );
  return row ? classify(db, row) : null;
}

/**
 * Toutes les préparations, la plus ancienne d'abord.
 *
 * Aucune donnée ne vient de la mémoire du processus : tout est relu depuis
 * SQLCipher et le disque, donc un appel après redémarrage complet rend le même
 * résultat.
 */
export async function listMediaPreparations(
  db: SQLiteDatabase,
): Promise<MediaPreparation[]> {
  const rows = await db.getAllAsync<PrepRow>(
    `SELECT ${SELECT_COLUMNS} FROM e2ee_media_prep ORDER BY created_at`,
  );
  const preparations: MediaPreparation[] = [];
  for (const row of rows) preparations.push(await classify(db, row));
  return preparations;
}

/** Préparations qui ne sont ni abandonnées ni déjà envoyées. */
export async function listIncompleteMediaPreparations(
  db: SQLiteDatabase,
): Promise<MediaPreparation[]> {
  const all = await listMediaPreparations(db);
  return all.filter(
    (preparation) =>
      preparation.outcome.kind !== 'abandoned' && preparation.outcome.kind !== 'already_sent',
  );
}

function fileExists(uri: string | null): boolean {
  if (!uri) return false;
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

/**
 * Croise l'état déclaré avec les faits : fichiers réellement présents, ligne de
 * message, ligne d'outbox. L'état déclaré peut être en retard d'une étape (la
 * coupure tombe entre l'action et sa mise à jour), les faits jamais.
 */
async function classify(db: SQLiteDatabase, row: PrepRow): Promise<MediaPreparation> {
  const media = decodeMediaMeta(row.media_meta);
  const messageRefs = await loadMessageMediaRefs(db, row.client_id);
  const outbox = await loadOutboxMediaRefs(db, row.client_id);
  const mediaPresent = fileExists(row.local_cipher_uri);
  const thumbPresent = fileExists(row.local_thumb_cipher_uri);

  const preparation: MediaPreparation = {
    clientId: row.client_id,
    conversationId: row.conversation_id,
    state: row.state,
    media,
    mediaMeta: row.media_meta,
    localCipherUri: row.local_cipher_uri,
    localThumbCipherUri: row.local_thumb_cipher_uri,
    attachmentId: row.attachment_id,
    thumbUploadId: row.thumb_upload_id,
    mediaPresent,
    thumbPresent,
    messagePresent: Boolean(messageRefs),
    outboxState: (outbox?.state as MediaPreparation['outboxState']) ?? null,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    outcome: { kind: 'recoverable', next: 'journal' },
  };

  preparation.outcome = outcomeOf(preparation);
  return preparation;
}

function outcomeOf(preparation: MediaPreparation): MediaPreparationOutcome {
  if (preparation.outboxState === 'sent') return { kind: 'already_sent' };
  if (preparation.state === 'abandoned') return { kind: 'abandoned' };
  // Sans clés, un ciphertext présent ne serait qu'un bloc indéchiffrable : ne
  // jamais annoncer une reprise possible dans ce cas.
  const keys = preparation.media?.blob;
  if (!keys || !keys.fileKey || !keys.nonce) return { kind: 'keys_missing' };
  if (!preparation.mediaPresent) return { kind: 'durable_file_missing' };
  if (preparation.media?.thumb && !preparation.thumbPresent) {
    return { kind: 'durable_file_missing' };
  }
  if (preparation.messagePresent && preparation.outboxState === null) {
    // Fenêtre C : l'état est entièrement reconstruit (clés, fichier, upload),
    // mais aucune enveloppe n'est journalisée. On ne réinvente rien ici.
    return { kind: 'message_without_outbox' };
  }
  if (!preparation.attachmentId) return { kind: 'upload_unconfirmed' };
  // Vignette déjà téléversée ? Sinon l'enveloppe porterait un identifiant vide
  // et le destinataire n'aurait pas de miniature : autant l'annoncer.
  if (preparation.media?.thumb && !preparation.thumbUploadId) {
    return { kind: 'upload_unconfirmed' };
  }
  return {
    kind: 'recoverable',
    next: preparation.outboxState === null ? 'journal' : 'emit',
  };
}
