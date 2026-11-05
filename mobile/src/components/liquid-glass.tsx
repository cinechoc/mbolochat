/**
 * Liquid glass : l'effet natif iOS 26+ quand il est disponible, une imitation
 * RN soignée (voile translucide + liseré clair en haut) sur les autres
 * plateformes. La surface reste lisible en thème clair comme sombre.
 */

import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import { useTheme } from '@/hooks/use-theme';
import { useThemePreference } from '@/lib/theme-preference';

export function LiquidGlass({
  radius,
  tint,
  style,
  children,
}: {
  /** Rayon des coins (le vrai verre natif prend le rayon via le style RN). */
  radius: number;
  /** Teinte légère du verre sur iOS. Optionnel : verre neutre par défaut. */
  tint?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const theme = useTheme();
  const { scheme } = useThemePreference();
  const nativeGlass = Platform.OS === 'ios' && isLiquidGlassAvailable();

  if (nativeGlass) {
    return (
      <GlassView
        glassEffectStyle="clear"
        tintColor={tint}
        colorScheme={scheme}
        isInteractive
        style={[styles.base, { borderRadius: radius }, style]}>
        {children}
      </GlassView>
    );
  }

  // Imitation RN (Android, web, iOS < 26) : voile translucide + liseré clair de
  // 2 px en haut, comme un reflet de lumière sur le bord supérieur du verre.
  return (
    <View
      style={[
        styles.base,
        {
          borderRadius: radius,
          backgroundColor: theme.buttonGlass,
          borderColor: theme.buttonGlassBorder,
          borderTopWidth: 2,
          borderTopColor: theme.buttonGlassHighlight,
        },
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
