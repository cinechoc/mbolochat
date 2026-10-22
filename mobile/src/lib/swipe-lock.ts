/**
 * Verrou de geste : la timeline d'un vocal possède son propre glissement
 * horizontal. Tant qu'elle le tient, les bulles ne doivent pas se déplacer
 * pour répondre.
 */
let locked = false;

export function lockSwipe(): void {
  locked = true;
}

export function unlockSwipe(): void {
  locked = false;
}

export function isSwipeLocked(): boolean {
  return locked;
}
