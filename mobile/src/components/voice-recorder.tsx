import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { SendHorizontal, X } from 'lucide-react-native';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type FrameInfo,
} from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatDuration, type VoiceRecorderProps } from '@/lib/voice';

/** Au-delà, l'enregistrement s'arrête seul : personne n'écoute deux minutes. */
const MAX_SECONDS = 120;
/** Le preset par défaut ne fournit pas le niveau : la waveform en a besoin. */
const RECORDING_OPTIONS = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };

const WAVE_BARS = 36;
const WAVE_SLOTS = WAVE_BARS + 1;
const WAVE_HEIGHT = 26;
const BAR_WIDTH = 2.5;
/** Une nouvelle mesure toutes les 90 ms : le défilement paraît continu. */
const SAMPLE_MS = 90;
/** Niveau mini : sans son, la piste reste un chapelet de petits traits. */
const SILENT_LEVEL = 0.08;

/**
 * Le niveau du micro arrive en dBFS (-160 à 0). On garde une échelle
 * perceptuelle : -55 dB et moins = silence, 0 dB = plein.
 */
function levelOf(metering: number | undefined): number {
  if (metering === undefined || !Number.isFinite(metering)) {
    return SILENT_LEVEL;
  }
  return Math.min(1, Math.max(SILENT_LEVEL, (metering + 55) / 55));
}

/**
 * Une barre de la piste : hauteur fixe, seule sa `scaleY` change.
 * Volontairement une vue simple, pas `Animated` : trente-sept valeurs partagées
 * se réévaluent à chaque image et plafonnaient la piste à 9 images/s sur
 * l'appareil testé, contre une quarantaine avec la ligne seule animée.
 */
function Bar({ level, gap }: {
  level: number;
  gap: number;
}) {
  return <View style={[styles.waveBar, { marginRight: gap }, { transform: [{ scaleY: level }] }]} />;
}

/**
 * La piste défilante. Elle est mémorisée : le chrono du parent se met à jour
 * régulièrement, mais la piste et sa boucle de frame ne doivent pas se
 * réenregistrer pour autant.
 */
const WaveTrack = memo(function WaveTrack({
  recorder,
}: {
  recorder: ReturnType<typeof useAudioRecorder>;
}) {
  const [width, setWidth] = useState(0);
  /** Niveaux (0..1) de la piste, décalés d'un cran à chaque nouvelle mesure. */
  const [levels, setLevels] = useState<number[]>(
    () => Array<number>(WAVE_SLOTS).fill(SILENT_LEVEL)
  );
  /** Dernier niveau mesuré, consommé à chaque nouveau cran de la piste. */
  const latestLevel = useSharedValue(SILENT_LEVEL);
  /** Avancement dans le cran courant (0..1) : le défilement, lui, est continu. */
  const progress = useSharedValue(0);
  const slot = useSharedValue(0);

  const advance = useCallback((steps: number, level: number): void => {
    setLevels((prev) =>
      steps >= WAVE_SLOTS
        ? Array<number>(WAVE_SLOTS).fill(level)
        : prev.slice(steps).concat(Array<number>(steps).fill(level))
    );
  }, []);

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -progress.value * slot.value }],
  }));

  const onFrame = useCallback((frameInfo: FrameInfo): void => {
    'worklet';
    const delta = frameInfo.timeSincePreviousFrame;
    if (!delta || slot.value <= 0) {
      return;
    }
    let next = progress.value + delta / SAMPLE_MS;
    if (next >= 1) {
      const steps = Math.floor(next);
      next -= steps;
      // Le décalage des barres retourne côté JS (une render toutes les 90 ms) ;
      // la translation, elle, ne quitte jamais le thread UI.
      runOnJS(advance)(steps, latestLevel.value);
    }
    // eslint-disable-next-line react-hooks/immutability -- pattern Reanimated
    progress.value = next;
  }, [advance, latestLevel, progress, slot]);

  useFrameCallback(onFrame, true);

  /** Le niveau du micro alimente la piste ; le défilement, lui, est sur le thread UI. */
  useEffect(() => {
    const sample = (): void => {
      let metering: number | undefined;
      try {
        metering = recorder.getStatus().metering;
      } catch {
        metering = undefined;
      }
      // Pattern Reanimated officiel : la valeur partagée est alimentée depuis JS.
      // eslint-disable-next-line react-hooks/immutability
      latestLevel.value = levelOf(metering);
    };
    sample();
    const id = setInterval(sample, SAMPLE_MS);
    return () => clearInterval(id);
  }, [latestLevel, recorder]);

  return (
    <View
      style={styles.wave}
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width;
        setWidth(next);
        // eslint-disable-next-line react-hooks/immutability -- pattern Reanimated
        slot.value = next / WAVE_BARS;
      }}
      accessible={false}>
      {width > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.waveRow,
            { width: (width * WAVE_SLOTS) / WAVE_BARS },
            rowStyle,
          ]}>
          {Array.from({ length: WAVE_SLOTS }, (_, index) => (
            <Bar key={index} level={levels[index] ?? SILENT_LEVEL} gap={width / WAVE_BARS - BAR_WIDTH} />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
});

/**
 * Le micro en train d'enregistrer : chrono, annuler, envoyer.
 *
 * Ce fichier est le seul à importer `expo-audio` pour l'enregistrement, et il
 * n'est chargé qu'après vérification que l'appareil sait le faire.
 */
export function VoiceRecorder({ onFinished, onCancel }: VoiceRecorderProps) {
  const theme = useTheme();
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const [seconds, setSeconds] = useState(0);
  // `stop()` remet la position à zéro : la durée doit être prise pendant.
  const longestRef = useRef(0);
  const finishedRef = useRef(false);
  /** L'arrêt complet, appelé depuis la temporisation sans la relancer. */
  const finishRef = useRef<(send: boolean) => void>(() => undefined);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    void (async () => {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      // `record()` sans préparation ne démarre rien : le chrono resterait à zéro.
      await recorder.prepareToRecordAsync();
      recorder.record();
    })().catch(() => onCancelRef.current());
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
        <X size={22} color={theme.text} />
      </Pressable>
      <View style={styles.recordingDot} />
      <ThemedText style={styles.timer}>{formatDuration(seconds * 1000)}</ThemedText>
      <WaveTrack recorder={recorder} />
      <Pressable
        onPress={() => void finish(true)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Envoyer le message vocal"
        style={styles.send}>
        <SendHorizontal size={22} strokeWidth={2.4} color="#ffffff" />
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
  recordingDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#e5484d',
  },
  timer: {
    minWidth: 40,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  wave: {
    flex: 1,
    height: WAVE_HEIGHT,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  waveRow: {
    position: 'absolute',
    top: 0,
    height: WAVE_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  waveBar: {
    // Ni `borderRadius` ni `opacity` : chacun emballe la barre dans une couche
    // alpha hors écran, et les 37 couches coûtent plus cher que l'animation.
    width: BAR_WIDTH,
    height: WAVE_HEIGHT,
    backgroundColor: accentColor,
  },
  send: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#e5484d',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
