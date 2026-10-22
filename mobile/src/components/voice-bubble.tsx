import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { formatDuration, type VoiceBubbleProps } from '@/lib/voice';

/**
 * Un message vocal : lecture et mise en pause.
 *
 * Un seul appareil de lecture à la fois dans la conversation — sinon deux voix
 * se superposeraient, ce que personne ne réécoute jamais deux fois.
 */
let playing: ReturnType<typeof useAudioPlayer> | null = null;

export function VoiceBubble({ uri, durationMs, mine, onLongPress }: VoiceBubbleProps) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
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

  const toggle = (): void => {
    if (status.playing) {
      player.pause();
      if (playing === player) {
        playing = null;
      }
      return;
    }
    if (playing && playing !== player) {
      try {
        playing.pause();
      } catch {
        // Le lecteur précédent a déjà été libéré par son composant.
      }
    }
    playing = player;
    player.play();
  };

  return (
    <Pressable
      onPress={toggle}
      onLongPress={onLongPress}
      delayLongPress={320}
      style={[styles.row, mine ? styles.rowMine : null]}
      accessibilityRole="button"
      accessibilityLabel={status.playing ? 'Mettre en pause' : 'Écouter le message vocal'}>
      <ThemedText style={[styles.glyph, mine ? styles.textMine : null]}>
        {status.playing ? '❚❚' : '▶'}
      </ThemedText>
      <View style={[styles.track, mine ? styles.trackMine : null]}>
        <View style={[styles.filled, { width: `${ratio * 100}%` }, mine ? styles.filledMine : null]} />
      </View>
      <ThemedText style={[styles.time, mine ? styles.textMine : null]}>
        {formatDuration(status.playing && played > 0 ? played : total)}
      </ThemedText>
    </Pressable>
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
  glyph: {
    fontSize: 13,
    width: 20,
    textAlign: 'center',
  },
  track: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(0,0,0,0.18)',
    overflow: 'hidden',
  },
  trackMine: {
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  filled: {
    height: 4,
    borderRadius: 2,
    backgroundColor: '#53bdeb',
  },
  filledMine: {
    backgroundColor: '#ffffff',
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
