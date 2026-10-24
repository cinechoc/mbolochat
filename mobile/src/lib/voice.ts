import { requireOptionalNativeModule } from 'expo-modules-core';
import type { ComponentType, Ref } from 'react';

/**
 * Capacités audio : enregistrer et réécouter un message vocal.
 *
 * `expo-audio` est un module natif. Un build plus ancien que lui ne le contient
 * pas, et son simple import ferait tomber l'écran avant même l'affichage — la
 * même chute qu'avec SQLite. On sonde donc le module natif d'abord, ce qui ne
 * lève jamais, et on ne charge le JavaScript qu'une fois la capacité confirmée.
 */

/** Un enregistrement prêt à être importé. */
export interface VoiceTake {
  uri: string;
  durationMs: number;
  mime: string;
}

export interface VoiceRecorderHandle {
  /** Termine l'enregistrement en cours : `true` envoie, `false` annule. */
  finish: (send: boolean) => void;
}

export interface VoiceRecorderProps {
  /** Verrouillé : le relâchement n'arrête plus la capture, les boutons reviennent. */
  locked: boolean;
  onFinished: (take: VoiceTake) => void;
  onCancel: () => void;
  ref?: Ref<VoiceRecorderHandle>;
}

export interface VoiceBubbleProps {
  /** URL signée du fichier, telle que renvoyée par l'API. */
  uri: string;
  /** Durée connue avant le chargement du fichier, en millisecondes. */
  durationMs: number;
  mine: boolean;
  /** Photo et nom de l'expéditeur, affichés sur le bouton de lecture. */
  avatarUrl?: string | null;
  senderName?: string;
  /** Appui long : menu du message (répondre, supprimer…). */
  onLongPress?: () => void;
}

export interface VoiceComponents {
  Recorder: ComponentType<VoiceRecorderProps>;
  Bubble: ComponentType<VoiceBubbleProps>;
  /** Demande l'autorisation du micro, et dit si elle a été accordée. */
  requestMicrophone: () => Promise<boolean>;
}

/** Cet appareil peut-il enregistrer ? Faux sur un build sans expo-audio. */
export function audioAvailable(): boolean {
  return requireOptionalNativeModule('ExpoAudio') !== null;
}

let loading: Promise<VoiceComponents | null> | null = null;

/** Charge les composants audio une seule fois ; `null` si l'appareil ne peut pas. */
export function loadVoice(): Promise<VoiceComponents | null> {
  if (!audioAvailable()) {
    return Promise.resolve(null);
  }
  loading ??= Promise.all([
    import('../components/voice-recorder'),
    import('../components/voice-bubble'),
  ])
    .then(([recorder, bubble]) => ({
      Recorder: recorder.VoiceRecorder,
      Bubble: bubble.VoiceBubble,
      requestMicrophone: recorder.requestMicrophone,
    }))
    .catch(() => null);
  return loading;
}

/** « 1:07 » — la durée telle que WhatsApp l'écrit dans une bulle. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
