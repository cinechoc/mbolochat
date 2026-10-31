/** Écran d'auto-test E2EE : développement, ou build spike explicitement marquée. */
export function isE2eeDevToolsEnabled(
  dev: boolean = __DEV__,
  flag: string | undefined = process.env.EXPO_PUBLIC_E2EE_DEV_TOOLS,
  spike: string | undefined = process.env.EXPO_PUBLIC_E2EE_SPIKE_BUILD,
): boolean {
  return flag === '1' && (dev || spike === '1');
}
