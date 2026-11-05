import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { useChatColors } from '@/constants/chat-theme';
import { Radii } from '@/constants/theme';
import { VoiceMessageBubble, voiceBubbleWidth } from '@/features/voice-notes/VoiceMessageBubble';
import { toWaveform } from '@/features/voice-notes/useVoiceRecorder';
import { fr } from '@/i18n/fr';
import { openForView } from './mediaStore';
import type { EncryptedMedia } from './payload';

/**
 * Note vocale chiffrée, lue **dans la bulle** : au premier toucher, le
 * ciphertext est téléchargé et déchiffré dans le dossier privé, puis le lecteur
 * du chat en clair prend le relais sur l'URI locale. Le fichier déchiffré vit
 * jusqu'au démontage de l'écran (le nettoyage du parent l'efface) — jamais
 * au-delà, et rien n'est téléchargé avant le toucher, comme les autres médias.
 */
export function SecureVoicePlayer({
  token,
  media,
  mine,
  onLongPress,
}: {
  token: string | null;
  media: EncryptedMedia;
  mine: boolean;
  onLongPress?: () => void;
}) {
  const chat = useChatColors();
  const { width: screenW } = useWindowDimensions();
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const durationMs = media.duration ?? 0;
  const id = media.blob.uploadId;

  const decrypt = useCallback(async () => {
    if (!token || loading) return;
    setLoading(true);
    try {
      const plain = await openForView({ token, blob: media.blob, mime: media.mime });
      setUri(plain);
    } catch {
      Alert.alert(fr.e2eeMedia.errorTitle, fr.e2eeMedia.errorBody);
    } finally {
      setLoading(false);
    }
  }, [token, loading, media]);

  const bars = useMemo(
    () => toWaveform(media.waveform && media.waveform.length > 0 ? media.waveform : [], 24),
    [media.waveform],
  );

  if (uri) {
    return (
      <VoiceMessageBubble
        id={id}
        uri={uri}
        durationMs={durationMs}
        waveform={media.waveform}
        isMine={mine}
        accentColor={chat.mineBubble}
        receivedColor={chat.theirBubble}
        foregroundColor={chat.primaryText}
        barOffColor={chat.voiceBarOff}
        barOnColor={chat.voiceBarOn}
      />
    );
  }

  // Avant déchiffrement : la même silhouette que le lecteur final, mais le
  // toucher déclenche le déchiffrement au lieu de la lecture.
  const width = voiceBubbleWidth(durationMs, screenW);
  const background = mine ? chat.mineBubble : chat.theirBubble;

  return (
    <View style={mine ? styles.rowMine : styles.rowOther}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={fr.e2eeMedia.openLabel}
        onPress={() => void decrypt()}
        onLongPress={onLongPress}
        delayLongPress={320}
        style={({ pressed }) => [
          styles.bubble,
          { width, backgroundColor: background },
          pressed && styles.pressed,
        ]}>
        {loading ? (
          <ActivityIndicator size="small" color={chat.primaryText} style={styles.icon} />
        ) : (
          <Ionicons name="play" size={20} color={chat.primaryText} style={styles.icon} />
        )}
        <View style={styles.waveform}>
          {bars.map((value, index) => (
            <View
              key={index}
              style={[
                styles.bar,
                {
                  height: 4 + value * 20,
                  backgroundColor: chat.voiceBarOff,
                },
              ]}
            />
          ))}
        </View>
        <Text style={[styles.duration, { color: chat.primaryText }]}>
          {formatDuration(durationMs)}
        </Text>
      </Pressable>
    </View>
  );
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  rowMine: { alignSelf: 'flex-end' },
  rowOther: { alignSelf: 'flex-start' },
  bubble: {
    height: 44,
    borderRadius: Radii.lg,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  pressed: { opacity: 0.8 },
  icon: { width: 20 },
  waveform: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 28,
  },
  bar: { width: 2.5, borderRadius: Radii.full },
  duration: { minWidth: 34, textAlign: 'right', fontSize: 13, fontVariant: ['tabular-nums'] },
});
