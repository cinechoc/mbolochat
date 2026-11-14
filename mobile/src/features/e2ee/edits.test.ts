import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { describe, expect, it, vi } from 'vitest';

import { saveLocalMessage, type StoredE2eeMessage } from './db';
import { applyEditWith, canApplyEdit, nextEditRevision } from './edits';
import {
  InvalidPayloadError,
  MAX_EDIT_TEXT_LENGTH,
  buildEditV7,
  encodeText,
  parsePayload,
} from './payload';
import { migrateE2eeSchema, type E2eeSchemaDb } from './schema';

vi.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn(),
}));

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
      return { changes: Number(result.changes) };
    },
  };
}

async function fixture() {
  const raw = new DatabaseSync(':memory:');
  const db = adapter(raw);
  await migrateE2eeSchema(db);
  return { raw, db, sqlite: db as unknown as SQLiteDatabase };
}

const target: StoredE2eeMessage = {
  id: 'message-1',
  conversation_id: 'conv-1',
  sender_id: 'peer',
  sender_name: 'Pair',
  body: 'ancien texte',
  created_at: '2026-01-01T00:00:00.000Z',
  client_id: null,
  mine: 0,
  media_meta: null,
  quote_id: null,
  sticker_ref: null,
};

const edit = (revision: number, text: string, eventCreatedAt = '2026-01-01T00:01:00.000Z') => ({
  targetId: 'message-1',
  authorId: 'peer',
  conversationId: 'conv-1',
  revision,
  text,
  eventCreatedAt,
});

describe('payload de modification v7', () => {
  it('fait un aller-retour strict', () => {
    expect(parsePayload(buildEditV7('message-1', 3, 'texte corrigé'))).toEqual({
      kind: 'edit',
      targetId: 'message-1',
      revision: 3,
      text: 'texte corrigé',
    });
  });

  it('rejette les révisions, tailles et champs hors contrat', () => {
    expect(() => buildEditV7('message-1', 0, 'x')).toThrow(InvalidPayloadError);
    expect(() => buildEditV7('message-1', 6, 'x')).toThrow(InvalidPayloadError);
    expect(() => buildEditV7('message-1', 1, '')).toThrow(InvalidPayloadError);
    expect(() => buildEditV7('message-1', 1, 'x'.repeat(MAX_EDIT_TEXT_LENGTH + 1))).toThrow(
      InvalidPayloadError,
    );
    expect(() => parsePayload(encodeText(JSON.stringify({
      v: 7,
      kind: 'edit',
      targetId: 'message-1',
      revision: 1,
      text: 'ok',
      extra: 'refusé',
    })))).toThrow(InvalidPayloadError);
    expect(() => parsePayload(encodeText(JSON.stringify({
      v: 7,
      kind: 'edit',
      targetId: 'message-1',
      revision: 1.5,
      text: 'ok',
    })))).toThrow(InvalidPayloadError);
  });
});

describe('application des modifications', () => {
  it('remplace le texte, ignore les révisions anciennes et ne garde aucun historique', async () => {
    const { sqlite, raw } = await fixture();
    await saveLocalMessage(sqlite, target);

    expect(await applyEditWith(sqlite, edit(1, 'première'))).toEqual({
      exists: true,
      applied: true,
    });
    expect(await applyEditWith(sqlite, edit(1, 'doublon'))).toEqual({
      exists: true,
      applied: false,
    });
    expect(await applyEditWith(sqlite, edit(2, 'deuxième'))).toEqual({
      exists: true,
      applied: true,
    });
    expect(await applyEditWith(sqlite, edit(1, 'ordre inversé'))).toEqual({
      exists: true,
      applied: false,
    });

    const row = raw.prepare(
      'SELECT body, edited_at, edit_revision FROM e2ee_messages WHERE id = ?',
    ).get('message-1') as Record<string, unknown>;
    expect(row).toEqual({
      body: 'deuxième',
      edited_at: '2026-01-01T00:01:00.000Z',
      edit_revision: 2,
    });
  });

  it('refuse un autre auteur, un média, un message supprimé et une cible inconnue', async () => {
    const { sqlite } = await fixture();
    await saveLocalMessage(sqlite, target);
    expect(await applyEditWith(sqlite, { ...edit(1, 'x'), authorId: 'autre' })).toEqual({
      exists: true,
      applied: false,
    });
    expect(await applyEditWith(sqlite, edit(1, 'x', '2025-12-31T23:59:59.000Z'))).toEqual({
      exists: true,
      applied: false,
    });
    expect(await applyEditWith(sqlite, edit(1, 'x', '2026-01-01T00:16:00.000Z'))).toEqual({
      exists: true,
      applied: false,
    });
    expect(await applyEditWith(sqlite, { ...edit(1, 'x'), targetId: 'inconnue' })).toEqual({
      exists: false,
      applied: false,
    });

    await sqlite.runAsync(
      "UPDATE e2ee_messages SET media_meta = '{}' WHERE id = 'message-1'",
    );
    expect(await applyEditWith(sqlite, edit(1, 'x'))).toEqual({ exists: true, applied: false });
    await sqlite.runAsync(
      "UPDATE e2ee_messages SET media_meta = NULL, deleted = 1 WHERE id = 'message-1'",
    );
    expect(await applyEditWith(sqlite, edit(1, 'x'))).toEqual({ exists: true, applied: false });
  });

  it('borne la révision à cinq et calcule la suivante', async () => {
    const { sqlite, raw } = await fixture();
    await saveLocalMessage(sqlite, target);
    expect(await nextEditRevision(sqlite, edit(1, 'x'))).toBe(1);
    raw.prepare(
      "UPDATE e2ee_messages SET edit_revision = 5 WHERE id = 'message-1'",
    ).run();
    expect(await nextEditRevision(sqlite, edit(1, 'x', '2026-01-01T00:02:00.000Z'))).toBeNull();
    expect(
      canApplyEdit(
        {
          sender_id: 'peer',
          created_at: target.created_at,
          deleted: 0,
          content_kind: null,
          media_meta: null,
          sticker_ref: null,
          edit_revision: 5,
        },
        'peer',
        6,
        'x',
        '2026-01-01T00:01:00.000Z',
      ),
    ).toBe(false);
  });
});
