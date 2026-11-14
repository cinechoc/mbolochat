/**
 * Cible de flou pour les surfaces en verre.
 *
 * `expo-blur` n'existe que dans les builds natifs qui l'embarquent. Poser une
 * vue Expo dont le ViewManager n'est pas compilé fait planter Fabric
 * (`Can't find ViewManager 'ViewManagerAdapter_ExpoBlur_ExpoBlurView'`).
 * `requireNativeModule` ne suffit pas à le détecter : le module peut être
 * enregistré alors que ses vues ne le sont pas.
 *
 * On sonde donc le view config natif — exactement ce que lit l'adaptateur Expo
 * pour construire la vue — et on rend une vue ordinaire tant qu'il est absent.
 * Le verre retombe alors sur son fond opaque.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';
import type { ComponentRef, Ref } from 'react';
import { Platform, View, type ViewProps } from 'react-native';

const BLUR_MODULE = 'ExpoBlur';
const BLUR_VIEW = 'ExpoBlurView';
/** Vue dédiée Android : sur iOS, la cible est une `View` ordinaire. */
const BLUR_TARGET_VIEW = 'ExpoBlurTargetView';

let available: boolean | undefined;

/** `true` si le build natif embarque réellement les vues de `expo-blur`. */
export function isBlurAvailable(): boolean {
  if (available !== undefined) {
    return available;
  }
  if (Platform.OS === 'web') {
    // Le web floute via CSS : aucune vue native n'est nécessaire.
    available = false;
    return available;
  }
  try {
    // Installe les modules Expo à la demande, puis vérifie que le view config
    // existe vraiment : le module peut être enregistré sans que ses vues le
    // soient, et c'est précisément ce cas qui fait planter Fabric.
    requireOptionalNativeModule(BLUR_MODULE);
    const getViewConfig = globalThis.expo?.getViewConfig;
    const requiredViews =
      Platform.OS === 'android' ? [BLUR_VIEW, BLUR_TARGET_VIEW] : [BLUR_VIEW];
    available =
      typeof getViewConfig === 'function' &&
      requiredViews.every((viewName) => getViewConfig(BLUR_MODULE, viewName) != null);
  } catch {
    available = false;
  }
  return available;
}

/** Props de la cible de flou : une `View` classique, ref comprise. */
export type BlurTargetProps = ViewProps & {
  ref?: Ref<ComponentRef<typeof View>>;
};

export function BlurTarget({ ...props }: BlurTargetProps) {
  if (!isBlurAvailable()) {
    return <View {...props} />;
  }
  // Le chargement conditionnel évite de référencer une vue native absente.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BlurTargetView } = require('expo-blur');
  return <BlurTargetView {...props} />;
}
