import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import {
  createVideoPlayer,
  type VideoPlayer,
  type VideoThumbnail,
} from 'expo-video';
import { memo, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useChatColors } from '@/constants/chat-theme';
import { Spacing } from '@/constants/theme';

import {
  documentVisual,
  formatFileSize,
  formatMediaDuration,
  middleTruncate,
} from './mediaLayout';
import { ProgressRing, UploadStatusBadge } from './ProgressRing';

interface ImageBubbleProps {
  uri: string;
  width: number;
  height: number;
  sending?: boolean;
  progress?: number | null;
  failed?: boolean;
  onRetry?: () => void;
  onPress: () => void;
  onLongPress: () => void;
}

export const ImageMessageBubble = memo(function ImageMessageBubble({
  uri,
  width,
  height,
  sending,
  progress,
  failed,
  onRetry,
  onPress,
  onLongPress,
}: ImageBubbleProps) {
  return (
    <Pressable
      onPress={failed && onRetry ? onRetry : onPress}
      onLongPress={onLongPress}
      delayLongPress={320}
      accessibilityRole="button"
      accessibilityLabel={failed ? 'Réessayer l’envoi de cette photo' : 'Ouvrir la photo'}
      style={[styles.mediaFrame, { width, height }]}>
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        transition={120}
      />
      <UploadStatusBadge
        visible={!!sending}
        failed={failed}
        progress={progress === null || progress === undefined ? undefined : progress / 100}
        onRetry={onRetry}
      />
    </Pressable>
  );
});

interface VideoBubbleProps {
  uri: string;
  width: number;
  height: number;
  durationMs?: number;
  sending?: boolean;
  progress?: number | null;
  failed?: boolean;
  onRetry?: () => void;
  onPress: () => void;
  onLongPress: () => void;
}

function useVideoThumbnail(uri: string): VideoThumbnail | null {
  const [result, setResult] = useState<{ uri: string; thumbnail: VideoThumbnail } | null>(null);

  useEffect(() => {
    let active = true;
    let player: VideoPlayer | null = null;
    let subscription: { remove: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const waitForPlayer = () =>
      new Promise<void>((resolve) => {
        if (!player || player.status === 'readyToPlay' || player.status === 'error') {
          resolve();
          return;
        }
        subscription = player.addListener('statusChange', ({ status }) => {
          if (status === 'readyToPlay' || status === 'error') {
            subscription?.remove();
            subscription = null;
            resolve();
          }
        });
        timer = setTimeout(() => {
          subscription?.remove();
          subscription = null;
          resolve();
        }, 4000);
      });

    const generate = async () => {
      try {
        player = createVideoPlayer(uri);
        await waitForPlayer();
        if (!active || !player) return;
        const [thumbnail] = await player.generateThumbnailsAsync(0, { maxWidth: 640 });
        if (active && thumbnail) {
          setResult({ uri, thumbnail });
        }
      } catch {
        // La miniature est optionnelle : fond sombre + icône en secours.
      } finally {
        if (timer) clearTimeout(timer);
        subscription?.remove();
        subscription = null;
        player?.release();
        player = null;
      }
    };

    void generate();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      subscription?.remove();
      player?.release();
      player = null;
    };
  }, [uri]);

  return result?.uri === uri ? result.thumbnail : null;
}

/** Miniature d'une tuile vidéo, sans contrôles ni lecture. */
export function VideoThumb({ uri }: { uri: string }) {
  const thumbnail = useVideoThumbnail(uri);
  return thumbnail ? (
    <Image source={thumbnail} style={StyleSheet.absoluteFill} contentFit="cover" />
  ) : null;
}

export const VideoMessageBubble = memo(function VideoMessageBubble({
  uri,
  width,
  height,
  durationMs,
  sending,
  progress,
  failed,
  onRetry,
  onPress,
  onLongPress,
}: VideoBubbleProps) {
  const thumbnail = useVideoThumbnail(uri);
  const duration = formatMediaDuration(durationMs);

  return (
    <Pressable
      onPress={failed && onRetry ? onRetry : onPress}
      onLongPress={onLongPress}
      delayLongPress={320}
      accessibilityRole="button"
      accessibilityLabel={failed ? 'Réessayer l’envoi de cette vidéo' : 'Lire la vidéo'}
      style={[styles.mediaFrame, styles.videoFrame, { width, height }]}>
      {thumbnail ? (
        <Image source={thumbnail} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : null}
      <View style={styles.playCircle}>
        <Ionicons name="play" size={26} color="#ffffff" />
      </View>
      {duration ? (
        <View style={styles.durationPill}>
          <Text style={styles.durationText}>{duration}</Text>
        </View>
      ) : null}
      <UploadStatusBadge
        visible={!!sending}
        failed={failed}
        progress={progress === null || progress === undefined ? undefined : progress / 100}
        onRetry={onRetry}
      />
    </Pressable>
  );
});

interface DocumentBubbleProps {
  name: string;
  mime: string;
  size: number | null;
  width: number;
  mine: boolean;
  sending?: boolean;
  progress?: number | null;
  uploadedBytes?: number | null;
  totalBytes?: number | null;
  failed?: boolean;
  onRetry?: () => void;
  onOpen: () => void;
  onLongPress: () => void;
}

export const DocumentMessageBubble = memo(function DocumentMessageBubble({
  name,
  mime,
  size,
  width,
  mine,
  sending,
  progress,
  uploadedBytes,
  totalBytes,
  failed,
  onRetry,
  onOpen,
  onLongPress,
}: DocumentBubbleProps) {
  const chat = useChatColors();
  const visual = documentVisual(name, mime);
  const foreground = mine ? chat.mineText : chat.theirText;
  const bytesVisible =
    sending &&
    uploadedBytes !== null &&
    uploadedBytes !== undefined &&
    totalBytes !== null &&
    totalBytes !== undefined &&
    totalBytes > 0;

  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onLongPress}
      delayLongPress={320}
      accessibilityRole="button"
      accessibilityLabel={`Ouvrir le document ${name}`}
      style={[
        styles.documentCard,
        { width, backgroundColor: mine ? chat.mineBubble : chat.theirBubble },
      ]}>
      {sending ? (
        <View style={[styles.documentIcon, { backgroundColor: `${visual.color}1A` }]}>
          <ProgressRing
            progress={progress === null || progress === undefined ? undefined : progress / 100}
            size={40}
            strokeWidth={3}
            color={chat.send}
            trackColor={chat.border}>
            <Ionicons name="arrow-up" size={18} color={chat.primaryText} />
          </ProgressRing>
        </View>
      ) : failed ? (
        <Pressable
          onPress={onRetry}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Réessayer l’envoi de ce document"
          style={[styles.documentIcon, styles.documentFailedIcon]}>
          <Ionicons name="refresh" size={22} color="#ffffff" />
        </Pressable>
      ) : (
        <View style={[styles.documentIcon, { backgroundColor: `${visual.color}1A` }]}>
          <Ionicons name={visual.icon} size={30} color={visual.color} />
        </View>
      )}
      <View style={styles.documentBody}>
        <Text numberOfLines={2} style={[styles.documentName, { color: foreground }]}>
          {middleTruncate(name)}
        </Text>
        <Text style={[styles.documentSize, { color: chat.secondaryText }]}>
          {bytesVisible
            ? `${formatFileSize(uploadedBytes)} sur ${formatFileSize(totalBytes)}`
            : formatFileSize(size)}
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  mediaFrame: {
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  videoFrame: {
    backgroundColor: '#1C1C1E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  durationPill: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  durationText: {
    color: '#ffffff',
    fontSize: 11,
    lineHeight: 15,
    fontVariant: ['tabular-nums'],
  },
  documentCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: 6,
    padding: Spacing.two,
  },
  documentIcon: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  documentFailedIcon: {
    borderRadius: 22,
    backgroundColor: '#FA5151',
  },
  documentBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  documentName: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '500',
  },
  documentSize: {
    fontSize: 12,
    lineHeight: 16,
  },
});
