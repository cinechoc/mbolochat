import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { OutboxItem } from '@/lib/store';
import type { Message } from '@/lib/types';

import { albumGridLayout } from './album';
import { formatMediaDuration } from './mediaLayout';
import { mediaUrl } from './mediaUrl';
import { VideoThumb } from './MediaMessage';
import { UploadStatusBadge } from './ProgressRing';

interface AlbumTile {
  message: Message;
  uri: string;
  video: boolean;
  duration: string;
  sending: boolean;
  failed: boolean;
  progress: number | null;
  clientId: string | null;
}

export interface AlbumMessageBubbleProps {
  messages: Message[];
  queuedById: Map<string, OutboxItem>;
  width: number;
  onOpen: (messages: Message[], index: number) => void;
  onLongPress: (message: Message) => void;
  onRetry: (clientId: string) => void;
}

export const AlbumMessageBubble = memo(function AlbumMessageBubble({
  messages,
  queuedById,
  width,
  onOpen,
  onLongPress,
  onRetry,
}: AlbumMessageBubbleProps) {
  const tiles = useMemo(() => {
    const next: AlbumTile[] = [];
    for (const message of messages) {
      const attachment = message.attachment;
      if (!attachment) continue;
      const queued = queuedById.get(message.id);
      const failed =
        !!queued &&
        (queued.status === 'failed' ||
          (queued.kind !== 'audio' && queued.status === 'pending' && queued.error !== null));
      const video = attachment.type === 'VIDEO';
      const knownProgress =
        queued?.uploadedBytes !== null && queued?.uploadedBytes !== undefined;
      next.push({
        message,
        uri: mediaUrl(attachment.url),
        video,
        duration: video ? formatMediaDuration(attachment.duration) : '',
        sending: !!queued && !failed,
        failed,
        progress: knownProgress ? (queued?.progress ?? null) : null,
        clientId: queued?.clientId ?? null,
      });
    }
    return next;
  }, [messages, queuedById]);

  const layout = useMemo(() => albumGridLayout(tiles.length, width), [tiles.length, width]);
  const tileMessages = useMemo(() => tiles.map((tile) => tile.message), [tiles]);
  const tileStyles = useMemo(
    () =>
      layout.tiles.map((tile) => ({
        left: tile.x,
        top: tile.y,
        width: tile.width,
        height: tile.height,
      })),
    [layout],
  );

  const shown = tiles.slice(0, layout.visible);

  return (
    <View style={[styles.grid, { width: layout.width, height: layout.height }]}>
      {shown.map((tile, index) => {
        const hasOverflow = layout.overflow > 0 && index === shown.length - 1;
        const label = tile.video
          ? `Lire la vidéo ${index + 1} sur ${tiles.length}`
          : `Ouvrir la photo ${index + 1} sur ${tiles.length}`;
        return (
          <Pressable
            key={tile.message.id}
            onPress={
              tile.failed
                ? () => {
                    if (tile.clientId) onRetry(tile.clientId);
                  }
                : () => onOpen(tileMessages, index)
            }
            onLongPress={() => onLongPress(tile.message)}
            delayLongPress={320}
            accessibilityRole="button"
            accessibilityLabel={
              tile.failed ? 'Réessayer l’envoi de ce fichier' : label
            }
            style={[styles.tile, tileStyles[index]]}>
            {tile.video ? (
              <View style={styles.videoBackground}>
                <VideoThumb uri={tile.uri} />
              </View>
            ) : (
              <Image
                source={{ uri: tile.uri }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={120}
              />
            )}

            {tile.video ? (
              <>
                <View style={styles.playCircle}>
                  <Ionicons name="play" size={18} color="#ffffff" />
                </View>
                {tile.duration ? (
                  <View style={styles.durationPill}>
                    <Text style={styles.durationText}>{tile.duration}</Text>
                  </View>
                ) : null}
              </>
            ) : null}

            {hasOverflow && !tile.failed ? (
              <View pointerEvents="none" style={styles.overflowVeil}>
                <Text style={styles.overflowText}>+{layout.overflow}</Text>
              </View>
            ) : null}

            <UploadStatusBadge
              visible={tile.sending}
              failed={tile.failed}
              progress={tile.progress === null ? undefined : tile.progress / 100}
              onRetry={() => {
                if (tile.clientId) onRetry(tile.clientId);
              }}
            />

            {hasOverflow && (tile.failed || tile.sending) ? (
              <View pointerEvents="none" style={styles.overflowBadge}>
                <Text style={styles.overflowBadgeText}>+{layout.overflow}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  grid: {
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  tile: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: '#1C1C1E',
  },
  videoBackground: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#1C1C1E',
  },
  playCircle: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 34,
    height: 34,
    marginTop: -17,
    marginLeft: -17,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  durationPill: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  durationText: {
    color: '#ffffff',
    fontSize: 10,
    lineHeight: 13,
    fontVariant: ['tabular-nums'],
  },
  overflowVeil: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  overflowText: {
    color: '#ffffff',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '600',
  },
  overflowBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  overflowBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '600',
  },
});
