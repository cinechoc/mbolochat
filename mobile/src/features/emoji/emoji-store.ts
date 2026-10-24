/**
 * Persistance des émojis récents, favoris et du ton de peau choisi.
 *
 * Même contrat que '../lib/store.ts' : SQLite quand le module natif est là,
 * repli mémoire sinon — la perte d'un historique d'émojis ne casse rien.
 * Tables ajoutées à la base existante 'mbolochat.db'.
 */

import { RECENTS_CAP, pushFavorite, pushRecent, removeFavorite } from './emoji-history';

export interface EmojiStore {
  loadRecents(): Promise<string[]>;
  addRecent(glyph: string): Promise<void>;
  loadFavorites(): Promise<string[]>;
  /** true si le glyphe vient d'être ajouté (sinon retiré). */
  toggleFavorite(glyph: string): Promise<boolean>;
  loadTone(): Promise<number>;
  setTone(tone: number): Promise<void>;
  /** Efface l'historique (réinit d'appareil, changement de compte). */
  clear(): Promise<void>;
}

function clampTone(tone: number): number {
  const safe = Number.isFinite(tone) ? Math.round(tone) : 0;
  return Math.min(Math.max(safe, 0), 5);
}

// ————— Mémoire (repli) —————

const memory: {
  recents: string[];
  favorites: string[];
  tone: number;
} = { recents: [], favorites: [], tone: 0 };

function memoryStore(): EmojiStore {
  return {
    async loadRecents() {
      return [...memory.recents];
    },
    async addRecent(glyph) {
      memory.recents = pushRecent(memory.recents, glyph);
    },
    async loadFavorites() {
      return [...memory.favorites];
    },
    async toggleFavorite(glyph) {
      if (memory.favorites.includes(glyph)) {
        memory.favorites = removeFavorite(memory.favorites, glyph);
        return false;
      }
      memory.favorites = pushFavorite(memory.favorites, glyph);
      return true;
    },
    async loadTone() {
      return memory.tone;
    },
    async setTone(tone) {
      memory.tone = clampTone(tone);
    },
    async clear() {
      memory.recents = [];
      memory.favorites = [];
      memory.tone = 0;
    },
  };
}

// ————— SQLite —————

const SCHEMA = `
create table if not exists emoji_recent (
  glyph text primary key,
  at integer not null
);
create table if not exists emoji_favorite (
  glyph text primary key,
  at integer not null
);
create table if not exists emoji_state (
  key text primary key,
  value text not null
);
`;

interface Database {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
}

const TONE_KEY = 'tone';

function sqliteStore(db: Database): EmojiStore {
  return {
    async loadRecents() {
      const rows = await db.getAllAsync<{ glyph: string }>(
        'select glyph from emoji_recent order by at desc limit ?',
        RECENTS_CAP,
      );
      return rows.map((row) => row.glyph);
    },
    async addRecent(glyph) {
      await db.runAsync(
        'insert into emoji_recent (glyph, at) values (?, ?) on conflict (glyph) do update set at = excluded.at',
        glyph,
        Date.now(),
      );
      // Seules les plus récentes restent : la table ne grossit pas à l'infini.
      await db.runAsync(
        `delete from emoji_recent where glyph not in (
           select glyph from emoji_recent order by at desc limit ?
         )`,
        RECENTS_CAP,
      );
    },
    async loadFavorites() {
      const rows = await db.getAllAsync<{ glyph: string }>(
        'select glyph from emoji_favorite order by at asc',
      );
      return rows.map((row) => row.glyph);
    },
    async toggleFavorite(glyph) {
      const exists = await db.getFirstAsync<{ glyph: string }>(
        'select glyph from emoji_favorite where glyph = ?',
        glyph,
      );
      if (exists) {
        await db.runAsync('delete from emoji_favorite where glyph = ?', glyph);
        return false;
      }
      await db.runAsync('insert into emoji_favorite (glyph, at) values (?, ?)', glyph, Date.now());
      return true;
    },
    async loadTone() {
      const row = await db.getFirstAsync<{ value: string }>(
        'select value from emoji_state where key = ?',
        TONE_KEY,
      );
      return row ? clampTone(Number(row.value)) : 0;
    },
    async setTone(tone) {
      await db.runAsync(
        'insert into emoji_state (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
        TONE_KEY,
        String(clampTone(tone)),
      );
    },
    async clear() {
      await db.execAsync('delete from emoji_recent; delete from emoji_favorite; delete from emoji_state;');
    },
  };
}

// ————— Choix unique au premier usage (même motif que '../lib/store.ts') —————

let store: EmojiStore | null = null;
let opening: Promise<EmojiStore> | null = null;

export function getEmojiStore(): Promise<EmojiStore> {
  if (store) return Promise.resolve(store);
  if (!opening) {
    opening = (async () => {
      // Sonde avant d'évaluer l'import : un ExpoSQLite absent du build natif
      // lèverait son erreur dès la charge du module JavaScript (motif
      // identique à store.ts) ; sans lui, l'historique reste en mémoire.
      const { requireOptionalNativeModule } = await import('expo-modules-core');
      if (!requireOptionalNativeModule('ExpoSQLite')) {
        throw new Error('expo-sqlite absent de ce build');
      }
      const SQLite = (await import('expo-sqlite')) as unknown as {
        openDatabaseAsync(name: string): Promise<Database>;
      };
      const db = await SQLite.openDatabaseAsync('mbolochat.db');
      await db.execAsync(SCHEMA);
      return sqliteStore(db);
    })().catch(() => memoryStore());
  }
  return opening.then((resolved) => {
    store = resolved;
    return resolved;
  });
}

/** Nouveau compte : efface l'historique local d'émojis de l'appareil. */
export async function resetEmojiStore(): Promise<void> {
  const current = await getEmojiStore();
  await current.clear();
}

