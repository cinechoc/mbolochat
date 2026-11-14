import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Animated, {
  Easing,
  FadeIn,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  ZoomIn,
} from 'react-native-reanimated';

import { Radii, Type } from '@/constants/theme';
import { fr } from '@/i18n/fr';

import type { VoiceGestureZone } from './voice-gesture';

type Props = {
  levels: number[];
  elapsedMs: number;
  /** Zone de glissement active : teinte l'onde et remplace les indices. */
  zone: VoiceGestureZone;
  /** Indices masqués une fois l'enregistrement verrouillé (doigt relevé). */
  showHints: boolean;
  colors: { bar: string; cancel: string; text: string; dot: string; hint: string };
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
    height.value = withTiming(3 + level * 15, {
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

/** Ligne d'indices : les deux gestes de glissement, ou le message de zone. */
function HintLine({
  zone,
  showHints,
  colors,
}: {
  zone: VoiceGestureZone;
  showHints: boolean;
  colors: { cancel: string; hint: string };
}) {
  if (zone === 'cancel') {
    return (
      <Animated.View entering={ZoomIn.duration(140)} style={styles.hintLine}>
        <MaterialCommunityIcons
          name="trash-can-outline"
          size={13}
          color={colors.cancel}
        />
        <Text style={[styles.hint, { color: colors.cancel }]}>
          {fr.chat.voiceRecord.releaseToCancel}
        </Text>
      </Animated.View>
    );
  }
  if (zone === 'lock') {
    return (
      <Animated.View entering={ZoomIn.duration(140)} style={styles.hintLine}>
        <MaterialCommunityIcons
          name="lock-outline"
          size={12}
          color={colors.hint}
        />
        <Text style={[styles.hint, { color: colors.hint }]}>
          {fr.chat.voiceRecord.releaseToLock}
        </Text>
      </Animated.View>
    );
  }
  if (!showHints) return <View style={styles.hintLine} />;
  return (
    <View style={styles.hintLine}>
      <Text numberOfLines={1} style={[styles.hint, styles.hintLeft, { color: colors.hint }]}>
        {fr.chat.voiceRecord.hintCancel}
      </Text>
      <Text numberOfLines={1} style={[styles.hint, styles.hintRight, { color: colors.hint }]}>
        {fr.chat.voiceRecord.hintLock}
      </Text>
    </View>
  );
}

/** Vue d'enregistrement : chrono, onde live et indices de glissement. */
export function RecordingTimeline({ levels, elapsedMs, zone, showHints, colors }: Props) {
  return (
    <Animated.View entering={FadeIn.duration(120)} style={styles.container}>
      <View style={styles.track}>
        <PulseDot color={colors.dot} />
        <Text style={[styles.time, { color: colors.text }]}>{formatDuration(elapsedMs)}</Text>
        <View style={styles.bars}>
          {levels.map((level, index) => (
            <LiveBar
              key={index}
              level={level}
              index={index}
              count={levels.length}
              cancelling={zone === 'cancel'}
              barColor={colors.bar}
              cancelColor={colors.cancel}
            />
          ))}
        </View>
      </View>
      <HintLine zone={zone} showHints={showHints} colors={colors} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    gap: 1,
    paddingLeft: 10,
    height: 40,
  },
  track: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: { width: 8, height: 8, borderRadius: Radii.full },
  time: { fontSize: 13, fontVariant: ['tabular-nums'], minWidth: 42 },
  bars: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 22,
    overflow: 'hidden',
  },
  bar: { width: 2.5, borderRadius: Radii.full },
  hintLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 15,
    paddingHorizontal: 2,
  },
  hint: { flexShrink: 1, ...Type.micro, fontVariant: ['tabular-nums'] },
  hintLeft: { textAlign: 'left' },
  hintRight: { marginLeft: 'auto', textAlign: 'right' },
});
