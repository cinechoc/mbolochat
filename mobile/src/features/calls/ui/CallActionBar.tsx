import type { ReactNode } from 'react';
import { Phone, PhoneOff } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { CallMetrics, CallSurface, Motion, Spacing, Type } from '@/constants/theme';
import { CallButton, type CallButtonTone } from './CallButton';

export type CallActionItem = {
  key: string;
  label: string;
  icon: ReactNode;
  tone?: CallButtonTone;
  selected?: boolean;
  disabled?: boolean;
  size?: number;
  /** Marque une rupture visuelle (le raccrocher rouge reste à l'écart). */
  separate?: boolean;
  onPress: () => void;
};

/** Barre du bas de l'écran d'appel : les mêmes boutons ronds en 1:1 et en groupe. */
export function CallActionBar({ items }: { items: CallActionItem[] }) {
  return (
    <View style={styles.bar}>
      {items.map((item, index) => (
        <View key={item.key} style={item.separate && styles.separated}>
          <CallButton
            label={item.label}
            tone={item.tone ?? 'glass'}
            selected={item.selected}
            disabled={item.disabled}
            size={item.size ?? CallMetrics.button}
            delay={60 + index * 50}
            onPress={item.onPress}>
            {item.icon}
          </CallButton>
        </View>
      ))}
    </View>
  );
}

/** Refuser / accepter, avec l'option « sans caméra » d'un appel vidéo entrant. */
export function CallIncomingActions({
  video,
  onAccept,
  onDecline,
}: {
  video: boolean;
  onAccept: (withVideo: boolean) => void;
  onDecline: () => void;
}) {
  return (
    <View style={styles.incomingStack}>
      <View style={styles.incomingRow}>
        <CallButton label="Refuser l’appel" tone="hangup" onPress={onDecline} delay={80}>
          <PhoneOff size={30} color={CallSurface.onSurface} />
        </CallButton>
        <CallButton
          label={video ? 'Accepter avec caméra' : 'Accepter l’appel'}
          tone="accept"
          onPress={() => onAccept(video)}
          delay={160}>
          <Phone size={30} color={CallSurface.onSurface} />
        </CallButton>
      </View>
      {video ? (
        <Animated.View entering={FadeInDown.delay(220).duration(Motion.base)}>
          <Pressable
            onPress={() => onAccept(false)}
            accessibilityRole="button"
            accessibilityLabel="Accepter sans caméra"
            hitSlop={8}
            style={({ pressed }) => [styles.noCamera, pressed && styles.pressed]}>
            <Text style={styles.noCameraText}>Répondre sans caméra</Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.four,
    minHeight: CallMetrics.button,
  },
  separated: { marginLeft: Spacing.threeHalf },
  incomingStack: { alignItems: 'center', gap: Spacing.threeHalf },
  incomingRow: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.four + Spacing.threeHalf },
  noCamera: { paddingVertical: Spacing.one + 2, paddingHorizontal: Spacing.threeHalf },
  noCameraText: {
    ...Type.body,
    color: CallSurface.onSurfaceFaint,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  pressed: { opacity: 0.85 },
});
