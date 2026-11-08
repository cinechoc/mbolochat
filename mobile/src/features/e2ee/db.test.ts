import { describe, expect, it, vi } from 'vitest';

import { loadDraft, saveDraft, searchLocalMessages } from './db';

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

describe('brouillons E2EE — toujours dans la base chiffrée', () => {
  it('saveDraft écrit dans e2ee_drafts (UPSERT) pour un texte', async () => {
    const runAsync = vi.fn().mockResolvedValue({ changes: 1 });
    await saveDraft({ runAsync } as never, 'conv-1', 'brouillon secret');
    const [sql, ...params] = runAsync.mock.calls[0] as [string, string, string];
    // La cible est bien la table de la base chiffrée, jamais un autre stockage.
    expect(sql).toMatch(/INSERT INTO e2ee_drafts/);
    expect(sql).toMatch(/ON CONFLICT\(conversation_id\)/);
    expect(params).toEqual(['conv-1', 'brouillon secret']);
  });

  it('saveDraft supprime la ligne pour un brouillon vide ou espaces', async () => {
    const runAsync = vi.fn().mockResolvedValue({ changes: 1 });
    await saveDraft({ runAsync } as never, 'conv-1', '   ');
    const [sql, ...params] = runAsync.mock.calls[0] as [string, string];
    expect(sql).toMatch(/DELETE FROM e2ee_drafts/);
    expect(params).toEqual(['conv-1']);
  });

  it('loadDraft relit le corps stocké', async () => {
    const getFirstAsync = vi.fn().mockResolvedValue({ body: 'reste ici' });
    const body = await loadDraft({ getFirstAsync } as never, 'conv-1');
    const [sql, ...params] = getFirstAsync.mock.calls[0] as [string, string];
    expect(sql).toMatch(/FROM e2ee_drafts/);
    expect(params).toEqual(['conv-1']);
    expect(body).toBe('reste ici');
  });

  it('loadDraft renvoie une chaîne vide sans ligne', async () => {
    const getFirstAsync = vi.fn().mockResolvedValue(null);
    await expect(loadDraft({ getFirstAsync } as never, 'conv-1')).resolves.toBe('');
  });
});
