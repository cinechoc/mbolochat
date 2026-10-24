/* eslint-disable react-hooks/refs, @typescript-eslint/no-require-imports -- refs « dernière valeur » et import optionnel */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

/** Durée max d'une note vocale (comme WeChat : 60 s). */
export const MAX_DURATION_MS = 60_000;
/** En dessous, la note est jetée ("Message trop court"). */
export const MIN_DURATION_MS = 1_000;
/** Nombre de barres de la forme d'onde stockée avec le message. */
export const WAVEFORM_BARS = 40;
/** Nombre de barres de la forme d'onde "live" pendant l'enregistrement. */
export const LIVE_BARS = 26;

export type VoiceNote = {
  /** URI locale du fichier .m4a (AAC). */
  uri: string;
  durationMs: number;
  /** WAVEFORM_BARS valeurs normalisées entre 0 et 1. */
  waveform: number[];
  mimeType: 'audio/mp4';
};

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'stopping';

type Options = {
  onSend: (note: VoiceNote) => void;
  onTooShort?: () => void;
  onPermissionDenied?: () => void;
  onError?: (error: unknown) => void;
};

/**
 * Voix mono 44,1 kHz / 48 kbps : très bonne intelligibilité, et fréquence
 * d'échantillonnage supportée par le matériel Android courant.
 */
const RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  sampleRate: 44_100,
  bitRate: 48_000,
  isMeteringEnabled: true,
};

/** dBFS (-160..0) -> 0..1, avec une courbe qui rend bien pour la voix. */
function dbToLevel(db: number | undefined): number {
  if (db == null || !isFinite(db)) return 0;
  const linear = Math.min(1, Math.max(0, (db + 55) / 55));
  return Math.pow(linear, 1.4);
}

/** Réduit N échantillons à `bars` barres (moyenne par bucket), normalisées sur le pic. */
export function toWaveform(samples: number[], bars: number = WAVEFORM_BARS): number[] {
  if (samples.length === 0) return new Array(bars).fill(0.15);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = Math.floor((i * samples.length) / bars);
    const end = Math.max(start + 1, Math.floor(((i + 1) * samples.length) / bars));
    let sum = 0;
    for (let j = start; j < end && j < samples.length; j++) sum += samples[j];
    out.push(sum / (end - start));
  }
  const peak = Math.max(...out, 0.2);
  return out.map((v) => Math.round(Math.min(1, Math.max(0.08, v / peak)) * 100) / 100);
}

async function tryDeleteFile(uri: string | null | undefined) {
  if (!uri) return;
  try {
    // API "nouvelle génération" d'expo-file-system (SDK 54+). Silencieux si absente.
    const { File } = require('expo-file-system');
    new File(uri).delete();
  } catch {
    /* le fichier est dans le cache, l'OS le nettoiera */
  }
}

export function useVoiceRecorder(options: Options) {
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, 80);

  const [status, setStatusState] = useState<RecorderStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => new Array(LIVE_BARS).fill(0));

  const statusRef = useRef<RecorderStatus>('idle');
  const startedAtRef = useRef(0);
  const samplesRef = useRef<number[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** L'utilisateur a relâché avant que l'enregistrement ait réellement démarré. */
  const pendingReleaseRef = useRef<null | 'send' | 'cancel'>(null);

  // Toujours les dernières callbacks / le dernier recorder, sans recréer les fonctions.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  const setStatus = (next: RecorderStatus) => {
    statusRef.current = next;
    setStatusState(next);
  };

  const stopTick = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  };

  // Alimente la forme d'onde à chaque mise à jour du metering.
  useEffect(() => {
    if (statusRef.current !== 'recording') return;
    const level = dbToLevel(recorderState.metering);
    samplesRef.current.push(level);
    setLevels((prev) => [...prev.slice(1), level]);
  }, [recorderState]);

  const finish = useCallback(async (cancel: boolean) => {
    if (statusRef.current !== 'recording') return;
    stopTick();
    setStatus('stopping');

    const durationMs = Date.now() - startedAtRef.current;
    const waveform = toWaveform(samplesRef.current);
    let uri: string | null | undefined = null;

    try {
      await recorderRef.current.stop();
      uri = recorderRef.current.uri;
    } catch (e) {
      optionsRef.current.onError?.(e);
    }

    try {
      // Repasse en mode lecture pour que le son sorte par le haut-parleur (iOS).
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    } catch {
      /* non bloquant */
    }

    setStatus('idle');
    setElapsedMs(0);
    setLevels(new Array(LIVE_BARS).fill(0));

    if (cancel || !uri) {
      void tryDeleteFile(uri);
      return;
    }
    if (durationMs < MIN_DURATION_MS) {
      void tryDeleteFile(uri);
      optionsRef.current.onTooShort?.();
      return;
    }
    optionsRef.current.onSend({
      uri,
      durationMs: Math.min(durationMs, MAX_DURATION_MS),
      waveform,
      mimeType: 'audio/mp4',
    });
  }, []);

  const start = useCallback(async () => {
    if (statusRef.current !== 'idle') return;
    pendingReleaseRef.current = null;
    setStatus('starting');

    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setStatus('idle');
        optionsRef.current.onPermissionDenied?.();
        return;
      }

      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorderRef.current.prepareToRecordAsync();
      recorderRef.current.record();

      samplesRef.current = [];
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setLevels(new Array(LIVE_BARS).fill(0));
      setStatus('recording');

      stopTick();
      tickRef.current = setInterval(() => {
        const elapsed = Date.now() - startedAtRef.current;
        setElapsedMs(elapsed);
        if (elapsed >= MAX_DURATION_MS) void finish(false); // envoi auto à 60 s
      }, 80);

      // Doigt relâché pendant la préparation : on termine tout de suite.
      const pending = pendingReleaseRef.current;
      pendingReleaseRef.current = null;
      if (pending) await finish(pending === 'cancel');
    } catch (e) {
      stopTick();
      setStatus('idle');
      optionsRef.current.onError?.(e);
    }
  }, [finish]);

  /** À appeler quand le doigt est relevé. `cancel` = true pour jeter la note. */
  const release = useCallback(
    (cancel: boolean) => {
      if (statusRef.current === 'starting') {
        pendingReleaseRef.current = cancel ? 'cancel' : 'send';
        return;
      }
      if (statusRef.current === 'recording') void finish(cancel);
    },
    [finish],
  );

  // App mise en arrière-plan pendant l'enregistrement : on annule proprement.
  // Un passage très bref en fond (activité de permission système) ne doit pas
  // jeter la note : on attend que l'app reste réellement en arrière-plan.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      if (s === 'background' && !timer) {
        timer = setTimeout(() => {
          timer = null;
          release(true);
        }, 400);
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [release]);

  // Démontage pendant l'enregistrement.
  useEffect(() => {
    return () => {
      stopTick();
      if (statusRef.current === 'recording') {
        recorderRef.current.stop().catch(() => {});
      }
    };
  }, []);

  return { status, elapsedMs, levels, start, release };
}
