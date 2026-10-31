import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';

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
    await deleteDatabaseAsync(DATABASE_NAME).catch(() => undefined);
  }
  const { key } = await MboloCrypto.sqlCipherKey();
  let sqlKey = key;
  try {
    const db = await openDatabaseAsync(DATABASE_NAME);
    await db.execAsync(`PRAGMA key = "x'${sqlKey}'"`);
    const version = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version');
    if (!version?.cipher_version) {
      await db.closeAsync();
      throw new Error('SQLCipher indisponible dans cette build');
    }
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS e2ee_account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        account_pickle TEXT NOT NULL,
        device_id TEXT,
        identity_key TEXT NOT NULL,
        signing_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(e2ee_account)');
    const existing = new Set(columns.map((column) => column.name));
    const additions: [string, string][] = [
      ['fallback_key', 'TEXT'],
      ['fallback_signature', 'TEXT'],
      ['fallback_key_id', 'TEXT'],
    ];
    for (const [name, type] of additions) {
      if (!existing.has(name)) {
        await db.execAsync(`ALTER TABLE e2ee_account ADD COLUMN ${name} ${type}`);
      }
    }
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS e2ee_sessions (
        peer_user_id TEXT PRIMARY KEY,
        peer_device_id TEXT,
        session_pickle TEXT NOT NULL,
        peer_identity_key TEXT NOT NULL,
        peer_signing_key TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS e2ee_peer_keys (
        peer_user_id TEXT PRIMARY KEY,
        signing_key TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS e2ee_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        client_id TEXT,
        mine INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS e2ee_messages_conv_idx
        ON e2ee_messages (conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS e2ee_drafts (
        conversation_id TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
    `);
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
  await db.runAsync(
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
): Promise<E2eeSessionRow | null> {
  return db.getFirstAsync<E2eeSessionRow>(
    'SELECT * FROM e2ee_sessions WHERE peer_user_id = ?',
    peerId,
  );
}

export async function saveSession(
  db: SQLiteDatabase,
  session: E2eeSessionRow,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO e2ee_sessions
       (peer_user_id, peer_device_id, session_pickle, peer_identity_key, peer_signing_key, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(peer_user_id) DO UPDATE SET
       peer_device_id = excluded.peer_device_id,
       session_pickle = excluded.session_pickle,
       peer_identity_key = excluded.peer_identity_key,
       peer_signing_key = excluded.peer_signing_key,
       updated_at = excluded.updated_at`,
    session.peer_user_id,
    session.peer_device_id,
    session.session_pickle,
    session.peer_identity_key,
    session.peer_signing_key,
    session.updated_at,
  );
}

export async function loadPeerSigningKey(
  db: SQLiteDatabase,
  peerId: string,
): Promise<string | null> {
  const row = await db.getFirstAsync<{ signing_key: string }>(
    'SELECT signing_key FROM e2ee_peer_keys WHERE peer_user_id = ?',
    peerId,
  );
  return row?.signing_key ?? null;
}

export async function savePeerSigningKey(
  db: SQLiteDatabase,
  peerId: string,
  signingKey: string,
  verified: boolean,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO e2ee_peer_keys (peer_user_id, signing_key, verified, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_user_id) DO UPDATE SET
       signing_key = excluded.signing_key,
       verified = excluded.verified,
       updated_at = excluded.updated_at`,
    peerId,
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
}

export async function saveLocalMessage(
  db: SQLiteDatabase,
  message: StoredE2eeMessage,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO e2ee_messages
       (id, conversation_id, sender_id, sender_name, body, created_at, client_id, mine)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET body = excluded.body`,
    message.id,
    message.conversation_id,
    message.sender_id,
    message.sender_name,
    message.body,
    message.created_at,
    message.client_id,
    message.mine,
  );
}

export async function listLocalMessages(
  db: SQLiteDatabase,
  conversationId: string,
  limit = 200,
): Promise<StoredE2eeMessage[]> {
  return db.getAllAsync<StoredE2eeMessage>(
    `SELECT * FROM e2ee_messages WHERE conversation_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    conversationId,
    limit,
  );
}

export async function searchLocalMessages(
  db: SQLiteDatabase,
  conversationId: string,
  query: string,
): Promise<StoredE2eeMessage[]> {
  const term = `%${query.replace(/[%_]/g, (character) => `\${character}`)}%`;
  return db.getAllAsync<StoredE2eeMessage>(
    `SELECT * FROM e2ee_messages
     WHERE conversation_id = ? AND body LIKE ? ESCAPE '\'
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
