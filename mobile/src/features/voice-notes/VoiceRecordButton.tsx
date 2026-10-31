/* eslint-disable react-hooks/refs, react-hooks/immutability -- callbacks RNGH/Reanimated exécutés hors rendu */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { LIVE_BARS, MAX_DURATION_MS, VoiceNote, useVoiceRecorder } from './useVoiceRecorder';
import { Radii } from '@/constants/theme';

const DANGER = '#FA5151';
/** Distance (px) à glisser vers le haut pour entrer dans la zone "annuler". */
const CANCEL_DISTANCE = 90;
const BUBBLE_WIDTH = 190;
const BUBBLE_HEIGHT = 76;

export const DEFAULT_VOICE_LABELS = {
  idle: 'Maintenir pour parler',
  release: 'Relâcher pour envoyer',
  hintSend: 'Relâcher pour envoyer · Glisser vers le haut pour annuler',
  hintCancel: 'Relâcher pour annuler',
  tooShort: 'Message trop court',
  permission: 'Autorise le micro dans les réglages pour envoyer un vocal',
  startError: "Impossible de démarrer l'enregistrement",
  remaining: (s: number) => `Il reste ${s} s`,
};

type Props = {
  /** Appelée à l'envoi. C'est ici qu'on upload le fichier et qu'on crée le message. */
  onSend: (note: VoiceNote) => void | Promise<void>;
  onPermissionDenied?: () => void;
  onTooShort?: () => void;
  onError?: (error: unknown) => void;
  disabled?: boolean;
  /** Couleur de la bulle live (vert WeChat par défaut). */
  accentColor?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  idleColor?: string;
  pressedColor?: string;
  labels?: Partial<typeof DEFAULT_VOICE_LABELS>;
};

function formatTime(ms: number) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

type Rect = { x: number; y: number; w: number; h: number };

export function VoiceRecordButton({
  onSend,
  onPermissionDenied,
  onTooShort,
  onError,
  disabled,
  accentColor = '#95EC69',
  style,
  textStyle,
  idleColor = '#FFFFFF',
  pressedColor = '#C9C9C9',
  labels,
}: Props) {
  const L = useMemo(() => ({ ...DEFAULT_VOICE_LABELS, ...labels }), [labels]);

  const containerRef = useRef<React.ComponentRef<typeof View>>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [zone, setZone] = useState<'send' | 'cancel'>('send');
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoneRef = useRef<'send' | 'cancel'>('send');

  const pressed = useSharedValue(0);
  const cancelAnim = useSharedValue(0);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 1400);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const { status, elapsedMs, levels, start, release } = useVoiceRecorder({    onSend: (note) => {
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch {
        /* retour haptique non bloquant */
      }
      Promise.resolve(onSend(note)).catch((e) => onError?.(e));
    },
    onTooShort: () => {
      try {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } catch {
        /* retour haptique non bloquant */
      }
      showNotice(L.tooShort);
      onTooShort?.();
    },
    onPermissionDenied: () => {
      showNotice(L.permission);
      onPermissionDenied?.();
    },
    onError: (error) => {
      showNotice(L.startError);
      onError?.(error);
    },
  });

  const measure = useCallback(() => {
    containerRef.current?.measureInWindow((x, y, w, h) => setRect({ x, y, w, h }));
  }, []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true) // callbacks sur le thread JS : pas de worklet à configurer
        .enabled(!disabled)
        .maxPointers(1)
        .activateAfterLongPress(120)
        .onStart(() => {
          zoneRef.current = 'send';
          setZone('send');
          cancelAnim.value = 0;
          pressed.value = withSpring(1, { damping: 18, stiffness: 260 });
          // Le démarrage passe avant les effets visuels/haptiques : si l'un
          // d'eux échoue sur un appareil, l'enregistrement doit quand même partir.
          void start();
          try {
            measure();
          } catch {
            /* la mesure ne doit pas bloquer le micro */
          }
          try {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          } catch {
            /* retour haptique non bloquant */
          }
        })
        .onUpdate((e) => {
          const next = e.translationY < -CANCEL_DISTANCE ? 'cancel' : 'send';
          if (next !== zoneRef.current) {
            zoneRef.current = next;
            setZone(next);
            cancelAnim.value = withTiming(next === 'cancel' ? 1 : 0, { duration: 140 });
            try {
              Haptics.selectionAsync();
            } catch {
              /* retour haptique non bloquant */
            }
          }
        })
        .onEnd((_e, success) => {
          pressed.value = withSpring(0, { damping: 18, stiffness: 260 });
          // Geste interrompu par le système (appel, etc.) => on annule par sécurité.
          release(!success || zoneRef.current === 'cancel');
        }),
    [disabled, start, release, measure, pressed, cancelAnim],
  );

  const recording = status === 'recording' || status === 'starting';
  const cancelling = recording && zone === 'cancel';

  const buttonStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(pressed.value, [0, 1], [idleColor, pressedColor]),
    transform: [{ scale: interpolate(pressed.value, [0, 1], [1, 0.985]) }],
  }));

  const label = !recording ? L.idle : cancelling ? L.hintCancel : L.release;

  return (
    <View
      ref={containerRef}
      collapsable={false}
      style={[styles.wrap, recording && styles.wrapActive, style]}
    >
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[styles.button, buttonStyle, disabled && styles.disabled]}
          accessible
          accessibilityRole="button"
          accessibilityLabel={L.idle}
        >
          <Text style={[styles.buttonText, textStyle]} numberOfLines={1}>
            {label}
          </Text>
        </Animated.View>
      </GestureDetector>

      {notice && !recording && (
        <Animated.View
          entering={FadeIn.duration(120)}
          exiting={FadeOut.duration(160)}
          pointerEvents="none"
          style={styles.notice}
        >
          <Text style={styles.noticeText}>{notice}</Text>
        </Animated.View>
      )}

      {status === 'recording' && rect && (
        <RecordingOverlay
          rect={rect}
          accentColor={accentColor}
          levels={levels}
          elapsedMs={elapsedMs}
          cancelling={cancelling}
          cancelAnim={cancelAnim}
          labels={L}
        />
      )}
    </View>
  );
}

/* ----------------------------- Overlay plein écran ---------------------------- */

type OverlayProps = {
  rect: Rect;
  accentColor: string;
  levels: number[];
  elapsedMs: number;
  cancelling: boolean;
  cancelAnim: SharedValue<number>;
  labels: typeof DEFAULT_VOICE_LABELS;
};

function RecordingOverlay({
  rect,
  accentColor,
  levels,
  elapsedMs,
  cancelling,
  cancelAnim,
  labels,
}: OverlayProps) {
  const { width: W, height: H } = useWindowDimensions();
  const remainingS = Math.max(0, Math.ceil((MAX_DURATION_MS - elapsedMs) / 1000));
  const showCountdown = remainingS <= 10;

  const bubbleTop = Math.max(90, rect.y * 0.42);
  const bubbleLeft = W / 2 - BUBBLE_WIDTH / 2;

  const bubbleStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(cancelAnim.value, [0, 1], [accentColor, DANGER]),
    transform: [{ scale: interpolate(cancelAnim.value, [0, 1], [1, 0.94]) }],
  }));
  const tailStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(cancelAnim.value, [0, 1], [accentColor, DANGER]),
  }));
  const cancelCircleStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      cancelAnim.value,
      [0, 1],
      ['rgba(255,255,255,0.22)', DANGER],
    ),
    transform: [{ scale: interpolate(cancelAnim.value, [0, 1], [1, 1.3]) }],
  }));

  return (
    // pointerEvents none : le geste reste porté par le bouton, jamais volé par l'overlay.
    <Animated.View
      entering={FadeIn.duration(120)}
      exiting={FadeOut.duration(120)}
      pointerEvents="none"
      style={[styles.overlay, { left: -rect.x, top: -rect.y, width: W, height: H + 160 }]}
    >
      <View style={styles.dim} />

      <Text style={[styles.timer, { top: bubbleTop - 34, width: W }]}>
        {showCountdown ? labels.remaining(remainingS) : formatTime(elapsedMs)}
      </Text>

      <Animated.View style={[styles.bubble, { top: bubbleTop, left: bubbleLeft }, bubbleStyle]}>
        <View style={styles.bars}>
          {levels.slice(-LIVE_BARS).map((level, i) => (
            <LiveBar key={i} level={level} />
          ))}
        </View>
      </Animated.View>
      <Animated.View
        style={[
          styles.tail,
          { top: bubbleTop + BUBBLE_HEIGHT - 8, left: W / 2 - 8 },
          tailStyle,
        ]}
      />

      <Animated.View style={[styles.cancelCircle, { top: rect.y - 160, left: W / 2 - 32 }, cancelCircleStyle]}>
        <Ionicons name="close" size={30} color="#fff" />
      </Animated.View>

      <Text
        style={[
          styles.hint,
          { top: rect.y - 40, width: W },
          cancelling && { color: '#FF8A80' },
        ]}
      >
        {cancelling ? labels.hintCancel : labels.hintSend}
      </Text>
    </Animated.View>
  );
}

function LiveBar({ level }: { level: number }) {
  const h = useSharedValue(4);
  useEffect(() => {
    h.value = withTiming(4 + level * 44, { duration: 90 });
  }, [level, h]);
  const style = useAnimatedStyle(() => ({ height: h.value }));
  return <Animated.View style={[styles.bar, style]} />;
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  wrapActive: { zIndex: 1000, elevation: 1000 },
  button: {
    height: 40,
    borderRadius: Radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  disabled: { opacity: 0.5 },
  buttonText: { fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
  notice: {
    position: 'absolute',
    bottom: 54,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.78)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radii.sm,
  },
  noticeText: { color: '#fff', fontSize: 14 },
  overlay: { position: 'absolute', zIndex: 1000, elevation: 1000 },
  dim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.55)' },
  timer: {
    position: 'absolute',
    textAlign: 'center',
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  bubble: {
    position: 'absolute',
    width: BUBBLE_WIDTH,
    height: BUBBLE_HEIGHT,
    borderRadius: Radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tail: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: Radii.xs,
    transform: [{ rotate: '45deg' }],
  },
  bars: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 52 },
  bar: { width: 3, borderRadius: Radii.full, backgroundColor: 'rgba(0,0,0,0.72)' },
  cancelCircle: {
    position: 'absolute',
    width: 64,
    height: 64,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: {
    position: 'absolute',
    textAlign: 'center',
    color: 'rgba(255,255,255,0.9)',
    fontSize: 13,
  },
});
