import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Radii } from '@/constants/theme';

type Props = {
  levels: number[];
  elapsedMs: number;
  cancelling: boolean;
  colors: { bar: string; cancel: string; text: string; dot: string };
};

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Point d'enregistrement : pulsation douce en boucle. */
function PulseDot({ color }: { color: string }) {
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(0.35, { duration: 620, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return <Animated.View style={[styles.dot, { backgroundColor: color }, style]} />;
}

type BarProps = {
  level: number;
  index: number;
  count: number;
  cancelling: boolean;
  barColor: string;
  cancelColor: string;
};

/** Barre d'onde : hauteur lissée entre deux mesures, couleur animée à l'annulation. */
function LiveBar({ level, index, count, cancelling, barColor, cancelColor }: BarProps) {
  const height = useSharedValue(5);
  const cancel = useSharedValue(0);

  useEffect(() => {
    height.value = withTiming(5 + level * 22, {
      duration: 120,
      easing: Easing.out(Easing.cubic),
    });
  }, [level, height]);

  useEffect(() => {
    cancel.value = withTiming(cancelling ? 1 : 0, { duration: 140 });
  }, [cancelling, cancel]);

  const style = useAnimatedStyle(() => ({
    height: height.value,
    backgroundColor: interpolateColor(cancel.value, [0, 1], [barColor, cancelColor]),
  }));

  // Les barres anciennes s'estompent : effet « timeline ».
  const fade = 0.4 + (index / Math.max(1, count - 1)) * 0.6;

  return <Animated.View style={[styles.bar, style, { opacity: fade }]} />;
}

/** Vue d'enregistrement : point pulsé, chrono, onde live — remplace le champ. */
export function RecordingTimeline({ levels, elapsedMs, cancelling, colors }: Props) {
  return (
    <Animated.View entering={FadeIn.duration(120)} style={styles.container}>
      <PulseDot color={colors.dot} />
      <Text style={[styles.time, { color: cancelling ? colors.cancel : colors.text }]}>
        {cancelling ? 'Annuler' : formatDuration(elapsedMs)}
      </Text>
      <View style={styles.bars}>
        {levels.map((level, index) => (
          <LiveBar
            key={index}
            level={level}
            index={index}
            count={levels.length}
            cancelling={cancelling}
            barColor={colors.bar}
            cancelColor={colors.cancel}
          />
        ))}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 10,
    height: 40,
  },
  dot: { width: 8, height: 8, borderRadius: Radii.full},
  time: { fontSize: 13, fontVariant: ['tabular-nums'], minWidth: 42 },
  bars: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 32,
    overflow: 'hidden',
  },
  bar: { width: 2.5, borderRadius: Radii.full},
});
