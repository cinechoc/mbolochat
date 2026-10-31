import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { CallSurface, Radii } from '@/constants/theme';

const RING_DURATION = 2200;

/**
 * Anneaux qui respirent autour de l'avatar : l'appelant attend, le locuteur est
 * désigné. `withSequence` est proscrit (crash natif observé) : deux valeurs
 * partagées identiques, décalées par un délai d'amorce.
 */
export function SpeakingRing({
  active,
  size,
  offset = 0,
}: {
  active: boolean;
  size: number;
  /** Décalage visuel entre deux anneaux superposés, en millisecondes. */
  offset?: number;
}) {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (!active) {
      cancelAnimation(progress);
      progress.value = 0;
      return;
    }
    const animation = withRepeat(
      withTiming(1, { duration: RING_DURATION, easing: Easing.out(Easing.quad) }),
      -1,
      false,
    );
    if (offset > 0) {
      // Deux anneaux déphasés : le second repart à zéro après un temps d'attente.
      progress.value = 0;
      const timer = setTimeout(() => {
        progress.value = animation;
      }, offset);
      return () => {
        clearTimeout(timer);
        cancelAnimation(progress);
      };
    }
    progress.value = animation;
    return () => {
      cancelAnimation(progress);
    };
  }, [active, offset, progress]);

  const style = useAnimatedStyle(() => ({
    opacity: 0.35 * (1 - progress.value),
    transform: [{ scale: 1 + progress.value * 0.55 }],
  }));

  if (!active) {
    return null;
  }
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.ring, { width: size, height: size, borderRadius: Radii.full }, style]}
    />
  );
}

const styles = StyleSheet.create({
  ring: {
    position: 'absolute',
    borderWidth: 1.5,
    borderColor: CallSurface.ring,
  },
});
