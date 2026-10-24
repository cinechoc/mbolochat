/**
 * Logique de texte pure du sélecteur d'émojis, testable hors exécution mobile :
 * pli de recherche, choix du ton de peau, suppression d'une grappe Unicode
 * entière (famille, drapeau, ton, variante) au ⌫ du panneau.
 */

/**
 * Recherche insensible aux majuscules et aux accents (« café » trouve bien
 * « cafe », et l'inverse). Les balises du catalogue sont prêpliéees avec.
 */
export function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Base minimale pour choisir un glyphe selon le ton de peau. */
export interface ToneEntry {
  u: string;
  s?: string[];
}
/**
 * Glyphe affiché sous le ton choisi. 0 = « naturel », 1..5 = clair → foncé.
 * Un émoji sans variantes garde le sien ; c'est le catalogue qui décide.
 */
export function toneVariant(entry: ToneEntry, tone: number): string {
  if (tone <= 0 || !entry.s || entry.s.length === 0) return entry.u;
  return entry.s[Math.min(tone - 1, entry.s.length - 1)] ?? entry.u;
}

// ————— Suppression d'une grappe Unicode entière —————

/** Modificateurs qui prolongent la grappe précédente plutôt qu'une neuve. */
const CONTINUATIONS = new Set(['\u200D', '\uFE0F', '\uFE0E', '\u20E3']);

const isSkinTone = (code: number): boolean => code >= 0x1f3fb && code <= 0x1f3ff;
const isRegionalIndicator = (code: number): boolean => code >= 0x1f1e6 && code <= 0x1f1ff;
const isTagChar = (code: number): boolean => code >= 0xe0020 && code <= 0xe007f;

function clusterStarts(codepoints: { cp: number; text: string }[]): boolean[] {
  const start = codepoints.map(() => true);
  for (let i = 1; i < codepoints.length; i += 1) {
    const { cp } = codepoints[i];
    const previous = codepoints[i - 1];
    const continuing =
      // séquences ZWJ : le glyphe qui suit appartient aussi au même visuel
      previous.cp === 0x200d ||
      // Variation Selectors, combinateur de touche (1️⃣) : ils s'accrochent
      // à leur base et n'ouvrent jamais une nouvelle grappe
      CONTINUATIONS.has(codepoints[i].text) ||
      // un ton de peau ne vit jamais sans base
      isSkinTone(cp) ||
      // un ZWJ suit un modificateur dans 👨🏻‍⚕️ ; la grappe continue
      isSkinTone(previous.cp) ||
      // drapeaux de pays (deux indicateurs) et sous-drapeaux (tags)
      (isRegionalIndicator(cp) && isRegionalIndicator(previous.cp)) ||
      (isTagChar(cp) && (isTagChar(previous.cp) || previous.cp === 0x1f3f4));
    if (continuing) start[i] = false;
  }
  return start;
}

/**
 * Décalage (en unités UTF-16) où commence la grappe qui se termine à `index` :
 * au ⌫ du panneau d'émojis, la famille 👨‍👩‍👦 ou le drapeau 🇫🇷 partent d'un
 * seul appui, comme sur les applications de référence.
 */
export function previousClusterIndex(text: string, index: number): number {
  if (index <= 0) return 0;
  const head = text.slice(0, index);
  const codepoints: { cp: number; text: string }[] = [];
  for (const ch of head) {
    codepoints.push({ cp: ch.codePointAt(0) ?? 0, text: ch });
  }
  const starts = clusterStarts(codepoints);
  for (let i = codepoints.length - 1; i >= 0; i -= 1) {
    if (starts[i]) return codepoints.slice(0, i).reduce((sum, item) => sum + item.text.length, 0);
  }
  return 0;
}
