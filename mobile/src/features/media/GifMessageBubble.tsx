import { memo } from 'react';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ProgressRing } from '@/features/media/ProgressRing';

export interface GifMessageBubbleProps {
  uri: string;
  /** Aperçu statique affiché pendant le chargement réseau de l'animation. */
  stillUri?: string;
  /** Sticker animé : bord arrondi léger ; GIF plein cadre : angles nets. */
  sticker: boolean;
  width: number;
  height: number;
  /** File d'attente : anneau indéterminé sur la bulle, image légèrement papier. */
  sending: boolean;
  failed: boolean;
  onRetry?: () => void;
  onPress?: () => void;
  onLongPress?: () => void;
}

 /**
 * Bulle d'un GIF historique : aucun fond, l'animation est posée directement
 * dans la conversation (style WhatsApp). Le WebP animé est rendu directement
 * par `expo-image` ; plus aucun sélecteur GIPHY ne permet d'en envoyer.
 */
export const GifMessageBubble = memo(function GifMessageBubble({
  uri,
  stillUri,
  sticker,
  width,
  height,
  sending,
  failed,
  onRetry,
  onPress,
  onLongPress,
}: GifMessageBubbleProps) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={320}
      style={[styles.frame, { width, height }]}
      accessibilityRole="imagebutton"
      accessibilityLabel={sticker ? 'Sticker animé' : 'GIF'}>
      <Image
        source={{ uri }}
        placeholder={stillUri ? { uri: stillUri } : undefined}
        placeholderContentFit="cover"
        style={[
          styles.image,
          sticker ? styles.stickerRadius : styles.framedRadius,
          sending ? styles.imageDim : null,
        ]}
        contentFit={sticker ? 'contain' : 'cover'}
        transition={140}
        cachePolicy="disk"
        allowDownscaling
      />
      {sending ? (
        <View style={styles.holding} pointerEvents="none">
          <ProgressRing size={34} />
        </View>
      ) : null}
      {failed && !sending ? (
        <Pressable onPress={onRetry} style={styles.retry}>
          <ThemedText type="smallBold" style={styles.retryText}>
            Réessayer
          </ThemedText>
        </Pressable>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  stickerRadius: {
    borderRadius: 14,
  },
  framedRadius: {
    borderRadius: 10,
  },
  imageDim: {
    opacity: 0.55,
  },
  holding: {
    position: 'absolute',
  },
  retry: {
    position: 'absolute',
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  retryText: {
    color: '#fff',
    fontSize: 11.5,
  },
});
