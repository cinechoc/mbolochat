import { extname } from 'node:path';
import type { MessageAttachmentType } from '../db/schema.js';

/**
 * Ce que l'application sait importer et relire.
 *
 * Une seule table pour l'import et la diffusion : un fichier accepté à l'entrée
 * doit nécessairement avoir un nom de contenu à la sortie, sinon il serait
 * stocké sans jamais pouvoir être rejoué.
 */
export interface MediaKind {
  /** Extension canonique, celle qui est écrite sur le disque. */
  extension: string;
  mime: string;
  type: MessageAttachmentType;
  /**
   * Ce qui accompagne le fichier : dimensions, durée, les deux (vidéo), ou rien
   * (document).
   */
  measures: 'image' | 'duration' | 'video' | 'none';
}

const KINDS: MediaKind[] = [
  { extension: '.jpg', mime: 'image/jpeg', type: 'IMAGE', measures: 'image' },
  { extension: '.png', mime: 'image/png', type: 'IMAGE', measures: 'image' },
  { extension: '.webp', mime: 'image/webp', type: 'IMAGE', measures: 'image' },
  { extension: '.gif', mime: 'image/gif', type: 'IMAGE', measures: 'image' },
  { extension: '.heic', mime: 'image/heic', type: 'IMAGE', measures: 'image' },
  { extension: '.heif', mime: 'image/heif', type: 'IMAGE', measures: 'image' },
  { extension: '.mp4', mime: 'video/mp4', type: 'VIDEO', measures: 'video' },
  { extension: '.mov', mime: 'video/quicktime', type: 'VIDEO', measures: 'video' },
  { extension: '.m4v', mime: 'video/x-m4v', type: 'VIDEO', measures: 'video' },
  { extension: '.m4a', mime: 'audio/mp4', type: 'AUDIO', measures: 'duration' },
  { extension: '.aac', mime: 'audio/aac', type: 'AUDIO', measures: 'duration' },
  { extension: '.mp3', mime: 'audio/mpeg', type: 'AUDIO', measures: 'duration' },
  { extension: '.ogg', mime: 'audio/ogg', type: 'AUDIO', measures: 'duration' },
  { extension: '.opus', mime: 'audio/opus', type: 'AUDIO', measures: 'duration' },
  // .webm reste audio : une extension ne peut pas désigner deux formats servis.
  { extension: '.webm', mime: 'audio/webm', type: 'AUDIO', measures: 'duration' },
  { extension: '.wav', mime: 'audio/wav', type: 'AUDIO', measures: 'duration' },
  { extension: '.pdf', mime: 'application/pdf', type: 'FILE', measures: 'none' },
  { extension: '.doc', mime: 'application/msword', type: 'FILE', measures: 'none' },
  {
    extension: '.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    type: 'FILE',
    measures: 'none',
  },
  { extension: '.xls', mime: 'application/vnd.ms-excel', type: 'FILE', measures: 'none' },
  {
    extension: '.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    type: 'FILE',
    measures: 'none',
  },
  { extension: '.ppt', mime: 'application/vnd.ms-powerpoint', type: 'FILE', measures: 'none' },
  {
    extension: '.pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    type: 'FILE',
    measures: 'none',
  },
  { extension: '.zip', mime: 'application/zip', type: 'FILE', measures: 'none' },
  { extension: '.txt', mime: 'text/plain', type: 'FILE', measures: 'none' },
  { extension: '.csv', mime: 'text/csv', type: 'FILE', measures: 'none' },
  { extension: '.md', mime: 'text/markdown', type: 'FILE', measures: 'none' },
  { extension: '.json', mime: 'application/json', type: 'FILE', measures: 'none' },
  // MIME propre à .log : text/plain est déjà pris par .txt dans cette table.
  { extension: '.log', mime: 'text/x-log', type: 'FILE', measures: 'none' },
  { extension: '.rtf', mime: 'application/rtf', type: 'FILE', measures: 'none' },
  { extension: '.odt', mime: 'application/vnd.oasis.opendocument.text', type: 'FILE', measures: 'none' },
  {
    extension: '.ods',
    mime: 'application/vnd.oasis.opendocument.spreadsheet',
    type: 'FILE',
    measures: 'none',
  },
  {
    extension: '.odp',
    mime: 'application/vnd.oasis.opendocument.presentation',
    type: 'FILE',
    measures: 'none',
  },
];

const BY_EXTENSION = new Map(KINDS.map((kind) => [kind.extension, kind]));
const BY_MIME = new Map(KINDS.map((kind) => [kind.mime, kind]));

/** Les noms que les appareils et les navigateurs renvoient pour ces mêmes formats. */
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': '.jpg',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/mp4a-latm': '.m4a',
  'audio/aacp': '.aac',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-pn-realaudio': '.wav',
  'audio/x-mpeg-3': '.mp3',
  'audio/x-caf': '.m4a',
  'video/mov': '.mov',
  'video/x-quicktime': '.mov',
  'video/m4v': '.m4v',
  'application/x-zip-compressed': '.zip',
  'application/x-pdf': '.pdf',
  'text/x-csv': '.csv',
  'text/x-markdown': '.md',
  'application/x-markdown': '.md',
  'text/json': '.json',
  'application/x-json': '.json',
  'text/log': '.log',
  'application/rtf': '.rtf',
};

export function kindForExtension(extension: string): MediaKind | undefined {
  return BY_EXTENSION.get(extension.toLowerCase());
}

/**
 * À quel format appartient ce fichier ? Le nom et les types déclarés doivent
 * tomber d'accord : c'est le seul contrôle qui tienne quand l'expéditeur écrit
 * ce qu'il veut dans l'en-tête de sa requête. Un désaccord est un refus, même
 * si l'un des deux indices paraît sincère.
 *
 * Plusieurs types peuvent être annoncés (la partie multipart, puis le champ
 * explicite du formulaire). Un seul concordant suffit : certains clients
 * déduisent un type erroné du nom de fichier — expo-file-system annonce par
 * exemple `audio/mpeg` pour un `.m4a`. Si aucun ne concorde, on refuse.
 */
export function detectKind(
  originalName: string | undefined,
  declaredMimes: Array<string | undefined>,
): MediaKind | null {
  const fromExtension = BY_EXTENSION.get(extname(originalName ?? '').toLowerCase());
  const resolved: MediaKind[] = [];
  for (const declared of declaredMimes) {
    const mime = (declared ?? '').split(';')[0].trim().toLowerCase();
    const kind = BY_MIME.get(mime) ?? BY_EXTENSION.get(MIME_ALIASES[mime] ?? '');
    if (kind) {
      resolved.push(kind);
    }
  }
  if (fromExtension) {
    return resolved.find((kind) => kind.extension === fromExtension.extension) ?? null;
  }
  return resolved[0] ?? null;
}
