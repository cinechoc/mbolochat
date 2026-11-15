import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import { BlurOverlay } from '@/components/blur-overlay';
import { BlurTarget } from '@/components/blur-target';
import { ThemedText } from '@/components/themed-text';
import { useChatColors } from '@/constants/chat-theme';
import { MediaSurface, Radii, Spacing } from '@/constants/theme';
import {
  formatFileSize,
  formatMediaDuration,
  mediaDisplaySize,
} from '@/features/media/mediaLayout';
import { DocumentMessageBubble } from '@/features/media/MediaMessage';
import { useAppPreference } from '@/lib/app-preferences';
import { fr } from '@/i18n/fr';
import { shouldAutoLoadThumbnail } from './mediaPolicy';
import { SecureVoicePlayer } from './SecureVoicePlayer';
import { closeMedia, loadThumbnailDataUrl, openForView } from './mediaStore';
import type { EncryptedMedia } from './payload';
import { useNetworkClass } from './useNetworkClass';

/**
 * Affichage d'un média chiffré dans la conversation E2EE.
 *
 * Le clair n'existe que pendant la lecture : rien n'est téléchargé tant que
 * l'utilisateur n'ouvre pas le média, le déchiffré vit dans un dossier privé, et
 * la fermeture (ou le démontage de l'écran) efface tout. L'affichage ne dit
 * jamais « chiffré » : toute la conversation l'est, le message n'a pas à le
 * répéter — c'est la règle M3.
 */

type State = 'idle' | 'loading' | 'ready' | 'error';

interface Props {
  token: string | null;
  media: EncryptedMedia;
  mine: boolean;
  caption?: string;
  /** Ouvre le clair déchiffré ; l'écran choisit la visionneuse selon le type. */
  onOpen: (uri: string, media: EncryptedMedia) => void;
  onLongPress?: () => void;
}

export function SecureMediaMessage({ token, media, mine, caption, onOpen, onLongPress }: Props) {
  const chat = useChatColors();
  const { width: windowWidth } = useWindowDimensions();
  const [wifi] = useAppPreference('mediaAutoDownloadWifi');
  const [cellular] = useAppPreference('mediaAutoDownloadCellular');
  const network = useNetworkClass();
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [state, setState] = useState<State>('idle');
  const blurTargetRef = useRef<ComponentRef<typeof View>>(null);
  const id = media.blob.uploadId;

  // Au démontage — fermeture de la conversation, navigation, rechargement de la
  // liste : plus aucun clair ne doit subsister pour ce média.
  useEffect(() => () => closeMedia(id), [id]);

  const thumb = media.thumb;

  useEffect(() => {
    if (!token || !thumb || thumbnail) return;
    if (!shouldAutoLoadThumbnail(network, { wifi, cellular })) return;
    let active = true;
    void loadThumbnailDataUrl({ token, blob: thumb, mime: 'image/jpeg' })
      .then((dataUrl) => {
        if (active) setThumbnail(dataUrl);
      })
      .catch((cause) => {
        if (__DEV__) {
          console.warn(
            '[e2ee-media] vignette indisponible',
            cause instanceof Error ? cause.message : String(cause),
          );
        }
        if (active) setThumbFailed(true);
      });
    return () => {
      active = false;
    };
  }, [token, thumb, thumbnail, network, wifi, cellular]);

  const open = useCallback(async () => {
    if (!token || state === 'loading') return;
    setState('loading');
    try {
      const uri = await openForView({ token, blob: media.blob, mime: media.mime });
      setState('ready');
      onOpen(uri, media);
    } catch {
      setState('error');
      Alert.alert(fr.e2eeMedia.errorTitle, fr.e2eeMedia.errorBody);
    }
  }, [token, state, media, onOpen]);

  const close = useCallback(() => {
    closeMedia(id);
    setState('idle');
  }, [id]);

  const captionBlock = caption ? (
    <View style={styles.captionBox}>
      <ThemedText
        type="small"
        style={[styles.caption, { color: mine ? chat.mineText : chat.theirText }]}>
        {caption}
      </ThemedText>
    </View>
  ) : null;

  if (media.type === 'AUDIO') {
    // Le vocal se lit dans la bulle, comme en clair : le déchiffrement part du
    // toucher, la lecture n'ouvre aucune autre application.
    return (
      <>
        <SecureVoicePlayer token={token} media={media} mine={mine} onLongPress={onLongPress} />
        {captionBlock}
      </>
    );
  }

  if (media.type === 'FILE') {
    return (
      <>
        <DocumentMessageBubble
          name={media.name ?? fr.e2eeMedia.fileFallbackName}
          mime={media.mime}
          size={media.blob.size > 0 ? media.blob.size : null}
          width={Math.min(280, Math.round(windowWidth * 0.7))}
          mine={mine}
          onOpen={() => void open()}
          onLongPress={onLongPress ?? (() => undefined)}
        />
        {captionBlock}
        {state === 'loading' ? (
          <ThemedText type="small" themeColor="textSecondary">
            {fr.e2eeMedia.opening}
          </ThemedText>
        ) : null}
      </>
    );
  }

  const size = mediaDisplaySize({ width: media.width, height: media.height }, windowWidth);
  const duration = formatMediaDuration(media.duration);
  const waitingForThumbnail =
    Boolean(thumb) &&
    !thumbnail &&
    !thumbFailed &&
    shouldAutoLoadThumbnail(network, { wifi, cellular });
  // Métadonnées réelles uniquement : une dimension ou un poids absent n'est
  // jamais remplacé par une valeur plausible.
  const metadata = [
    media.width && media.height ? `${media.width} × ${media.height}` : null,
    media.blob.size > 0 ? formatFileSize(media.blob.size) : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <>
      <Pressable
        onPress={() => void open()}
        onLongPress={onLongPress}
        delayLongPress={320}
        accessibilityRole="button"
        accessibilityLabel={fr.e2eeMedia.openLabel}
        style={[styles.frame, { width: size.width, height: size.height }]}>
        <BlurTarget ref={blurTargetRef} style={StyleSheet.absoluteFill}>
          {thumbnail ? (
            <Image source={{ uri: thumbnail }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.placeholder]} />
          )}
        </BlurTarget>
        {!thumbnail ? (
          <BlurOverlay
            intensity={50}
            blurTarget={blurTargetRef}
            fallbackColor={MediaSurface.overlay}>
            <View style={styles.centerFill}>
              {waitingForThumbnail ? (
                <>
                  <ActivityIndicator color={MediaSurface.onSurface} />
                  <ThemedText type="micro" style={styles.overlayText}>
                    {fr.e2eeMedia.preparing}
                  </ThemedText>
                </>
              ) : (
                <Ionicons
                  name={media.type === 'VIDEO' ? 'videocam-outline' : 'image-outline'}
                  size={28}
                  color={MediaSurface.onSurface}
                />
              )}
            </View>
          </BlurOverlay>
        ) : null}
        {media.type === 'VIDEO' ? (
          <View style={styles.playBadge}>
            <Ionicons name="play" size={22} color={MediaSurface.onSurface} />
          </View>
        ) : null}
        {duration ? (
          <View style={styles.durationPill}>
            <ThemedText type="small" style={styles.durationText}>
              {duration}
            </ThemedText>
          </View>
        ) : null}
        {state === 'loading' ? (
          <BlurOverlay
            intensity={50}
            blurTarget={blurTargetRef}
            fallbackColor={MediaSurface.overlay}
            style={styles.overlay}>
            <View style={styles.centerFill}>
              <ActivityIndicator size="large" color={MediaSurface.onSurface} />
              <ThemedText type="small" style={styles.overlayText}>
                {fr.e2eeMedia.opening}
              </ThemedText>
            </View>
          </BlurOverlay>
        ) : null}
      </Pressable>
      {metadata.length > 0 ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.metadata}>
          {metadata.join(' · ')}
        </ThemedText>
      ) : null}
      {captionBlock}
      {state === 'ready' ? (
        <Pressable onPress={close} accessibilityRole="button" style={styles.closeRow}>
          <ThemedText type="small" themeColor="textSecondary">
            {fr.e2eeMedia.close}
          </ThemedText>
        </Pressable>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: Radii.md,
    overflow: 'hidden',
    backgroundColor: MediaSurface.background,
  },
  placeholder: {
    backgroundColor: MediaSurface.background,
  },
  overlay: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.one },
  metadata: { paddingTop: 2, textAlign: 'right' },
  overlayText: { color: MediaSurface.onSurface },
  playBadge: {
    position: 'absolute',
    alignSelf: 'center',
    top: '42%',
    padding: 10,
    borderRadius: Radii.full,
    backgroundColor: MediaSurface.overlay,
  },
  durationPill: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radii.sm,
    backgroundColor: MediaSurface.overlay,
  },
  durationText: { color: MediaSurface.onSurface },
  captionBox: { marginTop: Spacing.one, maxWidth: 280 },
  caption: { lineHeight: 18 },
  closeRow: { marginTop: Spacing.one },
});
