/** Réactions autorisées : références fermées, rendues en emoji dans l’interface. */
export const REACTION_REFS = [
  'mbolo-panther-2d/amour',
  'mbolo-panther-2d/fou-rire',
  'mbolo-panther-2d/pouce-leve',
  'mbolo-panther-2d/choc',
  'mbolo-panther-2d/tristesse',
  'mbolo-panther-2d/priere',
  'mbolo-panther-2d/colere',
] as const;

export type ReactionRef = (typeof REACTION_REFS)[number];

/** Les six réactions rapides, dans l’ordre demandé par l’interface. */
export const QUICK_REACTION_REFS = [
  'mbolo-panther-2d/pouce-leve',
  'mbolo-panther-2d/amour',
  'mbolo-panther-2d/fou-rire',
  'mbolo-panther-2d/choc',
  'mbolo-panther-2d/tristesse',
  'mbolo-panther-2d/priere',
] as const satisfies readonly ReactionRef[];

export const REACTION_EMOJIS: Record<ReactionRef, string> = {
  'mbolo-panther-2d/amour': '❤️',
  'mbolo-panther-2d/fou-rire': '😂',
  'mbolo-panther-2d/pouce-leve': '👍',
  'mbolo-panther-2d/choc': '😮',
  'mbolo-panther-2d/tristesse': '😢',
  'mbolo-panther-2d/priere': '🙏',
  'mbolo-panther-2d/colere': '😠',
};

export function isReactionRef(value: unknown): value is ReactionRef {
  return typeof value === 'string' && (REACTION_REFS as readonly string[]).includes(value);
}
