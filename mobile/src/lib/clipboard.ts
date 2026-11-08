/**
 * Copie dans le presse-papiers. Le module est natif : un build plus ancien que
 * cette version le renvoie absent, et son simple import ferait tomber l'écran.
 * On le sonde donc avant de le charger, et on le dit si il manque.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    if (!requireOptionalNativeModule('ExpoClipboard')) {
      return false;
    }
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}
