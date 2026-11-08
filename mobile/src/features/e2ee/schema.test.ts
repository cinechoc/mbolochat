import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

import { E2EE_SCHEMA_VERSION, migrateE2eeSchema, type E2eeSchemaDb } from './schema';

vi.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn(),
}));

vi.mock('../../../modules/mbolo-crypto/src', () => ({
  MboloCrypto: {},
}));

/** Adaptateur minimal : le schéma ne connaît que ce sous-ensemble d'expo-sqlite. */
function adapter(db: DatabaseSync): E2eeSchemaDb & {
  runAsync: (sql: string, ...params: unknown[]) => Promise<{ changes: number }>;
} {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql);
    },
    getAllAsync: (async <T,>(sql: string, ...params: unknown[]) =>
      (db.prepare(sql).all(...(params as never[])) as T[]).map(
        (row) => ({ ...row }) as T,
      )) as E2eeSchemaDb['getAllAsync'],
    getFirstAsync: (async <T,>(sql: string, ...params: unknown[]) => {
      const row = db.prepare(sql).get(...(params as never[])) as T | undefined;
      return row === undefined ? null : ({ ...row } as T);
    }) as E2eeSchemaDb['getFirstAsync'],
    withTransactionAsync: async (task: () => Promise<void>) => {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
    },
    runAsync: async (sql: string, ...params: unknown[]) => {
      const result = db.prepare(sql).run(...(params as never[]));
      return { changes: Number(result.changes) };
    },
  };
}

/** Base telle que la version 1 du code l'a créée, avec des données réelles. */
function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE e2ee_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      account_pickle TEXT NOT NULL,
      device_id TEXT,
      identity_key TEXT NOT NULL,
      signing_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE e2ee_sessions (
      peer_user_id TEXT PRIMARY KEY,
      peer_device_id TEXT,
      session_pickle TEXT NOT NULL,
      peer_identity_key TEXT NOT NULL,
      peer_signing_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE e2ee_peer_keys (
      peer_user_id TEXT PRIMARY KEY,
      signing_key TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE e2ee_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      client_id TEXT,
      mine INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX e2ee_messages_conv_idx ON e2ee_messages (conversation_id, created_at);
    CREATE TABLE e2ee_drafts (
      conversation_id TEXT PRIMARY KEY,
      body TEXT NOT NULL
    );
    INSERT INTO e2ee_account
      VALUES (1, 'pickle-1', 'dev-1', 'ident-1', 'sign-1', '2026-01-01T00:00:00Z');
    INSERT INTO e2ee_sessions
      VALUES ('peer-1', 'peer-dev-1', 'session-a', 'ident-a', 'sign-a', '2026-01-01T00:00:00Z');
    INSERT INTO e2ee_sessions
      VALUES ('peer-2', NULL, 'session-b', 'ident-b', 'sign-b', '2026-01-02T00:00:00Z');
    INSERT INTO e2ee_peer_keys
      VALUES ('peer-1', 'sign-a', 1, '2026-01-01T00:00:00Z');
    INSERT INTO e2ee_peer_keys
      VALUES ('peer-2', 'sign-b', 0, '2026-01-02T00:00:00Z');
    INSERT INTO e2ee_messages
      VALUES ('msg-1', 'conv-1', 'peer-1', 'Alice', 'bonjour', '2026-01-01T00:00:10Z', 'c-1', 0);
    INSERT INTO e2ee_drafts VALUES ('conv-1', 'brouillon');
  `);
  return db;
}

async function primaryKeyColumns(db: E2eeSchemaDb, table: string): Promise<string[]> {
  const info = await db.getAllAsync<{ name: string; pk: number }>(
    `PRAGMA table_info(${table})`,
  );
  return info
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
}

async function tableNames(db: E2eeSchemaDb): Promise<string[]> {
  const rows = await db.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  );
  return rows.map((row) => row.name);
}

describe('migrateE2eeSchema — base neuve', () => {
  it('crée toutes les tables à la version courante', async () => {
    const db = adapter(new DatabaseSync(':memory:'));
    const version = await migrateE2eeSchema(db);

    expect(version).toBe(E2EE_SCHEMA_VERSION);
    expect(await tableNames(db)).toEqual(
      expect.arrayContaining([
        'e2ee_account',
        'e2ee_sessions',
        'e2ee_peer_keys',
        'e2ee_messages',
        'e2ee_drafts',
        'e2ee_outbox',
        'e2ee_bundles',
        'e2ee_schema_meta',
      ]),
    );
    expect(await primaryKeyColumns(db, 'e2ee_sessions')).toEqual([
      'peer_user_id',
      'peer_device_id',
    ]);
    expect(await primaryKeyColumns(db, 'e2ee_peer_keys')).toEqual([
      'peer_user_id',
      'peer_device_id',
    ]);
  });

  it('une seconde exécution ne rejoue rien', async () => {
    const db = adapter(new DatabaseSync(':memory:'));
    await migrateE2eeSchema(db);
    const before = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM e2ee_schema_meta WHERE key = 'schema_version'",
    );
    await migrateE2eeSchema(db);
    const after = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM e2ee_schema_meta WHERE key = 'schema_version'",
    );
    expect(after?.value).toBe(before?.value);
    expect(await tableNames(db)).not.toContain('e2ee_sessions__v2');
  });
});

describe('migrateE2eeSchema — base peuplée en version 1', () => {
  it('conserve les données et passe les clés primaires en composite', async () => {
    const raw = legacyDatabase();
    const db = adapter(raw);
    const version = await migrateE2eeSchema(db);

    expect(version).toBe(E2EE_SCHEMA_VERSION);
    expect(await primaryKeyColumns(db, 'e2ee_sessions')).toEqual([
      'peer_user_id',
      'peer_device_id',
    ]);
    expect(await primaryKeyColumns(db, 'e2ee_peer_keys')).toEqual([
      'peer_user_id',
      'peer_device_id',
    ]);

    const sessions = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM e2ee_sessions ORDER BY peer_user_id',
    );
    expect(sessions).toEqual([
      {
        peer_user_id: 'peer-1',
        peer_device_id: 'peer-dev-1',
        session_pickle: 'session-a',
        peer_identity_key: 'ident-a',
        peer_signing_key: 'sign-a',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        // L'appareil inconnu devient la chaîne vide, jamais NULL : SQLite
        // autoriserait plusieurs NULL dans une clé primaire composite.
        peer_user_id: 'peer-2',
        peer_device_id: '',
        session_pickle: 'session-b',
        peer_identity_key: 'ident-b',
        peer_signing_key: 'sign-b',
        updated_at: '2026-01-02T00:00:00Z',
      },
    ]);

    expect(
      await db.getAllAsync<Record<string, unknown>>(
        'SELECT * FROM e2ee_peer_keys ORDER BY peer_user_id',
      ),
    ).toEqual([
      {
        peer_user_id: 'peer-1',
        peer_device_id: '',
        signing_key: 'sign-a',
        verified: 1,
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        peer_user_id: 'peer-2',
        peer_device_id: '',
        signing_key: 'sign-b',
        verified: 0,
        updated_at: '2026-01-02T00:00:00Z',
      },
    ]);

    const message = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM e2ee_messages WHERE id = ?',
      'msg-1',
    );
    expect(message).toMatchObject({
      body: 'bonjour',
      client_id: 'c-1',
      media_meta: null,
      quote_id: null,
      local_cipher_uri: null,
      upload_id: null,
      local_thumb_cipher_uri: null,
      thumb_upload_id: null,
    });
    expect(
      await db.getFirstAsync<Record<string, unknown>>(
        'SELECT * FROM e2ee_drafts WHERE conversation_id = ?',
        'conv-1',
      ),
    ).toMatchObject({ body: 'brouillon' });
  });

  it('un second passage laisse la base strictement identique', async () => {
    const db = adapter(legacyDatabase());
    await migrateE2eeSchema(db);
    const snapshot = async () => ({
      sessions: await db.getAllAsync('SELECT * FROM e2ee_sessions ORDER BY peer_user_id'),
      keys: await db.getAllAsync('SELECT * FROM e2ee_peer_keys ORDER BY peer_user_id'),
      messages: await db.getAllAsync('SELECT * FROM e2ee_messages ORDER BY id'),
      tables: await tableNames(db),
    });
    const before = await snapshot();
    const version = await migrateE2eeSchema(db);
    expect(version).toBe(E2EE_SCHEMA_VERSION);
    expect(await snapshot()).toEqual(before);
    expect((await tableNames(db)).filter((name) => name.endsWith('__v2'))).toEqual([]);
  });

  it('refuse de reconstruire une table qui porte un index inattendu', async () => {
    const raw = legacyDatabase();
    raw.exec('CREATE INDEX idx_sessions_device ON e2ee_sessions (peer_device_id)');
    const db = adapter(raw);

    await expect(migrateE2eeSchema(db)).rejects.toThrow(/index idx_sessions_device/);

    // Rien n'a bougé : ni la version, ni la clé primaire, ni les données.
    expect(
      await db.getFirstAsync<{ value: string }>(
        "SELECT value FROM e2ee_schema_meta WHERE key = 'schema_version'",
      ),
    ).toEqual({ value: '1' });
    expect(await primaryKeyColumns(db, 'e2ee_sessions')).toEqual(['peer_user_id']);
    expect(
      await db.getFirstAsync<{ c: number }>('SELECT count(*) AS c FROM e2ee_sessions'),
    ).toEqual({ c: 2 });
  });

  it('un échec au milieu de l‘étape ne laisse ni table partielle ni version avancée', async () => {
    const raw = legacyDatabase();
    // Un déclencheur sur la seconde table reconstruite fait échouer l'étape
    // après que `e2ee_sessions` a déjà été remplacée.
    raw.exec(`
      CREATE TRIGGER guard_peer_keys AFTER INSERT ON e2ee_peer_keys
      BEGIN SELECT RAISE(ABORT, 'guard'); END;
    `);
    const db = adapter(raw);

    await expect(migrateE2eeSchema(db)).rejects.toThrow(/trigger guard_peer_keys/);

    expect(
      await db.getFirstAsync<{ value: string }>(
        "SELECT value FROM e2ee_schema_meta WHERE key = 'schema_version'",
      ),
    ).toEqual({ value: '1' });
    expect(await primaryKeyColumns(db, 'e2ee_sessions')).toEqual(['peer_user_id']);
    const tables = await tableNames(db);
    expect(tables).not.toContain('e2ee_outbox');
    expect(tables).not.toContain('e2ee_bundles');
    expect(tables.filter((name) => name.endsWith('__v2'))).toEqual([]);
  });
});

describe('e2ee_outbox et e2ee_bundles — contraintes du schéma', () => {
  it('l’outbox journalise une enveloppe et son pickle de session, sans client_upload_id', async () => {
    const db = adapter(new DatabaseSync(':memory:'));
    await migrateE2eeSchema(db);
    const columns = await db.getAllAsync<{ name: string }>(
      'PRAGMA table_info(e2ee_outbox)',
    );
    const names = columns.map((column) => column.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'client_id',
        'conversation_id',
        'envelope',
        'envelope_type',
        'session_pickle',
        'state',
        'attempts',
      ]),
    );
    // Décision C3 : l'idempotence de téléversement est reportée à la partie 2.
    expect(names).not.toContain('client_upload_id');
  });

  it('interdit de réserver deux fois la même one-time key (R1)', async () => {
    const db = adapter(new DatabaseSync(':memory:'));
    await migrateE2eeSchema(db);
    const insert = `
      INSERT INTO e2ee_bundles
        (id, conversation_id, peer_user_id, peer_device_id, peer_identity_key,
         one_time_key_id, one_time_key, session_pickle, envelope, envelope_type,
         state, created_at, updated_at)
      VALUES (?, 'conv-1', 'peer-1', 'peer-dev-1', 'ident-1', ?, 'otk', 's1', 'e', 'prekey',
              'reserved', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `;
    await db.runAsync(insert, 'bundle-1', 'otk-1');
    await expect(db.runAsync(insert, 'bundle-2', 'otk-1')).rejects.toThrow(/UNIQUE/);
    await db.runAsync(insert, 'bundle-3', 'otk-2');
  });
});

describe('updateLocalMessageMedia — média et vignette indépendants', () => {
  it('écrit chaque référence sans toucher aux autres', async () => {
    const db = adapter(legacyDatabase());
    await migrateE2eeSchema(db);
    // `db.ts` n'apporte que des fonctions : il est importé après les mocks.
    const { updateLocalMessageMedia } = await import('./db');
    const handle = db as unknown as Parameters<typeof updateLocalMessageMedia>[0];

    expect(
      await updateLocalMessageMedia(handle, 'msg-1', {
        localCipherUri: 'file:///cache/media.bin',
        localThumbCipherUri: 'file:///cache/thumb.bin',
      }),
    ).toBe(1);
    expect(
      await updateLocalMessageMedia(handle, 'msg-1', { uploadId: 'blob-media' }),
    ).toBe(1);
    let row = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM e2ee_messages WHERE id = ?',
      'msg-1',
    );
    expect(row).toMatchObject({
      local_cipher_uri: 'file:///cache/media.bin',
      local_thumb_cipher_uri: 'file:///cache/thumb.bin',
      upload_id: 'blob-media',
      thumb_upload_id: null,
    });

    await updateLocalMessageMedia(handle, 'msg-1', { thumbUploadId: 'blob-thumb' });
    row = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM e2ee_messages WHERE id = ?',
      'msg-1',
    );
    // La vignette avance seule : le blob média déjà téléversé reste en place.
    expect(row).toMatchObject({
      upload_id: 'blob-media',
      thumb_upload_id: 'blob-thumb',
    });
  });

  it('ne fait rien pour un patch vide ou un id inconnu', async () => {
    const db = adapter(legacyDatabase());
    await migrateE2eeSchema(db);
    const { updateLocalMessageMedia } = await import('./db');
    const handle = db as unknown as Parameters<typeof updateLocalMessageMedia>[0];
    expect(await updateLocalMessageMedia(handle, 'msg-1', {})).toBe(0);
    expect(
      await updateLocalMessageMedia(handle, 'inconnu', { uploadId: 'blob' }),
    ).toBe(0);
  });
});

describe('migrateE2eeSchema — v3 : identité des enveloppes de l’outbox', () => {
  /** Base figée à la v2, avec deux enveloppes déjà journalisées. */
  async function v2Database() {
    const raw = legacyDatabase();
    const db = adapter(raw);
    // Montée bornée : la base reste exactement dans l'état d'une installation
    // qui tournait avant la v3.
    expect(await migrateE2eeSchema(db, 2)).toBe(2);
    const insert = `
      INSERT INTO e2ee_outbox
        (client_id, conversation_id, message_id, envelope, envelope_type,
         session_pickle, attachment_id, media_meta, quote_id, state, attempts,
         last_error, created_at, updated_at)
      VALUES (?, 'conv-1', NULL, ?, 'normal', '', NULL, NULL, NULL, ?, 0, NULL,
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `;
    await db.runAsync(insert, 'c-pending', 'E-pending', 'pending');
    await db.runAsync(insert, 'c-sent', 'E-sent', 'sent');
    return db;
  }

  it('ajoute les identités sur une base v2 peuplée sans rien perdre', async () => {
    const db = await v2Database();
    expect(await migrateE2eeSchema(db)).toBe(E2EE_SCHEMA_VERSION);

    const columns = await db.getAllAsync<{ name: string; notnull: number }>(
      'PRAGMA table_info(e2ee_outbox)',
    );
    for (const name of ['account_id', 'peer_user_id', 'peer_device_id']) {
      const column = columns.find((entry) => entry.name === name);
      expect(column).toBeDefined();
      // Nullable : aucune valeur par défaut pour les lignes antérieures.
      expect(column?.notnull).toBe(0);
    }

    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT client_id, envelope, state, created_at,
              account_id, peer_user_id, peer_device_id
       FROM e2ee_outbox ORDER BY client_id`,
    );
    expect(rows).toEqual([
      {
        client_id: 'c-pending',
        envelope: 'E-pending',
        state: 'pending',
        created_at: '2026-01-01T00:00:00Z',
        // Aucune identité inventée pour une ligne qui n'en avait pas.
        account_id: null,
        peer_user_id: null,
        peer_device_id: null,
      },
      {
        client_id: 'c-sent',
        envelope: 'E-sent',
        state: 'sent',
        created_at: '2026-01-01T00:00:00Z',
        account_id: null,
        peer_user_id: null,
        peer_device_id: null,
      },
    ]);
  });

  it('un second passage ne change ni la version ni la structure', async () => {
    const db = await v2Database();
    await migrateE2eeSchema(db);
    const snapshot = async () => ({
      version: await db.getFirstAsync<{ value: string }>(
        "SELECT value FROM e2ee_schema_meta WHERE key = 'schema_version'",
      ),
      columns: (await db.getAllAsync<{ name: string }>('PRAGMA table_info(e2ee_outbox)')).map(
        (column) => column.name,
      ),
      indexes: await db.getAllAsync<Record<string, unknown>>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'e2ee_outbox' ORDER BY name",
      ),
      rows: await db.getAllAsync('SELECT * FROM e2ee_outbox ORDER BY client_id'),
    });
    const before = await snapshot();
    expect(await migrateE2eeSchema(db)).toBe(E2EE_SCHEMA_VERSION);
    expect(await snapshot()).toEqual(before);
  });

  it('conserve la clé primaire et pose les deux index attendus', async () => {
    const db = await v2Database();
    await migrateE2eeSchema(db);

    const info = await db.getAllAsync<{ name: string; pk: number }>(
      'PRAGMA table_info(e2ee_outbox)',
    );
    expect(info.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
      'client_id',
    ]);

    const indexes = (
      await db.getAllAsync<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'e2ee_outbox' AND sql IS NOT NULL`,
      )
    )
      .map((index) => index.name)
      .sort();
    expect(indexes).toEqual(['e2ee_outbox_peer_idx', 'e2ee_outbox_state_idx']);

    // Les colonnes restent utilisables dans un index : la recherche par paire
    // et appareil ne dégénère pas en parcours complet.
    expect(
      await db.getAllAsync<Record<string, unknown>>(
        'PRAGMA index_info(e2ee_outbox_peer_idx)',
      ),
    ).toHaveLength(3);
  });

  it('v4 : ajoute le journal de préparation sans toucher aux données existantes', async () => {
    const db = await v2Database();
    expect(await migrateE2eeSchema(db)).toBe(E2EE_SCHEMA_VERSION);

    // La table est neuve : aucune ligne inventée pour les envois antérieurs.
    expect(
      await db.getFirstAsync<{ c: number }>('SELECT count(*) AS c FROM e2ee_media_prep'),
    ).toEqual({ c: 0 });
    const columns = (
      await db.getAllAsync<{ name: string; notnull: number }>(
        'PRAGMA table_info(e2ee_media_prep)',
      )
    ).map((column) => column.name);
    expect(columns).toEqual([
      'client_id',
      'conversation_id',
      'media_meta',
      'local_cipher_uri',
      'local_thumb_cipher_uri',
      'attachment_id',
      'thumb_upload_id',
      'state',
      'attempts',
      'last_error',
      'created_at',
      'updated_at',
    ]);
    // Les enveloppes v2 sont intactes.
    expect(
      await db.getAllAsync<Record<string, unknown>>(
        'SELECT client_id, state FROM e2ee_outbox ORDER BY client_id',
      ),
    ).toEqual([
      { client_id: 'c-pending', state: 'pending' },
      { client_id: 'c-sent', state: 'sent' },
    ]);
  });

  it('v4 : refuse un état de préparation inconnu', async () => {
    const db = adapter(legacyDatabase());
    await migrateE2eeSchema(db);
    await db.runAsync(
      `INSERT INTO e2ee_media_prep (client_id, conversation_id, state, created_at, updated_at)
       VALUES ('c1', 'conv-1', 'preparing', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    await expect(
      db.runAsync(
        `INSERT INTO e2ee_media_prep (client_id, conversation_id, state, created_at, updated_at)
         VALUES ('c2', 'conv-1', 'inventé', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      ),
    ).rejects.toThrow(/CHECK|constraint/i);
  });

  it('un échec de la v3 ne laisse ni colonne ni version avancée', async () => {
    const db = await v2Database();
    // Un objet portant le nom de l'index fait échouer l'étape *après* l'ajout
    // des colonnes : c'est le rollback de l'étape entière qui est vérifié ici.
    await db.execAsync('CREATE TABLE e2ee_outbox_peer_idx (x TEXT)');

    await expect(migrateE2eeSchema(db)).rejects.toThrow(/e2ee_outbox_peer_idx/);

    const names = (
      await db.getAllAsync<{ name: string }>('PRAGMA table_info(e2ee_outbox)')
    ).map((column) => column.name);
    expect(names).not.toContain('account_id');
    expect(names).not.toContain('peer_user_id');
    expect(
      await db.getFirstAsync<{ value: string }>(
        "SELECT value FROM e2ee_schema_meta WHERE key = 'schema_version'",
      ),
    ).toEqual({ value: '2' });
    expect(
      await db.getFirstAsync<{ c: number }>('SELECT count(*) AS c FROM e2ee_outbox'),
    ).toEqual({ c: 2 });
  });
});
