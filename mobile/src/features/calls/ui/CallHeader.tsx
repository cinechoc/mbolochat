import type { ReactNode } from 'react';
import { ChevronDown, PhoneOff, Volume2 } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { CallMetrics, CallSurface, Motion, Radii, Spacing, Type } from '@/constants/theme';
import { CallTimer } from './CallTimer';

/**
 * Carte d'en-tête de l'écran d'appel : réduire, identité, minuteur ou état,
 * haut-parleur et raccrocher. La même en un à un et en groupe (le compteur de
 * participants passe simplement dans `detail`).
 */
export function CallHeader({
  title,
  status,
  detail,
  startedAt,
  timing,
  avatar,
  onMinimize,
  onHangup,
  hangupLabel,
  speaker,
}: {
  title: string;
  status: string;
  /** Mention discrète à droite de l'état (chemin réseau en développement). */
  detail?: string | null;
  startedAt: number | null;
  timing: boolean;
  avatar: ReactNode;
  onMinimize: () => void;
  onHangup: () => void;
  hangupLabel: string;
  speaker?: { on: boolean; onPress: () => void };
}) {
  return (
    <Animated.View entering={FadeInDown.duration(Motion.screen)} style={styles.card}>
      <Pressable
        onPress={onMinimize}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Réduire l’appel"
        style={({ pressed }) => [styles.icon, pressed && styles.pressed]}>
        <ChevronDown size={20} strokeWidth={2.4} color={CallSurface.onSurface} />
      </Pressable>
      {avatar}
      <View style={styles.identity}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {timing ? (
          <View style={styles.statusRow}>
            <CallTimer startedAt={startedAt} active={timing} />
            {detail ? <Text style={styles.detail}>{detail}</Text> : null}
          </View>
        ) : (
          <Text style={styles.status} numberOfLines={1}>
            {status}
            {detail ? ` · ${detail}` : ''}
          </Text>
        )}
      </View>
      {speaker ? (
        <Pressable
          onPress={speaker.onPress}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={speaker.on ? 'Désactiver le haut-parleur' : 'Activer le haut-parleur'}
          accessibilityState={{ selected: speaker.on }}
          style={({ pressed }) => [
            styles.icon,
            speaker.on && styles.iconOn,
            pressed && styles.pressed,
          ]}>
          <Volume2 size={19} color={CallSurface.onSurface} />
        </Pressable>
      ) : null}
      <Pressable
        onPress={onHangup}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={hangupLabel}
        style={({ pressed }) => [styles.hangup, pressed && styles.pressed]}>
        <PhoneOff size={21} strokeWidth={2.2} color={CallSurface.onSurface} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Radii.md,
    backgroundColor: CallSurface.card,
  },
  icon: {
    width: CallMetrics.cardIcon,
    height: CallMetrics.cardIcon,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: CallSurface.glass,
  },
  iconOn: { backgroundColor: CallSurface.glassStrong },
  hangup: {
    width: CallMetrics.hangup,
    height: CallMetrics.hangup,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: CallSurface.hangup,
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.94 }] },
  identity: { flex: 1, minWidth: 0 },
  title: { ...Type.body, color: CallSurface.onSurface, fontWeight: '600' },
  status: { ...Type.caption, color: CallSurface.onSurfaceSoft, marginTop: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.one },
  detail: { ...Type.micro, color: CallSurface.onSurfaceSoft },
});
