import { describe, expect, test } from 'bun:test';
import {
  chatVsLoopContradictions,
  idleCycleShare,
  medianCycleIntervalMs,
  overlappingTopics,
} from '../../../src/watcher/metrics/baseline';

const cycle = (startedAt: string, status = 'completed', extra: Record<string, unknown> = {}) => ({
  cycleId: `c-${startedAt}`,
  startedAt,
  status,
  ...extra,
});

const map = (...names: string[]) => ({ topics: names.map((name) => ({ name })) });

describe('idleCycleShare', () => {
  test('empty input is 0', () => {
    expect(idleCycleShare([])).toBe(0);
  });

  test('share of cycles whose status is idle', () => {
    const cycles = [
      cycle('2026-10-01T00:00:00Z', 'idle'),
      cycle('2026-10-01T01:00:00Z', 'completed'),
      cycle('2026-10-01T02:00:00Z', 'idle'),
      cycle('2026-10-01T03:00:00Z', 'skipped'),
    ];
    expect(idleCycleShare(cycles)).toBe(0.5);
  });

  test('a cycle without status is not idle', () => {
    expect(idleCycleShare([{ cycleId: 'a', startedAt: '2026-10-01T00:00:00Z' }])).toBe(0);
  });
});

describe('medianCycleIntervalMs', () => {
  test('empty and single-cycle input is 0', () => {
    expect(medianCycleIntervalMs([])).toBe(0);
    expect(medianCycleIntervalMs([cycle('2026-10-01T00:00:00Z')])).toBe(0);
  });

  test('median of gaps between consecutive starts, input order irrelevant', () => {
    const cycles = [
      cycle('2026-10-01T03:00:00Z'),
      cycle('2026-10-01T00:00:00Z'),
      cycle('2026-10-01T01:00:00Z'),
      cycle('2026-10-01T05:00:00Z'),
    ];
    // gaps 1h, 2h, 2h → median 2h
    expect(medianCycleIntervalMs(cycles)).toBe(2 * 3_600_000);
  });

  test('even number of gaps averages the two middle ones', () => {
    const cycles = [
      cycle('2026-10-01T00:00:00Z'),
      cycle('2026-10-01T01:00:00Z'),
      cycle('2026-10-01T04:00:00Z'),
    ];
    // gaps 1h, 3h → 2h
    expect(medianCycleIntervalMs(cycles)).toBe(2 * 3_600_000);
  });

  test('never measures a gap across two bots', () => {
    const cycles = [
      cycle('2026-10-01T00:00:00Z', 'completed', { botId: 'a' }),
      cycle('2026-10-01T00:10:00Z', 'completed', { botId: 'b' }),
      cycle('2026-10-01T02:00:00Z', 'completed', { botId: 'a' }),
      cycle('2026-10-01T02:10:00Z', 'completed', { botId: 'b' }),
    ];
    expect(medianCycleIntervalMs(cycles)).toBe(2 * 3_600_000);
  });

  test('rows with an unparsable startedAt are ignored', () => {
    const cycles = [
      cycle('2026-10-01T00:00:00Z'),
      cycle('not a date'),
      cycle('2026-10-01T01:00:00Z'),
    ];
    expect(medianCycleIntervalMs(cycles)).toBe(3_600_000);
  });
});

describe('overlappingTopics', () => {
  test('empty input gives no overlaps', () => {
    expect(overlappingTopics({})).toEqual([]);
  });

  test('a topic shared by two bots is reported with both names', () => {
    const out = overlappingTopics({
      alpha: map('Remote job market', 'Gardening'),
      beta: map('remote job market', 'Chess'),
    });
    expect(out).toHaveLength(1);
    expect(out[0].bots.map((b) => b.botId).sort()).toEqual(['alpha', 'beta']);
    expect(out[0].names.sort()).toEqual(['Remote job market', 'remote job market']);
  });

  test('near-duplicates below the threshold are not merged', () => {
    const out = overlappingTopics({
      alpha: map('Remote job market Argentina'),
      beta: map('Remote job market Spain'),
    });
    // jaccard 3/5 = 0.6 < 0.8
    expect(out).toEqual([]);
  });

  test('a topic repeated inside one bot is not an overlap', () => {
    expect(overlappingTopics({ alpha: map('Chess', 'chess') })).toEqual([]);
  });

  test('malformed maps are skipped, never thrown on', () => {
    const out = overlappingTopics({
      alpha: { topics: [{ name: 'Chess' }, { name: 3 as unknown as string }] },
      beta: undefined as unknown as { topics: { name: string }[] },
      gamma: map('Chess'),
    });
    expect(out).toHaveLength(1);
    expect(out[0].bots.map((b) => b.botId).sort()).toEqual(['alpha', 'gamma']);
  });
});

describe('chatVsLoopContradictions', () => {
  test('empty input gives no candidates', () => {
    expect(chatVsLoopContradictions([], [])).toEqual([]);
  });

  test('a reply and a plan of the same bot sharing topic words are a candidate', () => {
    const out = chatVsLoopContradictions(
      [{ botId: 'a', text: 'I stopped the newsletter draft, we agreed to pause it.' }],
      [{ botId: 'a', cycleId: 'c1', text: 'Finish the newsletter draft and send it' }]
    );
    expect(out).toHaveLength(1);
    expect(out[0].botId).toBe('a');
    expect(out[0].cycleId).toBe('c1');
    expect(out[0].shared.sort()).toEqual(['draft', 'newsletter']);
  });

  test('pairs across different bots are never compared', () => {
    const out = chatVsLoopContradictions(
      [{ botId: 'a', text: 'newsletter draft paused' }],
      [{ botId: 'b', cycleId: 'c1', text: 'newsletter draft finish' }]
    );
    expect(out).toEqual([]);
  });

  test('one shared word, or only short words and stopwords, is not enough', () => {
    const out = chatVsLoopContradictions(
      [{ botId: 'a', text: 'the newsletter is on hold for now' }],
      [{ botId: 'a', cycleId: 'c1', text: 'review the newsletter for now' }]
    );
    expect(out).toEqual([]);
  });

  test('empty texts are skipped', () => {
    expect(
      chatVsLoopContradictions([{ botId: 'a', text: '' }], [{ botId: 'a', cycleId: 'c', text: '' }])
    ).toEqual([]);
  });
});
