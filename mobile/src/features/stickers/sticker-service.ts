/**
 * Cycle de vie local d'un sticker : résolution d'une ressource bundlée en URI
 * uploadable, et création d'un sticker personnel depuis la photothèque.
 *
 * Aucun service tiers n'intervient : l'image choisie est recadrée par le
 * sélecteur système, copiée dans le dossier privé de l'application, puis
 * envoyée comme n'importe quelle image par la file d'attente existante.
 */

import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import { isRejectedMedia, normalizeImageAsset } from '@/features/media/pickMedia';
import type { Sticker } from './sticker-catalog';
import {
  addPersonalSticker,
  personalStickerDirectory,
  type PersonalSticker,
} from './sticker-store';

const resolvedAssets = new Map<string, string>();

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

function extensionFor(mime: string, uri: string, fileName?: string | null): string {
  return (
    EXTENSIONS[mime.toLowerCase()] ||
    extensionOf(fileName) ||
    extensionOf(uri) ||
    'png'
  );
}

function cleanStickerName(value: string | null | undefined): string {
  const base = value?.split(/[\\/]/).pop() ?? '';
  const withoutExtension = base.replace(/\.[^.]+$/, '').trim();
  const cleaned = withoutExtension.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'Mon sticker').slice(0, 48);
}

/**
 * `require()` ne donne pas de chemin de fichier : Expo Asset télécharge (ou
 * localise) la ressource et fournit l'URI locale que l'API d'upload attend.
 */
export async function resolveStickerUri(sticker: Sticker): Promise<string> {
  if (typeof sticker.source === 'object') {
    return sticker.source.uri;
  }
  const cached = resolvedAssets.get(sticker.id);
  if (cached) return cached;
  const asset = Asset.fromModule(sticker.source);
  if (!asset.localUri) {
    await asset.downloadAsync();
  }
  const uri = asset.localUri ?? asset.uri;
  if (!uri) {
    throw new Error("Impossible de charger l'image du sticker.");
  }
  resolvedAssets.set(sticker.id, uri);
  return uri;
}

export type CreateStickerResult =
  | { status: 'cancelled' }
  | { status: 'rejected'; reason: string }
  | { status: 'created'; sticker: PersonalSticker };

/**
 * Ouvre la photothèque avec le recadrage système carré. L'utilisateur voit
 * exactement l'image qui sera envoyée ; l'original n'est jamais modifié.
 * Aucune permission préalable : le sélecteur système agit hors du processus et
 * reste utilisable même si l'accès complet à la photothèque a été refusé.
 */
export async function createPersonalSticker(): Promise<CreateStickerResult> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.9,
    exif: false,
  });
  if (result.canceled || !result.assets[0]) {
    return { status: 'cancelled' };
  }

  const normalized = normalizeImageAsset(result.assets[0]);
  if (isRejectedMedia(normalized)) {
    return { status: 'rejected', reason: normalized.reason };
  }
  if (normalized.kind !== 'image') {
    return { status: 'rejected', reason: 'Choisis une image pour créer un sticker.' };
  }

  const id = `personal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = extensionFor(normalized.mime, normalized.uri, normalized.name);
  const directory = personalStickerDirectory();
  const destination = new File(directory, `${id}.${ext}`);
  const source = new File(normalized.uri);
  try {
    await source.copy(destination);
  } catch {
    // Un fichier partiel ne doit pas rester dans le dossier.
    try {
      if (destination.exists) destination.delete();
    } catch {
      // Rien de plus à nettoyer.
    }
    throw new Error("Impossible d'enregistrer le sticker sur cet appareil.");
  }

  const sticker: PersonalSticker = {
    id,
    name: cleanStickerName(normalized.name),
    packId: 'mes-stickers',
    uri: destination.uri,
    mime: normalized.mime,
    width: normalized.width && normalized.width > 0 ? normalized.width : 512,
    height: normalized.height && normalized.height > 0 ? normalized.height : 512,
    createdAt: Date.now(),
  };
  await addPersonalSticker(sticker);
  return { status: 'created', sticker };
}
