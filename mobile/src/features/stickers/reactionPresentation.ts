import { fr } from '@/i18n/fr';
import {
  QUICK_REACTION_REFS,
  REACTION_EMOJIS,
  REACTION_REFS,
  type ReactionRef,
} from './reactionRules';

export interface ReactionPresentation {
  ref: ReactionRef;
  emoji: string;
  label: string;
}

const LABELS: Record<ReactionRef, string> = {
  'mbolo-panther-2d/amour': fr.chat.unified.reactions.amour,
  'mbolo-panther-2d/fou-rire': fr.chat.unified.reactions.fouRire,
  'mbolo-panther-2d/pouce-leve': fr.chat.unified.reactions.pouceLeve,
  'mbolo-panther-2d/choc': fr.chat.unified.reactions.choc,
  'mbolo-panther-2d/tristesse': fr.chat.unified.reactions.tristesse,
  'mbolo-panther-2d/priere': fr.chat.unified.reactions.priere,
  'mbolo-panther-2d/colere': fr.chat.unified.reactions.colere,
};

function present(ref: ReactionRef): ReactionPresentation {
  return { ref, emoji: REACTION_EMOJIS[ref], label: LABELS[ref] };
}

/** Six réactions rapides affichées au-dessus de la bulle. */
export const QUICK_REACTIONS = QUICK_REACTION_REFS.map(present);

/** Toutes les réactions autorisées, pour le bouton « + ». */
export const ALL_REACTIONS = REACTION_REFS.map(present);

export function reactionPresentation(value: string): ReactionPresentation | null {
  if (!(REACTION_REFS as readonly string[]).includes(value)) return null;
  return present(value as ReactionRef);
}
