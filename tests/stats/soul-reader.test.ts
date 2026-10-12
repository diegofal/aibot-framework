import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSoulHealth, readTraitChanges, readTraits } from '../../src/stats/readers/soul';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

let botDir: string;
let soulDir: string;
beforeEach(() => {
  botDir = createTempDir('stats-soul');
  soulDir = join(botDir, 'soul');
  mkdirSync(soulDir, { recursive: true });
});
afterEach(() => removeTempDir(botDir));

const traitsFile = {
  current: { curiosity: 0.6, caution: 0.5 },
  history: [
    { timestamp: 1, source: 'adaptive', traits: { curiosity: 0.5, caution: 0.5 } },
    { timestamp: 2, source: 'strategist', traits: { curiosity: 0.6, caution: 0.5 } },
  ],
};

describe('readTraits', () => {
  it('reads TRAITS.json from the bot dir (sibling of soul/) — the TraitRegisters layout', () => {
    writeFileSync(join(botDir, 'TRAITS.json'), JSON.stringify(traitsFile));
    const { stats, history } = readTraits(soulDir);
    expect(stats.current).toEqual({ curiosity: 0.6, caution: 0.5 });
    expect(stats.drift).toEqual({ curiosity: 0.1, caution: 0 });
    expect(history).toHaveLength(2);
  });

  it('prefers an in-soul TRAITS.json when both exist', () => {
    writeFileSync(join(botDir, 'TRAITS.json'), JSON.stringify(traitsFile));
    writeFileSync(
      join(soulDir, 'TRAITS.json'),
      JSON.stringify({ current: { curiosity: 0.1 }, history: [] })
    );
    expect(readTraits(soulDir).stats.current).toEqual({ curiosity: 0.1 });
  });

  it('returns nulls when neither location has the file', () => {
    expect(readTraits(soulDir).stats.current).toBeNull();
  });
});

describe('readSoulHealth.lastReflectionAt', () => {
  it.each([
    ['- date: 2026-08-15', '2026-08-15'],
    ['- Date: 2026-08-16', '2026-08-16'],
    ['- **Date:** 2026-08-20', '2026-08-20'],
    ['- **Fecha**: 2026-08-19', '2026-08-19'],
    ['- **Date**: 2026-08-18', '2026-08-18'],
  ])('parses %p', (line, expected) => {
    writeFileSync(
      join(soulDir, 'MOTIVATIONS.md'),
      `## Last Reflection\n${line}\n- Trigger: cron\n`
    );
    expect(readSoulHealth(soulDir).lastReflectionAt).toBe(expected);
  });

  it('keeps the latest date when several reflections are listed', () => {
    writeFileSync(
      join(soulDir, 'MOTIVATIONS.md'),
      '- date: 2026-08-10\n- **Date:** 2026-08-20\n- date: 2026-08-15\n'
    );
    expect(readSoulHealth(soulDir).lastReflectionAt).toBe('2026-08-20');
  });
});

describe('readTraitChanges (why-everywhere row 13)', () => {
  const file = {
    current: { curiosity: 0.6, caution: 0.53 },
    history: [
      { timestamp: 1000, source: 'adaptive', traits: { curiosity: 0.5, caution: 0.5 } },
      // legacy: no recorded changes → diffed from the previous snapshot
      { timestamp: 2000, source: 'strategist', traits: { curiosity: 0.6, caution: 0.5 } },
      // nothing moved → skipped
      { timestamp: 2500, source: 'pinned', traits: { curiosity: 0.6, caution: 0.5 } },
      {
        timestamp: 3000,
        source: 'strategist',
        traits: { curiosity: 0.6, caution: 0.53 },
        cycleId: 'c-9',
        reasons: { caution: 'Errors.' },
        changes: { caution: { from: 0.5, to: 0.53, requested: 0.03 } },
        rejected: { sociability: { requested: 0.02, rule: 'locked' } },
      },
    ],
    rejections: [
      {
        timestamp: 4000,
        source: 'strategist',
        traits: { curiosity: 0.6, caution: 0.53 },
        cycleId: 'c-10',
        rejected: { sociability: { requested: 0.03, rule: 'locked' } },
      },
    ],
  };

  it('newest first: recorded changes, refusals, and legacy snapshots diffed; baseline skipped', () => {
    writeFileSync(join(botDir, 'TRAITS.json'), JSON.stringify(file));
    const out = readTraitChanges(soulDir);
    expect(out.map((c) => [c.ts, c.source, c.derived])).toEqual([
      [new Date(4000).toISOString(), 'strategist', false],
      [new Date(3000).toISOString(), 'strategist', false],
      [new Date(2000).toISOString(), 'strategist', true],
    ]);
    expect(out[0]).toMatchObject({
      cycleId: 'c-10',
      changes: [],
      rejected: [{ trait: 'sociability', requested: 0.03, rule: 'locked' }],
    });
    expect(out[1]).toMatchObject({
      cycleId: 'c-9',
      changes: [{ trait: 'caution', from: 0.5, to: 0.53, requested: 0.03 }],
      reasons: { caution: 'Errors.' },
    });
    expect(out[2]).toMatchObject({
      cycleId: null,
      changes: [{ trait: 'curiosity', from: 0.5, to: 0.6 }],
      reasons: {},
    });
  });

  it('caps the list and returns [] without a file', () => {
    expect(readTraitChanges(soulDir)).toEqual([]);
    writeFileSync(join(botDir, 'TRAITS.json'), JSON.stringify(file));
    expect(readTraitChanges(soulDir, 1)).toHaveLength(1);
  });
});
