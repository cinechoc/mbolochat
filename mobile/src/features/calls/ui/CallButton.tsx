import type { ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { CallMetrics, CallSurface, Motion } from '@/constants/theme';

export type CallButtonTone = 'glass' | 'solid' | 'hangup' | 'accept';

const BACKGROUND: Record<CallButtonTone, string> = {
  glass: CallSurface.glass,
  solid: CallSurface.onSurface,
  hangup: CallSurface.hangup,
  accept: CallSurface.accept,
};

/** Bouton rond de l'écran d'appel, partagé par le 1:1 et le groupe. */
export function CallButton({
  label,
  tone = 'glass',
  onPress,
  children,
  delay = 0,
  selected,
  disabled,
  size = CallMetrics.button,
}: {
  label: string;
  tone?: CallButtonTone;
  onPress: () => void;
  children: ReactNode;
  delay?: number;
  selected?: boolean;
  disabled?: boolean;
  size?: number;
}) {
  const filled = selected === true && tone === 'glass';
  return (
    <Animated.View
      entering={FadeInDown.delay(delay).duration(Motion.screen).springify().damping(18)}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={selected === undefined ? { disabled } : { selected, disabled }}
        style={({ pressed }) => [
          styles.button,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: filled ? CallSurface.onSurface : BACKGROUND[tone],
          },
          disabled && styles.disabled,
          pressed && styles.pressed,
        ]}>
        {children}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.55 },
  pressed: { transform: [{ scale: 0.92 }], opacity: 0.9 },
});
