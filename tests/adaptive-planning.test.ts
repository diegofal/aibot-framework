import { describe, expect, it } from 'bun:test';
import {
  type AdaptiveMetrics,
  type AdaptiveParams,
  computeAdaptiveAdjustments,
  createDefaultAdaptiveParams,
  ema,
  renderAdaptiveParams,
} from '../src/bot/adaptive-planning';

describe('adaptive-planning', () => {
  // ── EMA ──

  describe('ema', () => {
    it('returns new value when alpha=1', () => {
      expect(ema(10, 20, 1.0)).toBe(20);
    });

    it('returns current value when alpha=0', () => {
      expect(ema(10, 20, 0.0)).toBe(10);
    });

    it('blends with default alpha=0.3', () => {
      const result = ema(1.0, 1.25);
      // 0.3 * 1.25 + 0.7 * 1.0 = 0.375 + 0.7 = 1.075
      expect(result).toBeCloseTo(1.075, 3);
    });
  });

  // ── Defaults ──

  describe('createDefaultAdaptiveParams', () => {
    it('returns nominal values', () => {
      const p = createDefaultAdaptiveParams();
      expect(p.cycleIntervalMultiplier).toBe(1.0);
      expect(p.maxToolRoundsAdjust).toBe(0);
      expect(p.temperatureAdjust).toBe(0);
      expect(p.forceAskHuman).toBe(false);
      expect(p.lastAdaptiveAt).toBeNull();
    });
  });

  // ── Core computation ──

  describe('computeAdaptiveAdjustments', () => {
    const base = createDefaultAdaptiveParams();

    const nominalMetrics: AdaptiveMetrics = {
      idleRate: 0.3,
      planSuccessRate: 0.6,
      karmaTrend: 0,
      cyclesSinceAskHuman: 2,
    };

    it('rate-limits adjustments within 6 hours', () => {
      const recent: AdaptiveParams = {
        ...base,
        lastAdaptiveAt: Date.now() - 1_000, // 1 second ago
      };
      const result = computeAdaptiveAdjustments(recent, nominalMetrics);
      // Should return unchanged
      expect(result).toEqual(recent);
    });

    it('allows adjustment after 6 hours', () => {
      const old: AdaptiveParams = {
        ...base,
        lastAdaptiveAt: Date.now() - 7 * 3_600_000, // 7 hours ago
      };
      const result = computeAdaptiveAdjustments(old, nominalMetrics);
      expect(result.lastAdaptiveAt).not.toEqual(old.lastAdaptiveAt);
    });

    it('allows first adjustment when lastAdaptiveAt is null', () => {
      const result = computeAdaptiveAdjustments(base, nominalMetrics);
      expect(result.lastAdaptiveAt).not.toBeNull();
    });

    it('increases interval on high idle rate', () => {
      const metrics: AdaptiveMetrics = {
        ...nominalMetrics,
        idleRate: 0.75,
      };
      const result = computeAdaptiveAdjustments(base, metrics);
      expect(result.cycleIntervalMultiplier).toBeGreaterThan(1.0);
    });

    it('decreases interval when active', () => {
      const starting: AdaptiveParams = {
        ...base,
        cycleIntervalMultiplier: 2.0,
      };
      const metrics: AdaptiveMetrics = {
        ...nominalMetrics,
        idleRate: 0.1,
      };
      const result = computeAdaptiveAdjustments(starting, metrics);
      expect(result.cycleIntervalMultiplier).toBeLessThan(2.0);
    });

    it('increases tool rounds on high success + positive karma', () => {
      const metrics: AdaptiveMetrics = {
        ...nominalMetrics,
        planSuccessRate: 0.9,
        karmaTrend: 1.5,
      };
      const result = computeAdaptiveAdjustments(base, metrics);
      expect(result.maxToolRoundsAdjust).toBeGreaterThan(0);
    });

    it('decreases tool rounds and temperature on low success', () => {
      const metrics: AdaptiveMetrics = {
        ...nominalMetrics,
        planSuccessRate: 0.2,
      };
      const result = computeAdaptiveAdjustments(base, metrics);
      expect(result.maxToolRoundsAdjust).toBeLessThan(0);
      expect(result.temperatureAdjust).toBeLessThan(0);
    });

    it('forces ask_human on long silence + declining karma', () => {
      const metrics: AdaptiveMetrics = {
        ...nominalMetrics,
        cyclesSinceAskHuman: 12,
        karmaTrend: -1.0,
      };
      const result = computeAdaptiveAdjustments(base, metrics);
      expect(result.forceAskHuman).toBe(true);
    });

    it('does not force ask_human when karma is positive', () => {
      const metrics: AdaptiveMetrics = {
        ...nominalMetrics,
        cyclesSinceAskHuman: 12,
        karmaTrend: 0.5,
      };
      const result = computeAdaptiveAdjustments(base, metrics);
      expect(result.forceAskHuman).toBe(false);
    });

    it('clamps interval multiplier to [0.5, 4.0]', () => {
      // Test upper clamp
      const highIdle: AdaptiveParams = {
        ...base,
        cycleIntervalMultiplier: 3.9,
      };
      const r1 = computeAdaptiveAdjustments(highIdle, {
        ...nominalMetrics,
        idleRate: 0.9,
      });
      expect(r1.cycleIntervalMultiplier).toBeLessThanOrEqual(4.0);
    });

    it('clamps tool rounds to [-5, 10]', () => {
      const lowSuccess: AdaptiveParams = {
        ...base,
        maxToolRoundsAdjust: -4,
      };
      const result = computeAdaptiveAdjustments(lowSuccess, {
        ...nominalMetrics,
        planSuccessRate: 0.1,
      });
      expect(result.maxToolRoundsAdjust).toBeGreaterThanOrEqual(-5);
    });

    it('clamps temperature adjust to [-0.3, 0.3]', () => {
      const low: AdaptiveParams = {
        ...base,
        temperatureAdjust: -0.28,
      };
      const result = computeAdaptiveAdjustments(low, {
        ...nominalMetrics,
        planSuccessRate: 0.1,
      });
      expect(result.temperatureAdjust).toBeGreaterThanOrEqual(-0.3);
    });
  });

  // ── Rendering ──

  describe('renderAdaptiveParams', () => {
    it('renders nominal state', () => {
      const result = renderAdaptiveParams(createDefaultAdaptiveParams());
      expect(result).toBe('Adaptive: nominal');
    });

    it('renders non-nominal params', () => {
      const p: AdaptiveParams = {
        cycleIntervalMultiplier: 2.0,
        maxToolRoundsAdjust: 3,
        temperatureAdjust: -0.1,
        forceAskHuman: true,
        lastAdaptiveAt: Date.now(),
      };
      const result = renderAdaptiveParams(p);
      expect(result).toContain('interval: 2.00x');
      expect(result).toContain('toolRounds: +3');
      expect(result).toContain('temp: -0.10');
      expect(result).toContain('forceAskHuman');
    });
  });
});
