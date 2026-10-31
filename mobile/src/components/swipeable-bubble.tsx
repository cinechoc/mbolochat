import { Reply } from 'lucide-react-native';
import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { Spacing, Radii } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { isSwipeLocked } from '@/lib/swipe-lock';

const ACTIVATION = 6;
const MAX_OFFSET = 80;
const TRIGGER = 56;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface SwipeableBubbleProps {
  mine: boolean;
  onReply: () => void;
  onPress?: () => void;
  onLongPress: () => void;
  style: StyleProp<ViewStyle>;
  accessibilityLabel: string;
  children: ReactNode;
}

/**
 * Glisser la bulle vers l'extérieur (droite pour un reçu, gauche pour un
 * envoyé) prépare une réponse, comme dans WhatsApp.
 *
 * Le geste est revendiqué en phase capture uniquement pour un mouvement
 * horizontal : le vertical reste au défilement de la liste et le tap à la
 * bulle.
 */
function useSwipeToReply(direction: 1 | -1, onReply: () => void) {
  const offset = useMemo(() => new Animated.Value(0), []);
  const startPageXRef = useRef(0);

  const reset = useCallback((): void => {
    Animated.spring(offset, {
      toValue: 0,
      speed: 24,
      bounciness: 5,
      useNativeDriver: true,
    }).start();
  }, [offset]);

  const responder = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- callbacks de geste exécutés hors rendu
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponderCapture: (_event, gesture) => {
          if (isSwipeLocked()) {
            return false;
          }
          return (
            Math.abs(gesture.dx) > ACTIVATION &&
            Math.abs(gesture.dx) > Math.abs(gesture.dy) &&
            gesture.dx * direction > 0
          );
        },
        onPanResponderTerminationRequest: () => true,
        onPanResponderGrant: (event, gesture) => {
          startPageXRef.current = event.nativeEvent.pageX - gesture.dx;
        },
        onPanResponderMove: (_event, gesture) => {
          offset.setValue(direction * Math.min(MAX_OFFSET, Math.abs(gesture.dx)));
        },
        onPanResponderRelease: (event) => {
          // Le dernier move peut manquer (machine lente) : la position du
          // relâchement donne la distance réellement parcourue.
          const finalDx = (event.nativeEvent.pageX - startPageXRef.current) * direction;
          const triggered = finalDx >= TRIGGER;
          if (triggered) {
            offset.setValue(direction * MAX_OFFSET);
          }
          reset();
          if (triggered) {
            onReply();
          }
        },
        onPanResponderTerminate: reset,
      }),
    [direction, offset, onReply, reset],
  );

  const inputRange = direction === 1 ? [0, TRIGGER] : [-TRIGGER, 0];
  const opacity = offset.interpolate({ inputRange, outputRange: [0, 1], extrapolate: 'clamp' });
  const scale = offset.interpolate({ inputRange, outputRange: [0.6, 1], extrapolate: 'clamp' });

  return { translateX: offset, hintOpacity: opacity, hintScale: scale, responder };
}

export function SwipeableBubble({
  mine,
  onReply,
  onPress,
  onLongPress,
  style,
  accessibilityLabel,
  children,
}: SwipeableBubbleProps) {
  const theme = useTheme();
  const { translateX, hintOpacity, hintScale, responder } = useSwipeToReply(
    mine ? -1 : 1,
    onReply,
  );

  return (
    <View
      {...responder.panHandlers}
      style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.hint,
          mine ? styles.hintRight : styles.hintLeft,
          { opacity: hintOpacity, transform: [{ scale: hintScale }] },
        ]}>
        <View style={[styles.hintBadge, { backgroundColor: theme.backgroundElement }]}>
          <Reply size={16} strokeWidth={2.4} color={theme.textSecondary} />
        </View>
      </Animated.View>
      <AnimatedPressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={320}
        style={[style, { transform: [{ translateX }] }]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}>
        {children}
      </AnimatedPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    marginVertical: Spacing.half,
  },
  rowMine: {
    justifyContent: 'flex-end',
  },
  rowTheirs: {
    justifyContent: 'flex-start',
  },
  hint: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  hintLeft: {
    left: 12,
  },
  hintRight: {
    right: 12,
  },
  hintBadge: {
    width: 30,
    height: 30,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
