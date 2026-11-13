import { useEffect } from 'react';

import { sweepSecureMedia } from '@/features/e2ee/mediaStore';
import { useSecureScreen } from '@/features/e2ee/screen-security';
import type { ChatMode } from '../transport/types';

/**
 * Garde-fous d'écran du mode chiffré, et **d'eux seuls** :
 * - `FLAG_SECURE` pendant la vie de l'écran ;
 * - balayage des médias déchiffrés au démontage.
 *
 * En mode clair, aucun des deux n'est activé.
 */
export function useChatSecurity(mode: ChatMode | 'blocked' | 'pending'): void {
  useSecureScreen(mode === 'e2ee');
  useEffect(() => {
    if (mode !== 'e2ee') return;
    return () => {
      sweepSecureMedia();
    };
  }, [mode]);
}
