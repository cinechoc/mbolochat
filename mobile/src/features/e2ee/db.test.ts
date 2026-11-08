import { describe, expect, it, vi } from 'vitest';

import { loadDraft, saveDraft, searchLocalMessages, updateLocalMessageMedia } from './db';

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

describe('updateLocalMessageMedia — mise à jour ciblée des références média', () => {
  it('n’écrit que les colonnes fournies, jamais les autres', async () => {
    const runAsync = vi.fn().mockResolvedValue({ changes: 1 });
    const changes = await updateLocalMessageMedia({ runAsync } as never, 'msg-1', {
      uploadId: 'blob-media',
    });
    const [sql, ...params] = runAsync.mock.calls[0] as [string, ...string[]];
    expect(sql).toBe('UPDATE e2ee_messages SET upload_id = ? WHERE id = ?');
    // `upload_id` seul : ni la vignette ni le ciphertext local ne bougent.
    expect(sql).not.toMatch(/thumb|local_cipher_uri/);
    expect(params).toEqual(['blob-media', 'msg-1']);
    expect(changes).toBe(1);
  });

  it('traite média et vignette comme deux cycles indépendants', async () => {
    const runAsync = vi.fn().mockResolvedValue({ changes: 1 });
    await updateLocalMessageMedia({ runAsync } as never, 'msg-1', {
      localThumbCipherUri: 'file:///cache/thumb.bin',
      thumbUploadId: 'blob-thumb',
    });
    const [sql, ...params] = runAsync.mock.calls[0] as [string, ...string[]];
    expect(sql).toBe(
      'UPDATE e2ee_messages SET local_thumb_cipher_uri = ?, thumb_upload_id = ? WHERE id = ?',
    );
    expect(sql).not.toMatch(/media_meta/);
    expect(params).toEqual(['file:///cache/thumb.bin', 'blob-thumb', 'msg-1']);
  });

  it('écrit un NULL explicite, distinct d’un champ absent', async () => {
    const runAsync = vi.fn().mockResolvedValue({ changes: 1 });
    await updateLocalMessageMedia({ runAsync } as never, 'msg-1', { mediaMeta: null });
    const [sql, ...params] = runAsync.mock.calls[0] as [string, ...(string | null)[]];
    expect(sql).toBe('UPDATE e2ee_messages SET media_meta = ? WHERE id = ?');
    expect(params).toEqual([null, 'msg-1']);
  });

  it('n’émet aucune requête pour un patch vide', async () => {
    const runAsync = vi.fn().mockResolvedValue({ changes: 0 });
    await expect(
      updateLocalMessageMedia({ runAsync } as never, 'msg-1', {}),
    ).resolves.toBe(0);
    expect(runAsync).not.toHaveBeenCalled();
  });

  it('renvoie 0 quand le message provisoire a disparu', async () => {
    const runAsync = vi.fn().mockResolvedValue({ changes: 0 });
    await expect(
      updateLocalMessageMedia({ runAsync } as never, 'msg-1', { uploadId: 'blob' }),
    ).resolves.toBe(0);
  });
});
