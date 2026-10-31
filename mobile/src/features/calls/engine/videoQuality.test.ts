import { describe, expect, it } from 'vitest';

import {
  DIRECT_VIDEO_TIERS,
  GROUP_VIDEO_TIERS,
  VIDEO_TUNING,
  decideVideoTier,
  initialTierIndex,
  initialTierState,
  lowestUsableIndex,
  perLinkBudgetKbps,
  senderParameters,
  type DecideOptions,
  type LinkVideoSample,
  type VideoTierState,
} from './videoQuality';

function sample(patch: Partial<LinkVideoSample> = {}): LinkVideoSample {
  return {
    availableBitrateBps: 2_000_000,
    lossRatio: 0,
    roundTripMs: 80,
    limitationReason: 'none',
    ...patch,
  };
}

const GROUP: DecideOptions = { kind: 'GROUP', peerLinks: 2, captureHeight: 480 };
const DIRECT: DecideOptions = { kind: 'DIRECT', peerLinks: 1, captureHeight: 720 };

function apply(
  state: VideoTierState,
  patches: Partial<LinkVideoSample>[],
  options = GROUP,
): { state: VideoTierState; actions: string[] } {
  const actions: string[] = [];
  let current = state;
  for (const patch of patches) {
    const decision = decideVideoTier(current, sample(patch), options);
    current = decision.state;
    actions.push(decision.action);
  }
  return { state: current, actions };
}

describe('paliers initiaux', () => {
  it('démarre en 480p/600 kbit/s en un à un', () => {
    expect(DIRECT_VIDEO_TIERS[initialTierIndex('DIRECT')]).toMatchObject({
      height: 480,
      maxFramerate: 24,
      maxBitrateKbps: 600,
    });
  });

  it('démarre en 480p/15 i/s à 350 kbit/s en groupe', () => {
    expect(GROUP_VIDEO_TIERS[initialTierIndex('GROUP')]).toMatchObject({
      height: 480,
      maxFramerate: 15,
      maxBitrateKbps: 350,
    });
  });
});

describe('budget montant du maillage', () => {
  it('répartit 900 kbit/s puis borne à 350 par lien', () => {
    expect(perLinkBudgetKbps('GROUP', 2)).toBe(350);
    expect(perLinkBudgetKbps('GROUP', 3)).toBe(300);
    expect(perLinkBudgetKbps('GROUP', 7)).toBe(200);
    expect(perLinkBudgetKbps('GROUP', 1)).toBe(350);
  });

  it('ne divise pas le budget en un à un', () => {
    expect(perLinkBudgetKbps('DIRECT', 1)).toBe(1200);
  });
});

describe('paramètres du sender', () => {
  it('plafonne le débit au budget du lien et garde 15 i/s', () => {
    const params = senderParameters(GROUP_VIDEO_TIERS[0], 300, 480);
    expect(params.maxBitrate).toBe(300_000);
    expect(params.maxFramerate).toBe(15);
    expect(params.scaleResolutionDownBy).toBe(1);
    expect(params.degradationPreference).toBe('maintain-framerate');
  });

  it('réduit la résolution relative à la capture', () => {
    const tier = GROUP_VIDEO_TIERS.find((entry) => entry.height === 360)!;
    expect(senderParameters(tier, 350, 480).scaleResolutionDownBy).toBe(1.33);
    expect(senderParameters(tier, 350, 720).scaleResolutionDownBy).toBe(2);
  });

  it('ne dépasse jamais la source', () => {
    expect(lowestUsableIndex(DIRECT_VIDEO_TIERS, 480)).toBe(1);
    expect(lowestUsableIndex(DIRECT_VIDEO_TIERS, 720)).toBe(0);
    expect(senderParameters(DIRECT_VIDEO_TIERS[0], 1200, 480).scaleResolutionDownBy).toBe(1);
  });
});

describe('dégradation par paliers', () => {
  it('descend débit → i/s → résolution avant de couper', () => {
    const start = initialTierState('GROUP');
    const { actions } = apply(start, [
      { lossRatio: 0.1 }, { lossRatio: 0.1 }, // g1 : débit 280
      { lossRatio: 0.1 }, { lossRatio: 0.1 }, // g2 : 12 i/s
      { lossRatio: 0.1 }, { lossRatio: 0.1 }, // g3 : 360p
      { lossRatio: 0.1 }, { lossRatio: 0.1 }, // g4 : 240p
      { lossRatio: 0.1 }, { lossRatio: 0.1 }, // coupe
    ]);
    expect(actions.filter((entry) => entry === 'step-down')).toHaveLength(4);
    expect(actions.at(-1)).toBe('cut');
    expect(GROUP_VIDEO_TIERS[1].maxFramerate).toBe(15);
    expect(GROUP_VIDEO_TIERS[2].maxFramerate).toBeLessThan(15);
    expect(GROUP_VIDEO_TIERS[3].height).toBeLessThan(GROUP_VIDEO_TIERS[2].height);
  });

  it('ne descend pas sur une seule mesure mauvaise', () => {
    const { actions, state } = apply(initialTierState('GROUP'), [{ lossRatio: 0.1 }]);
    expect(actions).toEqual(['none']);
    expect(state.index).toBe(0);
  });

  it('une mesure neutre casse la série', () => {
    const neutral = { lossRatio: 0.03, availableBitrateBps: null };
    const { actions } = apply(initialTierState('GROUP'), [
      { lossRatio: 0.1 },
      neutral,
      { lossRatio: 0.1 },
    ]);
    expect(actions).toEqual(['none', 'none', 'none']);
  });

  it('coupe tout de suite sous le plancher dur, audio conservé', () => {
    const { actions, state } = apply(initialTierState('GROUP'), [
      { availableBitrateBps: 100_000 },
      { availableBitrateBps: 100_000 },
    ]);
    expect(actions.at(-1)).toBe('cut');
    expect(state.cut).toBe(true);
  });

  it('tient compte du CPU (qualityLimitationReason)', () => {
    const { actions } = apply(initialTierState('GROUP'), [
      { limitationReason: 'cpu' },
      { limitationReason: 'cpu' },
    ]);
    expect(actions.at(-1)).toBe('step-down');
  });
});

describe('remontée prudente', () => {
  it('exige ~10 s de mesures bonnes pour le palier visé', () => {
    const stepped = apply(initialTierState('GROUP'), [{ lossRatio: 0.1 }, { lossRatio: 0.1 }]);
    expect(stepped.state.index).toBe(1);
    const good = { availableBitrateBps: 600_000, lossRatio: 0, roundTripMs: 60 };
    const attempts = apply(stepped.state, Array(VIDEO_TUNING.goodSamplesToStepUp).fill(good));
    expect(attempts.actions.slice(0, 4)).toEqual(['none', 'none', 'none', 'none']);
    expect(attempts.actions.at(-1)).toBe('step-up');
    expect(attempts.state.index).toBe(0);
  });

  it('ne remonte pas si le débit suffit au palier courant mais pas au palier visé', () => {
    const stepped = { index: 1, cut: false, bad: 0, good: 0 };
    // 300 kbit/s : assez pour 280, insuffisant pour 350 × 1,25 = 437,5.
    const samples = Array(VIDEO_TUNING.goodSamplesToStepUp + 2).fill({
      availableBitrateBps: 300_000,
      lossRatio: 0,
      roundTripMs: 60,
    });
    const result = apply(stepped, samples);
    expect(result.actions).toEqual(Array(samples.length).fill('none'));
    expect(result.state.index).toBe(1);
  });

  it('repart du palier le plus bas après une coupure', () => {
    const cut: VideoTierState = { index: GROUP_VIDEO_TIERS.length - 1, cut: true, bad: 0, good: 0 };
    const good = { availableBitrateBps: 400_000, lossRatio: 0, roundTripMs: 60 };
    const result = apply(cut, Array(VIDEO_TUNING.goodSamplesToStepUp).fill(good));
    expect(result.actions.at(-1)).toBe('resume');
    expect(result.state.index).toBe(GROUP_VIDEO_TIERS.length - 1);
    expect(result.state.cut).toBe(false);
  });

  it('ne monte jamais au-delà du palier 0 en groupe', () => {
    const result = apply(initialTierState('GROUP'), Array(10).fill({ availableBitrateBps: 2_000_000 }));
    expect(result.state.index).toBe(0);
    expect(result.actions).toEqual(Array(10).fill('none'));
  });
});

describe('un à un', () => {
  it('monte à 720p seulement si la capture suit', () => {
    const state: VideoTierState = { index: 1, cut: false, bad: 0, good: 0 };
    const good = { availableBitrateBps: 3_000_000, lossRatio: 0, roundTripMs: 40 };
    const withoutCapture = apply(state, Array(5).fill(good), { ...DIRECT, captureHeight: 480 });
    expect(withoutCapture.state.index).toBe(1);
    const withCapture = apply(state, Array(5).fill(good), DIRECT);
    expect(withCapture.state.index).toBe(0);
    expect(withCapture.actions.at(-1)).toBe('step-up');
  });
});
