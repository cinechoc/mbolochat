/**
 * Bibliothèque locale de stickers : récents, favoris et créations personnelles.
 *
 * La clé de stockage est celle de l'ancien sélecteur Mbolo (`mbolo.stickers.v1`)
 * pour retrouver les créations et favoris déjà présents sur l'appareil. Les
 * images personnelles vivent dans le dossier privé `stickers` et survivent aux
 * redémarrages ainsi qu'au nettoyage du cache.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';

export const STICKER_LIBRARY_KEY = 'mbolo.stickers.v1';
export const PERSONAL_STICKER_DIRECTORY = 'stickers';
export const PERSONAL_PACK_ID = 'mes-stickers';

const RECENTS_CAP = 24;
const FAVORITES_CAP = 200;
const MAX_PERSONAL = 120;

export interface PersonalSticker {
  id: string;
  name: string;
  uri: string;
  mime: string;
  width: number;
  height: number;
  size?: number | null;
  createdAt: number;
}

export interface StickerLibraryState {
  /** Références de catalogue (`mbolo-panther-2d/amour`) ou identifiants personnels. */
  recents: string[];
  favorites: string[];
  personal: PersonalSticker[];
}

const EMPTY: StickerLibraryState = { recents: [], favorites: [], personal: [] };

let cached: StickerLibraryState | null = null;
let opening: Promise<StickerLibraryState> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function clone(state: StickerLibraryState): StickerLibraryState {
  return {
    recents: [...state.recents],
    favorites: [...state.favorites],
    personal: state.personal.map((sticker) => ({ ...sticker })),
  };
}

function stringList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue;
    seen.add(item);
    list.push(item);
    if (list.length >= cap) break;
  }
  return list;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_NAME = /^(image|img|photo|cropped|sticker)[-_ ]?\d*$/i;

function cleanStoredName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || UUID_PATTERN.test(cleaned) || GENERIC_NAME.test(cleaned)) {
    return 'Mon sticker';
  }
  return cleaned.slice(0, 48);
}

function personalSticker(value: unknown): PersonalSticker | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    typeof row.name !== 'string' ||
    typeof row.uri !== 'string' ||
    !row.uri.startsWith('file:') ||
    typeof row.mime !== 'string' ||
    !row.mime.startsWith('image/') ||
    typeof row.width !== 'number' ||
    typeof row.height !== 'number' ||
    typeof row.createdAt !== 'number'
  ) {
    return null;
  }
  return {
    id: row.id,
    name: cleanStoredName(row.name),
    uri: row.uri,
    mime: row.mime,
    width: Math.max(1, Math.round(row.width)),
    height: Math.max(1, Math.round(row.height)),
    size: typeof row.size === 'number' && row.size > 0 ? row.size : null,
    createdAt: row.createdAt,
  };
}

function fileStillExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return true;
  }
}

function sanitize(raw: unknown): StickerLibraryState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return clone(EMPTY);
  const row = raw as Record<string, unknown>;
  const personal = Array.isArray(row.personal)
    ? row.personal
        .map(personalSticker)
        .filter((sticker): sticker is PersonalSticker => sticker !== null)
        .filter((sticker) => fileStillExists(sticker.uri))
        .slice(0, MAX_PERSONAL)
    : [];
  return {
    recents: stringList(row.recents, RECENTS_CAP),
    favorites: stringList(row.favorites, FAVORITES_CAP),
    personal,
  };
}

async function persist(state: StickerLibraryState): Promise<void> {
  await AsyncStorage.setItem(STICKER_LIBRARY_KEY, JSON.stringify(state));
  cached = state;
  notify();
}

export function loadStickerLibrary(): Promise<StickerLibraryState> {
  if (cached) return Promise.resolve(cached);
  if (!opening) {
    opening = AsyncStorage.getItem(STICKER_LIBRARY_KEY)
      .then((value) => {
        if (!value) return clone(EMPTY);
        try {
          return sanitize(JSON.parse(value));
        } catch {
          return clone(EMPTY);
        }
      })
      .catch((error) => {
        opening = null;
        throw error;
      })
      .then((state) => {
        cached = state;
        notify();
        return state;
      });
  }
  return opening;
}

export function getStickerLibrary(): StickerLibraryState {
  return cached ?? EMPTY;
}

export function subscribeStickerLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function withRecent(state: StickerLibraryState, key: string): string[] {
  return [key, ...state.recents.filter((item) => item !== key)].slice(0, RECENTS_CAP);
}

export async function addRecentSticker(key: string): Promise<void> {
  const state = cached ?? (await loadStickerLibrary());
  if (state.recents[0] === key) return;
  await persist({ ...state, recents: withRecent(state, key) });
}

/** true si le sticker vient d'entrer dans les favoris, false s'il en sort. */
export async function toggleStickerFavorite(key: string): Promise<boolean> {
  const state = cached ?? (await loadStickerLibrary());
  const exists = state.favorites.includes(key);
  const favorites = exists
    ? state.favorites.filter((item) => item !== key)
    : [...state.favorites, key].slice(0, FAVORITES_CAP);
  await persist({ ...state, favorites });
  return !exists;
}

export async function addPersonalSticker(sticker: PersonalSticker): Promise<void> {
  const state = cached ?? (await loadStickerLibrary());
  const personal = [sticker, ...state.personal.filter((item) => item.id !== sticker.id)].slice(
    0,
    MAX_PERSONAL,
  );
  await persist({
    ...state,
    personal,
    recents: withRecent(state, sticker.id),
  });
}

/** Enregistre un sticker reçu puis l'ajoute directement aux favoris. */
export async function addPersonalFavorite(sticker: PersonalSticker): Promise<void> {
  const state = cached ?? (await loadStickerLibrary());
  const personal = [sticker, ...state.personal.filter((item) => item.id !== sticker.id)].slice(
    0,
    MAX_PERSONAL,
  );
  const favorites = [sticker.id, ...state.favorites.filter((item) => item !== sticker.id)].slice(
    0,
    FAVORITES_CAP,
  );
  await persist({
    ...state,
    personal,
    favorites,
    recents: withRecent(state, sticker.id),
  });
}

export async function removePersonalSticker(id: string): Promise<void> {
  const state = cached ?? (await loadStickerLibrary());
  const target = state.personal.find((item) => item.id === id);
  if (!target) return;
  try {
    const file = new File(target.uri);
    if (file.exists) file.delete();
  } catch {
    // Le fichier a déjà disparu : les métadonnées doivent partir quand même.
  }
  await persist({
    personal: state.personal.filter((item) => item.id !== id),
    recents: state.recents.filter((item) => item !== id),
    favorites: state.favorites.filter((item) => item !== id),
  });
}

export function personalStickerDirectory(): Directory {
  const directory = new Directory(Paths.document, PERSONAL_STICKER_DIRECTORY);
  if (!directory.exists) {
    directory.create({ intermediates: true, idempotent: true });
  }
  return directory;
}

export async function resetStickerLibrary(): Promise<void> {
  const state = cached ?? (await loadStickerLibrary().catch(() => clone(EMPTY)));
  for (const sticker of state.personal) {
    try {
      const file = new File(sticker.uri);
      if (file.exists) file.delete();
    } catch {
      // Rien à faire : on efface aussi les métadonnées.
    }
  }
  try {
    await AsyncStorage.removeItem(STICKER_LIBRARY_KEY);
  } catch {
    // La déconnexion ne doit jamais échouer à cause du stockage local.
  }
  cached = clone(EMPTY);
  opening = null;
  notify();
}

/* --------------------------- Stickers reçus --------------------------- */

export interface ReceivedStickerInput {
  url: string;
  name?: string;
  mime?: string;
  width?: number;
  height?: number;
  /** Identité stable du sticker reçu (pack/id, sinon URL sans signature). */
  seed: string;
}

function extensionFor(mime: string, url: string): string {
  const normalized = mime.toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('heic') || normalized.includes('heif')) return 'heic';
  const match = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(url);
  return match?.[1]?.toLowerCase() ?? 'png';
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function receivedStickerId(seed: string): string {
  return `received-${stableHash(seed)}`;
}

export function receivedStickerSeed(attachment: {
  stickerPackId?: string;
  stickerId?: string;
  url: string;
}): string {
  if (attachment.stickerId) {
    return `${attachment.stickerPackId ?? ''}/${attachment.stickerId}`;
  }
  return attachment.url.split('?')[0] ?? attachment.url;
}

/** Télécharge le sticker reçu dans le dossier privé, sans doublon. */
export async function saveReceivedSticker(input: ReceivedStickerInput): Promise<PersonalSticker> {
  const id = receivedStickerId(input.seed);
  const state = cached ?? (await loadStickerLibrary());
  const existing = state.personal.find((sticker) => sticker.id === id);
  if (existing && fileStillExists(existing.uri)) return existing;

  const mime = input.mime?.startsWith('image/') ? input.mime : 'image/png';
  const directory = personalStickerDirectory();
  const destination = new File(directory, `${id}.${extensionFor(mime, input.url)}`);
  try {
    if (!destination.exists || destination.size === 0) {
      await File.downloadFileAsync(input.url, destination, { idempotent: true });
    }
  } catch {
    try {
      if (destination.exists) destination.delete();
    } catch {
      // Rien d'autre à nettoyer.
    }
    throw new Error("Impossible de télécharger ce sticker.");
  }

  const size = destination.size > 0 ? destination.size : null;
  const sticker: PersonalSticker = {
    id,
    name: (input.name?.trim() || 'Sticker reçu').slice(0, 48),
    uri: destination.uri,
    mime,
    width: input.width && input.width > 0 ? Math.round(input.width) : 512,
    height: input.height && input.height > 0 ? Math.round(input.height) : 512,
    size,
    createdAt: Date.now(),
  };
  await addPersonalFavorite(sticker);
  return sticker;
}
