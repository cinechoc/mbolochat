/**
 * Stockage local des messages en attente et du point de rattrapage.
 *
 * SQLite par défaut : une ligne perdue serait un message perdu, et lui seul
 * survit à un crash ou à la fermeture de l'app.
 *
 * Un build natif plus ancien que ce module (ou une erreur d'ouverture) fait
 * retomber sur une file en mémoire : l'envoi fonctionne, il ne survit
 * simplement pas au redémarrage. C'est dégradable, pas cassant.
 */

export type OutboxStatus = 'pending' | 'sending' | 'failed';

export interface OutboxItem {
  clientId: string;
  conversationId: string;
  content: string;
  /** Message cité par une réponse. */
  replyTo: string | null;
  /** Photo ou message vocal en attente d'import : chemin local, pas sur le serveur. */
  localUri: string | null;
  /** Ce que porte ce fichier local. */
  kind: 'image' | 'audio';
  /** Durée d'un message vocal, en millisecondes. */
  durationMs: number | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  /** Identifiant d'import déjà réussi : une reprise ne retélécharge pas. */
  uploadId: string | null;
  status: OutboxStatus;
  attempts: number;
  error: string | null;
  createdAt: number;
}

export interface LocalStore {
  /** La source de vérité pour le type stocké. */
  save(item: OutboxItem): Promise<void>;
  list(conversationId?: string): Promise<OutboxItem[]>;
  /** Renvoie true si une ligne a vraiment été retirée. */
  remove(clientId: string): Promise<boolean>;
  readCursor(): Promise<number | null>;
  /** Ne recule jamais : le rattrapage repart du point le plus avancé. */
  advanceCursor(ms: number): Promise<void>;
  clear(): Promise<void>;
}

// ————— Mémoire (repli) —————

const memoryItems = new Map<string, OutboxItem>();
let memoryCursor: number | null = null;

const memoryStore: LocalStore = {
  async save(item) {
    memoryItems.set(item.clientId, item);
  },
  async list(conversationId) {
    const all = [...memoryItems.values()].filter(
      (item) => !conversationId || item.conversationId === conversationId,
    );
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },
  async remove(clientId) {
    return memoryItems.delete(clientId);
  },
  async readCursor() {
    return memoryCursor;
  },
  async advanceCursor(ms) {
    if (memoryCursor === null || ms > memoryCursor) {
      memoryCursor = ms;
    }
  },
  async clear() {
    memoryItems.clear();
    memoryCursor = null;
  },
};

// ————— SQLite —————

type Row = {
  client_id: string;
  conversation_id: string;
  content: string;
  reply_to: string | null;
  local_uri: string | null;
  kind: string;
  duration_ms: number | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  upload_id: string | null;
  status: string;
  attempts: number;
  error: string | null;
  created_at: number;
};

const SCHEMA = `
create table if not exists outbox (
  client_id text primary key,
  conversation_id text not null,
  content text not null default '',
  reply_to text,
  local_uri text,
  kind text not null default 'image',
  duration_ms integer,
  mime text,
  width integer,
  height integer,
  upload_id text,
  status text not null,
  attempts integer not null default 0,
  error text,
  created_at integer not null
);
create index if not exists outbox_conversation_idx on outbox (conversation_id, created_at);

create table if not exists sync_state (
  id integer primary key,
  since_ms integer not null
);
`;

const toParams = (item: OutboxItem): Record<string, string | number | null> => ({
  $client_id: item.clientId,
  $conversation_id: item.conversationId,
  $content: item.content,
  $reply_to: item.replyTo,
  $local_uri: item.localUri,
  $kind: item.kind,
  $duration_ms: item.durationMs,
  $mime: item.mime,
  $width: item.width,
  $height: item.height,
  $upload_id: item.uploadId,
  $status: item.status,
  $attempts: item.attempts,
  $error: item.error,
  $created_at: item.createdAt,
});

const fromRow = (row: Row): OutboxItem => ({
  clientId: row.client_id,
  conversationId: row.conversation_id,
  content: row.content,
  replyTo: row.reply_to,
  localUri: row.local_uri,
  kind: row.kind === 'audio' ? 'audio' : 'image',
  durationMs: row.duration_ms,
  mime: row.mime,
  width: row.width,
  height: row.height,
  uploadId: row.upload_id,
  status: row.status as OutboxStatus,
  attempts: row.attempts,
  error: row.error,
  createdAt: row.created_at,
});

interface Database {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  getAllAsync< T>(sql: string, ...params: unknown[]): Promise<T[]>;
  getFirstAsync< T>(sql: string, ...params: unknown[]): Promise<T | null>;
}

async function openSqlite(): Promise<Database> {
  // Un module Expo absent du build natif lève son erreur dès l'évaluation de son
  // JavaScript — hors de portée de tout try environnant. On sonde donc le module
  // natif d'abord, ce qui ne lève jamais, et on n'importe expo-sqlite que s'il
  // est réellement là.
  const { requireOptionalNativeModule } = await import('expo-modules-core');
  if (!requireOptionalNativeModule('ExpoSQLite')) {
    throw new Error('expo-sqlite absent de ce build');
  }
  const SQLite = (await import('expo-sqlite')) as unknown as {
    openDatabaseAsync(name: string): Promise<Database>;
  };
  const instance = await SQLite.openDatabaseAsync('mbolochat.db');
  await instance.execAsync('pragma journal_mode = wal;');
  await instance.execAsync(SCHEMA);
  return instance;
}

function sqliteStore(db: Database): LocalStore {
  return {
    async save(item) {
      await db.runAsync(
        `insert into outbox (client_id, conversation_id, content, reply_to, local_uri, kind, duration_ms, mime, width, height, upload_id, status, attempts, error, created_at)
         values ($client_id, $conversation_id, $content, $reply_to, $local_uri, $kind, $duration_ms, $mime, $width, $height, $upload_id, $status, $attempts, $error, $created_at)
         on conflict (client_id) do update set
           content = excluded.content,
           local_uri = excluded.local_uri,
           mime = excluded.mime,
           width = excluded.width,
           height = excluded.height,
           upload_id = excluded.upload_id,
           status = excluded.status,
           attempts = excluded.attempts,
           error = excluded.error`,
        toParams(item),
      );
    },
    async list(conversationId) {
      const rows = conversationId
        ? await db.getAllAsync<Row>('select * from outbox where conversation_id = ? order by created_at asc', conversationId)
        : await db.getAllAsync<Row>('select * from outbox order by created_at asc');
      return rows.map(fromRow);
    },
    async remove(clientId) {
      const result = await db.runAsync('delete from outbox where client_id = ?', clientId);
      return result.changes > 0;
    },
    async readCursor() {
      const row = await db.getFirstAsync<{ since_ms: number }>(
        'select since_ms from sync_state where id = 1',
      );
      return row ? row.since_ms : null;
    },
    async advanceCursor(ms) {
      await db.runAsync(
        'insert into sync_state (id, since_ms) values (1, ?) on conflict (id) do update set since_ms = max(sync_state.since_ms, excluded.since_ms)',
        ms,
      );
    },
    async clear() {
      await db.execAsync('delete from outbox; delete from sync_state;');
    },
  };
}

// ————— Choix unique au premier usage —————

let store: LocalStore | null = null;
let opening: Promise<LocalStore> | null = null;

export function getStore(): Promise<LocalStore> {
  if (store) {
    return Promise.resolve(store);
  }
  if (!opening) {
    opening = (async () => {
      try {
        store = sqliteStore(await openSqlite());
      } catch {
        store = memoryStore;
      }
      // Un redémarrage avec le réseau coupé doit reprendre la file laissée.
      if (store !== memoryStore) {
        const leftovers = await store.list();
        for (const item of leftovers) {
          if (item.status === 'sending') {
            await store.save({ ...item, status: 'pending' });
          }
        }
      }
      return store;
    })().finally(() => {
      opening = null;
    });
  }
  return opening;
}

/** Oublie file et curseur (déconnexion, changement de compte). */
export async function resetLocalStore(): Promise<void> {
  (await getStore()).clear();
}
