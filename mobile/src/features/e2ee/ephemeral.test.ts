import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { describe, expect, it, vi } from 'vitest';

import {
  applyConversationEphemeralWith,
  loadConversationEphemeral,
} from './db';
import { purgeExpiredMessages } from './ephemeral';
import {
  EPHEMERAL_TTLS,
  InvalidPayloadError,
  buildEphemeralV6,
  encodeText,
  parsePayload,
} from './payload';
import { migrateE2eeSchema, type E2eeSchemaDb } from './schema';

const { cleanupDeletedMedia } = vi.hoisted(() => ({
  cleanupDeletedMedia: vi.fn(async () => undefined),
}));

vi.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn(),
}));

vi.mock('./deletionFiles', () => ({ cleanupDeletedMedia }));

vi.mock('../../../modules/mbolo-crypto/src', () => ({
  MboloCrypto: {},
}));

interface Handle extends E2eeSchemaDb {
  runAsync(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
}

function adapter(raw: DatabaseSync): Handle {
  return {
    execAsync: async (sql: string) => {
      raw.exec(sql);
    },
    getAllAsync: (async <T,>(sql: string, ...params: unknown[]) =>
      raw.prepare(sql).all(...(params as never[])).map((row) => ({ ...row }) as T)) as E2eeSchemaDb['getAllAsync'],
    getFirstAsync: (async <T,>(sql: string, ...params: unknown[]) => {
      const row = raw.prepare(sql).get(...(params as never[]));
      return row === undefined ? null : ({ ...row } as T);
    }) as E2eeSchemaDb['getFirstAsync'],
    withTransactionAsync: async (task: () => Promise<void>) => {
      raw.exec('BEGIN');
      try {
        await task();
        raw.exec('COMMIT');
      } catch (cause) {
        raw.exec('ROLLBACK');
        throw cause;
      }
    },
    runAsync: async (sql: string, ...params: unknown[]) => {
      const result = raw.prepare(sql).run(...(params as never[]));
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
  };
}

describe('payload éphémère v6', () => {
  it.each(EPHEMERAL_TTLS)('fait un aller-retour pour %i secondes', (ttl) => {
    expect(parsePayload(buildEphemeralV6(ttl, 12))).toEqual({
      kind: 'ephemeral',
      ttlSeconds: ttl,
      version: 12,
    });
  });

  it('refuse une durée, une version ou un champ hors contrat', () => {
    expect(() => buildEphemeralV6(3_600 as never, 1)).toThrow(InvalidPayloadError);
    expect(() => buildEphemeralV6(0, 0)).toThrow(InvalidPayloadError);
    expect(() => parsePayload(encodeText(JSON.stringify({
      v: 6,
      kind: 'ephemeral',
      ttlSeconds: 3_600,
      version: 1,
    })))).toThrow(InvalidPayloadError);
    expect(() => parsePayload(encodeText(JSON.stringify({
      v: 6,
      kind: 'ephemeral',
      ttlSeconds: 0,
      version: 1,
      extra: true,
    })))).toThrow(InvalidPayloadError);
  });
});

describe('état éphémère de conversation', () => {
  it('applique seulement la version strictement la plus récente', async () => {
    const db = adapter(new DatabaseSync(':memory:'));
    await migrateE2eeSchema(db);
    const sqlite = db as unknown as SQLiteDatabase;

    expect(await applyConversationEphemeralWith(sqlite, 'conv-1', 86_400, 10)).toBe(true);
    expect(await applyConversationEphemeralWith(sqlite, 'conv-1', 0, 9)).toBe(false);
    expect((await loadConversationEphemeral(sqlite, 'conv-1'))?.ephemeral_ttl_seconds).toBe(86_400);
    expect(await applyConversationEphemeralWith(sqlite, 'conv-1', 0, 10)).toBe(false);
    expect((await loadConversationEphemeral(sqlite, 'conv-1'))?.ephemeral_ttl_seconds).toBe(86_400);
    expect(await applyConversationEphemeralWith(sqlite, 'conv-1', 604_800, 11)).toBe(true);
    expect((await loadConversationEphemeral(sqlite, 'conv-1'))?.ephemeral_ttl_seconds).toBe(604_800);
  });
});

describe('purge des messages éphémères', () => {
  it('vide le contenu et les fichiers arrivés à échéance, sans toucher au reste', async () => {
    cleanupDeletedMedia.mockClear();
    const raw = new DatabaseSync(':memory:');
    const db = adapter(raw);
    await migrateE2eeSchema(db);
    await db.runAsync(
      `INSERT INTO e2ee_messages
         (id, conversation_id, sender_id, sender_name, body, created_at, mine,
          local_cipher_uri, upload_id, local_thumb_cipher_uri, thumb_upload_id,
          raw_payload, expires_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'old', 'conv-1', 'peer', 'Pair', 'secret', '2026-01-01T00:00:00.000Z', 0,
      'file:///old.enc', 'upload-old', 'file:///old-thumb.enc', 'thumb-old',
      '{"secret":true}', '2026-01-01T00:00:01.000Z', 0,
    );
    await db.runAsync(
      `INSERT INTO e2ee_messages
         (id, conversation_id, sender_id, sender_name, body, created_at, mine,
          expires_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'fresh', 'conv-1', 'peer', 'Pair', 'encore là', '2026-01-01T00:00:02.000Z', 0,
      '2026-01-01T00:10:00.000Z', 0,
    );
    await db.runAsync(
      `INSERT INTO e2ee_messages
         (id, conversation_id, sender_id, sender_name, body, created_at, mine,
          expires_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'already-deleted', 'conv-1', 'peer', 'Pair', '', '2026-01-01T00:00:03.000Z', 0,
      '2026-01-01T00:00:01.000Z', 1,
    );

    const purged = await purgeExpiredMessages(
      db as unknown as SQLiteDatabase,
      '2026-01-01T00:05:00.000Z',
    );

    expect(purged.map((item) => item.id)).toEqual(['old']);
    expect(cleanupDeletedMedia).toHaveBeenCalledTimes(1);
    expect(cleanupDeletedMedia).toHaveBeenCalledWith(db as unknown as SQLiteDatabase, {
      local_cipher_uri: 'file:///old.enc',
      upload_id: 'upload-old',
      local_thumb_cipher_uri: 'file:///old-thumb.enc',
      thumb_upload_id: 'thumb-old',
    });
    const old = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT body, media_meta, local_cipher_uri, upload_id, local_thumb_cipher_uri, thumb_upload_id, raw_payload, deleted FROM e2ee_messages WHERE id = ?',
      'old',
    );
    expect(old).toEqual({
      body: '',
      media_meta: null,
      local_cipher_uri: null,
      upload_id: null,
      local_thumb_cipher_uri: null,
      thumb_upload_id: null,
      raw_payload: null,
      deleted: 1,
    });
    const fresh = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT body, expires_at, deleted FROM e2ee_messages WHERE id = ?',
      'fresh',
    );
    expect(fresh).toEqual({
      body: 'encore là',
      expires_at: '2026-01-01T00:10:00.000Z',
      deleted: 0,
    });
  });
});
