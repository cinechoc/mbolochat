import type { LucideIcon } from 'lucide-react-native';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

const ACTION_WIDTH = 88;
const SPRING = { damping: 20, stiffness: 250, mass: 0.6 };
const OPEN_THRESHOLD = 32;

export interface SwipeAction {
  key: string;
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  /** Fond du bouton (bleu de marque par défaut). */
  background?: string;
}

interface SwipeableRowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Actions révélées en glissant vers la droite. */
  left: SwipeAction[];
  /** Actions révélées en glissant vers la gauche. */
  right: SwipeAction[];
  children: ReactNode;
}

/**
 * Ligne de liste glissable : révèle des actions sur les côtés.
 * Une seule ligne reste ouverte à la fois (l'écran pilote `open`).
 */
export function SwipeableRow({ open, onOpenChange, left, right, children }: SwipeableRowProps) {
  const theme = useTheme();
  const tx = useSharedValue(0);
  const startX = useSharedValue(0);
  const [side, setSide] = useState<'left' | 'right' | null>(null);
  const leftWidth = left.length * ACTION_WIDTH;
  const rightWidth = right.length * ACTION_WIDTH;

  const close = useCallback(() => {
    tx.value = withSpring(0, SPRING);
    setSide(null);
    onOpenChange(false);
  }, [onOpenChange, tx]);

  // Fermeture demandée par l'écran (autre ligne ouverte, défilement, navigation).
  useEffect(() => {
    if (!open && side !== null) close();
  }, [open, side, close]);

  const opened = useCallback(
    (next: 'left' | 'right') => {
      setSide(next);
      onOpenChange(true);
    },
    [onOpenChange],
  );

  const closed = useCallback(() => {
    setSide(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-14, 14])
    .onBegin(() => {
      startX.value = tx.value;
    })
    .onUpdate((event) => {
      const next = startX.value + event.translationX;
      tx.value = Math.min(leftWidth, Math.max(-rightWidth, next));
    })
    .onEnd((event) => {
      const next = startX.value + event.translationX;
      if (next > OPEN_THRESHOLD && leftWidth > 0) {
        tx.value = withSpring(leftWidth, SPRING);
        runOnJS(opened)('left');
      } else if (next < -OPEN_THRESHOLD && rightWidth > 0) {
        tx.value = withSpring(-rightWidth, SPRING);
        runOnJS(opened)('right');
      } else {
        tx.value = withSpring(0, SPRING);
        runOnJS(closed)();
      }
    });

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
  }));

  const renderActions = (actions: SwipeAction[], align: 'flex-start' | 'flex-end') => (
    <View style={[styles.actions, { justifyContent: align }]}>
      {actions.map((action) => (
        <Pressable
          key={action.key}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={() => {
            close();
            action.onPress();
          }}
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: action.background ?? '#3c87f7', opacity: pressed ? 0.85 : 1 },
          ]}>
          <Icon icon={action.icon} size={20} color="#ffffff" />
          <ThemedText style={styles.label} numberOfLines={2}>
            {action.label}
          </ThemedText>
        </Pressable>
      ))}
    </View>
  );

  return (
    <View style={[styles.wrap, { backgroundColor: theme.background }]}>
      {left.length > 0 ? renderActions(left, 'flex-start') : null}
      {right.length > 0 ? renderActions(right, 'flex-end') : null}
      <GestureDetector gesture={pan}>
        <Animated.View style={contentStyle}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  actions: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  action: {
    width: ACTION_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  label: { color: '#ffffff', fontWeight: '600', fontSize: 11, textAlign: 'center' },
});
