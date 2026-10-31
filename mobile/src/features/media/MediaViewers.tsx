import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatMediaDuration } from './mediaLayout';
import { Radii } from '@/constants/theme';

export interface MediaViewerItem {
  type: 'image' | 'video';
  uri: string;
  durationMs?: number;
}

interface ImageViewerProps {
  urls: string[];
  initialIndex: number;
  onClose: () => void;
}

export function ImageViewer({ urls, initialIndex, onClose }: ImageViewerProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState(initialIndex);
  const listRef = useRef<FlatList<string>>(null);

  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: initialIndex * width, animated: false });
  }, [initialIndex, width]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <FlatList
          ref={listRef}
          data={urls}
          horizontal
          pagingEnabled
          keyExtractor={(_, index) => String(index)}
          getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
          initialScrollIndex={initialIndex}
          onMomentumScrollEnd={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
            setCurrent(Math.round(event.nativeEvent.contentOffset.x / width));
          }}
          showsHorizontalScrollIndicator={false}
          renderItem={({ item }) => (
            <View style={[styles.page, { width, height }]}>
              <Image source={{ uri: item }} style={styles.image} contentFit="contain" />
            </View>
          )}
        />
        <Pressable
          onPress={onClose}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Fermer la visionneuse"
          style={[styles.close, { top: insets.top + 8 }]}>
          <Ionicons name="close" size={28} color="#ffffff" />
        </Pressable>
        {urls.length > 1 ? (
          <View style={[styles.counter, { bottom: insets.bottom + 16 }]}>
            <Text style={styles.counterText}>
              {current + 1} / {urls.length}
            </Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

interface VideoViewerProps {
  visible: boolean;
  uri: string | null;
  onClose: () => void;
}

function VideoPlayerScreen({ uri, onClose }: { uri: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer(uri, (instance) => {
    instance.play();
  });

  return (
    <View style={styles.backdrop}>
      <VideoView
        player={player}
        style={styles.video}
        contentFit="contain"
        nativeControls
      />
      <Pressable
        onPress={onClose}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Fermer le lecteur vidéo"
        style={[styles.close, { top: insets.top + 8 }]}>
        <Ionicons name="close" size={28} color="#ffffff" />
      </Pressable>
    </View>
  );
}

export function VideoViewer({ visible, uri, onClose }: VideoViewerProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {visible && uri ? <VideoPlayerScreen uri={uri} onClose={onClose} /> : null}
    </Modal>
  );
}

function AlbumVideoPage({ item }: { item: MediaViewerItem }) {
  const player = useVideoPlayer(item.uri, (instance) => {
    instance.play();
  });
  return (
    <VideoView
      player={player}
      style={styles.albumVideo}
      contentFit="contain"
      nativeControls
    />
  );
}

function AlbumPage({ item, active }: { item: MediaViewerItem; active: boolean }) {
  if (item.type === 'image') {
    return <Image source={{ uri: item.uri }} style={styles.image} contentFit="contain" />;
  }
  if (active) {
    return <AlbumVideoPage item={item} />;
  }
  const duration = formatMediaDuration(item.durationMs);
  return (
    <View style={styles.albumVideoPlaceholder}>
      <View style={styles.albumPlayCircle}>
        <Ionicons name="play" size={30} color="#ffffff" />
      </View>
      {duration ? (
        <View style={styles.videoDurationPill}>
          <Text style={styles.counterText}>{duration}</Text>
        </View>
      ) : null}
    </View>
  );
}

interface AlbumViewerProps {
  items: MediaViewerItem[];
  initialIndex: number;
  onClose: () => void;
}

/** Visionneuse d'un album : photos et vidéos paginées dans le même geste. */
export function AlbumViewer({ items, initialIndex, onClose }: AlbumViewerProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState(initialIndex);
  const listRef = useRef<FlatList<MediaViewerItem>>(null);

  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: initialIndex * width, animated: false });
  }, [initialIndex, width]);

  const updateCurrent = useCallback(
    (offset: number) => {
      const next = Math.max(0, Math.min(items.length - 1, Math.round(offset / width)));
      setCurrent(next);
    },
    [items.length, width],
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <FlatList
          ref={listRef}
          data={items}
          horizontal
          pagingEnabled
          keyExtractor={(item, index) => `${index}-${item.uri}`}
          getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
          initialScrollIndex={initialIndex}
          onMomentumScrollEnd={(event: NativeSyntheticEvent<NativeScrollEvent>) =>
            updateCurrent(event.nativeEvent.contentOffset.x)
          }
          showsHorizontalScrollIndicator={false}
          windowSize={3}
          renderItem={({ item, index }) => (
            <View style={[styles.page, { width, height }]}>
              <AlbumPage item={item} active={index === current} />
            </View>
          )}
        />
        <Pressable
          onPress={onClose}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Fermer l’album"
          style={[styles.close, { top: insets.top + 8 }]}>
          <Ionicons name="close" size={28} color="#ffffff" />
        </Pressable>
        <View style={[styles.counter, { bottom: insets.bottom + 16 }]}>
          <Text style={styles.counterText}>
            {current + 1} / {items.length}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: '#000000',
  },
  page: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  close: {
    position: 'absolute',
    left: 16,
    width: 42,
    height: 42,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  counter: {
    position: 'absolute',
    alignSelf: 'center',
    borderRadius: Radii.sm,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  counterText: {
    color: '#ffffff',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  video: {
    flex: 1,
  },
  albumVideo: {
    flex: 1,
    width: '100%',
  },
  albumVideoPlaceholder: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000000',
  },
  albumPlayCircle: {
    width: 64,
    height: 64,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  videoDurationPill: {
    position: 'absolute',
    right: 16,
    bottom: 24,
    borderRadius: Radii.xs,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
});
