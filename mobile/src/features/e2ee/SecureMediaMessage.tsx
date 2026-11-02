import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useChatColors } from '@/constants/chat-theme';
import { Radii, Spacing } from '@/constants/theme';
import { formatMediaDuration, mediaDisplaySize } from '@/features/media/mediaLayout';
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
  const [state, setState] = useState<State>('idle');
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
      .catch(() => undefined);
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

  return (
    <>
      <Pressable
        onPress={() => void open()}
        onLongPress={onLongPress}
        delayLongPress={320}
        accessibilityRole="button"
        accessibilityLabel={fr.e2eeMedia.openLabel}
        style={[styles.frame, { width: size.width, height: size.height }]}>
        {thumbnail ? (
          <Image source={{ uri: thumbnail }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.placeholder]}>
            <Ionicons name="lock-closed-outline" size={26} color="#ffffff" />
          </View>
        )}
        {media.type === 'VIDEO' ? (
          <View style={styles.playBadge}>
            <Ionicons name="play" size={22} color="#ffffff" />
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
          <View style={[StyleSheet.absoluteFill, styles.overlay]}>
            <ThemedText type="small" style={styles.overlayText}>
              {fr.e2eeMedia.opening}
            </ThemedText>
          </View>
        ) : null}
      </Pressable>
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
    backgroundColor: '#1c1c1e',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2c2c2e',
  },
  overlay: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  overlayText: { color: '#ffffff' },
  playBadge: {
    position: 'absolute',
    alignSelf: 'center',
    top: '42%',
    padding: 10,
    borderRadius: Radii.full,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  durationPill: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radii.sm,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  durationText: { color: '#ffffff' },
  captionBox: { marginTop: Spacing.one, maxWidth: 280 },
  caption: { lineHeight: 18 },
  closeRow: { marginTop: Spacing.one },
});
