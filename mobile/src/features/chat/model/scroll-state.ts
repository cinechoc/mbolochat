/** Au-delà de ce défilement, la pastille de retour en bas apparaît. */
export const JUMP_AFTER_PX = 320;

export interface ScrollState {
  atBottom: boolean;
  showJump: boolean;
  unseen: number;
}

export const INITIAL_SCROLL_STATE: ScrollState = {
  atBottom: true,
  showJump: false,
  unseen: 0,
};

/**
 * Effet d'un défilement sur la pastille de retour (liste inversée : offset 0 =
 * dernier message). Fonction pure : le hook ne fait que stocker le résultat.
 */
export function scrollStateForOffset(offset: number, unseen = 0): ScrollState {
  const atBottom = offset <= 32;
  return {
    atBottom,
    showJump: !atBottom && offset > JUMP_AFTER_PX,
    unseen: atBottom ? 0 : unseen,
  };
}

/** Un nouvel arrivage compte seulement si l'utilisateur n'est pas en bas. */
export function countUnseen(state: ScrollState, incoming: number): ScrollState {
  if (incoming <= 0 || state.atBottom) return state;
  return { ...state, unseen: state.unseen + incoming };
}

/** Retour en bas : tout est remis à zéro. */
export function resetScrollState(): ScrollState {
  return INITIAL_SCROLL_STATE;
}
