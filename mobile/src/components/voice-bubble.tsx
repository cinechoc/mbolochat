import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Pause, Play } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { Spacing, Radii } from '@/constants/theme';
import { lockSwipe, unlockSwipe } from '@/lib/swipe-lock';
import { formatDuration, type VoiceBubbleProps } from '@/lib/voice';

/**
 * Un message vocal : lecture et mise en pause.
 *
 * Un seul appareil de lecture à la fois dans la conversation — sinon deux voix
 * se superposeraient, ce que personne ne réécoute jamais deux fois.
 */
let playing: ReturnType<typeof useAudioPlayer> | null = null;

type Player = ReturnType<typeof useAudioPlayer>;

function claimPlayback(player: Player): void {
  if (playing && playing !== player) {
    try {
      playing.pause();
    } catch {
      // Le lecteur précédent a déjà été libéré par son composant.
    }
  }
  playing = player;
}

function releasePlayback(player: Player): void {
  if (playing === player) {
    playing = null;
  }
}

const BAR_COUNT = 28;
const BAR_MAX_HEIGHT = 26;
const PLAYED_COLOR = '#53bdeb';
const LONG_PRESS_MS = 320;
const SETTLE_MS = 280;

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

export function VoiceBubble({
  uri,
  durationMs,
  mine,
  avatarUrl,
  avatarGender,
  senderName,
  onLongPress,
}: VoiceBubbleProps) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
  const [waveWidth, setWaveWidth] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const bars = useMemo(() => waveform(uri), [uri]);
  const total = Math.max(durationMs, (status.duration ?? 0) * 1000);
  const played = Math.min((status.currentTime ?? 0) * 1000, total);
  const ratio = total > 0 ? played / total : 0;
  const displayedRatio = preview ?? ratio;

  const widthRef = useRef(0);
  const playerRef = useRef(player);
  const totalRef = useRef(total);
  const playingRef = useRef(status.playing);
  const previewRef = useRef<number | null>(null);
  const touchRef = useRef<{
    startX: number;
    startY: number;
    at: number;
    dragging: boolean;
    moved: boolean;
    wasPlaying: boolean;
  } | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    playerRef.current = player;
  }, [player]);
  useEffect(() => {
    totalRef.current = total;
  }, [total]);
  useEffect(() => {
    playingRef.current = status.playing;
  }, [status.playing]);

  // La bulle qui a lancé la lecture peut disparaître (message confirmé, liste
  // recyclée) : sa référence ne doit pas rester dans le lecteur global.
  useEffect(
    () => () => {
      releasePlayback(player);
    },
    [player],
  );

  useEffect(
    () => () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
      }
      unlockSwipe();
    },
    [],
  );

  const takeOver = (): void => {
    claimPlayback(player);
  };

  const toggle = (): void => {
    if (status.playing) {
      player.pause();
      releasePlayback(player);
      return;
    }
    takeOver();
    player.play();
  };

  const setPreviewValue = useCallback((value: number | null): void => {
    previewRef.current = value;
    setPreview(value);
  }, []);

  const fractionAt = (x: number): number => {
    const width = widthRef.current;
    if (width <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(1, x / width));
  };

  const finishSeek = useCallback(
    (fraction: number, resume: boolean): void => {
      if (totalRef.current <= 0) {
        return;
      }
      void playerRef.current.seekTo((fraction * totalRef.current) / 1000);
      setPreviewValue(fraction);
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
      }
      // La position du lecteur met un instant à suivre : on garde l'aperçu
      // pendant ce temps pour éviter un retour visuel en arrière.
      settleTimerRef.current = setTimeout(() => setPreviewValue(null), SETTLE_MS);
      if (resume) {
        claimPlayback(playerRef.current);
        playerRef.current.play();
      } else {
        // Après la fin d'un vocal, ExoPlayer reste en `playWhenReady` : sans
        // cette pause, un simple déplacement relancerait la lecture.
        playerRef.current.pause();
      }
    },
    [setPreviewValue],
  );

  // Le scrub passe par les événements tactiles bruts : sans revendiquer le
  // responder, la liste garde son défilement vertical natif. Un geste
  // horizontal met la lecture en pause et l'aperçu suit le doigt.
  const onWaveTouchStart = (event: GestureResponderEvent): void => {
    // La waveform a son propre geste horizontal : il ne doit pas se cumuler
    // avec le glissement de la bulle pour répondre.
    event.stopPropagation();
    lockSwipe();
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    touchRef.current = {
      startX: event.nativeEvent.locationX,
      startY: event.nativeEvent.locationY,
      at: Date.now(),
      dragging: false,
      moved: false,
      wasPlaying: playingRef.current,
    };
  };

  const onWaveTouchMove = (event: GestureResponderEvent): void => {
    event.stopPropagation();
    const touch = touchRef.current;
    if (!touch) {
      return;
    }
    const dx = event.nativeEvent.locationX - touch.startX;
    const dy = event.nativeEvent.locationY - touch.startY;
    if (!touch.dragging) {
      if (Math.abs(dy) > 4 && Math.abs(dy) > Math.abs(dx)) {
        touch.moved = true;
        return;
      }
      if (Math.abs(dx) <= 4) {
        return;
      }
      touch.dragging = true;
      if (touch.wasPlaying) {
        playerRef.current.pause();
        releasePlayback(playerRef.current);
      }
    }
    setPreviewValue(fractionAt(touch.startX + dx));
  };

  const onWaveTouchEnd = (event: GestureResponderEvent): void => {
    event.stopPropagation();
    unlockSwipe();
    const touch = touchRef.current;
    touchRef.current = null;
    if (!touch) {
      return;
    }
    if (touch.dragging) {
      finishSeek(
        previewRef.current ?? fractionAt(touch.startX),
        touch.wasPlaying,
      );
      return;
    }
    if (touch.moved) {
      return;
    }
    const endX = Math.abs(event.nativeEvent.locationX - touch.startX);
    const endY = Math.abs(event.nativeEvent.locationY - touch.startY);
    if (endX > 8 || endY > 8) {
      return;
    }
    // Un appui long ouvre le menu : il ne doit pas déplacer la lecture.
    if (Date.now() - touch.at >= LONG_PRESS_MS) {
      return;
    }
    finishSeek(fractionAt(event.nativeEvent.locationX), playingRef.current);
  };

  const onWaveTouchCancel = (event: GestureResponderEvent): void => {
    event.stopPropagation();
    unlockSwipe();
    const touch = touchRef.current;
    touchRef.current = null;
    if (touch?.dragging) {
      if (touch.wasPlaying) {
        finishSeek(previewRef.current ?? fractionAt(touch.startX), true);
      } else {
        setPreviewValue(null);
      }
    }
  };

  const onWaveLayout = (width: number): void => {
    widthRef.current = width;
    setWaveWidth(width);
  };

  const onSeekAction = (event: AccessibilityActionEvent): void => {
    const delta = event.nativeEvent.actionName === 'increment' ? 5 : -5;
    const next = Math.max(0, Math.min(total / 1000, (status.currentTime ?? 0) + delta));
    void player.seekTo(next);
  };

  return (
    <View style={[styles.row, mine ? styles.rowMine : null]}>
      <Pressable
        onPress={toggle}
        onLongPress={onLongPress}
        delayLongPress={LONG_PRESS_MS}
        hitSlop={6}
        style={styles.play}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? 'Mettre en pause' : 'Écouter le message vocal'}>
        <Avatar name={senderName ?? ''} uri={avatarUrl} size={36} gender={avatarGender} />
        <View style={styles.playBadge}>
          {status.playing ? (
            <Pause size={8} strokeWidth={3} color="#ffffff" fill="#ffffff" />
          ) : (
            <Play size={8} strokeWidth={3} color="#ffffff" fill="#ffffff" />
          )}
        </View>
      </Pressable>
      <View
        onTouchStart={onWaveTouchStart}
        onTouchMove={onWaveTouchMove}
        onTouchEnd={onWaveTouchEnd}
        onTouchCancel={onWaveTouchCancel}
        onLayout={(event) => onWaveLayout(event.nativeEvent.layout.width)}
        style={styles.wave}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Position de lecture"
        accessibilityHint="Glisse pour te déplacer dans le message."
        accessibilityValue={{ min: 0, max: 100, now: Math.round(displayedRatio * 100) }}
        accessibilityActions={[
          { name: 'increment', label: 'Avancer de 5 secondes' },
          { name: 'decrement', label: 'Reculer de 5 secondes' },
        ]}
        onAccessibilityAction={onSeekAction}>
        {bars.map((height, index) => {
          const playedBar = (index + 0.5) / BAR_COUNT <= displayedRatio;
          return (
            <View key={index} pointerEvents="none" style={styles.barSlot}>
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
        {waveWidth > 0 && displayedRatio > 0.005 ? (
          <View
            pointerEvents="none"
            style={[
              styles.playhead,
              { left: Math.min(Math.max(displayedRatio * waveWidth - 4, 0), waveWidth - 8) },
            ]}>
            <View
              style={[styles.playheadDot, { backgroundColor: mine ? '#ffffff' : PLAYED_COLOR }]}
            />
          </View>
        ) : null}
      </View>
      <ThemedText style={[styles.time, mine ? styles.textMine : null]}>
        {formatDuration(
          preview !== null ? preview * total : status.playing && played > 0 ? played : total,
        )}
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
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBadge: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 15,
    height: 15,
    borderRadius: Radii.full,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
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
    borderRadius: Radii.full,
  },
  playhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playheadDot: {
    width: 7,
    height: 7,
    borderRadius: Radii.full,
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
