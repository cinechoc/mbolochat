import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDatabaseAsync, openDatabaseAsync } from 'expo-sqlite';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { e2eeDatabaseNameForUser, openE2eeDatabase } from './db';
import { migrateE2eeSchema } from './schema';

const files = vi.hoisted(() => {
  const existing = new Set<string>();
  const moves: [string, string][] = [];
  const directories: string[] = [];
  const pathOf = (part: string | { uri: string }) =>
    typeof part === 'string' ? part : part.uri;
  const join = (parts: (string | { uri: string })[]) =>
    parts
      .map(pathOf)
      .reduce((result, part) => `${result.replace(/\/+$/, '')}/${part.replace(/^\/+/, '')}`);

  class MockFile {
    readonly uri: string;

    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(parts);
    }

    get exists() {
      return existing.has(this.uri);
    }

    async move(destination: { uri: string }) {
      moves.push([this.uri, destination.uri]);
      existing.delete(this.uri);
      existing.add(destination.uri);
    }
  }

  class MockDirectory {
    readonly uri: string;

    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(parts);
    }

    create() {
      directories.push(this.uri);
    }
  }

  return { existing, moves, directories, MockFile, MockDirectory };
});

vi.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn(),
  defaultDatabaseDirectory: '/mock/SQLite',
}));

vi.mock('expo-file-system', () => ({
  File: files.MockFile,
  Directory: files.MockDirectory,
}));

vi.mock('../../../modules/mbolo-crypto/src', () => ({
  MboloCrypto: {
    ensureKeys: vi.fn(async () => ({ recovered: false })),
    sqlCipherKey: vi.fn(async () => ({ key: 'ab'.repeat(32) })),
  },
}));

vi.mock('./schema', () => ({ migrateE2eeSchema: vi.fn() }));
vi.mock('./mediaStore', () => ({ sweepSecureMedia: vi.fn() }));

const LEGACY_URI = 'file:///mock/SQLite/mbolo-e2ee.db';

function legacyOwner(userId: string) {
  files.existing.add(LEGACY_URI);
  vi.mocked(openDatabaseAsync).mockImplementation(
    async () =>
      ({
        execAsync: async () => undefined,
        getFirstAsync: async (sql: string) => {
          if (sql.includes("name = 'e2ee_account'")) return { name: 'e2ee_account' };
          if (sql.includes('SELECT user_id')) return { user_id: userId };
          if (sql.includes('cipher_version')) return { cipher_version: '4.17.0' };
          return { c: 0 };
        },
        closeAsync: async () => undefined,
      }) as never,
  );
}

describe('openE2eeDatabase — routage par compte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files.existing.clear();
    files.moves.length = 0;
    files.directories.length = 0;
    vi.mocked(openDatabaseAsync).mockImplementation(
      async () =>
        ({
          execAsync: async () => undefined,
          getFirstAsync: async (sql: string) =>
            sql.includes('cipher_version') ? { cipher_version: '4.17.0' } : { c: 0 },
          closeAsync: async () => undefined,
        }) as never,
    );
  });

  it('un utilisateur sans base historique reçoit une base à son nom', async () => {
    await openE2eeDatabase('route-new-user');

    expect(vi.mocked(openDatabaseAsync).mock.calls.at(-1)?.[0]).toBe(
      e2eeDatabaseNameForUser('route-new-user'),
    );
    expect(e2eeDatabaseNameForUser('route-new-user')).toBe(
      'mbolo-e2ee-route-new-user.db',
    );
    expect(deleteDatabaseAsync).not.toHaveBeenCalled();
  });

  it('le propriétaire de la base historique garde exactement cette base', async () => {
    legacyOwner('route-owner-a');

    await openE2eeDatabase('route-owner-a');

    expect(vi.mocked(openDatabaseAsync).mock.calls.at(-1)?.[0]).toBe('mbolo-e2ee.db');
    expect(deleteDatabaseAsync).not.toHaveBeenCalled();
  });

  it('un autre compte reçoit une base dédiée sans toucher à la base historique', async () => {
    legacyOwner('route-owner-a');

    await openE2eeDatabase('route-owner-b');

    const names = vi.mocked(openDatabaseAsync).mock.calls.map(([name]) => name);
    expect(names).toContain('mbolo-e2ee.db');
    expect(names.at(-1)).toBe('mbolo-e2ee-route-owner-b.db');
    expect(deleteDatabaseAsync).not.toHaveBeenCalled();
    expect(files.existing.has(LEGACY_URI)).toBe(true);
  });

  it('met en quarantaine une base dont la clé a été régénérée', async () => {
    const name = e2eeDatabaseNameForUser('route-recovered');
    const uri = `file:///mock/SQLite/${name}`;
    files.existing.add(uri);
    files.existing.add(`${uri}-wal`);
    vi.mocked(MboloCrypto.ensureKeys).mockResolvedValueOnce({ recovered: true } as never);

    await openE2eeDatabase('route-recovered');

    expect(files.moves.map(([source]) => source)).toEqual([uri, `${uri}-wal`]);
    expect(files.moves[0]?.[1]).toContain('mbolo-e2ee-quarantine/');
    expect(deleteDatabaseAsync).not.toHaveBeenCalled();
    expect(files.directories).toHaveLength(1);
  });

  it('met en quarantaine un fichier illisible puis rouvre une base neuve', async () => {
    const name = e2eeDatabaseNameForUser('route-unreadable');
    const uri = `file:///mock/SQLite/${name}`;
    files.existing.add(uri);
    const handle = {
      execAsync: async () => undefined,
      getFirstAsync: async (sql: string) =>
        sql.includes('cipher_version') ? { cipher_version: '4.17.0' } : { c: 0 },
      closeAsync: async () => undefined,
    };
    vi.mocked(openDatabaseAsync)
      .mockRejectedValueOnce(new Error('file is not a database'))
      .mockResolvedValue(handle as never);

    await openE2eeDatabase('route-unreadable');

    expect(files.moves).toHaveLength(1);
    expect(files.moves[0]?.[1]).toContain('mbolo-e2ee-quarantine/');
    expect(deleteDatabaseAsync).not.toHaveBeenCalled();
    expect(vi.mocked(openDatabaseAsync)).toHaveBeenCalledTimes(2);
  });
});

describe('openE2eeDatabase — une seule migration à la fois', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files.existing.clear();
    files.moves.length = 0;
    files.directories.length = 0;
    vi.mocked(openDatabaseAsync).mockImplementation(
      async () =>
        ({
          execAsync: async () => undefined,
          getFirstAsync: async (sql: string) =>
            sql.includes('cipher_version') ? { cipher_version: '4.17.0' } : { c: 0 },
          closeAsync: async () => undefined,
        }) as never,
    );
  });

  it('sérialise deux ouvertures concurrentes (bootstrap + file programmée)', async () => {
    let active = 0;
    let maxActive = 0;
    vi.mocked(migrateE2eeSchema).mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return 13;
    });

    await Promise.all([openE2eeDatabase(), openE2eeDatabase()]);

    expect(maxActive).toBe(1);
    expect(vi.mocked(migrateE2eeSchema)).toHaveBeenCalledTimes(2);
  });
});
