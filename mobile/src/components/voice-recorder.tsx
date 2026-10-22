import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { formatDuration, type VoiceRecorderProps } from '@/lib/voice';

/** Au-delà, l'enregistrement s'arrête seul : personne n'écoute deux minutes. */
const MAX_SECONDS = 120;

/**
 * Le micro en train d'enregistrer : chrono, annuler, envoyer.
 *
 * Ce fichier est le seul à importer `expo-audio` pour l'enregistrement, et il
 * n'est chargé qu'après vérification que l'appareil sait le faire.
 */
export function VoiceRecorder({ onFinished, onCancel }: VoiceRecorderProps) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [seconds, setSeconds] = useState(0);
  // `stop()` remet la position à zéro : la durée doit être prise pendant.
  const longestRef = useRef(0);
  const finishedRef = useRef(false);
  /** L'arrêt complet, appelé depuis la temporisation sans la relancer. */
  const finishRef = useRef<(send: boolean) => void>(() => undefined);

  useEffect(() => {
    void setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    recorder.record();
    const tick = setInterval(() => {
      const current = Math.round(recorder.currentTime);
      if (current > longestRef.current) {
        longestRef.current = current;
      }
      setSeconds(longestRef.current);
      if (longestRef.current >= MAX_SECONDS) {
        finishRef.current(true);
      }
    }, 400);
    return () => {
      clearInterval(tick);
      void setAudioModeAsync({ allowsRecording: false });
    };
  }, [recorder]);

  const finish = useCallback(
    (send: boolean): void => {
      if (finishedRef.current) {
        return;
      }
      finishedRef.current = true;
      void (async () => {
        await recorder.stop();
        const durationMs = longestRef.current * 1000;
        const uri = recorder.uri;
        if (!send || !uri || durationMs < 500) {
          onCancel();
          return;
        }
        onFinished({ uri, durationMs, mime: 'audio/mp4' });
      })();
    },
    [onCancel, onFinished, recorder],
  );

  // La temporisation appelle toujours la dernière version, sans relancer l'enregistrement.
  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => void finish(false)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Annuler l’enregistrement"
        style={styles.cancel}>
        <ThemedText style={styles.cancelText}>✕</ThemedText>
      </Pressable>
      <View style={styles.recordingDot} />
      <ThemedText style={styles.timer}>{formatDuration(seconds * 1000)}</ThemedText>
      <Pressable
        onPress={() => void finish(true)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Envoyer le message vocal"
        style={styles.send}>
        <ThemedText style={styles.sendText}>➤</ThemedText>
      </Pressable>
    </View>
  );
}

/** Sans l'autorisation du micro, il n'y a rien à enregistrer : on le dit tôt. */
export async function requestMicrophone(): Promise<boolean> {
  const permission = await requestRecordingPermissionsAsync();
  return permission.granted;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  cancel: {
    padding: Spacing.one,
  },
  cancelText: {
    fontSize: 18,
  },
  recordingDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#e5484d',
  },
  timer: {
    flex: 1,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  send: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#e5484d',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: {
    color: '#ffffff',
    fontSize: 18,
    lineHeight: 20,
    marginLeft: 2,
  },
});
