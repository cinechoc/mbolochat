import { Ionicons } from '@expo/vector-icons';
import { useEffect, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { Radii } from '@/constants/theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export interface ProgressRingProps {
  /** 0..1. Absent ou invalide : arc indéterminé qui tourne. */
  progress?: number | null;
  size?: number;
  strokeWidth?: number;
  color?: string;
  trackColor?: string;
  children?: ReactNode;
}

/**
 * Anneau de progression unique du chat. Le SVG est déjà installé : l'arc est
 * dessiné avec strokeDasharray/strokeDashoffset et animé par Reanimated.
 */
export function ProgressRing({
  progress,
  size = 44,
  strokeWidth = 3,
  color = '#ffffff',
  trackColor = 'rgba(255,255,255,0.3)',
  children,
}: ProgressRingProps) {
  const center = size / 2;
  const radius = Math.max(0, (size - strokeWidth) / 2);
  const circumference = 2 * Math.PI * radius;
  const indeterminate =
    progress === undefined || progress === null || !Number.isFinite(progress);
  const target = indeterminate ? 0 : Math.max(0.05, Math.min(1, progress));

  const value = useSharedValue(target);
  const spin = useSharedValue(0);

  useEffect(() => {
    if (indeterminate) {
      return;
    }
    value.value = withTiming(target, {
      duration: 200,
      easing: Easing.out(Easing.quad),
    });
  }, [indeterminate, target, value]);

  useEffect(() => {
    if (!indeterminate) {
      cancelAnimation(spin);
      spin.value = 0;
      return;
    }
    spin.value = withRepeat(
      withTiming(360, { duration: 950, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(spin);
  }, [indeterminate, spin]);

  const arcProps = useAnimatedProps(
    () => ({
      strokeDashoffset: circumference * (1 - value.value),
    }),
    [circumference],
  );
  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value}deg` }],
  }));

  return (
    <View style={{ width: size, height: size }}>
      {indeterminate ? (
        <Animated.View style={[StyleSheet.absoluteFill, spinStyle]}>
          <Svg width={size} height={size}>
            <Circle
              cx={center}
              cy={center}
              r={radius}
              stroke={trackColor}
              strokeWidth={strokeWidth}
              fill="none"
            />
            <Circle
              cx={center}
              cy={center}
              r={radius}
              stroke={color}
              strokeWidth={strokeWidth}
              fill="none"
              strokeDasharray={[circumference * 0.25, circumference]}
              strokeLinecap="round"
              rotation={-90}
              origin={[center, center]}
            />
          </Svg>
        </Animated.View>
      ) : (
        <Svg width={size} height={size}>
          <Circle
            cx={center}
            cy={center}
            r={radius}
            stroke={trackColor}
            strokeWidth={strokeWidth}
            fill="none"
          />
          <AnimatedCircle
            cx={center}
            cy={center}
            r={radius}
            stroke={color}
            strokeWidth={strokeWidth}
            fill="none"
            strokeDasharray={[circumference]}
            animatedProps={arcProps}
            strokeLinecap="round"
            rotation={-90}
            origin={[center, center]}
          />
        </Svg>
      )}
      <View pointerEvents="none" style={styles.content}>
        {children}
      </View>
    </View>
  );
}

interface UploadStatusBadgeProps {
  visible: boolean;
  progress?: number | null;
  failed?: boolean;
  onRetry?: () => void;
  showRetryLabel?: boolean;
}

/**
 * Pastille d'envoi posée sur un média. Elle reste montée pour que sa
 * disparition puisse être fondue ; invisible, elle ne capte aucun toucher.
 */
export function UploadStatusBadge({
  visible,
  progress,
  failed = false,
  onRetry,
  showRetryLabel = true,
}: UploadStatusBadgeProps) {
  const shown = visible || failed;
  const opacity = useSharedValue(shown ? 1 : 0);

  useEffect(() => {
    opacity.value = withTiming(shown ? 1 : 0, { duration: 150 });
  }, [opacity, shown]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      pointerEvents={shown && failed ? 'box-none' : 'none'}
      style={[StyleSheet.absoluteFill, styles.badge, style]}>
      {failed ? (
        <Pressable
          onPress={onRetry}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Réessayer l’envoi de ce fichier"
          style={styles.failedWrap}>
          <View style={[styles.circle, styles.failedCircle]}>
            <Ionicons name="refresh" size={20} color="#ffffff" />
          </View>
          {showRetryLabel ? <Text style={styles.retryText}>Réessayer</Text> : null}
        </Pressable>
      ) : (
        <View style={[styles.circle, styles.sendingCircle]}>
          <ProgressRing
            progress={progress}
            size={44}
            strokeWidth={3}
            color="#ffffff"
            trackColor="rgba(255,255,255,0.3)">
            <Ionicons name="arrow-up" size={20} color="#ffffff" />
          </ProgressRing>
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  content: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  circle: {
    width: 44,
    height: 44,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendingCircle: {
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  failedCircle: {
    backgroundColor: '#FA5151',
  },
  failedWrap: {
    alignItems: 'center',
    gap: 4,
  },
  retryText: {
    color: '#ffffff',
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radii.xs,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
});
