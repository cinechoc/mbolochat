/** Chiffrement de bout en bout : actif sauf désactivation explicite de build. */
export function isE2eeEnabled(
  flag: string | undefined = process.env.EXPO_PUBLIC_E2EE_ENABLED,
): boolean {
  if (flag === undefined || flag.trim() === '') return true;
  return !['0', 'false', 'off', 'no'].includes(flag.trim().toLowerCase());
}
