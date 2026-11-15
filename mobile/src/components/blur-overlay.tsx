import type { ComponentRef, ReactNode, RefObject } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { isBlurAvailable } from './blur-target';
import { BlurIntensity } from '@/constants/theme';

type BlurModule = typeof import('expo-blur');

let blurModule: BlurModule | null | undefined;

function loadBlurModule(): BlurModule | null {
  if (blurModule !== undefined) return blurModule;
  if (!isBlurAvailable()) {
    blurModule = null;
    return blurModule;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    blurModule = require('expo-blur') as BlurModule;
  } catch {
    blurModule = null;
  }
  return blurModule;
}

interface BlurOverlayProps {
  children?: ReactNode;
  intensity?: number;
  tint?: 'light' | 'dark' | 'default';
  fallbackColor?: string;
  style?: StyleProp<ViewStyle>;
  blurTarget?: RefObject<ComponentRef<typeof View> | null>;
}

/** Voile flouté avec repli opaque si le build natif n’embarque pas expo-blur. */
export function BlurOverlay({
  children,
  intensity = BlurIntensity,
  tint = 'dark',
  fallbackColor = 'rgba(0,0,0,0.5)',
  style,
  blurTarget,
}: BlurOverlayProps) {
  const blur = loadBlurModule();
  if (!blur) {
    return (
      <View style={[styles.fill, { backgroundColor: fallbackColor }, style]}>{children}</View>
    );
  }
  return (
    <blur.BlurView
      intensity={intensity}
      tint={tint}
      blurTarget={blurTarget}
      blurMethod={Platform.OS === 'android' && !blurTarget ? 'none' : 'dimezisBlurViewSdk31Plus'}
      style={[styles.fill, style]}>
      {children}
    </blur.BlurView>
  );
}

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
});
