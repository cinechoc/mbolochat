/**
 * Recherche locale des stickers, indépendante de Metro et du système de
 * fichiers : elle peut être testée avec `node --test` sans charger les images.
 */

export interface StickerSearchEntry {
  id: string;
  name: string;
  tags: string[];
}

/** Minuscules sans accents, pour que « cafe » trouve « Café ». */
export function foldStickerText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .trim();
}

export function findStickerMatches<T extends StickerSearchEntry>(
  pool: readonly T[],
  query: string,
  limit = 60,
): T[] {
  const needle = foldStickerText(query);
  if (!needle) return [];
  const found: T[] = [];
  for (const sticker of pool) {
    const haystack = foldStickerText(`${sticker.name} ${sticker.tags.join(' ')}`);
    if (haystack.includes(needle)) {
      found.push(sticker);
      if (found.length >= limit) break;
    }
  }
  return found;
}
