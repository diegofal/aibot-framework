import { describe, expect, it } from 'bun:test';
import {
  CURIOSITY_DEFAULTS,
  CURIOSITY_PRESETS,
  evaluateFrontierItem,
  parseEveryMs,
  resolveCuriosity,
  scaleExploreRatio,
} from '../../../src/bot/curiosity/config';
import type { FrontierItem } from '../../../src/bot/curiosity/types';
import { BotAgentLoopOverrideSchema, GlobalAgentLoopConfigSchema } from '../../../src/config';

const item = (over: Partial<FrontierItem> = {}): FrontierItem => ({
  id: 'f1',
  question: 'q',
  whyInteresting: 'w',
  bridge: 'serves purpose',
  distance: 1,
  surpriseScore: 0.5,
  createdAt: '2026-10-03T00:00:00Z',
  status: 'open',
  ...over,
});

describe('curiosity config schema', () => {
  it('accepts a per-bot curiosity block', () => {
    const parsed = BotAgentLoopOverrideSchema.parse({
      curiosity: { preset: 'wild', limits: { identity: 'closed' }, exploreRatio: 0.4 },
    });
    expect(parsed.curiosity?.preset).toBe('wild');
    expect(parsed.curiosity?.limits?.identity).toBe('closed');
  });

  it('rejects an unknown dial level', () => {
    expect(() =>
      BotAgentLoopOverrideSchema.parse({ curiosity: { limits: { topic: 'maybe' } } })
    ).toThrow();
  });

  it('global agentLoop has no curiosity block by default (DNA defaults live in code)', () => {
    expect(GlobalAgentLoopConfigSchema.parse({}).curiosity).toBeUndefined();
  });
});

describe('parseEveryMs', () => {
  it('parses m/h/d', () => {
    expect(parseEveryMs('30m')).toBe(30 * 60_000);
    expect(parseEveryMs('12h')).toBe(12 * 3_600_000);
    expect(parseEveryMs('1d')).toBe(86_400_000);
  });
  it('falls back on garbage', () => {
    expect(parseEveryMs('soon', 5)).toBe(5);
  });
});

describe('scaleExploreRatio', () => {
  it('leaves the ratio unchanged at curiosity 0.5', () => {
    expect(scaleExploreRatio(0.25, 0.5)).toBeCloseTo(0.25);
  });
  it('scales up with high curiosity and caps at 0.6', () => {
    expect(scaleExploreRatio(0.25, 0.9)).toBeCloseTo(0.35);
    expect(scaleExploreRatio(0.5, 0.9)).toBe(0.6);
  });
  it('scales down with low curiosity', () => {
    expect(scaleExploreRatio(0.25, 0.1)).toBeCloseTo(0.15);
  });
  it('ignores a missing trait', () => {
    expect(scaleExploreRatio(0.25, undefined)).toBe(0.25);
  });
});

describe('resolveCuriosity', () => {
  it('is on by default with the explorer preset — curiosity is DNA', () => {
    const r = resolveCuriosity(undefined, undefined);
    expect(r.enabled).toBe(true);
    expect(r.preset).toBe('explorer');
    expect(r.limits).toEqual(CURIOSITY_PRESETS.explorer);
    expect(r.exploreRatio).toBe(CURIOSITY_DEFAULTS.exploreRatio);
    expect(r.dispatch.maxChars).toBe(1200);
  });

  it('per-bot preset wins over global preset', () => {
    const r = resolveCuriosity({ preset: 'focused' }, { preset: 'wild' });
    expect(r.preset).toBe('wild');
    expect(r.limits).toEqual(CURIOSITY_PRESETS.wild);
  });

  it('explicit dials override the preset, per-bot over global', () => {
    const r = resolveCuriosity(
      { limits: { topic: 'closed', method: 'ask' } },
      { preset: 'wild', limits: { identity: 'closed', topic: 'ask' } }
    );
    expect(r.limits.identity).toBe('closed');
    expect(r.limits.topic).toBe('ask');
    expect(r.limits.method).toBe('ask'); // global explicit dial beats bot preset
    expect(r.limits.purpose).toBe('open');
  });

  it('per-bot enabled:false turns it off', () => {
    expect(resolveCuriosity({ enabled: true }, { enabled: false }).enabled).toBe(false);
  });

  it('scales exploreRatio with the curiosity trait', () => {
    const r = resolveCuriosity(undefined, { exploreRatio: 0.2 }, 0.9);
    expect(r.exploreRatio).toBeCloseTo(0.28);
  });

  it('resolves navigatorEvery to ms and merges dispatch settings', () => {
    const r = resolveCuriosity(
      { navigatorEvery: '12h', dispatch: { maxChars: 900 } },
      { dispatch: { minEditorScore: 0.8 } }
    );
    expect(r.navigatorEveryMs).toBe(12 * 3_600_000);
    expect(r.dispatch.maxChars).toBe(900);
    expect(r.dispatch.minEditorScore).toBe(0.8);
  });

  it('keeps min ≤ base ≤ max dispatch intervals', () => {
    const r = resolveCuriosity(undefined, {
      dispatch: { minIntervalHours: 20, baseIntervalHours: 6, maxIntervalHours: 10 },
    });
    expect(r.dispatch.minIntervalHours).toBeLessThanOrEqual(r.dispatch.baseIntervalHours);
    expect(r.dispatch.baseIntervalHours).toBeLessThanOrEqual(r.dispatch.maxIntervalHours);
  });
});

describe('evaluateFrontierItem', () => {
  const explorer = CURIOSITY_PRESETS.explorer;

  it('allows an adjacent bridged item under any preset', () => {
    expect(evaluateFrontierItem(item(), CURIOSITY_PRESETS.focused)).toEqual({
      allowed: true,
      crosses: [],
      needsApproval: [],
      blockedBy: [],
    });
  });

  it('a far item crosses topic: blocked when closed', () => {
    const r = evaluateFrontierItem(item({ distance: 2 }), CURIOSITY_PRESETS.focused);
    expect(r.allowed).toBe(false);
    expect(r.blockedBy).toEqual(['topic']);
  });

  it('a far item is allowed when topic is open', () => {
    expect(evaluateFrontierItem(item({ distance: 3 }), explorer).allowed).toBe(true);
  });

  it('an unbridged item crosses purpose: needs approval under ask', () => {
    const r = evaluateFrontierItem(item({ bridge: undefined }), explorer);
    expect(r.allowed).toBe(false);
    expect(r.needsApproval).toEqual(['purpose']);
  });

  it('operator approval (signal up) unlocks an ask-gated item', () => {
    const r = evaluateFrontierItem(item({ bridge: '  ', operatorSignal: 'up' }), explorer);
    expect(r.allowed).toBe(true);
    expect(r.crosses).toEqual(['purpose']);
  });

  it('operator rejection blocks even an otherwise allowed item', () => {
    expect(evaluateFrontierItem(item({ operatorSignal: 'down' }), explorer).allowed).toBe(false);
  });

  it('a closed dial still blocks after approval', () => {
    const r = evaluateFrontierItem(
      item({ distance: 4, operatorSignal: 'up' }),
      CURIOSITY_PRESETS.focused
    );
    expect(r.allowed).toBe(false);
    expect(r.blockedBy).toEqual(['topic']);
  });
});
