/**
 * Création d'un sticker personnel depuis la galerie, avec recadrage système
 * carré puis aperçu avant enregistrement. L'image choisie est copiée dans le
 * dossier privé de l'application ; l'original n'est jamais modifié.
 */

import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import { isRejectedMedia, normalizeImageAsset } from '../media/pickMedia';
import {
  addPersonalSticker,
  personalStickerDirectory,
  type PersonalSticker,
} from './stickerLibrary';

export interface PickedStickerImage {
  uri: string;
  mime: string;
  name: string;
  width: number;
  height: number;
  size: number | null;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function extensionOf(value: string | null | undefined): string {
  if (!value) return '';
  const base = value.split(/[?#]/)[0]?.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_NAME = /^(image|img|photo|cropped|sticker)[-_ ]?\d*$/i;

function cleanName(value: string | null | undefined): string {
  const base = value?.split(/[\\/]/).pop() ?? '';
  const withoutExtension = base.replace(/\.[^.]+$/, '').trim();
  const cleaned = withoutExtension.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || UUID_PATTERN.test(cleaned) || GENERIC_NAME.test(cleaned)) {
    return 'Mon sticker';
  }
  return cleaned.slice(0, 48);
}

/** Ouvre la galerie avec le recadrage carré. Retourne null si annulé. */
export async function pickStickerImage(): Promise<PickedStickerImage | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.9,
    exif: false,
  });
  if (result.canceled || !result.assets[0]) return null;

  const normalized = normalizeImageAsset(result.assets[0]);
  if (isRejectedMedia(normalized)) {
    throw new Error(normalized.reason);
  }
  if (normalized.kind !== 'image') {
    throw new Error('Choisis une image pour créer un sticker.');
  }
  return {
    uri: normalized.uri,
    mime: normalized.mime,
    name: cleanName(normalized.name),
    width: normalized.width && normalized.width > 0 ? normalized.width : 512,
    height: normalized.height && normalized.height > 0 ? normalized.height : 512,
    size: normalized.size,
  };
}

/** Copie l'image recadrée dans le dossier privé et l'ajoute à la bibliothèque. */
export async function savePickedSticker(picked: PickedStickerImage): Promise<PersonalSticker> {
  const id = `personal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const extension =
    EXTENSIONS[picked.mime.toLowerCase()] ||
    extensionOf(picked.name) ||
    extensionOf(picked.uri) ||
    'jpg';
  const directory = personalStickerDirectory();
  const destination = new File(directory, `${id}.${extension}`);
  const source = new File(picked.uri);
  try {
    await source.copy(destination);
  } catch {
    try {
      if (destination.exists) destination.delete();
    } catch {
      // Rien de plus à nettoyer.
    }
    throw new Error("Impossible d'enregistrer le sticker sur cet appareil.");
  }

  const sticker: PersonalSticker = {
    id,
    name: picked.name,
    uri: destination.uri,
    mime: picked.mime,
    width: picked.width,
    height: picked.height,
    size: picked.size,
    createdAt: Date.now(),
  };
  await addPersonalSticker(sticker);
  return sticker;
}
