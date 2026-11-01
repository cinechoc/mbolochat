import { describe, expect, it, vi } from 'vitest';

import { searchLocalMessages } from './db';

vi.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn(),
}));

vi.mock('../../../modules/mbolo-crypto/src', () => ({
  MboloCrypto: {},
}));

describe('searchLocalMessages — échappement LIKE', () => {
  it('utilise une clause ESCAPE d un seul caractère et protège % _ et \\', async () => {
    const getAllAsync = vi.fn().mockResolvedValue([]);
    await searchLocalMessages(
      { getAllAsync } as never,
      'conv-1',
      '100%_sure\\',
    );
    const [sql, ...params] = getAllAsync.mock.calls[0] as [string, string, string];
    expect(sql).toMatch(/ESCAPE '\\'/);
    expect(params).toEqual(['conv-1', '%100\\%\\_sure\\\\%']);
  });
});
