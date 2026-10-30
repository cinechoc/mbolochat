/**
 * Réactions autorisées : des stickers de la panthère Mbolo, pas des emojis
 * Unicode. La liste est fermée pour garder un rendu cohérent et éviter qu'un
 * texte arbitraire serve de « réaction ».
 */
export const PANTHER_REACTIONS = [
  'mbolo-panther-2d/amour',
  'mbolo-panther-2d/fou-rire',
  'mbolo-panther-2d/pouce-leve',
  'mbolo-panther-2d/choc',
  'mbolo-panther-2d/tristesse',
  'mbolo-panther-2d/colere',
] as const;

export type PantherReaction = (typeof PANTHER_REACTIONS)[number];

export function isPantherReaction(value: unknown): value is PantherReaction {
  return typeof value === 'string' && (PANTHER_REACTIONS as readonly string[]).includes(value);
}

/** Résumé d'une réaction pour un message, du point de vue du lecteur. */
export interface ReactionSummary {
  /** Référence de sticker, ex. « mbolo-panther-2d/amour ». */
  reaction: string;
  count: number;
  /** L'utilisateur courant a réagi avec ce sticker. */
  mine: boolean;
}
