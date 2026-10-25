import type { EmojiGroup, EmojiItem } from './emojiCatalog';

/** Remplace les ligatures que NFD ne décompose pas (cœur, æ, ß…). */
const LIGATURES: Record<string, string> = {
  œ: 'oe',
  æ: 'ae',
  ß: 'ss',
  ø: 'o',
  đ: 'd',
  ł: 'l',
};

/** Normalise une requête/nom pour une recherche insensible à la casse et aux accents. */
export function normalizeEmojiSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[œæßøđł]/g, (char) => LIGATURES[char] ?? char)
    .replace(/\s+/g, ' ')
    .trim();
}

export type EmojiSearchEntry = {
  item: EmojiItem;
  name: string;
  haystack: string;
};

/** Indexe les groupes une seule fois : la recherche reste O(n) sur ~1 900 emoji. */
export function buildEmojiSearchIndex(groups: EmojiGroup[]): EmojiSearchEntry[] {
  return groups.flatMap((group) =>
    group.emojis.map((item) => ({
      item,
      name: normalizeEmojiSearch(item.name),
      haystack: normalizeEmojiSearch(
        `${item.name} ${item.keywords?.join(' ') ?? ''} ${item.char}`,
      ),
    })),
  );
}

/** Recherche les emoji dont tous les mots de la requête apparaissent dans le nom/les mots-clés. */
export function searchEmojiIndex(index: EmojiSearchEntry[], query: string): EmojiItem[] {
  const normalized = normalizeEmojiSearch(query);
  if (!normalized) {
    return [];
  }
  const tokens = normalized.split(' ');
  const exact = query.trim();
  const results: { item: EmojiItem; score: number; order: number }[] = [];

  index.forEach((entry, order) => {
    if (!tokens.every((token) => entry.haystack.includes(token))) {
      return;
    }
    let score = 0;
    if (entry.item.char === exact) score += 100;
    if (entry.name === normalized) score += 60;
    else if (entry.name.startsWith(normalized)) score += 40;
    else if (entry.name.includes(normalized)) score += 25;
    if (entry.haystack.includes(normalized)) score += 10;
    results.push({ item: entry.item, score, order });
  });

  results.sort((a, b) => b.score - a.score || a.order - b.order);
  return results.map((entry) => entry.item);
}

/** Raccourci pour les tests et les petits catalogues. */
export function searchEmojis(groups: EmojiGroup[], query: string): EmojiItem[] {
  return searchEmojiIndex(buildEmojiSearchIndex(groups), query);
}
