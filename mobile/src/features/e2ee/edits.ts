import type { SQLiteDatabase } from 'expo-sqlite';

import {
  EDIT_WINDOW_MS,
  MAX_EDIT_REVISION,
  MAX_EDIT_TEXT_LENGTH,
} from './payload';

export interface EditApplyInput {
  targetId: string;
  authorId: string;
  conversationId: string;
  revision: number;
  text: string;
  eventCreatedAt: string;
}

export interface EditApplyResult {
  exists: boolean;
  applied: boolean;
}

interface EditableRow {
  sender_id: string;
  created_at: string;
  deleted: number;
  content_kind: string | null;
  media_meta: string | null;
  sticker_ref: string | null;
  edit_revision: number | null;
}

/**
 * Vérifie toutes les règles côté récepteur. Aucun champ du payload n'accorde de
 * droit : seul `sender_id`, écrit depuis l'identité Olm de l'enveloppe, fait foi.
 */
export function canApplyEdit(
  row: EditableRow,
  authorId: string,
  revision: number,
  text: string,
  eventCreatedAt: string,
): boolean {
  if (row.sender_id !== authorId || row.deleted === 1) return false;
  if (row.content_kind !== null) return false;
  if (row.media_meta !== null || row.sticker_ref !== null) return false;
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > MAX_EDIT_REVISION) {
    return false;
  }
  if (revision <= (row.edit_revision ?? 0)) return false;
  if (text.length < 1 || text.length > MAX_EDIT_TEXT_LENGTH) return false;
  const createdAt = Date.parse(row.created_at);
  const eventAt = Date.parse(eventCreatedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(eventAt)) return false;
  const elapsed = eventAt - createdAt;
  return elapsed >= 0 && elapsed <= EDIT_WINDOW_MS;
}

async function loadEditableRow(
  db: SQLiteDatabase,
  targetId: string,
  conversationId: string,
): Promise<EditableRow | null> {
  return db.getFirstAsync<EditableRow>(
    `SELECT sender_id, created_at, deleted, content_kind, media_meta, sticker_ref, edit_revision
       FROM e2ee_messages WHERE id = ? AND conversation_id = ?`,
    targetId,
    conversationId,
  );
}

/** Numéro à utiliser par l'auteur, ou null si la cible n'est plus modifiable. */
export async function nextEditRevision(
  db: SQLiteDatabase,
  input: Omit<EditApplyInput, 'revision'>,
): Promise<number | null> {
  const row = await loadEditableRow(db, input.targetId, input.conversationId);
  if (!row) return null;
  const revision = (row.edit_revision ?? 0) + 1;
  return canApplyEdit(row, input.authorId, revision, input.text, input.eventCreatedAt)
    ? revision
    : null;
}

/**
 * Applique une modification déjà validée par le payload. L'ancien texte est
 * remplacé dans la même requête : il n'existe aucune colonne d'historique.
 * Une cible absente (événement arrivé avant le message) ou supprimée est
 * ignorée silencieusement ; la ligne de contrôle reste, elle, pour l'idempotence.
 */
export async function applyEditWith(
  db: SQLiteDatabase,
  input: EditApplyInput,
): Promise<EditApplyResult> {
  const row = await loadEditableRow(db, input.targetId, input.conversationId);
  if (!row) return { exists: false, applied: false };
  if (!canApplyEdit(row, input.authorId, input.revision, input.text, input.eventCreatedAt)) {
    return { exists: true, applied: false };
  }
  const result = await db.runAsync(
    `UPDATE e2ee_messages
        SET body = ?, edited_at = ?, edit_revision = ?
      WHERE id = ? AND conversation_id = ? AND deleted = 0`,
    input.text,
    input.eventCreatedAt,
    input.revision,
    input.targetId,
    input.conversationId,
  );
  return { exists: true, applied: result.changes > 0 };
}
