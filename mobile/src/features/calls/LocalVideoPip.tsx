import { StyleSheet, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { RTCView } from 'react-native-webrtc';
import { Radii } from '@/constants/theme';

const PIP_WIDTH = 108;
const PIP_HEIGHT = 144;
const MARGIN = 14;
/** Laisse la barre du bas et la carte du haut respirer. */
const BOTTOM_RESERVE = 210;

/**
 * Aperçu local flottant : déplaçable, miroir en caméra frontale.
 */
export function LocalVideoPip({ streamURL, mirror }: { streamURL: string; mirror: boolean }) {
  const { width, height } = useWindowDimensions();
  const startX = width - PIP_WIDTH - MARGIN;
  const startY = height - PIP_HEIGHT - BOTTOM_RESERVE;
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);

  const pan = Gesture.Pan()
    .onStart(() => {
      originX.value = translateX.value;
      originY.value = translateY.value;
    })
    .onUpdate((event) => {
      const nextX = originX.value + event.translationX;
      const nextY = originY.value + event.translationY;
      translateX.value = Math.min(
        Math.max(nextX, -startX + MARGIN),
        width - PIP_WIDTH - MARGIN - startX,
      );
      translateY.value = Math.min(
        Math.max(nextY, -startY + MARGIN + 60),
        height - PIP_HEIGHT - MARGIN - startY,
      );
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.pip, { left: startX, top: startY }, animatedStyle]}
        accessibilityLabel="Votre caméra">
        <RTCView
          streamURL={streamURL}
          style={styles.video}
          objectFit="cover"
          mirror={mirror}
          zOrder={1}
        />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  pip: {
    position: 'absolute',
    width: PIP_WIDTH,
    height: PIP_HEIGHT,
    borderRadius: Radii.md,
    overflow: 'hidden',
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  video: { flex: 1 },
});
