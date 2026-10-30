import type { RTCPeerConnection, RTCRtpSender } from 'react-native-webrtc';

import { CALL_VIDEO_FPS } from '@/lib/calls';
import { OPUS_MAX_KBPS } from './sdp';

/**
 * Lectures de `getStats()` partagées par l'appel un à un et le maillage de
 * groupe : un lien = une connexion, donc une seule source de vérité pour la
 * qualité descendante, montante et le candidat retenu.
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

export type LinkStats = {
  /** `host` | `srflx` | `relay` : confirme ou non le passage par le TURN. */
  candidateType: string | null;
  /** Bande passante estimée montante, en bits/s (peut être absente sur Android). */
  availableBitrate: number | null;
  videoBytesSent: number;
  /** Niveau du flux audio reçu, 0 à 1. */
  audioLevel: number;
  audioBytesReceived: number;
  packetsLost: number;
  packetsReceived: number;
  jitterMs: number;
  roundTripMs: number | null;
  quality: LinkQuality;
};

const EMPTY: LinkStats = {
  candidateType: null,
  availableBitrate: null,
  videoBytesSent: 0,
  audioLevel: 0,
  audioBytesReceived: 0,
  packetsLost: 0,
  packetsReceived: 0,
  jitterMs: 0,
  roundTripMs: null,
  quality: 'good',
};

export async function readLinkStats(pc: RTCPeerConnection): Promise<LinkStats> {
  try {
    const report: any = await pc.getStats();
    const stats = { ...EMPTY };
    let localId: string | null = null;
    const locals = new Map<string, any>();
    let rttSeconds: number | null = null;
    report.forEach((entry: any) => {
      if (!entry || typeof entry.type !== 'string') {
        return;
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
      } else if (entry.type === 'inbound-rtp' && entry.kind === 'audio') {
        stats.audioLevel = Number(entry.audioLevel ?? 0);
        stats.audioBytesReceived = Number(entry.bytesReceived ?? 0);
        stats.packetsLost = Number(entry.packetsLost ?? 0);
        stats.packetsReceived = Number(entry.packetsReceived ?? 0);
        stats.jitterMs = Number(entry.jitter ?? 0) * 1000;
      }
    });
    const local = localId ? locals.get(localId) : null;
    stats.candidateType = local?.candidateType ?? null;
    stats.roundTripMs = rttSeconds === null ? null : Math.round(rttSeconds * 1000);
    const received = stats.packetsReceived;
    const lossRatio =
      received + stats.packetsLost > 0
        ? stats.packetsLost / (received + stats.packetsLost)
        : 0;
    stats.quality = classifyQuality({
      lossRatio,
      jitterMs: stats.jitterMs,
      roundTripMs: stats.roundTripMs,
    });
    return stats;
  } catch {
    return EMPTY;
  }
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
 * Plafond d'encodage vidéo : la vidéo cède avant l'audio sur un réseau faible.
 * Certains chemins natifs ignorent `setParameters` : on ne remonte jamais l'erreur.
 */
export async function applyVideoBitrate(
  sender: RTCRtpSender,
  maxBitrate: number,
  fps: number = CALL_VIDEO_FPS,
): Promise<boolean> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{} as never];
    }
    params.encodings[0].maxBitrate = maxBitrate;
    params.encodings[0].maxFramerate = fps;
    params.degradationPreference = 'balanced';
    await sender.setParameters(params);
    return true;
  } catch {
    return false;
  }
}
