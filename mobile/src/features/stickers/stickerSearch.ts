const LIGATURES: Record<string, string> = {
  œ: 'oe',
  æ: 'ae',
  ß: 'ss',
  ø: 'o',
  đ: 'd',
  ł: 'l',
};

/** Même normalisation que la recherche d'emojis, sans dépendance runtime. */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[œæßøđł]/g, (char) => LIGATURES[char] ?? char)
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SearchableSticker {
  name: string;
  tags: string[];
}

/** Recherche insensible aux accents dans le nom et les mots-clés. */
export function searchStickerEntries<T extends SearchableSticker>(
  entries: T[],
  query: string,
): T[] {
  const normalized = normalize(query);
  if (!normalized) return entries;
  const tokens = normalized.split(' ');
  return entries.filter((entry) => {
    const haystack = normalize(`${entry.name} ${entry.tags.join(' ')}`);
    return tokens.every((token) => haystack.includes(token));
  });
}
