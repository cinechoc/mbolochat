import type { SQLiteDatabase } from 'expo-sqlite';

import type { LocalMediaRefs } from './db';
import { durableMediaIdFromUri, removeDurableMediaIfUnreferenced } from './mediaStore';

/**
 * Supprime les ciphertexts durable devenus non référencés après une tombstone.
 * Un fichier encore utilisé par l'outbox ou un autre message est conservé.
 */
export async function cleanupDeletedMedia(
  db: SQLiteDatabase,
  refs: LocalMediaRefs | null | undefined,
): Promise<void> {
  if (!refs) return;
  const ids = new Set<string>();
  for (const uri of [refs.local_cipher_uri, refs.local_thumb_cipher_uri]) {
    if (!uri) continue;
    const parsed = durableMediaIdFromUri(uri);
    if (parsed) ids.add(parsed.id);
  }
  for (const id of ids) {
    await removeDurableMediaIfUnreferenced(db, id).catch(() => false);
  }
}
