import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TraitRegisters, createDefaultTraits, deriveParameters } from '../src/bot/trait-registers';
import type { TraitSet } from '../src/bot/trait-registers';

const TEST_DIR = join(import.meta.dir, '.tmp-trait-registers');
const BOT_ID = 'test-bot';

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
} as any;

describe('trait-registers', () => {
  let registers: TraitRegisters;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    registers = new TraitRegisters(TEST_DIR, nullLogger);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ── Defaults ──

  describe('createDefaultTraits', () => {
    it('returns all traits at 0.5', () => {
      const traits = createDefaultTraits();
      for (const val of Object.values(traits)) {
        expect(val).toBe(0.5);
      }
    });
  });

  // ── Load/Save ──

  describe('load', () => {
    it('creates defaults when no file exists', () => {
      const traits = registers.load(BOT_ID);
      expect(traits.curiosity).toBe(0.5);
      expect(traits.creativity).toBe(0.5);
      // File should now exist
      expect(existsSync(join(TEST_DIR, BOT_ID, 'TRAITS.json'))).toBe(true);
    });

    it('persists and reloads traits', () => {
      registers.adjust(BOT_ID, { curiosity: 0.05 }, 'strategist');
      // New instance to force disk read
      const registers2 = new TraitRegisters(TEST_DIR, nullLogger);
      const traits = registers2.load(BOT_ID);
      expect(traits.curiosity).toBeCloseTo(0.55, 2);
    });
  });

  // ── Adjustments ──

  describe('adjust', () => {
    it('applies bounded strategist adjustments (±0.05)', () => {
      const result = registers.adjust(BOT_ID, { curiosity: 0.1 }, 'strategist');
      // Should be clamped to +0.05
      expect(result.curiosity).toBeCloseTo(0.55, 2);
    });

    it('applies bounded reflection adjustments (±0.15)', () => {
      const result = registers.adjust(BOT_ID, { curiosity: 0.2 }, 'reflection');
      // Should be clamped to +0.15
      expect(result.curiosity).toBeCloseTo(0.65, 2);
    });

    it('applies bounded adaptive adjustments (±0.03)', () => {
      const result = registers.adjust(BOT_ID, { curiosity: 0.1 }, 'adaptive');
      // Should be clamped to +0.03
      expect(result.curiosity).toBeCloseTo(0.53, 2);
    });

    it('clamps values to [0.1, 0.9]', () => {
      // Push curiosity high through multiple adjustments
      for (let i = 0; i < 20; i++) {
        registers.adjust(BOT_ID, { curiosity: 0.15 }, 'reflection');
      }
      const traits = registers.load(BOT_ID);
      expect(traits.curiosity).toBeLessThanOrEqual(0.9);

      // Push low
      for (let i = 0; i < 20; i++) {
        registers.adjust(BOT_ID, { curiosity: -0.15 }, 'reflection');
      }
      const traits2 = registers.load(BOT_ID);
      expect(traits2.curiosity).toBeGreaterThanOrEqual(0.1);
    });

    it('handles negative deltas', () => {
      const result = registers.adjust(BOT_ID, { caution: -0.05 }, 'strategist');
      expect(result.caution).toBeCloseTo(0.45, 2);
    });

    it('adjusts multiple traits at once', () => {
      const result = registers.adjust(
        BOT_ID,
        { curiosity: 0.05, caution: -0.03, creativity: 0.04 },
        'strategist'
      );
      expect(result.curiosity).toBeCloseTo(0.55, 2);
      expect(result.caution).toBeCloseTo(0.47, 2);
      expect(result.creativity).toBeCloseTo(0.54, 2);
    });
  });

  // ── Derived parameters ──

  describe('deriveParameters', () => {
    it('computes correct parameters from default traits', () => {
      const params = deriveParameters(createDefaultTraits());
      // creativity=0.5: executorTemp = 0.4 + 0.5*0.6 = 0.7
      expect(params.executorTemperature).toBeCloseTo(0.7, 2);
      // creativity=0.5: plannerTemp = 0.15 + 0.5*0.35 = 0.325
      expect(params.plannerTemperature).toBeCloseTo(0.325, 3);
      // independence=0.5: cycles = 3 + 0.5*10 = 8
      expect(params.askHumanCheckInCycles).toBe(8);
      // depth=0.5: bonus = 0.5*15 = 7.5 → 8
      expect(params.maxToolRoundsBonus).toBe(8);
      // curiosity=0.5: not > 0.7
      expect(params.webToolAlwaysIncluded).toBe(false);
      // persistence=0.5: cycles = 3 + 0.5*12 = 9
      expect(params.idleCyclesBeforeAbandon).toBe(9);
    });

    it('high curiosity enables web tools', () => {
      const traits: TraitSet = { ...createDefaultTraits(), curiosity: 0.8 };
      expect(deriveParameters(traits).webToolAlwaysIncluded).toBe(true);
    });

    it('low creativity lowers temperatures', () => {
      const traits: TraitSet = { ...createDefaultTraits(), creativity: 0.1 };
      const params = deriveParameters(traits);
      expect(params.executorTemperature).toBeCloseTo(0.46, 2);
      expect(params.plannerTemperature).toBeCloseTo(0.185, 3);
    });

    it('high depth increases tool rounds bonus', () => {
      const traits: TraitSet = { ...createDefaultTraits(), depth: 0.9 };
      const params = deriveParameters(traits);
      expect(params.maxToolRoundsBonus).toBe(14); // 0.9*15=13.5 → 14
    });
  });

  // ── getParameters integration ──

  describe('getParameters', () => {
    it('loads traits and returns derived params', () => {
      registers.adjust(BOT_ID, { creativity: 0.05 }, 'strategist');
      const params = registers.getParameters(BOT_ID);
      // creativity went from 0.5 → 0.55
      expect(params.executorTemperature).toBeCloseTo(0.4 + 0.55 * 0.6, 2);
    });
  });

  // ── History ──

  describe('getHistory', () => {
    it('tracks adjustment history', () => {
      registers.load(BOT_ID); // creates initial
      registers.adjust(BOT_ID, { curiosity: 0.05 }, 'strategist');
      registers.adjust(BOT_ID, { caution: -0.03 }, 'adaptive');

      const history = registers.getHistory(BOT_ID);
      // 1 initial save + 2 adjustments = 3
      expect(history.length).toBe(3);
      expect(history[1].source).toBe('strategist');
      expect(history[2].source).toBe('adaptive');
    });

    it('prunes history to 10 entries', () => {
      for (let i = 0; i < 15; i++) {
        registers.adjust(BOT_ID, { curiosity: 0.01 }, 'adaptive');
      }
      const history = registers.getHistory(BOT_ID);
      expect(history.length).toBe(10);
    });
  });

  // ── Prompt rendering ──

  describe('renderForPrompt', () => {
    it('renders trait state with bars', () => {
      const result = registers.renderForPrompt(BOT_ID);
      expect(result).toContain('## Current Trait State');
      expect(result).toContain('curiosity:');
      expect(result).toContain('executor_temperature:');
      expect(result).toContain('trait_adjustments');
      expect(result).toContain('█');
      expect(result).toContain('░');
    });
  });
});
