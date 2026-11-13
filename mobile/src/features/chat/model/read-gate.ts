import type { ChatMode } from '../transport/types';

/**
 * Seule porte du marquage « Ouvert » en mode chiffré : écran consulté, app
 * active, liste prête et messages réellement visibles (read-visibility).
 * Aucun chargement, aucune réception ne peut la contourner.
 */
export function canMarkEncryptedRead(input: {
  mode: ChatMode | 'blocked' | 'pending';
  focused: boolean;
  appActive: boolean;
  ready: boolean;
  visibleIds: readonly string[];
}): boolean {
  return (
    input.mode === 'e2ee' &&
    input.focused &&
    input.appActive &&
    input.ready &&
    input.visibleIds.length > 0
  );
}
