import type { SQLiteDatabase } from 'expo-sqlite';

/**
 * Schéma de la base chiffrée E2EE et ses migrations versionnées (étape 1.1a).
 *
 * Le fichier ne fait aucune supposition sur le moteur : il ne reçoit qu'un
 * sous-ensemble de l'API `SQLiteDatabase` d'expo-sqlite, ce qui permet de le
 * rejouer dans un test sur une vraie base SQLite (voir `schema.test.ts`).
 *
 * Règles tenues ici :
 *  - une seule table de version (`e2ee_schema_meta`), lue avant toute écriture ;
 *  - chaque étape tourne dans sa propre transaction, version estampillée dans la
 *    même transaction : un plantage laisse la base soit à la version n-1, soit
 *    à la version n, jamais entre les deux ;
 *  - un second passage ne rejoue rien (version courante) et chaque étape est en
 *    plus écrite pour être sans effet si elle était rejouée.
 */

export type E2eeSchemaDb = Pick<
  SQLiteDatabase,
  'execAsync' | 'getAllAsync' | 'getFirstAsync' | 'withTransactionAsync'
>;

/** Version de schéma attendue par ce code. */
export const E2EE_SCHEMA_VERSION = 9;

const META_TABLE = 'e2ee_schema_meta';

/**
 * Ajoute à une table les colonnes qui manquent, sans erreur si elles existent
 * déjà : `ALTER TABLE ... ADD COLUMN` n'est pas idempotent, `PRAGMA table_info`
 * l'est. C'est la façon dont une base ouverte par une version antérieure gagne
 * les colonnes d'une version plus récente.
 */
export async function addMissingColumns(
  db: E2eeSchemaDb,
  table: string,
  columns: [string, string][],
): Promise<void> {
  const existing = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  const present = new Set(existing.map((column) => column.name));
  for (const [name, type] of columns) {
    if (!present.has(name)) {
      await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

/** Table de suivi de version, créée avant toute autre chose. */
const META_DDL = `
  CREATE TABLE IF NOT EXISTS ${META_TABLE} (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** Tables historiques (version 1), reprises telles quelles : elles existent
 * déjà chez les installations courantes et ne doivent pas être recréées. */
const BASE_DDL = `
  CREATE TABLE IF NOT EXISTS e2ee_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    account_pickle TEXT NOT NULL,
    device_id TEXT,
    identity_key TEXT NOT NULL,
    signing_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
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
`;

/**
 * Journal de récupération **unique** de l'envoi chiffré (décision C1) : il
 * contient l'enveloppe déjà chiffrée et le pickle de session qui va avec, donc
 * aucune autre table de journal n'est nécessaire.
 *
 * Il n'y a volontairement pas de `client_upload_id` : le report de
 * l'idempotence de téléversement côté serveur est acté pour la partie 2
 * (décision C3), les blobs orphelins restent un risque résiduel documenté.
 *
 * Les colonnes d'identité (`account_id`, `peer_user_id`, `peer_device_id`)
 * n'apparaissent pas ici : elles sont ajoutées par la migration v3, avec la
 * forme historique de la table. Une base neuve les obtient donc en passant par
 * les mêmes étapes qu'une installation existante, ce qui garde les deux
 * chemins identiques.
 */
const OUTBOX_DDL = `
  CREATE TABLE IF NOT EXISTS e2ee_outbox (
    client_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_id TEXT,
    envelope TEXT NOT NULL,
    envelope_type TEXT NOT NULL,
    session_pickle TEXT NOT NULL,
    attachment_id TEXT,
    media_meta TEXT,
    quote_id TEXT,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'sending', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS e2ee_outbox_state_idx
    ON e2ee_outbox (state, created_at);
`;

/**
 * Réservation d'une prekey sortante (décisions R1) : une enveloppe `prekey`
 * est persistée avec son pickle S1 avant l'envoi. L'unicité sur
 * (pair, appareil, otk) interdit au niveau du schéma de réutiliser une OTK
 * déjà consommée : une seconde réservation de la même clé échoue.
 */
const BUNDLES_DDL = `
  CREATE TABLE IF NOT EXISTS e2ee_bundles (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    peer_user_id TEXT NOT NULL,
    peer_device_id TEXT NOT NULL DEFAULT '',
    peer_identity_key TEXT NOT NULL,
    one_time_key_id TEXT NOT NULL,
    one_time_key TEXT NOT NULL,
    session_pickle TEXT NOT NULL,
    envelope TEXT NOT NULL,
    envelope_type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'reserved'
      CHECK (state IN ('reserved', 'sent', 'discarded')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (peer_user_id, peer_device_id, one_time_key_id)
  );
`;

/**
 * Journal de **préparation** d'un média chiffré (v4).
 *
 * L'outbox ne peut pas servir ici : il n'existe qu'une fois l'enveloppe Olm
 * créée, donc après le chiffrement et les téléversements. Sans cette table, une
 * coupure entre le stockage durable et le journal laissait un ciphertext et des
 * clés que plus rien ne reliait — les fenêtres A, B et C de l'audit.
 *
 * La ligne est créée **avant** le premier fichier durable : l'identité de la
 * préparation (donc le nom du dossier durable) est donc toujours retrouvable.
 * Les clés média vivent ici, dans SQLCipher, et nulle part ailleurs.
 *
 * `state` est une **étape**, pas un fait sur le message : `message` signifie que
 * l'écriture de la ligne a été exécutée (elle peut avoir été retirée depuis), et
 * `journaled` que l'enveloppe est dans l'outbox. L'existence réelle du message
 * se lit dans `e2ee_messages`, jamais ici.
 *
 * `media_meta` réutilise le format de l'enveloppe (`EncryptedMedia`) : mêmes
 * clés, mêmes nonces, mêmes identifiants d'upload. Tant que les
 * téléversements n'ont pas abouti, `uploadId` y vaut `''` et les colonnes
 * `attachment_id`/`thumb_upload_id` font foi ; elles sont remplies dès que le
 * serveur répond.
 */
const MEDIA_PREP_DDL = `
  CREATE TABLE IF NOT EXISTS e2ee_media_prep (
    client_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    media_meta TEXT,
    local_cipher_uri TEXT,
    local_thumb_cipher_uri TEXT,
    attachment_id TEXT,
    thumb_upload_id TEXT,
    state TEXT NOT NULL DEFAULT 'preparing'
      CHECK (state IN ('preparing', 'stored', 'uploaded', 'message', 'journaled', 'abandoned')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS e2ee_media_prep_state_idx
    ON e2ee_media_prep (state, created_at);
`;

/** Version 1 : tables historiques, colonnes ajoutées après coup. */
async function migrateToV1(db: E2eeSchemaDb): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(BASE_DDL);
    await addMissingColumns(db, 'e2ee_account', [
      ['fallback_key', 'TEXT'],
      ['fallback_signature', 'TEXT'],
      ['fallback_key_id', 'TEXT'],
    ]);
    // `media_meta` porte la référence du média chiffré (clé du fichier, nonce,
    // empreinte) — elle ne quitte jamais cette base SQLCipher, contrairement au
    // corps du message qui peut être vide. `quote_id` retient l'id du message
    // cité, pour reconstruire l'aperçu.
    await addMissingColumns(db, 'e2ee_messages', [
      ['media_meta', 'TEXT'],
      ['quote_id', 'TEXT'],
    ]);
    await stampVersion(db, 1);
  });
}

/** Estampille la version dans la transaction de l'étape : jamais entre deux. */
async function stampVersion(db: E2eeSchemaDb, version: number): Promise<void> {
  await db.execAsync(
    `INSERT INTO ${META_TABLE} (key, value) VALUES ('schema_version', '${version}')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
}

interface IndexOrTrigger {
  name: string;
  type: string;
}

/**
 * Refuse de reconstruire une table si elle porte des index, déclencheurs ou
 * clés étrangères entrantes inattendus : `DROP TABLE` les emporterait
 * silencieusement. L'échec est volontairement bruyant plutôt que destructeur.
 */
async function assertRebuildSafe(db: E2eeSchemaDb, table: string): Promise<void> {
  const objects = await db.getAllAsync<IndexOrTrigger>(
    `SELECT name, type FROM sqlite_master
     WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`,
    table,
  );
  if (objects.length > 0) {
    const names = objects.map((object) => `${object.type} ${object.name}`).join(', ');
    throw new Error(`e2ee_schema: reconstruction de ${table} refusée (${names})`);
  }

  const tables = await db.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const other of tables) {
    if (other.name === table) continue;
    const foreignKeys = await db.getAllAsync<{ table: string }>(
      `PRAGMA foreign_key_list(${other.name})`,
    );
    const incoming = foreignKeys.filter((row) => row.table === table);
    if (incoming.length > 0) {
      throw new Error(
        `e2ee_schema: reconstruction de ${table} refusée (clé étrangère depuis ${other.name})`,
      );
    }
  }
}

/**
 * Reconstruit une table dont la clé primaire est simple pour lui donner une clé
 * composite. SQLite ne sait pas modifier une clé primaire : la séquence
 * officielle est créer / copier / supprimer / renommer, ci-dessous.
 *
 * Retourne `true` si la table a été reconstruite, `false` si elle était déjà au
 * format composite (seconde exécution, base déjà migrée).
 *
 * Aucune transaction n'est ouverte ici : l'appelant (l'étape de migration) tient
 * la sienne, et SQLite n'accepte pas les transactions imbriquées. Le `PRAGMA
 * foreign_keys` doit en revanche être posé hors transaction, donc il reste ici
 * et l'appelant évite d'ouvrir sa transaction avant ce point.
 */
async function rebuildWithCompositeKey(
  db: E2eeSchemaDb,
  table: string,
  createSql: string,
  columns: string[],
  copyExpression: string,
): Promise<boolean> {
  const info = await db.getAllAsync<{ name: string; pk: number }>(
    `PRAGMA table_info(${table})`,
  );
  const keyColumns = info.filter((column) => column.pk > 0);
  if (keyColumns.length > 1) {
    return false;
  }
  await assertRebuildSafe(db, table);

  const staging = `${table}__v2`;
  await db.execAsync(`DROP TABLE IF EXISTS ${staging}`);
  await db.execAsync(createSql.replace(/__TABLE__/g, staging));
  await db.execAsync(
    `INSERT INTO ${staging} (${columns.join(', ')})
     SELECT ${copyExpression} FROM ${table}`,
  );
  await db.execAsync(`DROP TABLE ${table}`);
  await db.execAsync(`ALTER TABLE ${staging} RENAME TO ${table}`);

  const broken = await db.getAllAsync<Record<string, unknown>>('PRAGMA foreign_key_check');
  if (broken.length > 0) {
    throw new Error(`e2ee_schema: intégrité référentielle rompue après ${table}`);
  }
  return true;
}

/**
 * Version 2 : clés primaires composites (une session et une clé de pair par
 * appareil), journal d'envoi, réservations de prekey, colonnes du cycle média
 * durable.
 */
async function migrateToV2(db: E2eeSchemaDb): Promise<void> {
  const previousForeignKeys = await db.getFirstAsync<{ foreign_keys: number }>(
    'PRAGMA foreign_keys',
  );
  const foreignKeysWereOn = previousForeignKeys?.foreign_keys === 1;
  if (foreignKeysWereOn) {
    // Hors transaction : PRAGMA foreign_keys est sans effet dans une transaction.
    await db.execAsync('PRAGMA foreign_keys = OFF');
  }
  try {
    await db.withTransactionAsync(async () => {
      // Ordre imposé par 1.1a : nouvelles tables, reconstructions, colonnes média.
      await db.execAsync(OUTBOX_DDL);
      await db.execAsync(BUNDLES_DDL);

      await rebuildWithCompositeKey(
        db,
        'e2ee_sessions',
        `CREATE TABLE __TABLE__ (
           peer_user_id TEXT NOT NULL,
           peer_device_id TEXT NOT NULL DEFAULT '',
           session_pickle TEXT NOT NULL,
           peer_identity_key TEXT NOT NULL,
           peer_signing_key TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           PRIMARY KEY (peer_user_id, peer_device_id)
         )`,
        [
          'peer_user_id',
          'peer_device_id',
          'session_pickle',
          'peer_identity_key',
          'peer_signing_key',
          'updated_at',
        ],
        // Un appareil inconnu devient la chaîne vide : la paire reste unique et
        // l'ancien `WHERE peer_user_id` continue de trouver la ligne.
        `peer_user_id, COALESCE(peer_device_id, ''), session_pickle,
         peer_identity_key, peer_signing_key, updated_at`,
      );

      await rebuildWithCompositeKey(
        db,
        'e2ee_peer_keys',
        `CREATE TABLE __TABLE__ (
           peer_user_id TEXT NOT NULL,
           peer_device_id TEXT NOT NULL DEFAULT '',
           signing_key TEXT NOT NULL,
           verified INTEGER NOT NULL DEFAULT 0,
           updated_at TEXT NOT NULL,
           PRIMARY KEY (peer_user_id, peer_device_id)
         )`,
        ['peer_user_id', 'peer_device_id', 'signing_key', 'verified', 'updated_at'],
        `peer_user_id, '', signing_key, verified, updated_at`,
      );

      // Cycle média durable (décision 5) : le ciphertext local et l'id de blob
      // média d'un côté, ceux de la vignette de l'autre. Aucun des deux ne
      // dépend de l'autre, une vignette peut être téléversée avant le média.
      await addMissingColumns(db, 'e2ee_messages', [
        ['local_cipher_uri', 'TEXT'],
        ['upload_id', 'TEXT'],
        ['local_thumb_cipher_uri', 'TEXT'],
        ['thumb_upload_id', 'TEXT'],
      ]);
      await stampVersion(db, 2);
    });
  } finally {
    if (foreignKeysWereOn) {
      await db.execAsync('PRAGMA foreign_keys = ON');
    }
  }
}

const STEPS: { version: number; run: (db: E2eeSchemaDb) => Promise<void> }[] = [
  { version: 1, run: migrateToV1 },
  { version: 2, run: migrateToV2 },
  { version: 3, run: migrateToV3 },
  { version: 4, run: migrateToV4 },
  { version: 5, run: migrateToV5 },
  { version: 6, run: migrateToV6 },
  { version: 7, run: migrateToV7 },
  { version: 8, run: migrateToV8 },
  { version: 9, run: migrateToV9 },
];

async function readVersion(db: E2eeSchemaDb): Promise<number> {
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM ${META_TABLE} WHERE key = 'schema_version'`,
  );
  const parsed = Number.parseInt(row?.value ?? '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Version 3 : identité des enveloppes de l'outbox.
 *
 * Les trois colonnes sont ajoutées **nullables et sans valeur par défaut** :
 * les enveloppes déjà présentes gardent `NULL`, on n'invente aucune identité
 * pour elles. Elles servent la reprise par pair/appareil et le diagnostic.
 */
async function migrateToV3(db: E2eeSchemaDb): Promise<void> {
  await db.withTransactionAsync(async () => {
    await addMissingColumns(db, 'e2ee_outbox', [
      ['account_id', 'TEXT'],
      ['peer_user_id', 'TEXT'],
      ['peer_device_id', 'TEXT'],
    ]);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS e2ee_outbox_peer_idx
        ON e2ee_outbox (peer_user_id, peer_device_id, created_at);
    `);
    await stampVersion(db, 3);
  });
}

/**
 * Version 4 : journal de préparation des médias chiffrés.
 *
 * Ajout pur : aucune colonne existante n'est touchée, aucun contenu n'est
 * réécrit. Une base v3 monte en v4 sans perte, et une base v4 reste lisible par
 * du code qui ignorerait la table. Retour arrière = ignorer la table puis la
 * supprimer (`DROP TABLE e2ee_media_prep`) : aucun état d'envoi n'en dépend une
 * fois l'outbox écrit.
 */
async function migrateToV4(db: E2eeSchemaDb): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(MEDIA_PREP_DDL);
    await stampVersion(db, 4);
  });
}

/**
 * Version 5 : référence d'un sticker de catalogue reçu.
 *
 * Ajout pur d'une colonne **nullable** : les messages existants gardent `NULL`
 * et ne sont pas réécrits. Une base v4 monte en v5 sans perte ; une base v5
 * reste lisible par du code qui ignorerait la colonne (il afficherait un corps
 * vide, comme avant). Retour arrière = ignorer la colonne, puis
 * `ALTER TABLE e2ee_messages DROP COLUMN sticker_ref`.
 *
 * La référence ne quitte jamais cette base : rien n'est enregistré côté serveur.
 */
async function migrateToV5(db: E2eeSchemaDb): Promise<void> {
  await db.withTransactionAsync(async () => {
    await addMissingColumns(db, 'e2ee_messages', [['sticker_ref', 'TEXT']]);
    await stampVersion(db, 5);
  });
}

/**
 * Version 6 : motif d'un message authentifié mais illisible.
 *
 * Un payload dont le déchiffrement Olm a réussi peut échouer au parsing (version
 * future, contrat inconnu, encodage invalide). Persister la seule avancée de
 * session rendait le message invisible et surtout désynchronisait le ratchet :
 * le message suivant devenait indéchiffrable. La colonne retient donc, dans la
 * même transaction, un **motif normalisé** (`unsupported_version`,
 * `invalid_payload`, `invalid_encoding`) — jamais le contenu, jamais le message
 * d'erreur d'origine.
 *
 * Ajout pur d'une colonne **nullable** : les messages existants gardent `NULL`,
 * donc « lisible ». Retour arrière = ignorer la colonne.
 */
async function migrateToV6(db: E2eeSchemaDb): Promise<void> {
  await db.withTransactionAsync(async () => {
    await addMissingColumns(db, 'e2ee_messages', [['unreadable_reason', 'TEXT']]);
    await stampVersion(db, 6);
  });
}

/**
 * Version 7 : événements de contrôle chiffrés (réactions aujourd'hui).
 *
 * Une réaction voyage dans une enveloppe Olm normale. Sa ligne locale doit donc
 * exister pour l'idempotence et pour empêcher un second déchiffrement, mais elle
 * ne doit jamais apparaître comme une bulle. Les colonnes nullables décrivent
 * l'événement ; `raw_payload` conserve, uniquement dans SQLCipher, un contenu
 * authentifié d'une version future afin qu'il ne soit pas perdu.
 *
 * Ajout pur : les messages existants gardent `hidden = 0` et `content_kind =
 * NULL`, donc leur comportement visible ne change pas.
 */
async function migrateToV7(db: E2eeSchemaDb): Promise<void> {
  await db.withTransactionAsync(async () => {
    await addMissingColumns(db, 'e2ee_messages', [
      ['hidden', 'INTEGER NOT NULL DEFAULT 0'],
      ['content_kind', 'TEXT'],
      ['control_target', 'TEXT'],
      ['reaction', 'TEXT'],
      ['reaction_action', 'TEXT'],
      ['raw_payload', 'TEXT'],
    ]);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS e2ee_messages_reactions_idx
        ON e2ee_messages (conversation_id, content_kind, control_target, created_at);
    `);
    await stampVersion(db, 7);
  });
}

/**
 * Version 8 : suppression pour tous.
 *
 * Le message cible reste présent comme ligne vide (`deleted = 1`) pour que
 * l'ordre des bulles et les accusés ne changent pas. `deleted_by` permet de
 * constater l'auteur autorisé sans exposer le contenu supprimé.
 *
 * `e2ee_deletions` est une tombstone locale, chiffrée par SQLCipher. Elle est
 * écrite quand l'événement arrive avant le message ; la cible, en arrivant,
 * applique la tombstone dans la même transaction que l'avancement Olm.
 */
async function migrateToV8(db: E2eeSchemaDb): Promise<void> {
  await db.withTransactionAsync(async () => {
    await addMissingColumns(db, 'e2ee_messages', [
      ['deleted', 'INTEGER NOT NULL DEFAULT 0'],
      ['deleted_by', 'TEXT'],
    ]);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS e2ee_deletions (
        target_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        event_message_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (target_id, author_id)
      );
      CREATE INDEX IF NOT EXISTS e2ee_deletions_event_idx
        ON e2ee_deletions (event_message_id);
    `);
    await stampVersion(db, 8);
  });
}

/**
 * Version 9 : vérification d'identité locale.
 *
 * La table ne stocke que des clés **publiques** et l'empreinte du code de
 * sécurité. `verified_at` lie la vérification à la clé d'identité courante ;
 * un changement de clé efface cette date et renseigne `key_changed_at`, sans
 * supprimer la ligne afin que l'interface puisse afficher le bandeau.
 */
async function migrateToV9(db: E2eeSchemaDb): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS e2ee_identity_verifications (
        peer_user_id TEXT PRIMARY KEY,
        peer_identity_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        verified_at TEXT,
        key_changed_at TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    await stampVersion(db, 9);
  });
}

/**
 * Amène la base à `E2EE_SCHEMA_VERSION`. Sans effet si elle y est déjà, ce qui
 * rend l'appel sûr à chaque ouverture.
 *
 * `target` borne volontairement la montée de version : les tests s'en servent
 * pour fabriquer une base figée à la v2 et vérifier la migration suivante sur
 * une installation réaliste.
 *
 * Chaque étape ouvre sa propre transaction et y estampille sa version : un
 * plantage laisse la base soit à la version n-1, soit à la version n, jamais
 * entre les deux. Aucune transaction n'est donc ouverte ici (pas d'imbrication).
 */
export async function migrateE2eeSchema(
  db: E2eeSchemaDb,
  target: number = E2EE_SCHEMA_VERSION,
): Promise<number> {
  await db.execAsync(META_DDL);
  let version = await readVersion(db);
  for (const step of STEPS) {
    if (step.version <= version || step.version > target) continue;
    await step.run(db);
    version = await readVersion(db);
  }
  return version;
}
