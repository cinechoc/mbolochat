import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { MediaSurface, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import type { PickedAttachment } from './pickMedia';

export interface MediaComposerValue {
  caption: string;
  viewOnce: boolean;
  hd: boolean;
}

interface MediaComposerModalProps {
  media: PickedAttachment | null;
  index: number;
  total: number;
  sending: boolean;
  onClose: () => void;
  onSend: (value: MediaComposerValue) => void;
}

function VideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.play();
  });
  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="contain"
      nativeControls
    />
  );
}

export function MediaComposerModal({
  media,
  index,
  total,
  sending,
  onClose,
  onSend,
}: MediaComposerModalProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [caption, setCaption] = useState('');
  const [viewOnce, setViewOnce] = useState(false);
  const [hd, setHd] = useState(false);
  const isImage = media?.kind === 'image';

  return (
    <Modal
      visible={media !== null}
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}>
      <View style={styles.screen}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}>
          <View style={[styles.header, { paddingTop: insets.top + Spacing.two }]}>
            <Pressable
              onPress={onClose}
              disabled={sending}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={fr.common.close}
              style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
              <Ionicons name="close" size={24} color={MediaSurface.onSurface} />
            </Pressable>
            <View style={styles.headerTitle}>
              <ThemedText type="sectionTitle" style={styles.onSurface}>
                {fr.chat.mediaComposer.title}
              </ThemedText>
              {total > 1 ? (
                <ThemedText type="micro" style={styles.onSurfaceSoft}>
                  {fr.chat.mediaComposer.itemCount(index, total)}
                </ThemedText>
              ) : null}
            </View>
            <View style={styles.iconButton} />
          </View>

          <View style={styles.preview}>
            {media?.kind === 'image' ? (
              <Image source={{ uri: media.uri }} style={StyleSheet.absoluteFill} contentFit="contain" />
            ) : media?.kind === 'video' ? (
              <VideoPreview uri={media.uri} />
            ) : null}
            <View style={[styles.kindPill, { top: insets.top + 64 }]}>
              <Ionicons
                name={isImage ? 'image-outline' : 'videocam-outline'}
                size={15}
                color={MediaSurface.onSurface}
              />
              <ThemedText type="micro" style={styles.onSurface}>
                {isImage ? fr.chat.mediaComposer.image : fr.chat.mediaComposer.video}
              </ThemedText>
            </View>
          </View>

          <View
            style={[
              styles.controls,
              {
                paddingBottom: Math.max(insets.bottom, Spacing.three),
                borderColor: MediaSurface.border,
              },
            ]}>
            <TextInput
              value={caption}
              onChangeText={setCaption}
              editable={!sending}
              multiline
              maxLength={1000}
              placeholder={fr.chat.mediaComposer.captionPlaceholder}
              placeholderTextColor={MediaSurface.onSurfaceSoft}
              selectionColor={theme.accent}
              style={[styles.caption, { borderColor: MediaSurface.border }]}
            />
            <View style={styles.actionsRow}>
              <View style={styles.toggles}>
                <Pressable
                  onPress={() => setViewOnce((current) => !current)}
                  disabled={sending}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: viewOnce }}
                  accessibilityLabel={fr.chat.mediaComposer.viewOnce}
                  style={({ pressed }) => [
                    styles.optionButton,
                    viewOnce && { backgroundColor: theme.accent, borderColor: theme.accent },
                    pressed && styles.pressed,
                  ]}>
                  <ThemedText
                    type="smallBold"
                    style={viewOnce ? { color: theme.onAccent } : styles.onSurface}>
                    1
                  </ThemedText>
                  <ThemedText
                    type="micro"
                    style={viewOnce ? { color: theme.onAccent } : styles.onSurfaceSoft}>
                    {fr.chat.mediaComposer.viewOnce}
                  </ThemedText>
                </Pressable>
                {isImage ? (
                  <Pressable
                    onPress={() => setHd((current) => !current)}
                    disabled={sending}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: hd }}
                    accessibilityLabel={fr.chat.mediaComposer.hd}
                    style={({ pressed }) => [
                      styles.hdButton,
                      hd && { backgroundColor: theme.accent, borderColor: theme.accent },
                      pressed && styles.pressed,
                    ]}>
                    <ThemedText
                      type="smallBold"
                      style={hd ? { color: theme.onAccent } : styles.onSurface}>
                      {fr.chat.mediaComposer.hd}
                    </ThemedText>
                  </Pressable>
                ) : null}
              </View>
              <Pressable
                onPress={() => onSend({ caption: caption.trim(), viewOnce, hd: isImage && hd })}
                disabled={sending}
                accessibilityRole="button"
                accessibilityLabel={fr.chat.mediaComposer.send}
                accessibilityState={{ disabled: sending, busy: sending }}
                style={({ pressed }) => [
                  styles.sendButton,
                  { backgroundColor: theme.accent },
                  sending && styles.disabled,
                  pressed && styles.pressed,
                ]}>
                {sending ? (
                  <ActivityIndicator size="small" color={theme.onAccent} />
                ) : (
                  <Ionicons name="send" size={21} color={theme.onAccent} />
                )}
              </Pressable>
            </View>
            {sending ? (
              <ThemedText type="micro" style={[styles.sending, styles.onSurfaceSoft]}>
                {fr.chat.mediaComposer.sending}
              </ThemedText>
            ) : viewOnce ? (
              <ThemedText type="micro" style={[styles.sending, styles.onSurfaceSoft]}>
                {fr.chat.mediaComposer.viewOnceActive}
              </ThemedText>
            ) : hd && isImage ? (
              <ThemedText type="micro" style={[styles.sending, styles.onSurfaceSoft]}>
                {fr.chat.mediaComposer.hdActive}
              </ThemedText>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: MediaSurface.background },
  flex: { flex: 1 },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 3,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    backgroundColor: MediaSurface.overlay,
  },
  headerTitle: { flex: 1, alignItems: 'center', gap: 1 },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: MediaSurface.glass,
  },
  preview: { flex: 1, backgroundColor: MediaSurface.background, overflow: 'hidden' },
  kindPill: {
    position: 'absolute',
    left: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radii.full,
    backgroundColor: MediaSurface.overlay,
  },
  controls: {
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: MediaSurface.overlay,
  },
  caption: {
    minHeight: 46,
    maxHeight: 112,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: MediaSurface.glass,
    color: MediaSurface.onSurface,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 15,
    lineHeight: 21,
    textAlignVertical: 'top',
  },
  actionsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggles: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  optionButton: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: Radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: MediaSurface.border,
    backgroundColor: MediaSurface.glass,
  },
  hdButton: {
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    borderRadius: Radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: MediaSurface.border,
    backgroundColor: MediaSurface.glass,
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sending: { textAlign: 'center' },
  onSurface: { color: MediaSurface.onSurface },
  onSurfaceSoft: { color: MediaSurface.onSurfaceSoft },
  pressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
  disabled: { opacity: 0.6 },
});
