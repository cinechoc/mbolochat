import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';

const DATABASE_NAME = 'mbolo-e2ee.db';

export interface E2eeAccountRow {
  account_pickle: string;
  device_id: string | null;
  identity_key: string;
  signing_key: string;
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
    return { db, recovered: keys.recovered, cipherVersion: version.cipher_version };
  } finally {
    sqlKey = '';
  }
}

export async function loadE2eeAccount(db: SQLiteDatabase): Promise<E2eeAccountRow | null> {
  return db.getFirstAsync<E2eeAccountRow>(
    'SELECT account_pickle, device_id, identity_key, signing_key FROM e2ee_account WHERE id = 1',
  );
}

export async function saveE2eeAccount(
  db: SQLiteDatabase,
  account: E2eeAccountRow,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO e2ee_account (id, account_pickle, device_id, identity_key, signing_key, created_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_pickle = excluded.account_pickle,
       device_id = excluded.device_id,
       identity_key = excluded.identity_key,
       signing_key = excluded.signing_key`,
    account.account_pickle,
    account.device_id,
    account.identity_key,
    account.signing_key,
    new Date().toISOString(),
  );
}
