import type { SQLiteDatabase } from 'expo-sqlite';

import type { LocalMediaRefs } from './db';

export interface DeleteForAllResult {
  exists: boolean;
  applied: boolean;
  refs: LocalMediaRefs | null;
}

/**
 * Applique une suppression à une cible **déjà locale**, après vérification de
 * l'auteur. Aucune donnée du message n'est conservée : corps, citation,
 * sticker, média et vignette sont retirés dans la même requête.
 */
export async function applyDeleteForAll(
  db: SQLiteDatabase,
  targetId: string,
  authorId: string,
  conversationId: string,
): Promise<DeleteForAllResult> {
  const row = await db.getFirstAsync<{
    sender_id: string;
    deleted: number;
    content_kind: string | null;
    local_cipher_uri: string | null;
    upload_id: string | null;
    local_thumb_cipher_uri: string | null;
    thumb_upload_id: string | null;
  }>(
    `SELECT sender_id, deleted, content_kind, local_cipher_uri, upload_id,
            local_thumb_cipher_uri, thumb_upload_id
       FROM e2ee_messages WHERE id = ? AND conversation_id = ?`,
    targetId,
    conversationId,
  );
  if (!row) return { exists: false, applied: false, refs: null };
  if (row.sender_id !== authorId || row.deleted === 1 || row.content_kind !== null) {
    return { exists: true, applied: false, refs: null };
  }
  const refs: LocalMediaRefs = {
    local_cipher_uri: row.local_cipher_uri,
    upload_id: row.upload_id,
    local_thumb_cipher_uri: row.local_thumb_cipher_uri,
    thumb_upload_id: row.thumb_upload_id,
  };
  const result = await db.runAsync(
    `UPDATE e2ee_messages
        SET body = '', media_meta = NULL, local_cipher_uri = NULL, upload_id = NULL,
            local_thumb_cipher_uri = NULL, thumb_upload_id = NULL, sticker_ref = NULL,
            quote_id = NULL, unreadable_reason = NULL, raw_payload = NULL,
            deleted = 1, deleted_by = ?
      WHERE id = ?`,
    authorId,
    targetId,
  );
  return { exists: true, applied: result.changes > 0, refs };
}

/** Écrit une suppression arrivée avant sa cible. Idempotent par auteur. */
export async function addDeletionTombstone(
  db: SQLiteDatabase,
  input: { targetId: string; authorId: string; eventMessageId: string; createdAt: string },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO e2ee_deletions (target_id, author_id, event_message_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(target_id, author_id) DO NOTHING`,
    input.targetId,
    input.authorId,
    input.eventMessageId,
    input.createdAt,
  );
}

/** Vrai si l'auteur de la cible avait déjà demandé sa suppression. */
export async function hasDeletionTombstone(
  db: SQLiteDatabase,
  targetId: string,
  authorId: string,
  conversationId: string,
): Promise<boolean> {
  const row = await db.getFirstAsync<{ present: number }>(
    `SELECT 1 AS present
       FROM e2ee_deletions d
       JOIN e2ee_messages event ON event.id = d.event_message_id
      WHERE d.target_id = ? AND d.author_id = ? AND event.conversation_id = ?
      LIMIT 1`,
    targetId,
    authorId,
    conversationId,
  );
  return Boolean(row);
}

