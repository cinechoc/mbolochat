/** Chiffrement de bout en bout : désactivé sauf opt-in explicite de build. */
export function isE2eeEnabled(
  flag: string | undefined = process.env.EXPO_PUBLIC_E2EE_ENABLED,
): boolean {
  return flag === '1';
}
