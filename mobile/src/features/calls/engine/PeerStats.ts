import type { RTCPeerConnection, RTCRtpSender } from 'react-native-webrtc';

import { OPUS_MAX_KBPS } from './sdp';
import type { SenderVideoParameters } from './videoQuality';

/**
 * Lectures de `getStats()` partagées par l'appel un à un et le maillage de
 * groupe : un lien = une connexion, donc une seule source de vérité pour la
 * qualité montante, descendante et le candidat retenu.
 */
export type LinkQuality = 'good' | 'medium' | 'weak';

/** Seuils audio : au-delà, la voix devient hachée ou retardée. */
export const QUALITY_LOSS_MEDIUM = 0.02;
export const QUALITY_LOSS_WEAK = 0.08;
export const QUALITY_JITTER_MEDIUM_MS = 60;
export const QUALITY_JITTER_WEAK_MS = 120;
export const QUALITY_RTT_MEDIUM_MS = 250;
export const QUALITY_RTT_WEAK_MS = 400;

export interface QualityInput {
  /** Part des paquets perdus, 0 à 1. */
  lossRatio: number;
  jitterMs: number;
  roundTripMs: number | null;
}

/**
 * État du lien en trois paliers. La perte pèse le plus lourd : c'est elle qui
 * hache la voix ; le RTT ne gêne qu'au-delà de la demi-seconde.
 */
export function classifyQuality({ lossRatio, jitterMs, roundTripMs }: QualityInput): LinkQuality {
  if (
    lossRatio >= QUALITY_LOSS_WEAK ||
    jitterMs >= QUALITY_JITTER_WEAK_MS ||
    (roundTripMs !== null && roundTripMs >= QUALITY_RTT_WEAK_MS)
  ) {
    return 'weak';
  }
  if (
    lossRatio >= QUALITY_LOSS_MEDIUM ||
    jitterMs >= QUALITY_JITTER_MEDIUM_MS ||
    (roundTripMs !== null && roundTripMs >= QUALITY_RTT_MEDIUM_MS)
  ) {
    return 'medium';
  }
  return 'good';
}

/** Compteurs et cadence du flux vidéo envoyé. */
export type VideoOutStats = {
  bytesSent: number;
  packetsSent: number;
  framesPerSecond: number | null;
  qualityLimitationReason: string | null;
};

/** Compteurs et perte du flux vidéo reçu. */
export type VideoInStats = {
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  framesPerSecond: number | null;
  framesDropped: number | null;
  lossRatio: number;
  /** Attente moyenne dans le tampon de gigue, en millisecondes. */
  jitterBufferDelayMs: number | null;
};

export type LinkStats = {
  /** `host` | `srflx` | `relay` : confirme ou non le passage par le TURN. */
  candidateType: string | null;
  /** Bande passante estimée montante, en bits/s (peut être absente sur Android). */
  availableBitrate: number | null;
  videoBytesSent: number;
  videoOut: VideoOutStats;
  videoIn: VideoInStats;
  /** Niveau du flux audio reçu, 0 à 1. */
  audioLevel: number;
  audioBytesReceived: number;
  packetsLost: number;
  packetsReceived: number;
  jitterMs: number;
  roundTripMs: number | null;
  quality: LinkQuality;
};

const EMPTY_VIDEO_OUT: VideoOutStats = {
  bytesSent: 0,
  packetsSent: 0,
  framesPerSecond: null,
  qualityLimitationReason: null,
};

const EMPTY_VIDEO_IN: VideoInStats = {
  bytesReceived: 0,
  packetsReceived: 0,
  packetsLost: 0,
  framesPerSecond: null,
  framesDropped: null,
  lossRatio: 0,
  jitterBufferDelayMs: null,
};

const EMPTY: LinkStats = {
  candidateType: null,
  availableBitrate: null,
  videoBytesSent: 0,
  videoOut: EMPTY_VIDEO_OUT,
  videoIn: EMPTY_VIDEO_IN,
  audioLevel: 0,
  audioBytesReceived: 0,
  packetsLost: 0,
  packetsReceived: 0,
  jitterMs: 0,
  roundTripMs: null,
  quality: 'good',
};

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Lecture pure d'un rapport `getStats()` : garde une seule entrée vidéo par
 * direction, calcule la perte vidéo et l'attente du tampon de gigue.
 */
export function summarizeStats(entries: Record<string, any>[]): LinkStats {
  const stats: LinkStats = {
    ...EMPTY,
    videoOut: { ...EMPTY_VIDEO_OUT },
    videoIn: { ...EMPTY_VIDEO_IN },
  };
  let localId: string | null = null;
  const locals = new Map<string, any>();
  let rttSeconds: number | null = null;

  for (const entry of entries) {
    if (!entry || typeof entry.type !== 'string') {
      continue;
    }
    if (entry.type === 'local-candidate') {
      locals.set(entry.id, entry);
    } else if (entry.type === 'candidate-pair' && entry.state === 'succeeded') {
      if (typeof entry.currentRoundTripTime === 'number') {
        rttSeconds = entry.currentRoundTripTime;
      }
      if (entry.selected || localId === null) {
        localId = entry.localCandidateId ?? null;
        stats.availableBitrate =
          typeof entry.availableOutgoingBitrate === 'number'
            ? entry.availableOutgoingBitrate
            : stats.availableBitrate;
      }
    } else if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
      stats.videoBytesSent = Number(entry.bytesSent ?? 0);
      stats.videoOut = {
        bytesSent: Number(entry.bytesSent ?? 0),
        packetsSent: Number(entry.packetsSent ?? 0),
        framesPerSecond: numberOrNull(entry.framesPerSecond),
        qualityLimitationReason:
          typeof entry.qualityLimitationReason === 'string' ? entry.qualityLimitationReason : null,
      };
    } else if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
      const received = Number(entry.packetsReceived ?? 0);
      const lost = Math.max(0, Number(entry.packetsLost ?? 0));
      const emitted = Number(entry.jitterBufferEmittedCount ?? 0);
      const delay = Number(entry.jitterBufferDelay ?? 0);
      stats.videoIn = {
        bytesReceived: Number(entry.bytesReceived ?? 0),
        packetsReceived: received,
        packetsLost: lost,
        framesPerSecond: numberOrNull(entry.framesPerSecond),
        framesDropped: numberOrNull(entry.framesDropped),
        lossRatio: received + lost > 0 ? lost / (received + lost) : 0,
        jitterBufferDelayMs:
          emitted > 0 && Number.isFinite(delay) ? Math.round((delay / emitted) * 1000) : null,
      };
    } else if (entry.type === 'inbound-rtp' && entry.kind === 'audio') {
      stats.audioLevel = Number(entry.audioLevel ?? 0);
      stats.audioBytesReceived = Number(entry.bytesReceived ?? 0);
      stats.packetsLost = Number(entry.packetsLost ?? 0);
      stats.packetsReceived = Number(entry.packetsReceived ?? 0);
      stats.jitterMs = Number(entry.jitter ?? 0) * 1000;
    }
  }

  const local = localId ? locals.get(localId) : null;
  stats.candidateType = local?.candidateType ?? null;
  stats.roundTripMs = rttSeconds === null ? null : Math.round(rttSeconds * 1000);
  const received = stats.packetsReceived;
  const lossRatio =
    received + stats.packetsLost > 0 ? stats.packetsLost / (received + stats.packetsLost) : 0;
  stats.quality = classifyQuality({
    lossRatio,
    jitterMs: stats.jitterMs,
    roundTripMs: stats.roundTripMs,
  });
  return stats;
}

export async function readLinkStats(pc: RTCPeerConnection): Promise<LinkStats> {
  try {
    const report: any = await pc.getStats();
    const entries: Record<string, any>[] = [];
    report.forEach((entry: any) => entries.push(entry));
    return summarizeStats(entries);
  } catch {
    return {
      ...EMPTY,
      videoOut: { ...EMPTY_VIDEO_OUT },
      videoIn: { ...EMPTY_VIDEO_IN },
    };
  }
}

/** Débits vidéo dérivés de deux relevés de compteurs (octets). */
export type VideoRates = {
  outBps: number | null;
  inBps: number | null;
};

export function diffVideoRates(
  previous: LinkStats | null,
  current: LinkStats,
  elapsedMs: number,
): VideoRates {
  if (!previous || elapsedMs <= 0) {
    return { outBps: null, inBps: null };
  }
  const scale = (before: number, after: number) =>
    Math.max(0, Math.round(((after - before) * 8 * 1000) / elapsedMs));
  return {
    outBps: scale(previous.videoOut.bytesSent, current.videoOut.bytesSent),
    inBps: scale(previous.videoIn.bytesReceived, current.videoIn.bytesReceived),
  };
}

/** Débit audio Opus plafonné : la voix tient dans 28 kbit/s. */
export async function applyAudioBitrate(sender: RTCRtpSender): Promise<boolean> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{} as never];
    }
    params.encodings[0].maxBitrate = OPUS_MAX_KBPS * 1000;
    await sender.setParameters(params);
    return true;
  } catch {
    return false;
  }
}

/**
 * Applique les paramètres vidéo calculés par `videoQuality` : débit, cadence,
 * réduction de résolution et préférence de dégradation (fluidité d'abord).
 * Certains chemins natifs ignorent `setParameters` : on ne remonte jamais.
 */
export async function applySenderVideoParameters(
  sender: RTCRtpSender,
  values: SenderVideoParameters,
): Promise<boolean> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{} as never];
    }
    params.encodings[0].maxBitrate = values.maxBitrate;
    params.encodings[0].maxFramerate = values.maxFramerate;
    params.encodings[0].scaleResolutionDownBy = values.scaleResolutionDownBy;
    params.degradationPreference = values.degradationPreference as never;
    await sender.setParameters(params);
    return true;
  } catch {
    return false;
  }
}

