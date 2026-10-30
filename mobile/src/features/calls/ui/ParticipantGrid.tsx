import { MicOff } from 'lucide-react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { RTCView, type MediaStream } from 'react-native-webrtc';

import { Avatar } from '@/components/avatar';
import { CallMetrics, CallSurface, Radii, Spacing, Type } from '@/constants/theme';
import type { CallParticipant } from '@/lib/calls';
import { SpeakingRing } from './SpeakingRing';

/**
 * Colonnes de la mosaïque : une grande tuile à deux, deux par deux jusqu'à
 * quatre, trois par deux au-delà.
 */
export function gridColumns(count: number): number {
  if (count <= 2) {
    return 1;
  }
  if (count <= 4) {
    return 2;
  }
  return 3;
}

/** Nombre de flux vidéo distants réellement décodés en même temps. */
const MAX_VIDEO_TILES = 3;

export type GridParticipant = CallParticipant & { self?: boolean };

/**
 * Mosaïque des participants, ou tuile choisie en grand avec sa bande de
 * vignettes. La tuile agrandie ne change jamais toute seule.
 */
export function ParticipantGrid({
  participants,
  streams,
  speaking,
  expandedId,
  onExpand,
  audioOnly,
}: {
  participants: GridParticipant[];
  streams: Record<string, MediaStream>;
  speaking: string[];
  expandedId: string | null;
  onExpand: (id: string | null) => void;
  /** Mode économie : plus aucune vidéo distante n'est affichée. */
  audioOnly: boolean;
}) {
  /** Seuls les premiers flux reçus sont décodés, pour épargner les appareils modestes. */
  const decodable = new Map<string, MediaStream>();
  if (!audioOnly) {
    let count = 0;
    for (const participant of participants) {
      const stream = streams[participant.id];
      if (stream && participant.video && count < MAX_VIDEO_TILES) {
        decodable.set(participant.id, stream);
        count += 1;
      }
    }
  }

  const expanded = expandedId ? participants.find((entry) => entry.id === expandedId) : null;

  if (expanded) {
    return (
      <View style={styles.expandedWrap}>
        <Pressable
          onPress={() => onExpand(null)}
          accessibilityRole="button"
          accessibilityLabel="Revenir à la mosaïque"
          style={styles.expandedTile}>
          <ParticipantTile
            participant={expanded}
            stream={decodable.get(expanded.id) ?? null}
            speaking={speaking.includes(expanded.id)}
            size="expanded"
          />
        </Pressable>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.strip}
          style={styles.stripScroll}>
          {participants
            .filter((entry) => entry.id !== expanded.id)
            .map((entry) => (
              <Pressable
                key={entry.id}
                onPress={() => onExpand(entry.id)}
                accessibilityRole="button"
                accessibilityLabel={`Agrandir ${entry.displayName}`}
                style={styles.stripItem}>
                <ParticipantTile
                  participant={entry}
                  stream={null}
                  speaking={speaking.includes(entry.id)}
                  size="thumb"
                />
              </Pressable>
            ))}
        </ScrollView>
      </View>
    );
  }

  const columns = gridColumns(participants.length);
  return (
    <View style={styles.grid}>
      {participants.map((participant) => (
        <Pressable
          key={participant.id}
          onPress={() => onExpand(participant.id)}
          accessibilityRole="button"
          accessibilityLabel={`Agrandir ${participant.displayName}`}
          style={[styles.cell, { width: `${Math.floor(100 / columns)}%` as `${number}%` }]}>
          <ParticipantTile
            participant={participant}
            stream={decodable.get(participant.id) ?? null}
            speaking={speaking.includes(participant.id)}
            size="grid"
          />
        </Pressable>
      ))}
    </View>
  );
}

/** Tuile : vidéo reçue si disponible, sinon avatar ; anneau du locuteur. */
export function ParticipantTile({
  participant,
  stream,
  speaking,
  size,
}: {
  participant: GridParticipant;
  stream: MediaStream | null;
  speaking: boolean;
  size: 'grid' | 'expanded' | 'thumb';
}) {
  const showVideo = Boolean(stream) && participant.video && size !== 'thumb';
  const avatarSize =
    size === 'expanded' ? CallMetrics.avatar : size === 'thumb' ? Spacing.five : CallMetrics.avatarSmall;
  return (
    <Animated.View
      entering={FadeIn.duration(220)}
      exiting={FadeOut.duration(160)}
      style={[styles.tile, size === 'expanded' && styles.tileExpanded, size === 'thumb' && styles.tileThumb]}>
      <SpeakingRing active={speaking} size={avatarSize} />
      {showVideo && stream ? (
        <RTCView streamURL={stream.toURL()} style={styles.video} objectFit="cover" zOrder={0} />
      ) : (
        <Avatar
          name={participant.displayName}
          uri={participant.avatarUrl}
          size={avatarSize}
          variant="user"
          style={participant.connected || participant.self ? undefined : styles.dim}
        />
      )}
      {size !== 'thumb' ? (
        <>
          <Text style={styles.name} numberOfLines={1}>
            {participant.displayName}
          </Text>
          <View style={styles.statusRow}>
            {participant.muted ? (
              <MicOff size={12} strokeWidth={2.4} color={CallSurface.onSurfaceSoft} />
            ) : null}
            <Text style={styles.status} numberOfLines={1}>
              {participant.self
                ? 'vous'
                : !participant.connected
                  ? participant.reconnecting
                    ? 'Reconnexion…'
                    : 'connexion…'
                  : participant.weak
                    ? 'Réseau faible'
                    : participant.video
                      ? 'vidéo'
                      : 'en ligne'}
            </Text>
          </View>
        </>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'center',
    justifyContent: 'center',
    gap: CallMetrics.tileGap,
    paddingHorizontal: Spacing.three,
  },
  cell: { aspectRatio: 0.82, maxWidth: 240 },
  tile: {
    flex: 1,
    borderRadius: Radii.lg,
    backgroundColor: CallSurface.card,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    overflow: 'hidden',
  },
  tileExpanded: { borderRadius: Radii.lg },
  tileThumb: { width: 72, height: 96, padding: Spacing.two, gap: Spacing.one },
  video: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  dim: { opacity: 0.45 },
  name: { ...Type.caption, color: CallSurface.onSurface, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  status: { ...Type.micro, color: CallSurface.onSurfaceSoft },
  expandedWrap: { flex: 1, paddingHorizontal: Spacing.three, gap: Spacing.two },
  expandedTile: { flex: 1 },
  stripScroll: { flexGrow: 0 },
  strip: { gap: Spacing.two, paddingVertical: Spacing.one },
  stripItem: { borderRadius: Radii.lg, overflow: 'hidden' },
});
