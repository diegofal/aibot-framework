/**
 * Trait pinning / locking — operator-declared guard rails on TRAITS.json.
 * `pinned` values win on load and after every adjustment; `locked` traits
 * ignore strategist/adaptive deltas.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TraitRegisters, createDefaultTraits } from '../src/bot/trait-registers';
import type { TraitPolicy } from '../src/bot/trait-registers';

const TEST_DIR = join(import.meta.dir, '.tmp-trait-policy');
const BOT = 'guardian';

function makeLogger(): any {
  const l: any = {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
  l.child = () => l;
  return l;
}

describe('TraitRegisters policy (pinned / locked)', () => {
  let logger: any;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    logger = makeLogger();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('pinned values are applied on load over the persisted file', () => {
    mkdirSync(join(TEST_DIR, BOT), { recursive: true });
    writeFileSync(
      join(TEST_DIR, BOT, 'TRAITS.json'),
      JSON.stringify({
        current: { ...createDefaultTraits(), sociability: 0.67, independence: 0.37 },
        history: [],
      })
    );
    const registers = new TraitRegisters(TEST_DIR, logger, () => ({
      pinned: { sociability: 0.2, independence: 0.8 },
    }));
    const traits = registers.load(BOT);
    expect(traits.sociability).toBe(0.2);
    expect(traits.independence).toBe(0.8);
    expect(traits.curiosity).toBe(0.5);
    // Persisted so the stats page (which reads TRAITS.json) agrees
    const onDisk = JSON.parse(readFileSync(join(TEST_DIR, BOT, 'TRAITS.json'), 'utf-8'));
    expect(onDisk.current.sociability).toBe(0.2);
    expect(onDisk.history.at(-1).source).toBe('pinned');
  });

  test('pinned values are clamped to the 0.1-0.9 range', () => {
    const registers = new TraitRegisters(TEST_DIR, logger, () => ({
      pinned: { caution: 1.5, depth: -1 },
    }));
    const traits = registers.load(BOT);
    expect(traits.caution).toBe(0.9);
    expect(traits.depth).toBe(0.1);
  });

  test('pinned values are re-applied after every adjustment', () => {
    const registers = new TraitRegisters(TEST_DIR, logger, () => ({
      pinned: { sociability: 0.2 },
    }));
    registers.load(BOT);
    const after = registers.adjust(BOT, { sociability: 0.05, curiosity: 0.03 }, 'strategist');
    expect(after.sociability).toBe(0.2);
    expect(after.curiosity).toBeCloseTo(0.53, 5);
  });

  test('locked traits drop strategist and adaptive deltas, other traits still move', () => {
    const registers = new TraitRegisters(TEST_DIR, logger, () => ({
      locked: ['sociability', 'independence'],
    }));
    registers.load(BOT);
    const after = registers.adjust(
      BOT,
      { sociability: 0.03, independence: -0.02, caution: 0.04 },
      'strategist'
    );
    expect(after.sociability).toBe(0.5);
    expect(after.independence).toBe(0.5);
    expect(after.caution).toBeCloseTo(0.54, 5);

    const adaptive = registers.adjust(BOT, { independence: -0.03 }, 'adaptive');
    expect(adaptive.independence).toBe(0.5);
  });

  test('dropped deltas are logged once per adjust call at debug level', () => {
    const registers = new TraitRegisters(TEST_DIR, logger, () => ({ locked: ['sociability'] }));
    registers.load(BOT);
    registers.adjust(BOT, { sociability: 0.03, independence: -0.02 }, 'strategist');
    const dropCalls = logger.debug.mock.calls.filter((c: any[]) => String(c[1]).includes('locked'));
    expect(dropCalls).toHaveLength(1);
    expect(dropCalls[0][0].dropped).toEqual({ sociability: 0.03 });
  });

  test('an adjustment where every delta is locked writes no history entry', () => {
    const registers = new TraitRegisters(TEST_DIR, logger, () => ({ locked: ['sociability'] }));
    registers.load(BOT);
    const before = registers.getHistory(BOT).length;
    registers.adjust(BOT, { sociability: 0.03 }, 'strategist');
    expect(registers.getHistory(BOT).length).toBe(before);
  });

  test('setPolicy overrides the resolver and invalidates the cache', () => {
    const registers = new TraitRegisters(TEST_DIR, logger);
    registers.load(BOT);
    registers.setPolicy(BOT, { pinned: { depth: 0.8 } });
    expect(registers.load(BOT).depth).toBe(0.8);
    expect(registers.getPolicy(BOT)).toEqual({ pinned: { depth: 0.8 } });
  });

  test('no policy → behaviour is unchanged', () => {
    const registers = new TraitRegisters(TEST_DIR, logger);
    registers.load(BOT);
    const after = registers.adjust(BOT, { sociability: 0.03 }, 'strategist');
    expect(after.sociability).toBeCloseTo(0.53, 5);
    expect(registers.getPolicy(BOT)).toBeUndefined();
  });

  test('renderForPrompt names locked and pinned traits so the strategist does not propose them', () => {
    const policy: TraitPolicy = { locked: ['sociability'], pinned: { independence: 0.8 } };
    const registers = new TraitRegisters(TEST_DIR, logger, () => policy);
    const block = registers.renderForPrompt(BOT);
    expect(block).toContain('Locked traits (proposals ignored): sociability');
    expect(block).toContain('Pinned traits (fixed by the operator): independence=0.80');
  });
});

describe('TraitRegisters.getDrift', () => {
  let logger: any;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    logger = makeLogger();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('baseline is the first adaptive snapshot; delta = current - baseline', () => {
    const registers = new TraitRegisters(TEST_DIR, logger);
    registers.load(BOT); // writes the adaptive baseline
    registers.adjust(BOT, { sociability: 0.05, independence: -0.02 }, 'strategist');
    registers.adjust(BOT, { sociability: 0.05 }, 'strategist');

    const drift = registers.getDrift(BOT);
    expect(drift.baseline.sociability).toBe(0.5);
    expect(drift.current.sociability).toBeCloseTo(0.6, 5);
    expect(drift.delta.sociability).toBeCloseTo(0.1, 5);
    expect(drift.delta.independence).toBeCloseTo(-0.02, 5);
    expect(drift.delta.curiosity).toBe(0);
  });

  test('falls back to the first history entry, then defaults, when no adaptive snapshot exists', () => {
    mkdirSync(join(TEST_DIR, BOT), { recursive: true });
    writeFileSync(
      join(TEST_DIR, BOT, 'TRAITS.json'),
      JSON.stringify({
        current: { ...createDefaultTraits(), depth: 0.7 },
        history: [
          { timestamp: 1, source: 'strategist', traits: { ...createDefaultTraits(), depth: 0.6 } },
        ],
      })
    );
    const registers = new TraitRegisters(TEST_DIR, logger);
    const drift = registers.getDrift(BOT);
    expect(drift.baseline.depth).toBe(0.6);
    expect(drift.delta.depth).toBeCloseTo(0.1, 5);

    const fresh = new TraitRegisters(join(TEST_DIR, 'other'), logger);
    mkdirSync(join(TEST_DIR, 'other', BOT), { recursive: true });
    writeFileSync(
      join(TEST_DIR, 'other', BOT, 'TRAITS.json'),
      JSON.stringify({ current: { ...createDefaultTraits(), depth: 0.7 } })
    );
    expect(fresh.getDrift(BOT).baseline.depth).toBe(0.5);
  });
});
