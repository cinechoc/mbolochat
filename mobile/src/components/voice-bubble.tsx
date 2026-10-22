import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Pause, Play } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatDuration, type VoiceBubbleProps } from '@/lib/voice';

/**
 * Un message vocal : lecture et mise en pause.
 *
 * Un seul appareil de lecture à la fois dans la conversation — sinon deux voix
 * se superposeraient, ce que personne ne réécoute jamais deux fois.
 */
let playing: ReturnType<typeof useAudioPlayer> | null = null;

const BAR_COUNT = 28;
const BAR_MAX_HEIGHT = 26;
const PLAYED_COLOR = '#53bdeb';

/** Forme stable par message, en attendant les niveaux réels du micro. */
function waveform(seed: string): number[] {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ seed.charCodeAt(index), 16777619);
  }
  const next = (): number => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: BAR_COUNT }, (_, index) => {
    const wave = 0.55 + 0.28 * Math.sin(index / 2.1) + 0.17 * Math.sin(index / 0.9 + 1.4);
    return Math.min(1, Math.max(0.2, wave * (0.55 + next() * 0.65)));
  });
}

export function VoiceBubble({ uri, durationMs, mine, onLongPress }: VoiceBubbleProps) {
  const theme = useTheme();
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
  const [waveWidth, setWaveWidth] = useState(0);
  const bars = useMemo(() => waveform(uri), [uri]);
  const total = Math.max(durationMs, (status.duration ?? 0) * 1000);
  const played = Math.min((status.currentTime ?? 0) * 1000, total);
  const ratio = total > 0 ? played / total : 0;

  // La bulle qui a lancé la lecture peut disparaître (message confirmé, liste
  // recyclée) : sa référence ne doit pas rester dans le lecteur global.
  useEffect(
    () => () => {
      if (playing === player) {
        playing = null;
      }
    },
    [player],
  );

  const takeOver = (): void => {
    if (playing && playing !== player) {
      try {
        playing.pause();
      } catch {
        // Le lecteur précédent a déjà été libéré par son composant.
      }
    }
    playing = player;
  };

  const toggle = (): void => {
    if (status.playing) {
      player.pause();
      if (playing === player) {
        playing = null;
      }
      return;
    }
    takeOver();
    player.play();
  };

  const seek = (event: GestureResponderEvent): void => {
    if (waveWidth <= 0 || total <= 0) {
      return;
    }
    const fraction = Math.max(0, Math.min(1, event.nativeEvent.locationX / waveWidth));
    void player.seekTo((fraction * total) / 1000);
    if (!status.playing && fraction < 1) {
      takeOver();
      player.play();
    }
  };

  return (
    <View style={[styles.row, mine ? styles.rowMine : null]}>
      <Pressable
        onPress={toggle}
        onLongPress={onLongPress}
        delayLongPress={320}
        hitSlop={6}
        style={styles.play}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? 'Mettre en pause' : 'Écouter le message vocal'}>
        {status.playing ? (
          <Pause size={16} strokeWidth={2.4} color={mine ? '#ffffff' : theme.text} />
        ) : (
          <Play size={16} strokeWidth={2.4} color={mine ? '#ffffff' : theme.text} />
        )}
      </Pressable>
      <Pressable
        onPress={seek}
        onLongPress={onLongPress}
        delayLongPress={320}
        hitSlop={6}
        onLayout={(event) => setWaveWidth(event.nativeEvent.layout.width)}
        style={styles.wave}
        accessibilityRole="adjustable"
        accessibilityLabel="Position de lecture"
        accessibilityHint="Touche la waveform pour te déplacer dans le message."
        accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}>
        {bars.map((height, index) => {
          const playedBar = (index + 0.5) / BAR_COUNT <= ratio;
          return (
            <View key={index} style={styles.barSlot}>
              <View
                style={[
                  styles.bar,
                  {
                    height: Math.max(4, Math.round(height * BAR_MAX_HEIGHT)),
                    backgroundColor: playedBar
                      ? mine
                        ? '#ffffff'
                        : PLAYED_COLOR
                      : mine
                        ? 'rgba(255, 255, 255, 0.45)'
                        : 'rgba(0, 0, 0, 0.18)',
                  },
                ]}
              />
            </View>
          );
        })}
        {waveWidth > 0 && ratio > 0.005 ? (
          <View
            pointerEvents="none"
            style={[
              styles.playhead,
              {
                left: Math.min(Math.max(ratio * waveWidth - 1, 0), waveWidth - 2),
                backgroundColor: mine ? '#ffffff' : PLAYED_COLOR,
              },
            ]}
          />
        ) : null}
      </Pressable>
      <ThemedText style={[styles.time, mine ? styles.textMine : null]}>
        {formatDuration(status.playing && played > 0 ? played : total)}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minWidth: 190,
    paddingVertical: 4,
  },
  rowMine: {
    minWidth: 190,
  },
  play: {
    width: 20,
    alignItems: 'center',
  },
  wave: {
    flex: 1,
    height: BAR_MAX_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  barSlot: {
    flex: 1,
    alignItems: 'center',
  },
  bar: {
    width: 2.5,
    borderRadius: 1.5,
  },
  playhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    borderRadius: 1,
  },
  time: {
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    minWidth: 34,
    textAlign: 'right',
  },
  textMine: {
    color: '#ffffff',
  },
});
