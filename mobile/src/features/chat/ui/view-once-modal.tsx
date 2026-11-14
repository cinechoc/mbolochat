import { Bomb, Eye } from 'lucide-react-native';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { ThemedText } from '@/components/themed-text';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import type { ChatMessageView } from '../transport/types';
import { MessageText } from '@/features/emoji/EmojiText';
import { stopVoicePlayback, toggleVoicePlayback, useVoicePlayback } from '@/features/voice-notes/voicePlayback';
import { closeMedia, openForView } from '@/features/e2ee/mediaStore';
import { decodeMediaMeta } from '@/features/e2ee/payload';

/** Lecteur éphémère d'un vocal à lecture unique : démarre à l'ouverture. */
function VoiceOnceBody({ message }: { message: ChatMessageView }) {
  const theme = useTheme();
  const attachment = message.attachment;
  const id = `view-once:${message.id}`;
  const playback = useVoicePlayback(id);
  const active = playback.id === id;
  const durationMs = attachment?.durationMs ?? 0;
  const total = active && playback.durationMs > 0 ? playback.durationMs : durationMs;
  const progress = active && total > 0 ? Math.min(1, playback.positionMs / total) : 0;

  // La lecture démarre à l'ouverture : c'est le principe de la lecture unique.
  useEffect(() => {
    if (!attachment?.url) return;
    void toggleVoicePlayback(id, attachment.url, durationMs).catch(() => undefined);
    return () => {
      // Le lecteur est global : il ne doit survivre ni à la modale ni au
      // message, qui va être supprimé à la fermeture.
      void stopVoicePlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- la note ne change pas pendant l'ouverture
  }, [id]);

  const seconds = Math.max(0, Math.round((total - (active ? playback.positionMs : 0)) / 1000));
  const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <View style={styles.voiceBody}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          active && playback.playing
            ? 'Mettre en pause le message vocal'
            : 'Lire le message vocal'
        }
        onPress={() => {
          if (attachment?.url) {
            void toggleVoicePlayback(id, attachment.url, durationMs).catch(() => undefined);
          }
        }}
        style={({ pressed }) => [styles.voicePlay, pressed && { opacity: 0.8 }]}
      >
        <Ionicons
          name={active && playback.playing ? 'pause' : 'play'}
          size={20}
          color={theme.text}
        />
      </Pressable>
      <View style={styles.voiceTrack}>
        <View
          style={[
            styles.voiceProgress,
            { width: `${Math.round(progress * 100)}%`, backgroundColor: theme.accent },
          ]}
        />
      </View>
      <Text style={[styles.voiceTime, { color: theme.textSecondary }]}>{label}</Text>
    </View>
  );
}

/**
 * Vocal chiffré à lecture unique : le ciphertext est déchiffré à l'ouverture,
 * joué une fois, puis le clair et sa référence sont effacés à la fermeture —
 * la copie du pair l'est déjà par `consumeViewOnce`.
 */
function SecureVoiceOnceBody({ message, token }: { message: ChatMessageView; token: string | null }) {
  const theme = useTheme();
  const media = decodeMediaMeta(message.attachment?.mediaMeta ?? null);
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const uploadId = media?.blob.uploadId ?? null;
  const id = uploadId ? `view-once:${uploadId}` : 'view-once:invalid';
  const playback = useVoicePlayback(id);
  const active = playback.id === id;
  const durationMs = media?.duration ?? 0;
  const total = active && playback.durationMs > 0 ? playback.durationMs : durationMs;
  const progress = active && total > 0 ? Math.min(1, playback.positionMs / total) : 0;
  // Le déchiffrement ne doit tourner qu'une fois par ouverture.
  const startedRef = useRef(false);

  useEffect(() => {
    if (!media || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        if (!token) throw new Error('view_once_token_missing');
        const plain = await openForView({ token, blob: media.blob, mime: media.mime });
        if (cancelled) {
          closeMedia(media.blob.uploadId);
          return;
        }
        setUri(plain);
        await toggleVoicePlayback(id, plain, media.duration ?? 0);
      } catch {
        if (!cancelled) {
          setFailed(true);
          Alert.alert(fr.e2eeMedia.errorTitle, fr.e2eeMedia.errorBody);
        }
      }
    })();
    return () => {
      cancelled = true;
      // Plus aucun clair ne doit survivre à la modale : lecture stoppée et
      // fichier déchiffré supprimé, le message va disparaître.
      void stopVoicePlayback();
      if (uploadId) closeMedia(uploadId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- la note ne change pas pendant l'ouverture
  }, [id, token]);

  const seconds = Math.max(0, Math.round((total - (active ? playback.positionMs : 0)) / 1000));
  const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <View style={styles.voiceBody}>
      {failed ? (
        <ThemedText type="small" style={{ color: theme.textSecondary }}>
          {fr.e2eeMedia.unavailable}
        </ThemedText>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              active && playback.playing
                ? 'Mettre en pause le message vocal'
                : 'Lire le message vocal'
            }
            disabled={!uri}
            onPress={() => {
              if (uri) void toggleVoicePlayback(id, uri, durationMs).catch(() => undefined);
            }}
            style={({ pressed }) => [styles.voicePlay, pressed && { opacity: 0.8 }]}
          >
            <Ionicons
              name={active && playback.playing ? 'pause' : 'play'}
              size={20}
              color={theme.text}
            />
          </Pressable>
          <View style={styles.voiceTrack}>
            <View
              style={[
                styles.voiceProgress,
                { width: `${Math.round(progress * 100)}%`, backgroundColor: theme.accent },
              ]}
            />
          </View>
          <Text style={[styles.voiceTime, { color: theme.textSecondary }]}>{label}</Text>
        </>
      )}
    </View>
  );
}

export function ViewOnceModal({
  message,
  token,
  onClose,
}: {
  message: ChatMessageView | null;
  /** Jeton de déchiffrement des médias chiffrés (ouvertures E2EE). */
  token?: string | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const isClassicVoice =
    message?.attachment?.type === 'AUDIO' &&
    !message.attachment.encrypted &&
    Boolean(message.attachment.url);
  const isSecureVoice =
    Boolean(token) &&
    message?.attachment?.encrypted === true &&
    decodeMediaMeta(message.attachment.mediaMeta ?? null)?.type === 'AUDIO';
  return (
    <Modal visible={message !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: theme.backgroundElevated, borderColor: theme.border }]}>
          <View style={[styles.icon, { backgroundColor: theme.accentSoft }]}>
            <Eye size={24} strokeWidth={2.2} color={theme.accent} />
          </View>
          <ThemedText type="sectionTitle" style={{ color: theme.text, textAlign: 'center' }}>
            {fr.chat.viewOnce.title}
          </ThemedText>
          {message ? (
            <View style={styles.body}>
              {isClassicVoice ? (
                <VoiceOnceBody message={message} />
              ) : isSecureVoice ? (
                <SecureVoiceOnceBody message={message} token={token ?? null} />
              ) : (
                <MessageText
                  text={message.body}
                  style={{ color: theme.text, fontSize: 16, lineHeight: 22 }}
                />
              )}
            </View>
          ) : null}
          <ThemedText type="micro" style={{ color: theme.textSecondary, textAlign: 'center' }}>
            {fr.chat.viewOnce.warning}
          </ThemedText>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={fr.chat.viewOnce.close}
            style={({ pressed }) => [
              styles.close,
              { backgroundColor: theme.accent, opacity: pressed ? 0.78 : 1 },
            ]}>
            <Bomb size={18} strokeWidth={2.2} color={theme.onAccent} />
            <ThemedText type="smallBold" style={{ color: theme.onAccent }}>
              {fr.chat.viewOnce.close}
            </ThemedText>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  card: {
    width: '100%',
    maxWidth: 460,
    borderRadius: Radii.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.four,
    gap: Spacing.three,
    alignItems: 'center',
  },
  icon: { width: 52, height: 52, borderRadius: Radii.full, alignItems: 'center', justifyContent: 'center' },
  body: {
    alignSelf: 'stretch',
    maxHeight: 320,
    borderRadius: Radii.sm,
    backgroundColor: 'rgba(255,255,255,0.06)',
    padding: Spacing.three,
  },
  voiceBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    minHeight: 40,
  },
  voicePlay: { alignItems: 'center', justifyContent: 'center' },
  voiceTrack: {
    flex: 1,
    height: 4,
    borderRadius: Radii.full,
    backgroundColor: 'rgba(127,127,127,0.35)',
    overflow: 'hidden',
  },
  voiceProgress: { height: 4, borderRadius: Radii.full },
  voiceTime: { minWidth: 34, textAlign: 'right', fontSize: 13, fontVariant: ['tabular-nums'] },
  close: {
    alignSelf: 'stretch',
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    borderRadius: Radii.button,
  },
});
