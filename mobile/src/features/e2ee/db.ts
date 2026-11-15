import {
  defaultDatabaseDirectory,
  deleteDatabaseAsync,
  openDatabaseAsync,
  type SQLiteDatabase,
} from 'expo-sqlite';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import type { ReactionSummary } from '@/lib/types';
import { isReactionRef } from '../stickers/reactionRules';
import { migrateE2eeSchema } from './schema';

/** Base historique : elle reste attachée à son propriétaire lors de la migration. */
const LEGACY_DATABASE_NAME = 'mbolo-e2ee.db';
const DATABASE_PREFIX = 'mbolo-e2ee-';
const QUARANTINE_DIRECTORY = 'mbolo-e2ee-quarantine';

/** Nom stable et sûr de la base chiffrée propre à un compte. */
export function e2eeDatabaseNameForUser(userId: string): string {
  const safe = userId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${DATABASE_PREFIX}${safe || 'unknown'}.db`;
}

/** Une ouverture réussie est mémorisée pour la vie du processus. */
const databaseByUser = new Map<string, string>();

function databaseDirectoryUri(): string {
  const directory = String(defaultDatabaseDirectory).replace(/\/+$/, '');
  return directory.startsWith('file://') ? directory : `file://${directory}`;
}

function databaseUri(name: string): string {
  return `${databaseDirectoryUri()}/${name}`;
}

async function databaseExists(name: string): Promise<boolean> {
  try {
    // Import paresseux : les tests et les chemins sans routage de compte ne
    // doivent pas charger le module natif de fichiers.
    const { File } = await import('expo-file-system');
    return new File(databaseUri(name)).exists;
  } catch {
    return false;
  }
}

/**
 * Déplace une base illisible (et ses journaux WAL/SHM) dans un dossier de
 * quarantaine au lieu de l'effacer. L'utilisateur peut ainsi retrouver un
 * fichier pour diagnostic, et aucun historique n'est supprimé silencieusement.
 */
async function quarantineDatabase(databaseName: string, reason: string): Promise<string | null> {
  const { Directory, File } = await import('expo-file-system');
  const stamp = new Date().toISOString().replace(/[^0-9A-Za-z.-]/g, '-');
  const target = new Directory(
    databaseDirectoryUri(),
    QUARANTINE_DIRECTORY,
    `${stamp}-${reason}`,
  );
  let moved = false;
  for (const suffix of ['', '-wal', '-shm']) {
    const source = new File(databaseUri(`${databaseName}${suffix}`));
    if (!source.exists) {
      continue;
    }
    if (!moved) {
      target.create({ intermediates: true, idempotent: true });
      moved = true;
    }
    await source.move(new File(target, `${databaseName}${suffix}`));
  }
  return moved ? target.uri : null;
}

export interface E2eeAccountRow {
  account_pickle: string;
  device_id: string | null;
  /** Compte propriétaire : une base ne doit jamais servir deux identités. */
  user_id?: string | null;
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
/**
 * Une seule ouverture/migration à la fois.
 *
 * Plusieurs écrans et services ouvrent la base au même moment (bootstrap,
 * file des messages programmés, transport de conversation). Deux connexions
 * SQLCipher qui migrent un fichier neuf en parallèle peuvent voir un schéma
 * partiel et laisser `e2ee_account` absente : le bootstrap échoue alors au
 * premier login, alors que la base est saine. La porte est relâchée dès que
 * l'ouverture est terminée, pas pendant l'usage de la connexion.
 */
let openGate: Promise<unknown> = Promise.resolve();

export function openE2eeDatabase(userId?: string): Promise<E2eeDatabase> {
  const run = () => openE2eeDatabaseUnlocked(userId);
  const next = openGate.then(run, run);
  openGate = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Choisit la base d'un compte sans jamais détruire celle d'un autre.
 *
 * La base historique n'a pas de nom par compte. On ne la rattache qu'à son
 * propriétaire déjà inscrit (ou au premier compte d'une base pré-migration).
 * Tous les autres comptes reçoivent un fichier dédié. Une ouverture ultérieure
 * retrouve ainsi exactement la même identité, les mêmes sessions et le même
 * historique, même après un passage par un autre compte.
 */
async function openE2eeDatabaseUnlocked(userId?: string): Promise<E2eeDatabase> {
  const keys = await MboloCrypto.ensureKeys();
  const { key } = await MboloCrypto.sqlCipherKey();
  let sqlKey = key;
  try {
    const databaseName = userId
      ? databaseByUser.get(userId) ?? (await selectDatabaseForUser(userId, sqlKey))
      : LEGACY_DATABASE_NAME;
    const opened = await openDatabase(databaseName, sqlKey, keys.recovered);
    if (userId) databaseByUser.set(userId, databaseName);
    return opened;
  } finally {
    sqlKey = '';
  }
}

async function selectDatabaseForUser(userId: string, sqlKey: string): Promise<string> {
  const scoped = e2eeDatabaseNameForUser(userId);
  if (await databaseExists(scoped)) return scoped;
  if (!(await databaseExists(LEGACY_DATABASE_NAME))) return scoped;

  // Lecture seule du propriétaire de la base historique : aucun schéma ni
  // contenu n'est modifié ici.
  let legacy: SQLiteDatabase | null = null;
  try {
    legacy = await openDatabaseAsync(LEGACY_DATABASE_NAME);
    await legacy.execAsync(`PRAGMA key = "x'${sqlKey}'"`);
    const table = await legacy.getFirstAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'e2ee_account'",
    );
    if (!table) return scoped;
    const account = await legacy.getFirstAsync<{ user_id: string | null }>(
      'SELECT user_id FROM e2ee_account WHERE id = 1',
    );
    return account && (!account.user_id || account.user_id === userId)
      ? LEGACY_DATABASE_NAME
      : scoped;
  } catch {
    // Une base historique illisible ne doit pas empêcher le compte courant
    // d'ouvrir sa propre base. Le diagnostic de la base historique suivra.
    return scoped;
  } finally {
    await legacy?.closeAsync().catch(() => undefined);
  }
}

async function openDatabase(
  databaseName: string,
  sqlKey: string,
  keysRecovered: boolean,
): Promise<E2eeDatabase> {
  if (keysRecovered) {
    // Identité recréée : les clés qui ouvraient les médias temporaires ont
    // disparu, ces fichiers sont désormais illisibles et ne doivent pas rester.
    // Import paresseux : la base ne doit pas dépendre du système de fichiers.
    const { sweepSecureMedia } = await import('./mediaStore');
    sweepSecureMedia();
    await quarantineDatabase(databaseName, 'keys-recovered');
  }
  let db: SQLiteDatabase | null = null;
  try {
    let version = null as { cipher_version: string } | null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        db = await openDatabaseAsync(databaseName);
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
        // Fichier illisible avec cette clé (corruption, changement de clé) :
        // on met l'ancien fichier en quarantaine puis on repart d'une base
        // neuve. Ne jamais supprimer une base potentiellement récupérable.
        if (attempt === 1 || !String(cause).includes('file is not a database')) {
          throw cause;
        }
        await db?.closeAsync().catch(() => undefined);
        await quarantineDatabase(databaseName, 'unreadable');
      }
    }
    if (!db || !version) {
      throw new Error('SQLCipher indisponible dans cette build');
    }
    // Schéma versionné : création des tables historiques puis migrations
    // unitaires. Un second passage sur une base à jour n'écrit rien.
    await migrateE2eeSchema(db);
    return { db, recovered: keysRecovered, cipherVersion: version.cipher_version };
  } finally {
    // La clé ne vit que le temps de l'ouverture.
  }
}

export async function loadE2eeAccount(db: SQLiteDatabase): Promise<E2eeAccountRow | null> {
  return db.getFirstAsync<E2eeAccountRow>(
    `SELECT account_pickle, device_id, user_id, identity_key, signing_key,
            fallback_key, fallback_signature, fallback_key_id
     FROM e2ee_account WHERE id = 1`,
  );
}

/** Efface explicitement la base locale chiffrée d'un compte (jamais automatique). */
export async function deleteE2eeDatabase(userId?: string): Promise<void> {
  const name = userId ? e2eeDatabaseNameForUser(userId) : LEGACY_DATABASE_NAME;
  databaseByUser.delete(userId ?? '');
  await deleteDatabaseAsync(name);
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
       (id, account_pickle, device_id, user_id, identity_key, signing_key,
        fallback_key, fallback_signature, fallback_key_id, created_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_pickle = excluded.account_pickle,
       device_id = excluded.device_id,
       user_id = excluded.user_id,
       identity_key = excluded.identity_key,
       signing_key = excluded.signing_key,
       fallback_key = excluded.fallback_key,
       fallback_signature = excluded.fallback_signature,
       fallback_key_id = excluded.fallback_key_id`,
    account.account_pickle,
    account.device_id,
    account.user_id ?? null,
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

export interface ConversationEphemeralState {
  conversation_id: string;
  ephemeral_ttl_seconds: number;
  ephemeral_version: number;
  updated_at: string;
}

export async function loadConversationEphemeral(
  db: SQLiteDatabase,
  conversationId: string,
): Promise<ConversationEphemeralState | null> {
  return db.getFirstAsync<ConversationEphemeralState>(
    `SELECT conversation_id, ephemeral_ttl_seconds, ephemeral_version, updated_at
       FROM e2ee_conversation_state WHERE conversation_id = ?`,
    conversationId,
  );
}

/**
 * Applique un réglage seulement si sa version est strictement plus récente.
 * `changes > 0` indique que l'état local a réellement changé.
 */
export async function applyConversationEphemeralWith(
  writer: SqlWriter,
  conversationId: string,
  ttlSeconds: number,
  version: number,
  updatedAt = new Date().toISOString(),
): Promise<boolean> {
  const result = await writer.runAsync(
    `INSERT INTO e2ee_conversation_state
       (conversation_id, ephemeral_ttl_seconds, ephemeral_version, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       ephemeral_ttl_seconds = excluded.ephemeral_ttl_seconds,
       ephemeral_version = excluded.ephemeral_version,
       updated_at = excluded.updated_at
     WHERE excluded.ephemeral_version > e2ee_conversation_state.ephemeral_version`,
    conversationId,
    ttlSeconds,
    version,
    updatedAt,
  );
  return result.changes > 0;
}

export async function saveConversationEphemeral(
  db: SQLiteDatabase,
  conversationId: string,
  ttlSeconds: number,
  version: number,
): Promise<boolean> {
  return applyConversationEphemeralWith(db, conversationId, ttlSeconds, version);
}

export interface IdentityVerificationRow {
  peer_user_id: string;
  peer_identity_key: string;
  fingerprint: string;
  verified_at: string | null;
  key_changed_at: string | null;
  updated_at: string;
}

/** État local de vérification d'identité, lié à la clé publique courante. */
export async function loadIdentityVerification(
  db: SQLiteDatabase,
  peerId: string,
): Promise<IdentityVerificationRow | null> {
  return db.getFirstAsync<IdentityVerificationRow>(
    `SELECT peer_user_id, peer_identity_key, fingerprint, verified_at, key_changed_at, updated_at
       FROM e2ee_identity_verifications WHERE peer_user_id = ?`,
    peerId,
  );
}

export async function markIdentityVerified(
  db: SQLiteDatabase,
  peerId: string,
  peerIdentityKey: string,
  fingerprint: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO e2ee_identity_verifications
       (peer_user_id, peer_identity_key, fingerprint, verified_at, key_changed_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT(peer_user_id) DO UPDATE SET
       peer_identity_key = excluded.peer_identity_key,
       fingerprint = excluded.fingerprint,
       verified_at = excluded.verified_at,
       key_changed_at = NULL,
       updated_at = excluded.updated_at`,
    peerId,
    peerIdentityKey,
    fingerprint,
    now,
    now,
  );
}

/**
 * Réutilise le signal de changement de clé déjà produit par le chemin entrant.
 * La mise à jour est idempotente et n'efface jamais une vérification si la clé
 * n'a pas changé.
 */
export async function notePeerIdentityChangedWith(
  writer: SqlWriter,
  peerId: string,
  peerIdentityKey: string,
): Promise<void> {
  const now = new Date().toISOString();
  await writer.runAsync(
    `INSERT INTO e2ee_identity_verifications
       (peer_user_id, peer_identity_key, fingerprint, verified_at, key_changed_at, updated_at)
     VALUES (?, ?, '', NULL, NULL, ?)
     ON CONFLICT(peer_user_id) DO UPDATE SET
       verified_at = CASE
         WHEN e2ee_identity_verifications.peer_identity_key = excluded.peer_identity_key
         THEN e2ee_identity_verifications.verified_at ELSE NULL END,
       fingerprint = CASE
         WHEN e2ee_identity_verifications.peer_identity_key = excluded.peer_identity_key
         THEN e2ee_identity_verifications.fingerprint ELSE '' END,
       key_changed_at = CASE
         WHEN e2ee_identity_verifications.peer_identity_key = excluded.peer_identity_key
         THEN e2ee_identity_verifications.key_changed_at ELSE excluded.updated_at END,
       peer_identity_key = excluded.peer_identity_key,
       updated_at = excluded.updated_at`,
    peerId,
    peerIdentityKey,
    now,
  );
}

/** Plafond du payload brut conservé pour un type futur : 16 Kio encodés. */
export const MAX_UNKNOWN_PAYLOAD_CHARS = 16 * 1024;
/** Nombre de payloads inconnus dont le brut est conservé par conversation. */
export const MAX_UNKNOWN_PAYLOADS_PER_CONVERSATION = 20;

/**
 * Élague les payloads inconnus les plus anciens au-delà du plafond. Les lignes
 * restent (idempotence, avancement Olm) ; seul le brut est retiré, dans la même
 * transaction que l'arrivée du nouveau message.
 */
export async function pruneUnknownPayloadsWith(
  writer: SqlWriter,
  conversationId: string,
): Promise<void> {
  await writer.runAsync(
    `UPDATE e2ee_messages SET raw_payload = NULL
      WHERE id IN (
        SELECT id FROM e2ee_messages
         WHERE conversation_id = ? AND content_kind = 'unknown'
           AND raw_payload IS NOT NULL
         ORDER BY created_at DESC, rowid DESC
         LIMIT -1 OFFSET ?
      )`,
    conversationId,
    MAX_UNKNOWN_PAYLOADS_PER_CONVERSATION,
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
  /** Échéance d'un message éphémère, au format ISO ; null pour un message normal. */
  expires_at?: string | null;
  /** Message supprimé pour tous : rangée conservée, contenu vidé. */
  deleted?: number | null;
  /** Auteur vérifié de la suppression, pour audit local uniquement. */
  deleted_by?: string | null;
  /** Dernière modification texte appliquée, ou null. */
  edited_at?: string | null;
  /** Numéro de la dernière modification appliquée (0 = jamais modifiée). */
  edit_revision?: number | null;
  /** Envoi silencieux demandé par l'auteur (`v:8`). */
  silent?: number | null;
  /** Lecture unique demandée par l'auteur (`v:8`). */
  view_once?: number | null;
  /** Aperçu de lien validé, sérialisé en JSON dans SQLCipher uniquement. */
  preview_json?: string | null;
  /** Échéance locale d'une programmation ; jamais transmise dans l'enveloppe. */
  scheduled_at?: string | null;
  /** Marqueur normalisé d'échec d'envoi (`send_failed`), jamais le texte de l'erreur. */
  send_error?: string | null;
  /** Ordre d'insertion SQLite, utilisé uniquement comme départage de pagination. */
  rowid?: number;
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
        control_target, reaction, reaction_action, raw_payload, expires_at, deleted, deleted_by,
        edited_at, edit_revision, silent, view_once, preview_json, scheduled_at, send_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       sender_id = excluded.sender_id,
       sender_name = excluded.sender_name,
       mine = excluded.mine,
       body = CASE
         WHEN e2ee_messages.content_kind IS NULL
              AND e2ee_messages.edit_revision > 0
         THEN e2ee_messages.body ELSE excluded.body END,
       sticker_ref = COALESCE(excluded.sticker_ref, e2ee_messages.sticker_ref),
       unreadable_reason = COALESCE(excluded.unreadable_reason, e2ee_messages.unreadable_reason),
       hidden = excluded.hidden,
       content_kind = excluded.content_kind,
       control_target = excluded.control_target,
       reaction = excluded.reaction,
       reaction_action = excluded.reaction_action,
       raw_payload = COALESCE(excluded.raw_payload, e2ee_messages.raw_payload),
       expires_at = COALESCE(excluded.expires_at, e2ee_messages.expires_at),
       deleted = CASE WHEN e2ee_messages.deleted = 1 THEN 1 ELSE excluded.deleted END,
       deleted_by = COALESCE(e2ee_messages.deleted_by, excluded.deleted_by),
       edited_at = COALESCE(excluded.edited_at, e2ee_messages.edited_at),
       edit_revision = MAX(e2ee_messages.edit_revision, excluded.edit_revision),
       silent = excluded.silent,
       view_once = excluded.view_once,
       preview_json = COALESCE(excluded.preview_json, e2ee_messages.preview_json),
       scheduled_at = COALESCE(e2ee_messages.scheduled_at, excluded.scheduled_at),
       send_error = excluded.send_error`,
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
    message.expires_at ?? null,
    message.deleted ?? 0,
    message.deleted_by ?? null,
    message.edited_at ?? null,
    message.edit_revision ?? 0,
    message.silent ?? 0,
    message.view_once ?? 0,
    message.preview_json ?? null,
    message.scheduled_at ?? null,
    message.send_error ?? null,
  );
  // Une tombstone de lecture unique prime sur toute réinsertion, notamment
  // lorsqu'une synchronisation renvoie un message consommé après une coupure.
  // Les champs sensibles sont retirés dans la même écriture.
  await writer.runAsync(
    `UPDATE e2ee_messages
        SET body = '', media_meta = NULL, local_cipher_uri = NULL, upload_id = NULL,
            local_thumb_cipher_uri = NULL, thumb_upload_id = NULL, sticker_ref = NULL,
            quote_id = NULL, unreadable_reason = NULL, raw_payload = NULL,
            preview_json = NULL, silent = 0, view_once = 0, scheduled_at = NULL,
            hidden = 1
      WHERE id = ?
        AND EXISTS (
          SELECT 1 FROM e2ee_view_once_consumed WHERE message_id = ?
        )`,
    message.id,
    message.id,
  );
}

/** Ligne provisoire (avant accusé serveur) : id = clientId, renommée après ack. */
export async function renameLocalMessage(
  db: SQLiteDatabase,
  clientId: string,
  serverId: string,
): Promise<void> {
  await db.runAsync(
    'UPDATE e2ee_messages SET id = ?, client_id = ?, send_error = NULL WHERE id = ?',
    serverId,
    clientId,
    clientId,
  );
}

/** Pose un échec normalisé sur un envoi programmé, sans perdre son contenu. */
export async function markLocalMessageSendError(
  db: SQLiteDatabase,
  id: string,
  error: string | null = 'send_failed',
): Promise<void> {
  await db.runAsync(
    'UPDATE e2ee_messages SET send_error = ? WHERE id = ? OR client_id = ?',
    error,
    id,
    id,
  );
}

/** Remet un envoi programmé en attente immédiate après une action utilisateur. */
export async function retryScheduledMessage(
  db: SQLiteDatabase,
  id: string,
  scheduledAt: string,
): Promise<void> {
  await db.runAsync(
    'UPDATE e2ee_messages SET send_error = NULL, scheduled_at = ? WHERE id = ?',
    scheduledAt,
    id,
  );
}

export async function deleteLocalMessage(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM e2ee_messages WHERE id = ?', id);
}

/**
 * Consomme une lecture unique de façon durable.
 *
 * La tombstone est chiffrée par SQLCipher et survit à la disparition de la
 * bulle. Le message local est vidé au lieu d'être supprimé : ainsi une
 * synchronisation tardive ne peut pas réinsérer son contenu, et la reprise du
 * masquage serveur dispose encore de son identifiant.
 */
export async function consumeLocalViewOnce(
  db: SQLiteDatabase,
  messageId: string,
  conversationId: string,
  consumedAt = new Date().toISOString(),
): Promise<void> {
  await db.runAsync(
    `INSERT INTO e2ee_view_once_consumed
       (message_id, conversation_id, server_hidden, created_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(message_id) DO NOTHING`,
    messageId,
    conversationId,
    consumedAt,
  );
  await db.runAsync(
    `UPDATE e2ee_messages
        SET body = '', media_meta = NULL, local_cipher_uri = NULL, upload_id = NULL,
            local_thumb_cipher_uri = NULL, thumb_upload_id = NULL, sticker_ref = NULL,
            quote_id = NULL, unreadable_reason = NULL, raw_payload = NULL,
            preview_json = NULL, silent = 0, view_once = 0, scheduled_at = NULL,
            hidden = 1
      WHERE id = ? AND conversation_id = ?`,
    messageId,
    conversationId,
  );
}

export interface PendingViewOnceConsumption {
  message_id: string;
  conversation_id: string;
}

/** Lectures uniques encore à masquer côté serveur pour ce compte. */
export async function listPendingViewOnceConsumptions(
  db: SQLiteDatabase,
  limit = 20,
): Promise<PendingViewOnceConsumption[]> {
  return db.getAllAsync<PendingViewOnceConsumption>(
    `SELECT message_id, conversation_id
       FROM e2ee_view_once_consumed
      WHERE server_hidden = 0
      ORDER BY created_at ASC
      LIMIT ?`,
    limit,
  );
}

/** Le serveur a confirmé le masquage : la tombstone n'a plus à être rejouée. */
export async function markViewOnceServerHidden(
  db: SQLiteDatabase,
  messageId: string,
): Promise<void> {
  await db.runAsync(
    'UPDATE e2ee_view_once_consumed SET server_hidden = 1 WHERE message_id = ?',
    messageId,
  );
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

/**
 * Ligne locale encore en attente d'accusé. Après un succès partiel, son `id`
 * peut déjà avoir été remplacé par l'identifiant serveur : `client_id` est donc
 * le seul critère stable pour une reprise.
 */
export async function loadLocalMessageByClientId(
  db: SQLiteDatabase,
  clientId: string,
): Promise<StoredE2eeMessage | null> {
  return db.getFirstAsync<StoredE2eeMessage>(
    `SELECT * FROM e2ee_messages
      WHERE client_id = ?
      ORDER BY CASE WHEN id = client_id THEN 0 ELSE 1 END
      LIMIT 1`,
    clientId,
  );
}

/**
 * Envois programmés arrivés à échéance pour cet utilisateur. `id = client_id`
 * distingue une ligne encore dans la file d'un message acquitté et renommé.
 */
export async function listDueScheduledMessages(
  db: SQLiteDatabase,
  currentUserId: string,
  dueAt: string,
  limit = 20,
): Promise<StoredE2eeMessage[]> {
  return db.getAllAsync<StoredE2eeMessage>(
    `SELECT rowid AS rowid, * FROM e2ee_messages
      WHERE sender_id = ? AND mine = 1
        AND scheduled_at IS NOT NULL AND scheduled_at <= ?
        AND send_error IS NULL
        AND client_id IS NOT NULL AND id = client_id
      ORDER BY scheduled_at ASC, rowid ASC
      LIMIT ?`,
    currentUserId,
    dueAt,
    limit,
  );
}

/** Prochaine échéance encore en attente, ou `null` si la file est vide. */
export async function nextScheduledMessageAt(
  db: SQLiteDatabase,
  currentUserId: string,
): Promise<string | null> {
  const row = await db.getFirstAsync<{ scheduled_at: string | null }>(
    `SELECT scheduled_at FROM e2ee_messages
      WHERE sender_id = ? AND mine = 1
        AND scheduled_at IS NOT NULL AND send_error IS NULL
        AND client_id IS NOT NULL AND id = client_id
      ORDER BY scheduled_at ASC LIMIT 1`,
    currentUserId,
  );
  return row?.scheduled_at ?? null;
}

/**
 * Page d'historique antérieure à un message, en lecture seule.
 *
 * L'identifiant départage les horodatages égaux via `rowid` : deux messages
 * reçus dans la même milliseconde ne peuvent ni disparaître ni être relus deux
 * fois au passage d'une page. `limit + 1` est demandé par l'appelant pour
 * savoir s'il reste une page.
 */
export async function listLocalMessagesBefore(
  db: SQLiteDatabase,
  conversationId: string,
  beforeCreatedAt: string,
  beforeId: string,
  limit = 50,
): Promise<StoredE2eeMessage[]> {
  return db.getAllAsync<StoredE2eeMessage>(
    `WITH cursor AS (
       SELECT rowid AS cursor_rowid FROM e2ee_messages WHERE id = ?
     )
     SELECT message.rowid AS rowid, message.* FROM e2ee_messages AS message, cursor
      WHERE message.conversation_id = ?
        AND COALESCE(message.hidden, 0) = 0
        AND (message.created_at < ? OR
             (message.created_at = ? AND message.rowid < cursor.cursor_rowid))
      ORDER BY message.created_at DESC, message.rowid DESC
      LIMIT ?`,
    beforeId,
    conversationId,
    beforeCreatedAt,
    beforeCreatedAt,
    limit,
  );
}

export async function listLocalMessages(
  db: SQLiteDatabase,
  conversationId: string,
  limit = 200,
): Promise<StoredE2eeMessage[]> {
  return db.getAllAsync<StoredE2eeMessage>(
    `SELECT rowid AS rowid, * FROM e2ee_messages
      WHERE conversation_id = ? AND COALESCE(hidden, 0) = 0
      ORDER BY created_at DESC, rowid DESC LIMIT ?`,
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
      WHERE conversation_id = ? AND content_kind = 'reaction'`,
    conversationId,
  );
  // Une seule opération gagne par (cible, réaction, auteur) : la plus récente
  // par `created_at`, et à horodatage égal le retrait l'emporte. Ce choix est
  // indépendant de l'ordre d'arrivée sur les deux appareils.
  interface Winner {
    targetId: string;
    reaction: string;
    authorId: string;
    action: 'add' | 'remove';
    createdAt: string;
  }
  const winners = new Map<string, Winner>();
  for (const row of rows) {
    if (
      typeof row.control_target !== 'string' ||
      typeof row.reaction !== 'string' ||
      !isReactionRef(row.reaction) ||
      (row.reaction_action !== 'add' && row.reaction_action !== 'remove')
    ) {
      continue;
    }
    const key = `${row.control_target}\u0000${row.reaction}\u0000${row.sender_id}`;
    const previous = winners.get(key);
    if (
      !previous ||
      row.created_at > previous.createdAt ||
      (row.created_at === previous.createdAt &&
        row.reaction_action === 'remove' &&
        previous.action === 'add')
    ) {
      winners.set(key, {
        targetId: row.control_target,
        reaction: row.reaction,
        authorId: row.sender_id,
        action: row.reaction_action,
        createdAt: row.created_at,
      });
    }
  }

  const active = new Map<string, Map<string, Set<string>>>();
  for (const winner of winners.values()) {
    if (winner.action !== 'add') continue;
    let byReaction = active.get(winner.targetId);
    if (!byReaction) {
      byReaction = new Map();
      active.set(winner.targetId, byReaction);
    }
    let reactors = byReaction.get(winner.reaction);
    if (!reactors) {
      reactors = new Set();
      byReaction.set(winner.reaction, reactors);
    }
    reactors.add(winner.authorId);
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
