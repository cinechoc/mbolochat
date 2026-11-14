import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import type { ReactionSummary } from '@/lib/types';
import { migrateE2eeSchema } from './schema';

const DATABASE_NAME = 'mbolo-e2ee.db';

export interface E2eeAccountRow {
  account_pickle: string;
  device_id: string | null;
  identity_key: string;
  signing_key: string;
  fallback_key?: string | null;
  fallback_signature?: string | null;
  fallback_key_id?: string | null;
}

export interface E2eeDatabase {
  db: SQLiteDatabase;
  recovered: boolean;
  cipherVersion: string;
}

/**
 * Ouvre la base locale chiffrée. La clé SQLCipher est générée et protégée par
 * le Keystore ; elle ne transite ici que le temps du PRAGMA key (risque accepté
 * pour la v1, documenté dans le rapport).
 */
export async function openE2eeDatabase(): Promise<E2eeDatabase> {
  const keys = await MboloCrypto.ensureKeys();
  if (keys.recovered) {
    // Identité recréée : les clés qui ouvraient les médias temporaires ont
    // disparu, ces fichiers sont désormais illisibles et ne doivent pas rester.
    // Import paresseux : la base ne doit pas dépendre du système de fichiers.
    const { sweepSecureMedia } = await import('./mediaStore');
    sweepSecureMedia();
    await deleteDatabaseAsync(DATABASE_NAME);
  }
  const { key } = await MboloCrypto.sqlCipherKey();
  let sqlKey = key;
  let db: SQLiteDatabase | null = null;
  try {
    let version = null as { cipher_version: string } | null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        db = await openDatabaseAsync(DATABASE_NAME);
        await db.execAsync(`PRAGMA key = "x'${sqlKey}'"`);
        version = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version');
        if (!version?.cipher_version) {
          throw new Error('SQLCipher indisponible dans cette build');
        }
        // Le premier vrai accès au fichier : c'est là qu'un fichier illisible
        // se révèle, il doit tomber dans le reessai ci-dessous.
        await db.getFirstAsync<{ c: number }>('SELECT count(*) AS c FROM sqlite_master');
        break;
      } catch (cause) {
        // Fichier illisible avec cette clé (suppression de récupération qui a
        // échoué, corruption) : on repart d'une base propre plutôt que de
        // laisser l'app bloquée sur un fichier indéchiffrable.
        if (attempt === 1 || !String(cause).includes('file is not a database')) {
          throw cause;
        }
        await db?.closeAsync().catch(() => undefined);
        await deleteDatabaseAsync(DATABASE_NAME);
      }
    }
    if (!db || !version) {
      throw new Error('SQLCipher indisponible dans cette build');
    }
    // Schéma versionné : création des tables historiques puis migrations
    // unitaires. Un second passage sur une base à jour n'écrit rien.
    await migrateE2eeSchema(db);
    return { db, recovered: keys.recovered, cipherVersion: version.cipher_version };
  } finally {
    sqlKey = '';
  }
}

export async function loadE2eeAccount(db: SQLiteDatabase): Promise<E2eeAccountRow | null> {
  return db.getFirstAsync<E2eeAccountRow>(
    `SELECT account_pickle, device_id, identity_key, signing_key,
            fallback_key, fallback_signature, fallback_key_id
     FROM e2ee_account WHERE id = 1`,
  );
}

export async function saveE2eeAccount(
  db: SQLiteDatabase,
  account: E2eeAccountRow,
): Promise<void> {
  await saveE2eeAccountWith(db, account);
}

/**
 * Écrit le compte (prekey consommée incluse). Variante transactionnelle : le
 * chemin entrant fait avancer le compte et la session dans la même écriture.
 */
export async function saveE2eeAccountWith(
  writer: SqlWriter,
  account: E2eeAccountRow,
): Promise<void> {
  await writer.runAsync(
    `INSERT INTO e2ee_account
       (id, account_pickle, device_id, identity_key, signing_key,
        fallback_key, fallback_signature, fallback_key_id, created_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_pickle = excluded.account_pickle,
       device_id = excluded.device_id,
       identity_key = excluded.identity_key,
       signing_key = excluded.signing_key,
       fallback_key = excluded.fallback_key,
       fallback_signature = excluded.fallback_signature,
       fallback_key_id = excluded.fallback_key_id`,
    account.account_pickle,
    account.device_id,
    account.identity_key,
    account.signing_key,
    account.fallback_key ?? null,
    account.fallback_signature ?? null,
    account.fallback_key_id ?? null,
    new Date().toISOString(),
  );
}

export interface E2eeSessionRow {
  peer_user_id: string;
  peer_device_id: string | null;
  session_pickle: string;
  peer_identity_key: string;
  peer_signing_key: string;
  updated_at: string;
}

export async function loadSession(
  db: SQLiteDatabase,
  peerId: string,
  peerDeviceId?: string | null,
): Promise<E2eeSessionRow | null> {
  // Clé primaire composite (pair, appareil) : sans appareil explicite on prend
  // la session la plus récente, ce qui préserve les appelants existants.
  if (peerDeviceId) {
    return db.getFirstAsync<E2eeSessionRow>(
      'SELECT * FROM e2ee_sessions WHERE peer_user_id = ? AND peer_device_id = ?',
      peerId,
      peerDeviceId,
    );
  }
  return db.getFirstAsync<E2eeSessionRow>(
    `SELECT * FROM e2ee_sessions WHERE peer_user_id = ?
     ORDER BY updated_at DESC LIMIT 1`,
    peerId,
  );
}

/** Un appareil inconnu est stocké en chaîne vide : la paire reste unique et
 * n'est jamais `NULL`, qu'SQLite autorise pourtant dans une clé primaire. */
function sessionDevice(peerDeviceId: string | null | undefined): string {
  return peerDeviceId ?? '';
}

export async function saveSession(
  db: SQLiteDatabase,
  session: E2eeSessionRow,
): Promise<void> {
  await saveSessionWith(db, session);
}

/**
 * Handle minimal d'écriture : la base, ou bien la transaction exclusive
 * (`Transaction`) qui n'expose que `runAsync`. La même requête exacte sert donc
 * aux deux chemins, sans dupliquer le SQL de session.
 */
export type SqlWriter = Pick<SQLiteDatabase, 'runAsync'>;

/**
 * Écrit S1. Appelé hors transaction exclusive pour les chemins qui n'écrivent
 * pas d'enveloppe, et **avec le handle `tx`** depuis `persistSessionAndEnvelope`
 * pour que S1 et E soient dans la même transaction.
 */
export async function saveSessionWith(
  writer: SqlWriter,
  session: E2eeSessionRow,
): Promise<void> {
  await writer.runAsync(
    `INSERT INTO e2ee_sessions
       (peer_user_id, peer_device_id, session_pickle, peer_identity_key, peer_signing_key, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(peer_user_id, peer_device_id) DO UPDATE SET
       session_pickle = excluded.session_pickle,
       peer_identity_key = excluded.peer_identity_key,
       peer_signing_key = excluded.peer_signing_key,
       updated_at = excluded.updated_at`,
    session.peer_user_id,
    sessionDevice(session.peer_device_id),
    session.session_pickle,
    session.peer_identity_key,
    session.peer_signing_key,
    session.updated_at,
  );
}

export async function loadPeerSigningKey(
  db: SQLiteDatabase,
  peerId: string,
  peerDeviceId?: string | null,
): Promise<string | null> {
  if (peerDeviceId) {
    const row = await db.getFirstAsync<{ signing_key: string }>(
      'SELECT signing_key FROM e2ee_peer_keys WHERE peer_user_id = ? AND peer_device_id = ?',
      peerId,
      peerDeviceId,
    );
    return row?.signing_key ?? null;
  }
  const row = await db.getFirstAsync<{ signing_key: string }>(
    `SELECT signing_key FROM e2ee_peer_keys WHERE peer_user_id = ?
     ORDER BY updated_at DESC LIMIT 1`,
    peerId,
  );
  return row?.signing_key ?? null;
}

export async function savePeerSigningKey(
  db: SQLiteDatabase,
  peerId: string,
  signingKey: string,
  verified: boolean,
  peerDeviceId?: string | null,
): Promise<void> {
  await savePeerSigningKeyWith(db, peerId, signingKey, verified, peerDeviceId);
}

export async function savePeerSigningKeyWith(
  writer: SqlWriter,
  peerId: string,
  signingKey: string,
  verified: boolean,
  peerDeviceId?: string | null,
): Promise<void> {
  await writer.runAsync(
    `INSERT INTO e2ee_peer_keys (peer_user_id, peer_device_id, signing_key, verified, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(peer_user_id, peer_device_id) DO UPDATE SET
       signing_key = excluded.signing_key,
       verified = excluded.verified,
       updated_at = excluded.updated_at`,
    peerId,
    sessionDevice(peerDeviceId),
    signingKey,
    verified ? 1 : 0,
    new Date().toISOString(),
  );
}

export interface StoredE2eeMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  body: string;
  created_at: string;
  client_id: string | null;
  mine: number;
  /**
   * Référence JSON du média chiffré (blob + vignette, clés comprises), ou
   * `null` pour un message texte. Stockée dans la base SQLCipher : c'est la
   * seule copie des clés, elle ne doit jamais atterrir dans `mbolochat.db`.
   */
  media_meta: string | null;
  /** Id du message cité par cette réponse, ou `null`. */
  quote_id: string | null;
  /**
   * Référence d'un sticker de catalogue (« pack/id »), ou `null`. Comme
   * `media_meta`, elle ne vit que dans cette base chiffrée : le serveur ne la
   * reçoit jamais, et l'affichage seul la résout vers une image embarquée.
   */
  sticker_ref?: string | null;
  /**
   * Motif d'un message **authentifié mais illisible** (`unsupported_version`,
   * `invalid_payload`, `invalid_encoding`), ou `null`/absent pour un message
   * lisible. Liste fermée : on n'y met jamais le contenu ni le message d'une
   * exception, qui pourraient porter des données du payload.
   */
  unreadable_reason?: string | null;
  /** Chemin durable du ciphertext local du média, avant ou après envoi. */
  local_cipher_uri?: string | null;
  /** Identifiant serveur du blob média une fois téléversé. */
  upload_id?: string | null;
  /** Chemin durable du ciphertext local de la vignette. */
  local_thumb_cipher_uri?: string | null;
  /** Identifiant serveur du blob de vignette, indépendant de `upload_id`. */
  thumb_upload_id?: string | null;
  /** Ligne de contrôle : conservée pour l'idempotence, jamais affichée. */
  hidden?: number | null;
  /** `reaction`, `delete` ou `unknown` pour une ligne de contrôle. */
  content_kind?: string | null;
  /** Message visé par un événement de contrôle. */
  control_target?: string | null;
  /** Référence fermée de la réaction, jamais du texte libre. */
  reaction?: string | null;
  reaction_action?: string | null;
  /** Contenu authentifié d'une version future, conservé en SQLCipher seulement. */
  raw_payload?: string | null;
  /** Message supprimé pour tous : rangée conservée, contenu vidé. */
  deleted?: number | null;
  /** Auteur vérifié de la suppression, pour audit local uniquement. */
  deleted_by?: string | null;
}

export async function saveLocalMessage(
  db: SQLiteDatabase,
  message: StoredE2eeMessage,
): Promise<void> {
  await saveLocalMessageWith(db, message);
}

/**
 * Écrit un message déchiffré. Variante transactionnelle utilisée par le chemin
 * entrant, pour que le message et l'état de session atterrissent ensemble.
 */
export async function saveLocalMessageWith(
  writer: SqlWriter,
  message: StoredE2eeMessage,
): Promise<void> {
  await writer.runAsync(
    `INSERT INTO e2ee_messages
       (id, conversation_id, sender_id, sender_name, body, created_at, client_id, mine,
        media_meta, quote_id, sticker_ref, unreadable_reason, hidden, content_kind,
        control_target, reaction, reaction_action, raw_payload, deleted, deleted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       body = excluded.body,
       sticker_ref = COALESCE(excluded.sticker_ref, e2ee_messages.sticker_ref),
       unreadable_reason = COALESCE(excluded.unreadable_reason, e2ee_messages.unreadable_reason),
       hidden = excluded.hidden,
       content_kind = excluded.content_kind,
       control_target = excluded.control_target,
       reaction = excluded.reaction,
       reaction_action = excluded.reaction_action,
       raw_payload = COALESCE(excluded.raw_payload, e2ee_messages.raw_payload),
       deleted = CASE WHEN e2ee_messages.deleted = 1 THEN 1 ELSE excluded.deleted END,
       deleted_by = COALESCE(e2ee_messages.deleted_by, excluded.deleted_by)`,
    message.id,
    message.conversation_id,
    message.sender_id,
    message.sender_name,
    message.body,
    message.created_at,
    message.client_id,
    message.mine,
    message.media_meta ?? null,
    message.quote_id ?? null,
    message.sticker_ref ?? null,
    message.unreadable_reason ?? null,
    message.hidden ?? 0,
    message.content_kind ?? null,
    message.control_target ?? null,
    message.reaction ?? null,
    message.reaction_action ?? null,
    message.raw_payload ?? null,
    message.deleted ?? 0,
    message.deleted_by ?? null,
  );
}

/** Ligne provisoire (avant accusé serveur) : id = clientId, renommée après ack. */
export async function renameLocalMessage(
  db: SQLiteDatabase,
  clientId: string,
  serverId: string,
): Promise<void> {
  await db.runAsync(
    'UPDATE e2ee_messages SET id = ?, client_id = ? WHERE id = ?',
    serverId,
    clientId,
    clientId,
  );
}

export async function deleteLocalMessage(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM e2ee_messages WHERE id = ?', id);
}

/** Champs du cycle média durable que l'on peut mettre à jour séparément. */
export interface LocalMediaUpdate {
  mediaMeta?: string | null;
  localCipherUri?: string | null;
  uploadId?: string | null;
  localThumbCipherUri?: string | null;
  thumbUploadId?: string | null;
}

const MEDIA_UPDATE_COLUMNS: [keyof LocalMediaUpdate, string][] = [
  ['mediaMeta', 'media_meta'],
  ['localCipherUri', 'local_cipher_uri'],
  ['uploadId', 'upload_id'],
  ['localThumbCipherUri', 'local_thumb_cipher_uri'],
  ['thumbUploadId', 'thumb_upload_id'],
];

/**
 * Écrit les références du média chiffré sur un message déjà stocké.
 *
 * Une seule requête, et seulement les colonnes réellement fournies : le média et
 * sa vignette avancent indépendamment (décision 5), donc une mise à jour de la
 * vignette ne doit jamais effacer l'id de blob du média, et inversement. Un
 * appel sans champ n'écrit rien et renvoie 0.
 *
 * Retourne le nombre de lignes modifiées, ce qui permet à l'appelant de
 * constater qu'un message provisoire a disparu entre-temps.
 */
export async function updateLocalMessageMedia(
  db: SQLiteDatabase,
  id: string,
  update: LocalMediaUpdate,
): Promise<number> {
  const assignments: string[] = [];
  const values: (string | null)[] = [];
  for (const [key, column] of MEDIA_UPDATE_COLUMNS) {
    if (!(key in update)) continue;
    assignments.push(`${column} = ?`);
    values.push(update[key] ?? null);
  }
  if (assignments.length === 0) {
    return 0;
  }
  const result = await db.runAsync(
    `UPDATE e2ee_messages SET ${assignments.join(', ')} WHERE id = ?`,
    ...values,
    id,
  );
  return result.changes;
}

/** Références média d'un message, telles que persistées dans SQLCipher. */
export interface LocalMediaRefs {
  local_cipher_uri: string | null;
  upload_id: string | null;
  local_thumb_cipher_uri: string | null;
  thumb_upload_id: string | null;
}

/**
 * Relit les références média d'un message. Le ciphertext durable et son
 * identifiant d'upload sont deux états distincts (décision 5) : l'appelant doit
 * pouvoir voir qu'un fichier est là sans que le blob soit encore téléversé.
 */
export async function loadMessageMediaRefs(
  db: SQLiteDatabase,
  id: string,
): Promise<LocalMediaRefs | null> {
  return db.getFirstAsync<LocalMediaRefs>(
    `SELECT local_cipher_uri, upload_id, local_thumb_cipher_uri, thumb_upload_id
     FROM e2ee_messages WHERE id = ?`,
    id,
  );
}

/**
 * Un média durable est-il encore référencé par un message, ou par un envoi qui
 * n'est pas abouti ?
 *
 * Sert de garde avant toute suppression : un fichier encore référencé ne doit
 * jamais disparaître, même après un envoi réussi. `directory` est fourni par
 * l'appelant pour que le nom du dossier durable reste défini à un seul endroit
 * (pas de cycle d'import entre la base et le stockage).
 */
export async function isDurableMediaReferenced(
  db: SQLiteDatabase,
  mediaId: string,
  directory: string,
): Promise<boolean> {
  const needle = `/${directory}/${mediaId}/`;
  const row = await db.getFirstAsync<{ messages: number; pending: number; preparing: number }>(
    `SELECT
       (SELECT COUNT(*) FROM e2ee_messages
          WHERE INSTR(local_cipher_uri, ?) > 0
             OR INSTR(local_thumb_cipher_uri, ?) > 0) AS messages,
       (SELECT COUNT(*) FROM e2ee_outbox
          WHERE client_id = ? AND state IN ('pending', 'sending', 'failed')) AS pending,
       (SELECT COUNT(*) FROM e2ee_media_prep
          WHERE client_id = ? AND state != 'abandoned') AS preparing`,
    needle,
    needle,
    mediaId,
    mediaId,
  );
  return Boolean(
    row && (row.messages > 0 || row.pending > 0 || row.preparing > 0),
  );
}

/** Identifiants déjà présents pour ignorer le re-déchiffrement de l'historique. */
export async function knownMessageKeys(
  db: SQLiteDatabase,
  conversationId: string,
): Promise<{ ids: Set<string>; clientIds: Set<string> }> {
  const rows = await db.getAllAsync<{ id: string; client_id: string | null }>(
    'SELECT id, client_id FROM e2ee_messages WHERE conversation_id = ?',
    conversationId,
  );
  return {
    ids: new Set(rows.map((row) => row.id)),
    clientIds: new Set(rows.map((row) => row.client_id).filter(Boolean) as string[]),
  };
}

/** Un message déjà stocké, par identifiant serveur. Sert au contrôle de doublon
 * du chemin entrant : un message déjà écrit ne se déchiffre pas deux fois. */
export async function loadLocalMessage(
  db: SQLiteDatabase,
  id: string,
): Promise<StoredE2eeMessage | null> {
  return db.getFirstAsync<StoredE2eeMessage>('SELECT * FROM e2ee_messages WHERE id = ?', id);
}

export async function listLocalMessages(
  db: SQLiteDatabase,
  conversationId: string,
  limit = 200,
): Promise<StoredE2eeMessage[]> {
  return db.getAllAsync<StoredE2eeMessage>(
    `SELECT * FROM e2ee_messages WHERE conversation_id = ? AND COALESCE(hidden, 0) = 0
     ORDER BY created_at DESC LIMIT ?`,
    conversationId,
    limit,
  );
}

interface ReactionEventRow {
  control_target: string;
  sender_id: string;
  reaction: string;
  reaction_action: string;
  created_at: string;
  id: string;
}

/**
 * Agrège les réactions d'une conversation depuis SQLCipher.
 *
 * L'ensemble `(cible, réaction, auteur)` rend les doublons inoffensifs : un
 * `add` répété ne compte pas deux fois et `remove` retire seulement l'auteur
 * concerné. Les événements dont la cible n'existe pas encore restent dans la
 * map ; ils seront appliqués quand la cible arrivera.
 */
export async function loadReactionSummaries(
  db: SQLiteDatabase,
  conversationId: string,
  currentUserId: string,
): Promise<Map<string, ReactionSummary[]>> {
  const rows = await db.getAllAsync<ReactionEventRow>(
    `SELECT id, sender_id, control_target, reaction, reaction_action, created_at
       FROM e2ee_messages
      WHERE conversation_id = ? AND content_kind = 'reaction'
      ORDER BY created_at ASC, id ASC`,
    conversationId,
  );
  const active = new Map<string, Map<string, Set<string>>>();
  for (const row of rows) {
    if (
      typeof row.control_target !== 'string' ||
      typeof row.reaction !== 'string' ||
      (row.reaction_action !== 'add' && row.reaction_action !== 'remove')
    ) {
      continue;
    }
    let byReaction = active.get(row.control_target);
    if (!byReaction) {
      byReaction = new Map();
      active.set(row.control_target, byReaction);
    }
    let reactors = byReaction.get(row.reaction);
    if (!reactors) {
      reactors = new Set();
      byReaction.set(row.reaction, reactors);
    }
    if (row.reaction_action === 'add') reactors.add(row.sender_id);
    else reactors.delete(row.sender_id);
  }

  const result = new Map<string, ReactionSummary[]>();
  for (const [targetId, byReaction] of active) {
    const summaries: ReactionSummary[] = [];
    for (const [reaction, reactors] of byReaction) {
      if (reactors.size === 0) continue;
      summaries.push({ reaction, count: reactors.size, mine: reactors.has(currentUserId) });
    }
    if (summaries.length > 0) result.set(targetId, summaries);
  }
  return result;
}

export async function searchLocalMessages(
  db: SQLiteDatabase,
  conversationId: string,
  query: string,
): Promise<StoredE2eeMessage[]> {
  const term = `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return db.getAllAsync<StoredE2eeMessage>(
    `SELECT * FROM e2ee_messages
     WHERE conversation_id = ? AND body LIKE ? ESCAPE '\\'
     ORDER BY created_at DESC LIMIT 50`,
    conversationId,
    term,
  );
}

export async function saveDraft(
  db: SQLiteDatabase,
  conversationId: string,
  body: string,
): Promise<void> {
  if (body.trim().length === 0) {
    await db.runAsync('DELETE FROM e2ee_drafts WHERE conversation_id = ?', conversationId);
    return;
  }
  await db.runAsync(
    `INSERT INTO e2ee_drafts (conversation_id, body) VALUES (?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET body = excluded.body`,
    conversationId,
    body,
  );
}

export async function loadDraft(
  db: SQLiteDatabase,
  conversationId: string,
): Promise<string> {
  const row = await db.getFirstAsync<{ body: string }>(
    'SELECT body FROM e2ee_drafts WHERE conversation_id = ?',
    conversationId,
  );
  return row?.body ?? '';
}
