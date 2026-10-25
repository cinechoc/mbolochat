import emojiRegex from 'emoji-regex';

export type TextSegment = { type: 'text'; value: string };
export type EmojiSegment = { type: 'emoji'; value: string; key: string };
export type Segment = TextSegment | EmojiSegment;

const VARIATION_SELECTOR_16 = /\uFE0F/g;

/**
 * Clé stable d'un emoji = points de code en hexadécimal, séparés par « - »,
 * sans le sélecteur de variation FE0F.
 * Ex. 😀 -> "1f600", 👨‍💻 -> "1f468-200d-1f4bb", 1️⃣ -> "31-20e3".
 * Le script de génération des images utilise la MÊME fonction : ne la modifie pas
 * d'un côté seulement.
 */
export function toEmojiKey(emoji: string): string {
  const parts: string[] = [];
  for (const ch of emoji.replace(VARIATION_SELECTOR_16, '')) {
    parts.push((ch.codePointAt(0) as number).toString(16));
  }
  return parts.join('-');
}

const cache = new Map<string, Segment[]>();
const CACHE_MAX = 500;

/** Découpe un texte en morceaux « texte » et « emoji » (séquences ZWJ, tons de peau, drapeaux inclus). */
export function splitEmoji(text: string): Segment[] {
  const hit = cache.get(text);
  if (hit) return hit;

  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(emojiRegex())) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ type: 'text', value: text.slice(last, index) });
    segments.push({ type: 'emoji', value: match[0], key: toEmojiKey(match[0]) });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(text, segments);
  return segments;
}

/**
 * Retourne le nombre d'emoji (1 à 3) si le message ne contient QUE des emoji
 * (et des espaces) ; sinon 0. Sert à afficher les emoji en grand.
 */
export function emojiOnlyCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  let count = 0;
  for (const segment of splitEmoji(trimmed)) {
    if (segment.type === 'emoji') count += 1;
    else if (segment.value.trim() !== '') return 0;
  }
  return count >= 1 && count <= 3 ? count : 0;
}

export type EditResult = { text: string; cursor: number };

/** Insère `insert` à la sélection [start, end[. */
export function insertAt(text: string, start: number, end: number, insert: string): EditResult {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return { text: text.slice(0, s) + insert + text.slice(e), cursor: s + insert.length };
}

/**
 * Supprime vers l'arrière en respectant les emoji : un emoji composé
 * (ex. 👨‍👩‍👧 ou 👍🏽) est supprimé EN ENTIER, jamais à moitié.
 * Sélection non vide : supprime la sélection.
 */
export function deleteBackward(text: string, start: number, end: number): EditResult {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  if (e > s) return { text: text.slice(0, s) + text.slice(e), cursor: s };
  if (s === 0) return { text, cursor: 0 };

  const segments = splitEmoji(text.slice(0, s));
  const last = segments[segments.length - 1];
  let removeLength: number;
  if (last.type === 'emoji') {
    removeLength = last.value.length;
  } else {
    const chars = Array.from(last.value); // découpe par point de code (paires de substitution)
    removeLength = chars[chars.length - 1].length;
  }
  const cut = s - removeLength;
  return { text: text.slice(0, cut) + text.slice(s), cursor: cut };
}
