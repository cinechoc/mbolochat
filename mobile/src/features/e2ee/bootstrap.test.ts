import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import { bootstrapE2ee } from './bootstrap';
import { loadE2eeAccount, openE2eeDatabase } from './db';
import { migrateE2eeSchema } from './schema';

vi.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn(),
}));

vi.mock('../../../modules/mbolo-crypto/src', () => ({
  MboloCrypto: {
    secureCreateAccount: vi.fn(),
    secureGenerateOneTimeKeysSigned: vi.fn(),
    secureGenerateFallbackKey: vi.fn(),
    secureCreateInbound: vi.fn(),
    secureDecrypt: vi.fn(),
    secureEncrypt: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getE2eeStatus: vi.fn(),
    registerE2eeDevice: vi.fn(),
    addE2eePrekeys: vi.fn(),
  },
}));

vi.mock('./policy', () => ({ isE2eeEnabled: () => true }));
vi.mock('./mediaStore', () => ({
  sweepSecureMedia: vi.fn(),
  sweepDurablePartials: vi.fn(),
}));

// Seule l'ouverture de base est remplacée : tout le reste du module `db` est
// le vrai code, qui écrit dans la SQLite en mémoire ci-dessous.
vi.mock('./db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db')>();
  return { ...actual, openE2eeDatabase: vi.fn() };
});

const cryptoMock = vi.mocked(MboloCrypto);
const apiMock = vi.mocked(api);
const openMock = vi.mocked(openE2eeDatabase);

interface Handle {
  execAsync(sql: string): Promise<void>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  runAsync(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  closeAsync(): Promise<void>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  withExclusiveTransactionAsync(task: (txn: Handle) => Promise<void>): Promise<void>;
}

function openDb(): { raw: DatabaseSync; handle: Handle; db: never } {
  const raw = new DatabaseSync(':memory:');
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = (mode: string) => (task: (txn: Handle) => Promise<void>) => {
    const run = async () => {
      raw.exec(mode);
      try {
        await task(handle);
        raw.exec('COMMIT');
      } catch (cause) {
        raw.exec('ROLLBACK');
        throw cause;
      }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  const handle: Handle = {
    execAsync: async (sql: string) => {
      raw.exec(sql);
    },
    getAllAsync: async <T,>(sql: string, ...params: unknown[]) =>
      raw.prepare(sql).all(...(params as never[])).map((row) => ({ ...row }) as T),
    getFirstAsync: async <T,>(sql: string, ...params: unknown[]) => {
      const row = raw.prepare(sql).get(...(params as never[]));
      return row === undefined ? null : ({ ...row } as T);
    },
    runAsync: async (sql: string, ...params: unknown[]) => {
      const result = raw.prepare(sql).run(...(params as never[]));
      return { changes: Number(result.changes) };
    },
    closeAsync: async () => undefined,
    withTransactionAsync: async (task: () => Promise<void>) => {
      await exclusive('BEGIN')(async () => task());
    },
    withExclusiveTransactionAsync: (task: (txn: Handle) => Promise<void>) =>
      exclusive('BEGIN IMMEDIATE')(task),
  };
  return { raw, handle, db: handle as never };
}

const seedAccount = async (fixture: ReturnType<typeof openDb>, pickle = 'A0') => {
  await fixture.handle.runAsync(
    `INSERT INTO e2ee_account
       (id, account_pickle, device_id, identity_key, signing_key, fallback_key,
        fallback_signature, fallback_key_id, created_at)
     VALUES (1, ?, 'dev-local', 'local-identity', 'local-signing', 'fb', 'fbsig', 'fb1',
             '2026-01-01T00:00:00Z')`,
    pickle,
  );
};

beforeEach(async () => {
  vi.clearAllMocks();
  cryptoMock.secureGenerateOneTimeKeysSigned.mockImplementation(
    async (pickle: string) => ({
      account_pickle: `${pickle}+5keys`,
      keys: [{ key_id: 'k1', key: 'pub', signature: 'sig' }],
    }) as never,
  );
  apiMock.getE2eeStatus.mockResolvedValue({
    registered: true,
    fallbackAvailable: true,
    prekeysRemaining: 1,
  } as never);
  apiMock.addE2eePrekeys.mockResolvedValue(undefined as never);
});

describe('bootstrapE2ee — pickle global du compte', () => {
  it('ne perd aucune clé quand deux démarrages génèrent en même temps', async () => {
    const fixture = openDb();
    await migrateE2eeSchema(fixture.db);
    await seedAccount(fixture);
    // Deux écrans qui s'ouvrent ensemble appellent bootstrap en parallèle.
    openMock.mockResolvedValue({ db: fixture.db, recovered: false } as never);

    await Promise.all([bootstrapE2ee('t'), bootstrapE2ee('t')]);

    // Chaque génération part de l'état écrit par la précédente : rien n'est
    // écrasé, donc aucune clé privée publiée ne manque au compte.
    const account = await loadE2eeAccount(fixture.db);
    expect(account?.account_pickle).toBe('A0+5keys+5keys');
    expect(apiMock.addE2eePrekeys).toHaveBeenCalledTimes(2);
  });

  it('garde le pickle intact quand la génération échoue', async () => {
    const fixture = openDb();
    await migrateE2eeSchema(fixture.db);
    await seedAccount(fixture);
    openMock.mockResolvedValue({ db: fixture.db, recovered: false } as never);
    cryptoMock.secureGenerateOneTimeKeysSigned.mockRejectedValueOnce(new Error('crypto') as never);

    const result = await bootstrapE2ee('t');

    expect(result.registered).toBe(false);
    expect((await loadE2eeAccount(fixture.db))?.account_pickle).toBe('A0');
  });
});
