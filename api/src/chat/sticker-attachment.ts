/**
 * Métadonnées d'un sticker envoyé par l'application.
 *
 * Le fichier image suit le chemin d'import normal (`POST /uploads`) : le serveur
 * vérifie qu'il appartient bien à l'expéditeur, puis remplace son type IMAGE par
 * STICKER. Le client ne fournit ici que des identifiants opaques et un libellé.
 * Aucun champ de ce payload ne devient une URL ou un chemin de fichier.
 */

export interface StickerAttachmentMeta {
  /** Identifiant stable du sticker (catalogue local ou sticker personnel). */
  id: string;
  /** Pack d'origine, pour regrouper et retrouver le sticker. */
  packId: string;
  /** Nom lisible, facultatif. */
  name?: string;
}

export class InvalidStickerAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStickerAttachmentError';
  }
}

/** Identifiant opaque, assez large pour les UUID, sans séparateurs de chemin. */
const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_ID_LENGTH = 80;
const MAX_NAME_LENGTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    !ID_PATTERN.test(value)
  ) {
    throw new InvalidStickerAttachmentError(`${label} invalide`);
  }
  return value;
}

/** Nom accessible : texte court, sans caractères de contrôle. */
function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) {
      cleaned += char;
    }
  }
  const normalized = cleaned.trim().slice(0, MAX_NAME_LENGTH);
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeStickerAttachment(input: unknown): StickerAttachmentMeta {
  if (!isPlainObject(input)) {
    throw new InvalidStickerAttachmentError('Sticker invalide');
  }
  const packId = identifier(input.packId, "Identifiant du pack");
  const id = identifier(input.id, 'Identifiant du sticker');
  const name = cleanName(input.name);
  return { id, packId, ...(name !== undefined ? { name } : {}) };
}
