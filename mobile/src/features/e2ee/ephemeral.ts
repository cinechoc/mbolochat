import type { SQLiteDatabase } from 'expo-sqlite';

import type { LocalMediaRefs } from './db';
import { cleanupDeletedMedia } from './deletionFiles';

export interface PurgedExpiredMessage {
  id: string;
  refs: LocalMediaRefs;
}

/**
 * Purge locale des messages arrivés à échéance. Le contenu, les références
 * média et le payload brut sont effacés ; la ligne reste comme mention de
 * suppression, ce qui préserve l'ordre des bulles et l'idempotence.
 */
export async function purgeExpiredMessages(
  db: SQLiteDatabase,
  nowIso = new Date().toISOString(),
): Promise<PurgedExpiredMessage[]> {
  const rows = await db.getAllAsync<{
    id: string;
    local_cipher_uri: string | null;
    upload_id: string | null;
    local_thumb_cipher_uri: string | null;
    thumb_upload_id: string | null;
  }>(
    `SELECT id, local_cipher_uri, upload_id, local_thumb_cipher_uri, thumb_upload_id
       FROM e2ee_messages
      WHERE expires_at IS NOT NULL AND expires_at <= ? AND deleted = 0`,
    nowIso,
  );
  if (rows.length === 0) return [];

  const purged: PurgedExpiredMessage[] = [];
  await db.withTransactionAsync(async () => {
    for (const row of rows) {
      const result = await db.runAsync(
        `UPDATE e2ee_messages
            SET body = '', media_meta = NULL, local_cipher_uri = NULL, upload_id = NULL,
                local_thumb_cipher_uri = NULL, thumb_upload_id = NULL, sticker_ref = NULL,
                quote_id = NULL, unreadable_reason = NULL, raw_payload = NULL,
                deleted = 1, deleted_by = NULL
          WHERE id = ? AND deleted = 0`,
        row.id,
      );
      if (result.changes > 0) {
        purged.push({
          id: row.id,
          refs: {
            local_cipher_uri: row.local_cipher_uri,
            upload_id: row.upload_id,
            local_thumb_cipher_uri: row.local_thumb_cipher_uri,
            thumb_upload_id: row.thumb_upload_id,
          },
        });
      }
    }
  });
  for (const item of purged) {
    await cleanupDeletedMedia(db, item.refs).catch(() => undefined);
  }
  return purged;
}
