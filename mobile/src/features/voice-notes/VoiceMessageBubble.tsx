/* eslint-disable react-hooks/refs -- les refs ne sont lues que par les callbacks du geste */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { lockSwipe, unlockSwipe } from '@/lib/swipe-lock';
import { MAX_DURATION_MS, toWaveform } from './useVoiceRecorder';
import { seekVoicePlayback, toggleVoicePlayback, useVoicePlayback } from './voicePlayback';

type Props = {
  /** Identifiant UNIQUE du message (sert à savoir quelle note est en lecture). */
  id: string;
  /** URL distante (Storage, R2…) ou URI locale. */
  uri: string;
  durationMs: number;
  /** Valeurs 0..1 enregistrées avec le message ; sinon une forme générique est affichée. */
  waveform?: number[];
  isMine: boolean;
  /** Point rouge sur les vocaux reçus pas encore écoutés. */
  unplayed?: boolean;
  /** Appelée une seule fois à la première lecture : à persister côté backend. */
  onFirstPlay?: (id: string) => void;
  accentColor?: string;
  /** Fond d'une note reçue (blanc clair, sombre en thème nuit). */
  receivedColor?: string;
  /** Couleur de l'icône, de la durée et des barres actives. */
  foregroundColor?: string;
  barOffColor?: string;
  barOnColor?: string;
  style?: StyleProp<ViewStyle>;
};

function formatTime(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Largeur proportionnelle à la durée (comme WeChat), bornée. */
export function voiceBubbleWidth(durationMs: number, screenW: number): number {
  const minW = 118;
  const maxW = Math.min(screenW * 0.7, 320);
  const ratio = Math.sqrt(Math.min(1, durationMs / MAX_DURATION_MS));
  return Math.round(minW + (maxW - minW) * ratio);
}

/** Forme d'onde de secours, stable pour un même id. */
function fallbackWaveform(id: string, bars: number): number[] {
  let seed = 0;
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  return Array.from({ length: bars }, (_, i) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = (seed % 1000) / 1000;
    return 0.25 + 0.6 * Math.abs(Math.sin(i * 0.55)) * (0.5 + 0.5 * noise);
  });
}

function VoiceMessageBubbleBase({
  id,
  uri,
  durationMs,
  waveform,
  isMine,
  unplayed,
  onFirstPlay,
  accentColor = '#95EC69',
  receivedColor = '#FFFFFF',
  foregroundColor = '#1A1A1A',
  barOffColor,
  barOnColor,
  style,
}: Props) {
  const { width: screenW } = useWindowDimensions();
  const playback = useVoicePlayback(id);
  const [scrub, setScrub] = useState<number | null>(null);
  const track = useRef({ x: 0, width: 1 });

  // Largeur proportionnelle à la durée (comme WeChat), bornée.
  const width = voiceBubbleWidth(durationMs, screenW);

  const barCount = Math.max(8, Math.floor((width - 104) / 5));
  const bars = useMemo(
    () =>
      toWaveform(
        waveform && waveform.length > 0 ? waveform : fallbackWaveform(id, barCount),
        barCount,
      ),
    [waveform, id, barCount],
  );

  const total = playback.durationMs > 0 ? playback.durationMs : durationMs;
  const progress = playback.id === id && total > 0 ? Math.min(1, playback.positionMs / total) : 0;
  const shownProgress = scrub ?? progress;
  const active = playback.id === id;
  const label =
    scrub !== null
      ? formatTime(scrub * total)
      : active && playback.playing
        ? formatTime(total - playback.positionMs)
        : formatTime(durationMs);

  const onPress = useCallback(async () => {
    try {
      const started = await toggleVoicePlayback(id, uri, durationMs);
      if (started && unplayed) onFirstPlay?.(id);
    } catch (e) {
      console.warn('[VoiceMessageBubble] lecture impossible', e);
    }
  }, [id, uri, durationMs, unplayed, onFirstPlay]);

  const ratioFromX = useCallback(
    (x: number) => Math.min(1, Math.max(0, (x - track.current.x) / Math.max(1, track.current.width))),
    [],
  );

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .runOnJS(true)
      .onBegin(() => lockSwipe()) // le swipe de réponse ne doit pas voler le scrubbing
      .activeOffsetX([-6, 6]) // s'active seulement sur un mouvement horizontal
      .failOffsetY([-14, 14]) // laisse le scroll vertical de la liste gagner
      .onStart((e) => setScrub(ratioFromX(e.x)))
      .onUpdate((e) => setScrub(ratioFromX(e.x)))
      .onEnd((e, success) => {
        if (!success) return;
        const ratio = ratioFromX(e.x);
        // On garde le temps du doigt affiché tant que le lecteur n'est pas prêt :
        // le seek attend le chargement pour ne pas être ignoré.
        setScrub(ratio);
        void seekVoicePlayback(id, uri, durationMs, ratio)
          .catch(() => undefined)
          .finally(() => setScrub(null));
      })
      .onFinalize((_e, success) => {
        unlockSwipe();
        if (!success) setScrub(null);
      });

    return pan;
  }, [id, uri, durationMs, ratioFromX]);

  useEffect(() => () => unlockSwipe(), []);

  const bg = isMine ? accentColor : receivedColor;
  const barOff = barOffColor ?? (isMine ? 'rgba(0,0,0,0.25)' : '#D3D3D3');
  const barOn = barOnColor ?? (isMine ? 'rgba(0,0,0,0.78)' : '#1A1A1A');

  return (
    <View style={[styles.row, isMine ? styles.rowMine : styles.rowOther, style]}>
      <GestureDetector gesture={gesture}>
        <View style={[styles.bubble, { width, backgroundColor: bg }]}>
          <View
            pointerEvents="none"
            style={[
              styles.tail,
              isMine ? styles.tailRight : styles.tailLeft,
              { backgroundColor: bg },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              active && playback.playing
                ? 'Mettre en pause le message vocal'
                : `Lire le message vocal de ${formatTime(durationMs)}`
            }
            hitSlop={8}
            onPress={() => void onPress()}
            style={({ pressed }) => [styles.playButton, pressed && styles.pressed]}>
            <Ionicons
              name={active && playback.playing ? 'pause' : 'play'}
              size={20}
              color={foregroundColor}
              style={styles.icon}
            />
          </Pressable>
          <View
            style={styles.waveform}
            onLayout={(e) => {
              track.current = { x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width };
            }}>
            {bars.map((v, i) => (
              <View
                key={i}
                style={[
                  styles.bar,
                  { height: 4 + v * 20, backgroundColor: i / bars.length < shownProgress ? barOn : barOff },
                ]}
              />
            ))}
          </View>
          <Text style={[styles.duration, { color: foregroundColor }]}>{label}</Text>
        </View>
      </GestureDetector>
      {!isMine && unplayed && <View style={styles.unplayedDot} />}
    </View>
  );
}

export const VoiceMessageBubble = memo(VoiceMessageBubbleBase);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginVertical: 2 },
  rowMine: { alignSelf: 'flex-end' },
  rowOther: { alignSelf: 'flex-start' },
  bubble: {
    height: 44,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  tail: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 1,
    top: 15,
    transform: [{ rotate: '45deg' }],
  },
  tailLeft: { left: -5 },
  tailRight: { right: -5 },
  pressed: { opacity: 0.8 },
  playButton: { alignItems: 'center', justifyContent: 'center' },
  icon: { width: 20 },
  waveform: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 28 },
  bar: { width: 2.5, borderRadius: 2 },
  duration: { minWidth: 34, textAlign: 'right', fontSize: 13, fontVariant: ['tabular-nums'] },
  unplayedDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FA5151', marginLeft: 6 },
});
