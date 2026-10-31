import { describe, expect, it, vi } from 'vitest';
import type { RTCRtpSender } from 'react-native-webrtc';

import {
  applySenderVideoParameters,
  diffVideoRates,
  summarizeStats,
  type LinkStats,
} from './PeerStats';

const REPORT: Array<Record<string, any>> = [
  {
    id: 'pair-1',
    type: 'candidate-pair',
    state: 'succeeded',
    selected: true,
    localCandidateId: 'local-1',
    currentRoundTripTime: 0.08,
    availableOutgoingBitrate: 850_000,
  },
  { id: 'local-1', type: 'local-candidate', candidateType: 'srflx' },
  {
    id: 'audio-in',
    type: 'inbound-rtp',
    kind: 'audio',
    audioLevel: 0.4,
    bytesReceived: 5_000,
    packetsLost: 2,
    packetsReceived: 998,
    jitter: 0.02,
  },
  {
    id: 'video-in',
    type: 'inbound-rtp',
    kind: 'video',
    bytesReceived: 120_000,
    packetsReceived: 990,
    packetsLost: 10,
    framesPerSecond: 15,
    framesDropped: 3,
    jitterBufferDelay: 0.5,
    jitterBufferEmittedCount: 50,
  },
  {
    id: 'video-out',
    type: 'outbound-rtp',
    kind: 'video',
    bytesSent: 240_000,
    packetsSent: 800,
    framesPerSecond: 12,
    qualityLimitationReason: 'bandwidth',
  },
];

describe('summarizeStats', () => {
  it('lit les compteurs audio, vidéo et le candidat retenu', () => {
    const stats = summarizeStats(REPORT);
    expect(stats.candidateType).toBe('srflx');
    expect(stats.availableBitrate).toBe(850_000);
    expect(stats.roundTripMs).toBe(80);
    expect(stats.videoOut).toEqual({
      bytesSent: 240_000,
      packetsSent: 800,
      framesPerSecond: 12,
      qualityLimitationReason: 'bandwidth',
    });
    expect(stats.videoIn.bytesReceived).toBe(120_000);
    expect(stats.videoIn.framesPerSecond).toBe(15);
    expect(stats.videoIn.framesDropped).toBe(3);
    expect(stats.videoIn.lossRatio).toBeCloseTo(0.01, 5);
    expect(stats.videoIn.jitterBufferDelayMs).toBe(10);
    expect(stats.quality).toBe('good');
  });

  it('renvoie des valeurs neutres sans flux vidéo', () => {
    const stats = summarizeStats([]);
    expect(stats.videoOut.framesPerSecond).toBeNull();
    expect(stats.videoOut.qualityLimitationReason).toBeNull();
    expect(stats.videoIn.lossRatio).toBe(0);
    expect(stats.videoIn.framesDropped).toBeNull();
    expect(stats.candidateType).toBeNull();
  });

  it('classe toujours la voix selon la perte audio', () => {
    const lossy = REPORT.map((entry) =>
      entry.id === 'audio-in' ? { ...entry, packetsLost: 200 } : entry,
    );
    expect(summarizeStats(lossy).quality).toBe('weak');
  });
});

describe('diffVideoRates', () => {
  const before = summarizeStats([
    {
      id: 'o',
      type: 'outbound-rtp',
      kind: 'video',
      bytesSent: 1_000,
    },
    {
      id: 'i',
      type: 'inbound-rtp',
      kind: 'video',
      bytesReceived: 2_000,
    },
  ]);
  const after = summarizeStats([
    {
      id: 'o',
      type: 'outbound-rtp',
      kind: 'video',
      bytesSent: 101_000,
    },
    {
      id: 'i',
      type: 'inbound-rtp',
      kind: 'video',
      bytesReceived: 202_000,
    },
  ]);

  it('convertit les deltas en bits par seconde', () => {
    expect(diffVideoRates(before, after, 2_000)).toEqual({ outBps: 400_000, inBps: 800_000 });
  });

  it('ne calcule rien sans relevé précédent ou sans temps écoulé', () => {
    expect(diffVideoRates(null, after, 2_000)).toEqual({ outBps: null, inBps: null });
    expect(diffVideoRates(before, after, 0)).toEqual({ outBps: null, inBps: null });
  });

  it('borne à zéro une remise à zéro des compteurs', () => {
    const reset = summarizeStats([]);
    expect(diffVideoRates(after, reset, 2_000)).toEqual({ outBps: 0, inBps: 0 });
  });
});

describe('applySenderVideoParameters', () => {
  function sender(initial: any, fail = false) {
    const setParameters = vi.fn().mockImplementation(() =>
      fail ? Promise.reject(new Error('refusée')) : Promise.resolve(),
    );
    return {
      getParameters: () => ({ ...initial }),
      setParameters,
    } as unknown as RTCRtpSender & { setParameters: ReturnType<typeof vi.fn> };
  }

  it('pose débit, cadence, facteur de résolution et préférence de fluidité', async () => {
    const target = sender({ encodings: [{}] });
    const ok = await applySenderVideoParameters(target, {
      maxBitrate: 300_000,
      maxFramerate: 15,
      scaleResolutionDownBy: 1.33,
      degradationPreference: 'maintain-framerate',
    });
    expect(ok).toBe(true);
    expect(target.setParameters).toHaveBeenCalledWith({
      encodings: [
        { maxBitrate: 300_000, maxFramerate: 15, scaleResolutionDownBy: 1.33 },
      ],
      degradationPreference: 'maintain-framerate',
    });
  });

  it('crée un encodage quand la pile n’en expose aucun', async () => {
    const target = sender({});
    await applySenderVideoParameters(target, {
      maxBitrate: 200_000,
      maxFramerate: 12,
      scaleResolutionDownBy: 2,
      degradationPreference: 'maintain-framerate',
    });
    const params = target.setParameters.mock.calls[0][0];
    expect(params.encodings).toHaveLength(1);
    expect(params.encodings[0].maxBitrate).toBe(200_000);
  });

  it('ne lève jamais si la pile refuse les paramètres', async () => {
    const target = sender({ encodings: [{}] }, true);
    await expect(
      applySenderVideoParameters(target, {
        maxBitrate: 200_000,
        maxFramerate: 12,
        scaleResolutionDownBy: 1,
        degradationPreference: 'maintain-framerate',
      }),
    ).resolves.toBe(false);
  });
});

describe('compatibilité des champs existants', () => {
  it('conserve videoBytesSent pour les anciens appelants', () => {
    const stats: LinkStats = summarizeStats(REPORT);
    expect(stats.videoBytesSent).toBe(stats.videoOut.bytesSent);
  });
});
