import { useEffect } from 'react';

import { ScreenSecurity } from '../../../modules/mbolo-screen-security/src';
import { useAppPreference } from '@/lib/app-preferences';

/**
 * Politique de FLAG_SECURE : tant que l'écran est monté et que le réglage
 * « Masquer l'aperçu dans les applications récentes » est actif, le drapeau
 * est posé (aperçu et captures montrent un écran neutre). Au démontage, le
 * drapeau est toujours retiré, même si le réglage a changé entre-temps.
 *
 * Fonction pure séparée du hook pour être testable sans moteur de rendu.
 */
export function applySecureScreen(
  active: boolean,
  hidePreview: boolean,
  setSecure: (enabled: boolean) => Promise<boolean>,
): () => void {
  void setSecure(active && hidePreview);
  return () => {
    void setSecure(false);
  };
}

/** Pose FLAG_SECURE pendant la vie de l'écran appelant. */
export function useSecureScreen(active: boolean): void {
  const [hidePreview] = useAppPreference('hideRecentsPreview');
  useEffect(
    () => applySecureScreen(active, hidePreview, ScreenSecurity.setSecure),
    [active, hidePreview],
  );
}
