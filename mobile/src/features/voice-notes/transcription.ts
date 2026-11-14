/**
 * Transcription locale des notes vocales.
 *
 * Le texte est produit **sur l'appareil** : en E2EE, l'audio ne quitte jamais
 * le téléphone, et aucune copie ne va au serveur. Le moteur natif (reconnaissance
 * vocale embarquée) sera branché avec le lot natif ; en attendant, aucun moteur
 * n'est enregistré et l'interface masque le bouton « Aa ».
 *
 * Le texte dérivé d'un média chiffré vit uniquement dans SQLCipher (table
 * `e2ee_voice_transcriptions`) — jamais dans un stockage en clair.
 */

/** Entrée du moteur : un fichier audio local déchiffré, jamais une URL distante. */
export type VoiceTranscriberInput = {
  uri: string;
  mimeType: string;
  durationMs: number;
};

export interface VoiceTranscriber {
  /** Transcrit le fichier ; `null` si l'audio est inutilisable ou vide de parole. */
  transcribe(input: VoiceTranscriberInput): Promise<string | null>;
}

let engine: VoiceTranscriber | null = null;

/** Enregistre le moteur natif ; `null` le retire (l'interface masque le bouton). */
export function setVoiceTranscriber(next: VoiceTranscriber | null): void {
  engine = next;
}

export function getVoiceTranscriber(): VoiceTranscriber | null {
  return engine;
}

/** Un moteur est-il enregistré ? Seul cas où le bouton « Aa » s'affiche. */
export function voiceTranscriptionAvailable(): boolean {
  return engine !== null;
}

/** Un transcript tronqué reste lisible ; au-delà, la voix disait trop. */
export const MAX_TRANSCRIPTION_LENGTH = 5_000;

/** Nettoie un transcript brut : `null` si rien d'exploitable. */
export function normalizeTranscription(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  if (text.length <= MAX_TRANSCRIPTION_LENGTH) return text;
  return `${text.slice(0, MAX_TRANSCRIPTION_LENGTH)}…`;
}

/** Sous-ensemble de l'handle SQLCipher utilisé par le cache. */
export interface TranscriptionDb {
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
}

/** Relit la transcription en cache d'un message, ou `null`. */
export async function getStoredTranscription(
  db: TranscriptionDb,
  messageId: string,
): Promise<string | null> {
  const row = await db.getFirstAsync<{ text: string }>(
    'SELECT text FROM e2ee_voice_transcriptions WHERE message_id = ?',
    messageId,
  );
  return row?.text ?? null;
}

/** Écrit (ou remplace) la transcription en cache. */
export async function storeTranscription(
  db: TranscriptionDb,
  messageId: string,
  text: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO e2ee_voice_transcriptions (message_id, text, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`,
    messageId,
    text,
    now,
  );
}

/**
 * Orchestration du bouton « Aa » : le cache d'abord — même sans moteur
 * enregistré, un transcript déjà produit reste lisible — puis le moteur, et la
 * sauvegarde seulement si un texte existe. Sans moteur ni cache, renvoie `null` ;
 * l'appelant affiche alors l'état indisponible.
 */
export async function transcribeVoiceMessage(
  db: TranscriptionDb | null,
  messageId: string,
  input: VoiceTranscriberInput,
): Promise<string | null> {
  if (db) {
    const cached = await getStoredTranscription(db, messageId);
    if (cached !== null) return cached;
  }
  const transcriber = getVoiceTranscriber();
  if (!transcriber) return null;
  const text = normalizeTranscription(await transcriber.transcribe(input));
  if (text && db) await storeTranscription(db, messageId, text);
  return text;
}
