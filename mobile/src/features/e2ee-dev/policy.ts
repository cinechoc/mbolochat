/** Écran d'auto-test E2EE : uniquement en développement, sur opt-in explicite. */
export function isE2eeDevToolsEnabled(
  dev: boolean = __DEV__,
  flag: string | undefined = process.env.EXPO_PUBLIC_E2EE_DEV_TOOLS,
): boolean {
  return dev && flag === '1';
}
