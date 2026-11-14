/**
 * Surface « verre » cross-plateforme, point d'entrée unique.
 *
 * - iOS 26 et plus : Liquid Glass natif (`UIGlassEffect`) via
 *   `expo-glass-effect` ; le contenu floute derrière la surface et la
 *   réfraction suit la géométrie.
 * - Android 12+ : flou Material 3 Expressive via `expo-blur`. Ce module n'est
 *   présent que si l'appareil a été recompilé après son ajout : on le sonde
 *   avant de l'utiliser, sinon Fabric plante sur un ViewManager inexistant.
 * - Web / appareils sans module : fond opaque du thème. Un voile translucide
 *   sans flou superposerait le contenu du dessous au texte, ce qui tue la
 *   lisibilité ; on ne le fait jamais.
 */

import { GlassView as NativeGlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ComponentRef, ReactNode, RefObject } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { isBlurAvailable } from '@/components/blur-target';
import { BlurIntensity, GlassColors } from '@/constants/theme';
import { useThemePreference } from '@/lib/theme-preference';

type BlurModule = typeof import('expo-blur');

/**
 * `expo-blur` n'existe que dans les builds natifs qui l'embarquent. Une simple
 * lecture statique ferait tomber l'app sur un build plus ancien (ViewManager
 * manquant), donc on le charge à la demande et on mémorise l'échec. La sonde
 * partagée vérifie que les vues natives sont bien enregistrées, pas seulement
 * que le module Expo existe.
 */
let blurModule: BlurModule | null | undefined;

function loadBlurModule(): BlurModule | null {
  if (blurModule !== undefined) {
    return blurModule;
  }
  if (!isBlurAvailable()) {
    blurModule = null;
    return blurModule;
  }
  try {
    // Le chargement conditionnel évite de référencer une vue native absente.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    blurModule = require('expo-blur') as BlurModule;
  } catch {
    blurModule = null;
  }
  return blurModule;
}

export interface GlassProps extends ViewProps {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Teinte du verre : régulier (flou + saturation) ou clair (plus transparent). */
  variant?: 'regular' | 'clear';
  /** Appliquer une bordure claire façon verre Liquid Glass. */
  bordered?: boolean;
  /** Cible du flou Android : le contenu que la surface recouvre. */
  blurTarget?: RefObject<ComponentRef<typeof View> | null>;
  /** Fond opaque quand le flou est indisponible (assorti à la surface). */
  fallbackColor?: string;
  /**
   * Apparence forcée de la surface. Les écrans d'authentification restent
   * sombres quel que soit le thème : sans cela, le flou Android « clear »
   * éclaircit le champ et le texte clair devient illisible.
   */
  appearance?: 'light' | 'dark';
}

export function Glass({
  children,
  style,
  variant = 'regular',
  bordered = true,
  blurTarget,
  fallbackColor,
  appearance,
  ...rest
}: GlassProps) {
  const { scheme } = useThemePreference();
  const surface = appearance ?? scheme;
  const colors = GlassColors[surface];

  const glassStyle: ViewStyle = {
    borderColor: colors.border,
    borderWidth: bordered ? StyleSheet.hairlineWidth : 0,
  };

  if (Platform.OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <NativeGlassView
        {...rest}
        style={[style, glassStyle]}
        glassEffectStyle={variant}
        colorScheme={surface}
        isInteractive={false}>
        {children}
      </NativeGlassView>
    );
  }

  // Le flou natif n'est utilisable qu'avec son module compilé et, sur Android,
  // une cible explicite : sans les deux, on reste sur un fond opaque.
  const blur = loadBlurModule();
  const canBlur = !!blur && (Platform.OS !== 'android' || !!blurTarget);

  return (
    <View {...rest} style={[style, glassStyle]}>
      {canBlur ? (
        <blur.BlurView
          tint={colors.tint}
          intensity={BlurIntensity}
          blurMethod="dimezisBlurViewSdk31Plus"
          blurTarget={blurTarget}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: fallbackColor ?? colors.fallback }]}
        />
      )}
      {children}
    </View>
  );
}

/** Alias explicite pour les barres flottantes (composer, en-têtes). */
export function GlassBar({
  children,
  style,
  variant = 'regular',
  blurTarget,
  fallbackColor,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  variant?: 'regular' | 'clear';
  blurTarget?: RefObject<ComponentRef<typeof View> | null>;
  fallbackColor?: string;
}) {
  return (
    <Glass
      variant={variant}
      blurTarget={blurTarget}
      fallbackColor={fallbackColor}
      style={[styles.bar, style]}>
      {children}
    </Glass>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderRadius: 999,
    overflow: 'hidden',
  },
});
