/** Réactions autorisées : stickers de la panthère Mbolo, jamais du texte libre. */
export const REACTION_REFS = [
  'mbolo-panther-2d/amour',
  'mbolo-panther-2d/fou-rire',
  'mbolo-panther-2d/pouce-leve',
  'mbolo-panther-2d/choc',
  'mbolo-panther-2d/tristesse',
  'mbolo-panther-2d/colere',
] as const;

export type ReactionRef = (typeof REACTION_REFS)[number];

export function isReactionRef(value: unknown): value is ReactionRef {
  return typeof value === 'string' && (REACTION_REFS as readonly string[]).includes(value);
}
