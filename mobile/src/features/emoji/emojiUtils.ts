import { MBOLO_EMOJI_ENTRIES } from './mboloEmojiData.generated.ts';

export type TextSegment = { type: 'text'; value: string };
export type EmojiSegment = { type: 'emoji'; value: string; key: string };
export type Segment = TextSegment | EmojiSegment;

const VARIATION_SELECTOR_16 = /\uFE0F/g;
const ZWJ = 0x200d;
const KEYCAP = 0x20e3;
const TEXT_PRESENTATION = 0xfe0e;
const SKIN_TONE_MIN = 0x1f3fb;
const SKIN_TONE_MAX = 0x1f3ff;

interface TrieNode {
  children: Map<number, TrieNode>;
  key?: string;
}

function createNode(): TrieNode {
  return { children: new Map() };
}

/**
 * Trie construit une fois depuis l'inventaire complet. Les séquences sont
 * normalisées sans FE0F, comme `toEmojiKey` : le scan ignore FE0F et conserve
 * la valeur Unicode originale dans le segment.
 */
const ROOT = createNode();
for (const entry of MBOLO_EMOJI_ENTRIES) {
  let node = ROOT;
  for (const char of entry.char.replace(VARIATION_SELECTOR_16, '')) {
    const point = char.codePointAt(0) as number;
    let next = node.children.get(point);
    if (!next) {
      next = createNode();
      node.children.set(point, next);
    }
    node = next;
  }
  node.key ??= entry.key;
}

/**
 * Clé stable d'un emoji = points de code en hexadécimal, séparés par « - »,
 * sans le sélecteur de variation FE0F.
 * Ex. 😀 -> "1f600", 👨‍💻 -> "1f468-200d-1f4bb", 1️⃣ -> "31-20e3".
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

function isSequenceContinuation(point: number | undefined): boolean {
  return (
    point === ZWJ ||
    point === KEYCAP ||
    (point !== undefined && point >= SKIN_TONE_MIN && point <= SKIN_TONE_MAX)
  );
}

/**
 * Découpe un texte en morceaux « texte » et « emoji ».
 *
 * Le scan parcourt les points de code et cherche la plus longue séquence du
 * registre (ZWJ, tons de peau, drapeaux, keycaps, variantes de genre…). Il ne
 * remplace jamais un préfixe d'une séquence inconnue : si la suite immédiate
 * est un ZWJ, un ton de peau ou un keycap, la séquence est laissée en texte.
 */
export function splitEmoji(text: string): Segment[] {
  const hit = cache.get(text);
  if (hit) return hit;

  const chars = Array.from(text);
  const offsets = new Array<number>(chars.length + 1);
  let utf16 = 0;
  for (let index = 0; index < chars.length; index += 1) {
    offsets[index] = utf16;
    utf16 += chars[index].length;
  }
  offsets[chars.length] = utf16;

  const segments: Segment[] = [];
  let last = 0;
  let index = 0;

  while (index < chars.length) {
    let node = ROOT;
    let bestKey: string | undefined;
    let bestEnd = index;

    for (let cursor = index; cursor < chars.length; cursor += 1) {
      const point = chars[cursor].codePointAt(0) as number;
      if (point === 0xfe0f) {
        // Sélecteur de présentation : ignoré pour la correspondance, conservé dans la valeur.
        continue;
      }
      const next = node.children.get(point);
      if (!next) break;
      node = next;
      if (node.key) {
        bestKey = node.key;
        bestEnd = cursor + 1;
      }
    }

    // Un FE0F juste après la séquence fait partie de la présentation emoji :
    // il doit rester dans la valeur remplacée (ex. ❤️), pas devenir du texte.
    while (bestEnd < chars.length && chars[bestEnd].codePointAt(0) === 0xfe0f) {
      bestEnd += 1;
    }

    const nextPoint = bestEnd < chars.length ? chars[bestEnd].codePointAt(0) : undefined;
    const forcedText = nextPoint === TEXT_PRESENTATION;
    const partialUnknown = isSequenceContinuation(nextPoint);

    if (bestKey && !forcedText && !partialUnknown) {
      const start = offsets[index];
      const end = offsets[bestEnd];
      if (start > last) {
        segments.push({ type: 'text', value: text.slice(last, start) });
      }
      segments.push({ type: 'emoji', value: text.slice(start, end), key: bestKey });
      last = end;
      index = bestEnd;
    } else {
      index += 1;
    }
  }

  if (last < text.length) {
    segments.push({ type: 'text', value: text.slice(last) });
  }

  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value as string);
  }
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
