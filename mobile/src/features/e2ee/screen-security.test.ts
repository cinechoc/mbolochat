import { describe, expect, it, vi } from 'vitest';

import { applySecureScreen } from './screen-security';

// vi.mock est hissé au-dessus des imports par vitest : ces mocks coupent la
// chaîne d'imports vers react-native (Flow, non parsable par vitest). La
// fonction testée est pure et ne dépend d'aucun des deux.
vi.mock('../../../modules/mbolo-screen-security/src', () => ({
  ScreenSecurity: { setSecure: vi.fn(), isSecure: vi.fn() },
}));
vi.mock('@/lib/app-preferences', () => ({
  useAppPreference: vi.fn(),
}));

describe('applySecureScreen (politique FLAG_SECURE)', () => {
  it('pose le drapeau à l’entrée et le retire au nettoyage quand le réglage est actif', () => {
    const setSecure = vi.fn().mockResolvedValue(true);
    const cleanup = applySecureScreen(true, true, setSecure);

    expect(setSecure).toHaveBeenCalledTimes(1);
    expect(setSecure).toHaveBeenLastCalledWith(true);

    cleanup();
    expect(setSecure).toHaveBeenCalledTimes(2);
    expect(setSecure).toHaveBeenLastCalledWith(false);
  });

  it('ne pose jamais le drapeau quand le réglage « Masquer l’aperçu » est désactivé', () => {
    const setSecure = vi.fn().mockResolvedValue(true);
    const cleanup = applySecureScreen(true, false, setSecure);

    expect(setSecure).toHaveBeenCalledTimes(1);
    expect(setSecure).toHaveBeenLastCalledWith(false);

    // Le démontage reste sans effet résiduel : le drapeau est retiré.
    cleanup();
    expect(setSecure).toHaveBeenLastCalledWith(false);
  });

  it('écran inactif : le drapeau reste retiré même si le réglage est actif', () => {
    const setSecure = vi.fn().mockResolvedValue(true);
    const cleanup = applySecureScreen(false, true, setSecure);

    expect(setSecure).toHaveBeenCalledWith(false);
    cleanup();
    expect(setSecure).toHaveBeenLastCalledWith(false);
  });
});
