/** Limites alignées sur le backend (uploads.service.ts). */
export const MAX_MEDIA_SELECTION = 9;

const MB = 1024 * 1024;

export const MAX_IMAGE_BYTES = 25 * MB;
export const MAX_VIDEO_BYTES = 50 * MB;
export const MAX_DOCUMENT_BYTES = 25 * MB;

export const MEDIA_LIMITS = {
  image: MAX_IMAGE_BYTES,
  video: MAX_VIDEO_BYTES,
  file: MAX_DOCUMENT_BYTES,
} as const;

export type MediaLimitKind = keyof typeof MEDIA_LIMITS;

export function maxBytesFor(kind: MediaLimitKind): number {
  return MEDIA_LIMITS[kind];
}

export function maxLabelFor(kind: MediaLimitKind): string {
  return `${Math.round(MEDIA_LIMITS[kind] / MB)} Mo`;
}

export function tooLargeReason(kind: MediaLimitKind): string {
  const label = kind === 'image' ? 'Photo' : kind === 'video' ? 'Vidéo' : 'Fichier';
  return `${label} trop ${kind === 'file' ? 'lourd' : 'lourde'} (max ${maxLabelFor(kind)})`;
}
