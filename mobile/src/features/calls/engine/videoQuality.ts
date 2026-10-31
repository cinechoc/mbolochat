/**
 * Réglages vidéo des appels : paliers de qualité, budget montant du maillage et
 * paramètres `RTCRtpSender`. Logique pure, testée sans appareil.
 *
 * Ordre de dégradation imposé : débit, puis fréquence d'images, puis
 * résolution. La vidéo est coupée en dernier recours, jamais l'audio.
 */

export type CallLinkKind = 'DIRECT' | 'GROUP';

export type VideoTier = {
  id: string;
  /** Hauteur cible de l'image envoyée, en pixels. */
  height: number;
  maxFramerate: number;
  maxBitrateKbps: number;
};

/**
 * Un à un : départ 480p/600 kbit/s ; 720p seulement quand le lien est stable.
 * L'ordre des paliers est celui de la dégradation (débit → i/s → résolution).
 */
export const DIRECT_VIDEO_TIERS: readonly VideoTier[] = [
  { id: '720p-24-1200', height: 720, maxFramerate: 24, maxBitrateKbps: 1200 },
  { id: '480p-24-700', height: 480, maxFramerate: 24, maxBitrateKbps: 700 },
  { id: '480p-24-600', height: 480, maxFramerate: 24, maxBitrateKbps: 600 },
  { id: '480p-24-450', height: 480, maxFramerate: 24, maxBitrateKbps: 450 },
  { id: '480p-20-400', height: 480, maxFramerate: 20, maxBitrateKbps: 400 },
  { id: '480p-15-320', height: 480, maxFramerate: 15, maxBitrateKbps: 320 },
  { id: '360p-15-250', height: 360, maxFramerate: 15, maxBitrateKbps: 250 },
  { id: '360p-12-200', height: 360, maxFramerate: 12, maxBitrateKbps: 200 },
];

/** Groupe : 480p/15 i/s au départ, 350 kbit/s maximum par flux. */
export const GROUP_VIDEO_TIERS: readonly VideoTier[] = [
  { id: '480p-15-350', height: 480, maxFramerate: 15, maxBitrateKbps: 350 },
  { id: '480p-15-280', height: 480, maxFramerate: 15, maxBitrateKbps: 280 },
  { id: '480p-12-240', height: 480, maxFramerate: 12, maxBitrateKbps: 240 },
  { id: '360p-12-180', height: 360, maxFramerate: 12, maxBitrateKbps: 180 },
  { id: '240p-10-150', height: 240, maxFramerate: 10, maxBitrateKbps: 150 },
];

export const VIDEO_TUNING = {
  /** En un à un, la capture peut monter à 720p ; en groupe elle reste à 480p. */
  directCaptureHeight: 720,
  groupCaptureHeight: 480,
  /** Budget montant total du maillage, réparti à parts égales entre les liens. */
  groupUpstreamTotalKbps: 900,
  groupPerLinkMinKbps: 200,
  groupPerLinkMaxKbps: 350,
  /** Deux mesures mauvaises d'affilée (2 s chacune) font descendre d'un palier. */
  badSamplesToStepDown: 2,
  /** Cinq bonnes mesures d'affilée (~10 s) avant de remonter : pas d'ascenseur. */
  goodSamplesToStepUp: 5,
  /** Sous ce débit disponible pendant deux mesures, on coupe tout de suite. */
  hardCutBelowKbps: 120,
  badLossRatio: 0.05,
  badRoundTripMs: 400,
  goodLossRatio: 0.02,
  goodRoundTripMs: 250,
} as const;

export function tiersFor(kind: CallLinkKind): readonly VideoTier[] {
  return kind === 'GROUP' ? GROUP_VIDEO_TIERS : DIRECT_VIDEO_TIERS;
}

/**
 * Budget montant par lien, en kbit/s. En maillage, le total est divisé par le
 * nombre de liens (participants - 1), borné pour rester utile et raisonnable.
 */
export function perLinkBudgetKbps(kind: CallLinkKind, peerLinks: number): number {
  if (kind === 'DIRECT') {
    return DIRECT_VIDEO_TIERS[0].maxBitrateKbps;
  }
  const links = Math.max(1, peerLinks);
  return Math.min(
    VIDEO_TUNING.groupPerLinkMaxKbps,
    Math.max(VIDEO_TUNING.groupPerLinkMinKbps, Math.round(VIDEO_TUNING.groupUpstreamTotalKbps / links)),
  );
}

/** Palier de départ : 480p/600 kbit/s en un à un, 480p/350 en groupe. */
export function initialTierIndex(kind: CallLinkKind): number {
  return kind === 'GROUP' ? 0 : 2;
}

/** Indice du meilleur palier envoyable depuis la hauteur de capture courante. */
export function lowestUsableIndex(tiers: readonly VideoTier[], captureHeight: number): number {
  const index = tiers.findIndex((tier) => tier.height <= captureHeight);
  return index === -1 ? tiers.length - 1 : index;
}

export type SenderVideoParameters = {
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
  degradationPreference: 'maintain-framerate';
};

/**
 * Paramètres à poser sur le sender : débit borné par le budget du lien,
 * fréquence d'images et réduction de résolution relative à la capture.
 */
export function senderParameters(
  tier: VideoTier,
  budgetKbps: number,
  captureHeight: number,
): SenderVideoParameters {
  const scale = Math.min(Math.max(captureHeight / tier.height, 1), 4);
  return {
    maxBitrate: Math.min(tier.maxBitrateKbps, budgetKbps) * 1000,
    maxFramerate: tier.maxFramerate,
    scaleResolutionDownBy: Math.round(scale * 100) / 100,
    degradationPreference: 'maintain-framerate',
  };
}

export type LinkVideoSample = {
  /** Débit montant estimé par la pile WebRTC, en bits/s. */
  availableBitrateBps: number | null;
  /** Perte vidéo entrante, 0 à 1. */
  lossRatio: number;
  roundTripMs: number | null;
  /** `qualityLimitationReason` du flux sortant : bandwidth, cpu, other, none. */
  limitationReason: string | null;
};

export type VideoTierState = {
  index: number;
  /** La vidéo est coupée : l'audio continue seul. */
  cut: boolean;
  bad: number;
  good: number;
};

export type TierDecisionAction = 'none' | 'step-down' | 'step-up' | 'cut' | 'resume';

export type TierDecision = {
  state: VideoTierState;
  /** Palier à appliquer, `null` quand la vidéo reste coupée. */
  tier: VideoTier | null;
  action: TierDecisionAction;
};

export type DecideOptions = {
  kind: CallLinkKind;
  peerLinks: number;
  captureHeight: number;
};

export function initialTierState(kind: CallLinkKind): VideoTierState {
  return { index: initialTierIndex(kind), cut: false, bad: 0, good: 0 };
}

/**
 * Applique une mesure à l'état du palier. Descend vite (deux mesures), remonte
 * lentement (~10 s), coupe en dernier recours et repart du palier le plus bas
 * après une coupure, pour ne pas faire d'ascenseur.
 */
export function decideVideoTier(
  state: VideoTierState,
  sample: LinkVideoSample,
  options: DecideOptions,
): TierDecision {
  const tiers = tiersFor(options.kind);
  const budget = perLinkBudgetKbps(options.kind, options.peerLinks);
  const current = tiers[Math.min(state.index, tiers.length - 1)];
  const requiredBps = Math.min(current.maxBitrateKbps, budget) * 1000;
  const floorIndex = lowestUsableIndex(tiers, options.captureHeight);

  const hardCut = sample.availableBitrateBps !== null && sample.availableBitrateBps < VIDEO_TUNING.hardCutBelowKbps * 1000;
  const bad = hardCut || isBadSample(sample, requiredBps);
  // Une remontée exige le débit du palier visé, pas celui du palier courant :
  // sinon on monte puis on redescend aussitôt (effet d'ascenseur).
  const targetForGood =
    !state.cut && state.index > floorIndex ? tiers[state.index - 1] : current;
  const goodRequiredBps = Math.min(targetForGood.maxBitrateKbps, budget) * 1000;
  const good = !bad && isGoodSample(sample, goodRequiredBps);

  let badCount = good ? 0 : state.bad + (bad ? 1 : 0);
  let goodCount = bad ? 0 : state.good + (good ? 1 : 0);
  if (!bad && !good) {
    // Mesure neutre : elle ne valide ni ne casse une série.
    badCount = 0;
    goodCount = 0;
  }

  if (state.cut) {
    if (goodCount >= VIDEO_TUNING.goodSamplesToStepUp) {
      const resumeIndex = tiers.length - 1;
      return {
        state: { index: resumeIndex, cut: false, bad: 0, good: 0 },
        tier: tiers[resumeIndex],
        action: 'resume',
      };
    }
    return { state: { ...state, bad: badCount, good: goodCount }, tier: null, action: 'none' };
  }

  if (badCount >= VIDEO_TUNING.badSamplesToStepDown) {
    if (hardCut) {
      return {
        state: { index: state.index, cut: true, bad: 0, good: 0 },
        tier: null,
        action: 'cut',
      };
    }
    const nextIndex = state.index + 1;
    if (nextIndex >= tiers.length) {
      return {
        state: { index: tiers.length - 1, cut: true, bad: 0, good: 0 },
        tier: null,
        action: 'cut',
      };
    }
    return {
      state: { index: nextIndex, cut: false, bad: 0, good: 0 },
      tier: tiers[nextIndex],
      action: 'step-down',
    };
  }

  if (goodCount >= VIDEO_TUNING.goodSamplesToStepUp && state.index > floorIndex) {
    const nextIndex = state.index - 1;
    return {
      state: { index: nextIndex, cut: false, bad: 0, good: 0 },
      tier: tiers[nextIndex],
      action: 'step-up',
    };
  }

  return { state: { ...state, bad: badCount, good: goodCount }, tier: current, action: 'none' };
}

function isBadSample(sample: LinkVideoSample, requiredBps: number): boolean {
  if (sample.limitationReason === 'cpu') {
    return true;
  }
  if (sample.lossRatio >= VIDEO_TUNING.badLossRatio) {
    return true;
  }
  if (sample.roundTripMs !== null && sample.roundTripMs >= VIDEO_TUNING.badRoundTripMs) {
    return true;
  }
  return sample.availableBitrateBps !== null && sample.availableBitrateBps < requiredBps * 0.9;
}

function isGoodSample(sample: LinkVideoSample, requiredBps: number): boolean {
  if (sample.limitationReason === 'cpu') {
    return false;
  }
  if (sample.lossRatio > VIDEO_TUNING.goodLossRatio) {
    return false;
  }
  if (sample.roundTripMs !== null && sample.roundTripMs >= VIDEO_TUNING.goodRoundTripMs) {
    return false;
  }
  return sample.availableBitrateBps === null || sample.availableBitrateBps >= requiredBps * 1.25;
}
