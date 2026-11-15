import { describe, expect, it, vi } from 'vitest';

import {
  consumeLocalViewOnce,
  listPendingViewOnceConsumptions,
  loadDraft,
  markViewOnceServerHidden,
  saveDraft,
  saveLocalMessage,
  searchLocalMessages,
  updateLocalMessageMedia,
} from './db';

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

describe('saveLocalMessage — répare l’identité lors d’un conflit', () => {
  it('réécrit sender_id et mine quand le même identifiant existe déjà', async () => {
    const runAsync = vi.fn().mockResolvedValue({ changes: 1 });
    await saveLocalMessage({ runAsync } as never, {
      id: 'message-partage',
      conversation_id: 'conv-1',
      sender_id: 'peer',
      sender_name: 'Pair',
      body: 'reçu',
      created_at: '2026-01-01T00:00:01.000Z',
      client_id: null,
      mine: 0,
      media_meta: null,
      quote_id: null,
    });
    const [sql] = runAsync.mock.calls[0] as [string, ...unknown[]];
    expect(sql).toMatch(/sender_id = excluded\.sender_id/);
    expect(sql).toMatch(/sender_name = excluded\.sender_name/);
    expect(sql).toMatch(/mine = excluded\.mine/);
  });

  it('réapplique une tombstone de lecture unique lors d’une réinsertion', async () => {
    const runAsync = vi.fn().mockResolvedValue({ changes: 1 });
    await saveLocalMessage({ runAsync } as never, {
      id: 'view-once-1',
      conversation_id: 'conv-1',
      sender_id: 'peer',
      sender_name: 'Pair',
      body: 'ne doit jamais réapparaître',
      created_at: '2026-01-01T00:00:01.000Z',
      client_id: null,
      mine: 0,
      media_meta: null,
      quote_id: null,
      view_once: 1,
    });
    const [sql, ...params] = runAsync.mock.calls[1] as [string, ...string[]];
    expect(sql).toMatch(/EXISTS \(\s*SELECT 1 FROM e2ee_view_once_consumed/);
    expect(sql).toMatch(/hidden = 1/);
    expect(params).toEqual(['view-once-1', 'view-once-1']);
  });
});

describe('consommation durable des lectures uniques', () => {
  it('écrit la tombstone puis vide la copie locale', async () => {
    const runAsync = vi.fn().mockResolvedValue({ changes: 1 });
    await consumeLocalViewOnce(
      { runAsync } as never,
      'view-once-1',
      'conv-1',
      '2026-01-01T00:00:00Z',
    );

    const [insertSql, ...insertParams] = runAsync.mock.calls[0] as [string, ...string[]];
    expect(insertSql).toMatch(/INSERT INTO e2ee_view_once_consumed/);
    expect(insertParams).toEqual(['view-once-1', 'conv-1', '2026-01-01T00:00:00Z']);
    const [updateSql, ...updateParams] = runAsync.mock.calls[1] as [string, ...string[]];
    expect(updateSql).toMatch(/body = ''[\s\S]*media_meta = NULL[\s\S]*hidden = 1/);
    expect(updateParams).toEqual(['view-once-1', 'conv-1']);
  });

  it('liste les masquages serveur en attente puis les acquitte', async () => {
    const getAllAsync = vi
      .fn()
      .mockResolvedValue([{ message_id: 'view-once-1', conversation_id: 'conv-1' }]);
    const runAsync = vi.fn().mockResolvedValue({ changes: 1 });

    await expect(
      listPendingViewOnceConsumptions({ getAllAsync } as never),
    ).resolves.toEqual([{ message_id: 'view-once-1', conversation_id: 'conv-1' }]);
    await markViewOnceServerHidden({ runAsync } as never, 'view-once-1');

    expect(getAllAsync.mock.calls[0][0]).toMatch(/server_hidden = 0/);
    expect(runAsync).toHaveBeenCalledWith(
      'UPDATE e2ee_view_once_consumed SET server_hidden = 1 WHERE message_id = ?',
      'view-once-1',
    );
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
