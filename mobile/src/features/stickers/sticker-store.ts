/**
 * Bibliothèque personnelle de stickers : récents, favoris et créations.
 *
 * Le catalogue embarqué reste immuable (sticker-catalog.ts). Ici, seul l'état
 * propre à l'appareil est conservé : des identifiants pour les récents et les
 * favoris, et les fichiers recadrés pour « Mes stickers ». AsyncStorage porte
 * les métadonnées ; les images vivent dans `Paths.document/stickers` et
 * survivent aux redémarrages ainsi qu'au nettoyage du cache par le système.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';

import { PERSONAL_PACK, type Sticker } from './sticker-catalog';

const STORAGE_KEY = 'mbolo.stickers.v1';
/** Dossier privé aux créations : jamais exposé aux autres applications. */
export const PERSONAL_STICKER_DIRECTORY = 'stickers';
const RECENTS_CAP = 24;
const MAX_PERSONAL = 120;

export interface PersonalSticker {
  id: string;
  name: string;
  packId: typeof PERSONAL_PACK.id;
  uri: string;
  mime: string;
  width: number;
  height: number;
  createdAt: number;
}

export interface StickerLibraryState {
  /** Identifiants de stickers, du plus récent au plus ancien. */
  recents: string[];
  /** Identifiants favoris, dans l'ordre d'ajout. */
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
    name: row.name.slice(0, 48),
    packId: PERSONAL_PACK.id,
    uri: row.uri,
    mime: row.mime,
    width: Math.max(1, Math.round(row.width)),
    height: Math.max(1, Math.round(row.height)),
    createdAt: row.createdAt,
  };
}

/** Un fichier supprimé hors de l'app ne doit pas laisser une case morte. */
function fileStillExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    // Plateforme sans accès au système de fichiers : on garde la référence.
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
    favorites: stringList(row.favorites, 200),
    personal,
  };
}

async function persist(state: StickerLibraryState): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  cached = state;
  notify();
}

/** Charge une seule fois, puis sert la copie mémoire synchronisée. */
export function loadStickerLibrary(): Promise<StickerLibraryState> {
  if (cached) return Promise.resolve(cached);
  if (!opening) {
    opening = AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => {
        if (!value) return clone(EMPTY);
        try {
          return sanitize(JSON.parse(value));
        } catch {
          return clone(EMPTY);
        }
      })
      .catch((error) => {
        // Une lecture ratée ne condamne pas la session : le prochain montage
        // retentera. On ne met pas en cache pour laisser sa chance au retry.
        opening = null;
        throw error;
      })
      .then((state) => {
        cached = state;
        return state;
      });
  }
  return opening;
}

/** Photo synchrone de l'état, pour `useSyncExternalStore` ou un abonnement. */
export function getStickerLibrary(): StickerLibraryState {
  return cached ?? clone(EMPTY);
}

export function subscribeStickerLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function withRecent(state: StickerLibraryState, id: string): string[] {
  return [id, ...state.recents.filter((item) => item !== id)].slice(0, RECENTS_CAP);
}

export async function addRecentSticker(id: string): Promise<void> {
  const state = cached ?? (await loadStickerLibrary());
  if (state.recents[0] === id) return;
  await persist({ ...state, recents: withRecent(state, id) });
}

/** true si le sticker vient d'entrer dans les favoris, false s'il en sort. */
export async function toggleStickerFavorite(id: string): Promise<boolean> {
  const state = cached ?? (await loadStickerLibrary());
  const exists = state.favorites.includes(id);
  const favorites = exists
    ? state.favorites.filter((item) => item !== id)
    : [...state.favorites, id];
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
  const personal = state.personal.filter((item) => item.id !== id);
  await persist({
    personal,
    recents: state.recents.filter((item) => item !== id),
    favorites: state.favorites.filter((item) => item !== id),
  });
}

/** Convertit une création persistée en sticker affichable par le sélecteur. */
export function personalToSticker(sticker: PersonalSticker): Sticker {
  return {
    id: sticker.id,
    name: sticker.name,
    packId: PERSONAL_PACK.id,
    category: 'personnels',
    tags: [sticker.name],
    source: { uri: sticker.uri },
    mime: sticker.mime,
    width: sticker.width,
    height: sticker.height,
    createdAt: sticker.createdAt,
  };
}

/** Dossier des créations, créé à la première utilisation. */
export function personalStickerDirectory(): Directory {
  const directory = new Directory(Paths.document, PERSONAL_STICKER_DIRECTORY);
  if (!directory.exists) {
    directory.create({ intermediates: true, idempotent: true });
  }
  return directory;
}

/** Déconnexion : les créations et l'historique appartiennent au compte. */
export async function resetStickerStore(): Promise<void> {
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
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // La déconnexion ne doit jamais échouer à cause du stockage local.
  }
  cached = clone(EMPTY);
  opening = null;
  notify();
}
