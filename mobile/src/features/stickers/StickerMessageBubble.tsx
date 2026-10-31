import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import { useChatColors } from '@/constants/chat-theme';
import { Radii } from '@/constants/theme';

export interface StickerMessageBubbleProps {
  uri: string;
  name?: string;
  width?: number;
  height?: number;
  sending?: boolean;
  failed?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  onRetry?: () => void;
}

/** Un sticker s'affiche sans bulle : l'illustration est le message. */
export const StickerMessageBubble = memo(function StickerMessageBubble({
  uri,
  name,
  width,
  height,
  sending = false,
  failed = false,
  onPress,
  onLongPress,
  onRetry,
}: StickerMessageBubbleProps) {
  const chat = useChatColors();
  const { width: windowWidth } = useWindowDimensions();
  const base = Math.min(184, Math.max(124, Math.round(windowWidth * 0.42)));
  const ratio = width && height && width > 0 && height > 0 ? width / height : 1;
  const imageWidth = ratio >= 1 ? base : Math.round(base * ratio);
  const imageHeight = ratio >= 1 ? Math.round(base / ratio) : base;

  return (
    <Pressable
      onPress={failed && onRetry ? onRetry : onPress}
      onLongPress={onLongPress}
      delayLongPress={260}
      style={({ pressed }) => [
        styles.root,
        { width: imageWidth, height: imageHeight },
        pressed && styles.pressed,
        sending && styles.sending,
      ]}
      accessibilityRole="imagebutton"
      accessibilityLabel={name ? `Sticker ${name}` : 'Sticker'}
      accessibilityHint={failed ? 'Appuyer pour réessayer' : 'Appui long pour les options'}>
      <Image
        source={{ uri }}
        style={styles.image}
        contentFit="contain"
        transition={120}
        recyclingKey={uri}
        accessibilityIgnoresInvertColors
      />
      {sending ? (
        <View style={styles.sendingBadge}>
          <ActivityIndicator size="small" color={chat.primaryText} />
        </View>
      ) : null}
      {failed ? (
        <View style={[styles.failedBadge, { backgroundColor: chat.theirBubble }]}>
          <Ionicons name="alert-circle" size={15} color={chat.error} />
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  root: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  pressed: {
    opacity: 0.78,
    transform: [{ scale: 0.97 }],
  },
  sending: {
    opacity: 0.72,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  sendingBadge: {
    position: 'absolute',
    bottom: 2,
    left: 2,
    width: 26,
    height: 26,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(127,127,127,0.18)',
  },
  failedBadge: {
    position: 'absolute',
    bottom: 2,
    left: 2,
    width: 24,
    height: 24,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
