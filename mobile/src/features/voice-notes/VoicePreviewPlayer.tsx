import React, { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Radii } from '@/constants/theme';

import type { VoiceNote } from './useVoiceRecorder';
import { stopVoicePlayback, toggleVoicePlayback, useVoicePlayback } from './voicePlayback';

type Props = {
  note: VoiceNote;
  colors: { icon: string; barOn: string; barOff: string; text: string };
};

function formatTime(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Nombre de barres lisibles dans la largeur réduite de l'aperçu. */
const PREVIEW_BARS = 22;

/**
 * Mini lecteur du mode aperçu (après un enregistrement verrouillé arrêté) :
 * play/pause, forme d'onde statique colorée par la progression et durée.
 * Il partage le lecteur unique de l'app : écouter l'aperçu coupe toute
 * lecture de bulle en cours, et l'inverse.
 */
function VoicePreviewPlayerBase({ note, colors }: Props) {
  // L'URI locale est unique par capture : elle sert d'identifiant de lecture.
  const id = `preview:${note.uri}`;
  const playback = useVoicePlayback(id);
  const active = playback.id === id;
  const total = active && playback.durationMs > 0 ? playback.durationMs : note.durationMs;
  const progress = active && total > 0 ? Math.min(1, playback.positionMs / total) : 0;

  const bars = useMemo(() => {
    const source = note.waveform.length >= PREVIEW_BARS ? note.waveform : null;
    if (!source) return note.waveform.slice(0, PREVIEW_BARS);
    const out: number[] = [];
    for (let i = 0; i < PREVIEW_BARS; i++) {
      const start = Math.floor((i * source.length) / PREVIEW_BARS);
      const end = Math.max(start + 1, Math.floor(((i + 1) * source.length) / PREVIEW_BARS));
      let sum = 0;
      for (let j = start; j < end; j++) sum += source[j];
      out.push(sum / (end - start));
    }
    return out;
  }, [note.waveform]);

  const playbackRef = useRef(playback);
  useEffect(() => {
    playbackRef.current = playback;
  }, [playback]);
  // Si l'écran est quitté pendant l'aperçu, la lecture s'arrête avec lui.
  useEffect(
    () => () => {
      if (playbackRef.current.id === id) void stopVoicePlayback();
    },
    [id],
  );

  const toggle = useCallback(() => {
    void toggleVoicePlayback(id, note.uri, note.durationMs).catch(() => undefined);
  }, [id, note.uri, note.durationMs]);

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          active && playback.playing ? 'Mettre en pause l’aperçu' : 'Écouter l’enregistrement'
        }
        hitSlop={6}
        onPress={toggle}
        style={({ pressed }) => [styles.play, pressed && styles.pressed]}
      >
        <Ionicons
          name={active && playback.playing ? 'pause' : 'play'}
          size={20}
          color={colors.icon}
        />
      </Pressable>
      <View style={styles.waveform}>
        {bars.map((v, i) => (
          <View
            key={i}
            style={[
              styles.bar,
              { height: 3 + v * 15, backgroundColor: i / bars.length < progress ? colors.barOn : colors.barOff },
            ]}
          />
        ))}
      </View>
      <Text style={[styles.duration, { color: colors.text }]}>
        {formatTime(total - (active ? playback.positionMs : 0))}
      </Text>
    </View>
  );
}

export const VoicePreviewPlayer = memo(VoicePreviewPlayerBase);

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 40 },
  play: { alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
  waveform: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 24,
    overflow: 'hidden',
  },
  bar: { width: 2.5, borderRadius: Radii.full },
  duration: { minWidth: 34, textAlign: 'right', fontSize: 13, fontVariant: ['tabular-nums'] },
});
