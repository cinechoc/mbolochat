const MAX_MEDIA_HEIGHT = 300;
const MIN_RATIO = 3 / 4;
const MAX_RATIO = 4 / 3;

/** Taille d'une image ou vidéo : 60 % max de l'écran, hauteur 300 max, ratio borné. */
export function mediaDisplaySize(
  attachment: { width?: number; height?: number },
  windowWidth: number,
): { width: number; height: number } {
  const original =
    attachment.width && attachment.height ? attachment.width / attachment.height : MAX_RATIO;
  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, original));
  // 60 % de l'écran, mais 320 px au plus : l'app peut être fenêtrée sur tablette.
  const maxWidth = Math.min(Math.round(windowWidth * 0.6), 320);
  let width = maxWidth;
  let height = width / ratio;
  if (height > MAX_MEDIA_HEIGHT) {
    height = MAX_MEDIA_HEIGHT;
    width = height * ratio;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

export function documentCardWidth(windowWidth: number): number {
  return Math.min(Math.round(windowWidth * 0.7), 320);
}

const MAX_GIF_HEIGHT = 300;
const MAX_GIF_STICKER_HEIGHT = 220;

/**
 * Taille d'un GIF GIPHY : plein cadre comme une photo (60 %), sticker animé
 * plus compact (45 %, style WhatsApp). Le ratio source est conservé.
 */
export function gifDisplaySize(
  attachment: { width?: number; height?: number; sticker?: boolean },
  windowWidth: number,
): { width: number; height: number } {
  const sticker = attachment.sticker === true;
  const ratio =
    attachment.width && attachment.height ? attachment.width / attachment.height : 1;
  const maxHeight = sticker ? MAX_GIF_STICKER_HEIGHT : MAX_GIF_HEIGHT;
  const maxWidth = Math.min(
    Math.round(windowWidth * (sticker ? 0.45 : 0.6)),
    sticker ? 220 : 320,
  );
  let height = Math.min(maxHeight, Math.round(maxWidth / ratio));
  let width = Math.round(height * ratio);
  if (width > maxWidth) {
    width = maxWidth;
    height = Math.round(width / ratio);
  }
  return { width: Math.max(width, 48), height: Math.max(height, 48) };
}

/** m:ss, comme la pastille de durée WeChat. */
export function formatMediaDuration(durationMs: number | undefined): string {
  if (!durationMs || durationMs <= 0) return '';
  const total = Math.round(durationMs / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes <= 0) return '—';
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
}

/** Troncature au milieu, pour les noms de fichiers très longs. */
export function middleTruncate(value: string, max = 52): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export interface DocumentVisual {
  icon: 'document-text' | 'grid' | 'easel' | 'archive' | 'document';
  color: string;
}

export function documentVisual(name: string, mime: string): DocumentVisual {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const type = mime.toLowerCase();
  if (extension === 'pdf' || type.includes('pdf')) {
    return { icon: 'document-text', color: '#E5484D' };
  }
  if (['doc', 'docx'].includes(extension) || type.includes('word') || type.includes('wordprocessing')) {
    return { icon: 'document-text', color: '#2F6FED' };
  }
  if (['xls', 'xlsx'].includes(extension) || type.includes('excel') || type.includes('spreadsheet')) {
    return { icon: 'grid', color: '#1D9E5A' };
  }
  if (
    ['ppt', 'pptx'].includes(extension) ||
    type.includes('powerpoint') ||
    type.includes('presentation')
  ) {
    return { icon: 'easel', color: '#E8792E' };
  }
  if (extension === 'zip' || type.includes('zip')) {
    return { icon: 'archive', color: '#8E8E93' };
  }
  return { icon: 'document', color: '#8E8E93' };
}

export type DocumentPreviewKind = 'image' | 'pdf' | 'text' | 'other';

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'log', 'xml', 'html', 'htm',
  'yaml', 'yml', 'ini', 'conf', 'toml', 'properties', 'env',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'css', 'scss', 'less',
  'py', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs',
  'rb', 'php', 'sh', 'bash', 'zsh', 'sql', 'swift', 'dart', 'lua',
  'pl', 'r', 'gradle', 'srt', 'vtt',
]);

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp']);

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/x-yaml',
  'application/yaml',
  'application/x-sh',
  'application/sql',
  'application/x-httpd-php',
  'application/x-ipynb+json',
]);

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function documentPreviewKind(name: string, mime: string): DocumentPreviewKind {
  const extension = extensionOf(name);
  const type = mime.toLowerCase().split(';')[0].trim();
  if (extension === 'pdf' || type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (
    type.startsWith('text/') ||
    TEXT_MIMES.has(type) ||
    TEXT_EXTENSIONS.has(extension)
  ) {
    return 'text';
  }
  return 'other';
}

export function documentTypeLabel(name: string, mime: string): string {
  const extension = extensionOf(name);
  const type = mime.toLowerCase();
  if (extension === 'pdf' || type.includes('pdf')) return 'PDF';
  if (['doc', 'docx'].includes(extension) || type.includes('word')) return 'Document Word';
  if (['xls', 'xlsx'].includes(extension) || type.includes('excel') || type.includes('spreadsheet')) {
    return 'Feuille Excel';
  }
  if (['ppt', 'pptx'].includes(extension) || type.includes('powerpoint') || type.includes('presentation')) {
    return 'Présentation PowerPoint';
  }
  if (extension === 'zip' || type.includes('zip')) return 'Archive ZIP';
  if (['odt', 'ods', 'odp'].includes(extension) || type.includes('opendocument')) {
    return 'Document OpenDocument';
  }
  if (documentPreviewKind(name, mime) === 'text') return 'Fichier texte';
  if (documentPreviewKind(name, mime) === 'image') return 'Image';
  return 'Fichier';
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'application/x-markdown': 'md',
  'application/json': 'json',
  'text/json': 'json',
  'application/x-json': 'json',
  'text/x-log': 'log',
  'text/log': 'log',
  'application/rtf': 'rtf',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
};

/** Nom sûr pour le cache local et l'extension Manquante déduite du MIME. */
export function documentFileName(name: string, mime: string): string {
  const fallback = `fichier${EXTENSION_BY_MIME[mime] ? `.${EXTENSION_BY_MIME[mime]}` : ''}`;
  const safe = (name || fallback).split(/[\\/]/).pop()?.trim() || fallback;
  if (safe.includes('.')) return safe;
  const extension = EXTENSION_BY_MIME[mime];
  return extension ? `${safe}.${extension}` : safe;
}
