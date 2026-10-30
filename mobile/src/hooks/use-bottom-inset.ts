import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spacing } from '@/constants/theme';

/**
 * Marge de sécurité du bas, la même pour tous les écrans, feuilles et modales.
 *
 * Certains appareils à trois boutons rapportent 0 alors que la barre de
 * navigation recouvre toujours le bas de la fenêtre : le plancher évite un
 * contenu collé au bord. `extra` ajoute une respiration au-dessus de la barre.
 */
export function useBottomInset(extra = 0): number {
  const insets = useSafeAreaInsets();
  return Math.max(insets.bottom, Spacing.threeHalf) + extra;
}
