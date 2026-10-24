import * as DocumentPicker from 'expo-document-picker';
import { File as FsFile } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import {
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_MEDIA_SELECTION,
  MAX_VIDEO_BYTES,
  tooLargeReason,
} from './mediaLimits';

export type PickedMediaKind = 'image' | 'video' | 'file';

export interface PickedAttachment {
  uri: string;
  kind: PickedMediaKind;
  mime: string;
  name: string;
  size: number | null;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface RejectedMedia {
  name: string;
  reason: string;
}

export interface PickedMediaResult {
  files: PickedAttachment[];
  rejected: RejectedMedia[];
}

const IMAGE_MIMES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
};

const VIDEO_MIMES: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
};

const DOCUMENT_MIMES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  log: 'text/x-log',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
};

/** Le nom prime : ces trois formats sont souvent annoncés « text/plain ». */
const CANONICAL_TEXT_EXTENSIONS = new Set(['md', 'json', 'log']);

function extensionOf(value: string | null | undefined): string {
  if (!value) return '';
  const clean = value.split(/[?#]/)[0] ?? '';
  const base = clean.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function cleanName(value: string | null | undefined): string {
  if (!value) return '';
  return (value.split(/[\\/]/).pop() ?? '').trim();
}

function localFileInfo(uri: string): { name: string; size: number | null; mime: string } {
  try {
    const file = new FsFile(uri);
    return {
      name: cleanName(file.name),
      size: file.size > 0 ? file.size : null,
      mime: file.type || '',
    };
  } catch {
    return { name: '', size: null, mime: '' };
  }
}

function imageKind(asset: ImagePicker.ImagePickerAsset, ext: string): 'image' | 'video' {
  if (asset.type === 'video' || asset.type === 'pairedVideo') return 'video';
  if (asset.mimeType?.startsWith('video/')) return 'video';
  if (ext in VIDEO_MIMES) return 'video';
  return 'image';
}

export function normalizeImageAsset(
  asset: ImagePicker.ImagePickerAsset,
): PickedAttachment | RejectedMedia {
  const info = localFileInfo(asset.uri);
  const ext = extensionOf(asset.fileName) || extensionOf(info.name) || extensionOf(asset.uri);
  const kind = imageKind(asset, ext);
  const fallbackMime = kind === 'video' ? VIDEO_MIMES[ext] ?? 'video/mp4' : IMAGE_MIMES[ext] ?? 'image/jpeg';
  const mime = (asset.mimeType && !asset.mimeType.includes('octet-stream') ? asset.mimeType : '') || fallbackMime;
  const name =
    cleanName(asset.fileName) ||
    info.name ||
    (kind === 'video' ? `video${ext ? `.${ext}` : '.mp4'}` : `photo${ext ? `.${ext}` : '.jpg'}`);
  const size = asset.fileSize ?? info.size;
  const limit = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (size !== null && size > limit) {
    return { name, reason: tooLargeReason(kind) };
  }
  return {
    uri: asset.uri,
    kind,
    mime,
    name,
    size,
    width: asset.width > 0 ? Math.round(asset.width) : undefined,
    height: asset.height > 0 ? Math.round(asset.height) : undefined,
    durationMs: kind === 'video' && asset.duration && asset.duration > 0 ? Math.round(asset.duration) : undefined,
  };
}

function normalizeDocumentAsset(asset: DocumentPicker.DocumentPickerAsset): PickedAttachment | RejectedMedia {
  const info = localFileInfo(asset.uri);
  const name = cleanName(asset.name) || info.name || 'fichier';
  const ext = extensionOf(name) || extensionOf(asset.uri);
  const pickedMime = asset.mimeType && !asset.mimeType.includes('octet-stream') ? asset.mimeType : '';
  const canonical = DOCUMENT_MIMES[ext];
  const mime =
    canonical && CANONICAL_TEXT_EXTENSIONS.has(ext)
      ? canonical
      : pickedMime || canonical || info.mime || 'application/octet-stream';
  const size = asset.size ?? info.size;
  if (size !== null && size > MAX_DOCUMENT_BYTES) {
    return { name, reason: tooLargeReason('file') };
  }
  return { uri: asset.uri, kind: 'file', mime, name, size };
}

function collect(results: (PickedAttachment | RejectedMedia)[]): PickedMediaResult {
  const files: PickedAttachment[] = [];
  const rejected: RejectedMedia[] = [];
  for (const result of results) {
    if ('reason' in result) rejected.push(result);
    else files.push(result);
  }
  return { files, rejected };
}

export function isRejectedMedia(value: PickedAttachment | RejectedMedia): value is RejectedMedia {
  return 'reason' in value;
}

export async function pickLibraryMedia(): Promise<PickedMediaResult | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    selectionLimit: MAX_MEDIA_SELECTION,
    // iOS 15+ numérote la sélection ; le sélecteur Android dépend de sa version.
    orderedSelection: true,
    quality: 1,
  });
  if (result.canceled || result.assets.length === 0) {
    return null;
  }
  const assets = result.assets.slice(0, MAX_MEDIA_SELECTION);
  const extra = result.assets.length - assets.length;
  const collected = collect(assets.map(normalizeImageAsset));
  if (extra > 0) {
    collected.rejected.push({
      name: `${extra} fichier${extra > 1 ? 's' : ''}`,
      reason: `Maximum ${MAX_MEDIA_SELECTION} fichiers par sélection`,
    });
  }
  return collected;
}

export async function pickDocuments(): Promise<PickedMediaResult | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled || result.assets.length === 0) {
    return null;
  }
  const assets = result.assets.slice(0, MAX_MEDIA_SELECTION);
  const extra = result.assets.length - assets.length;
  const collected = collect(assets.map(normalizeDocumentAsset));
  if (extra > 0) {
    collected.rejected.push({
      name: `${extra} fichier${extra > 1 ? 's' : ''}`,
      reason: `Maximum ${MAX_MEDIA_SELECTION} fichiers par sélection`,
    });
  }
  return collected;
}
