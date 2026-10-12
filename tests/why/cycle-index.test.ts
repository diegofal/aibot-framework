import { describe, expect, it } from 'bun:test';
import {
  CycleIndex,
  type CycleRow,
  describeModeReason,
  findCycleAt,
  toWhyCycle,
} from '../../src/why/cycle-index';
import { WhyCycleSchema } from '../../src/why/types';

const row = (over: Partial<CycleRow> = {}): CycleRow => ({
  cycleId: 'c1',
  startedAt: '2026-10-11T12:00:00.000Z',
  endedAt: '2026-10-11T12:02:00.000Z',
  planSummary: 'Search roles',
  goalId: 'g-1',
  goalTitle: 'Find roles',
  ...over,
});

describe('findCycleAt', () => {
  it('finds the cycle whose run contains the time', () => {
    const rows = [row({ cycleId: 'early', endedAt: '2026-10-11T12:00:30Z' }), row()];
    expect(findCycleAt(rows, '2026-10-11T12:01:00Z')?.cycleId).toBe('c1');
  });
  it('ignores rows without an end and unparsable times', () => {
    expect(findCycleAt([row({ endedAt: undefined })], '2026-10-11T12:01:00Z')).toBeUndefined();
    expect(findCycleAt([row()], 'nope')).toBeUndefined();
  });
});

describe('CycleIndex', () => {
  it('reads once per bot, spanning every item of that bot', () => {
    const calls: Array<[string, number, number]> = [];
    const index = CycleIndex.for(
      (botId, since, until) => {
        calls.push([botId, since, until]);
        return botId === 'b1' ? [row()] : [];
      },
      [
        { botId: 'b1', at: '2026-10-11T12:01:00Z' },
        { botId: 'b1', at: '2026-10-12T12:00:00Z' },
        { botId: 'b2', at: '2026-10-11T00:00:00Z' },
      ]
    );
    expect(calls.map((c) => c[0])).toEqual(['b1', 'b2']);
    const [, since, until] = calls[0];
    expect(since).toBeLessThan(Date.parse('2026-10-11T12:01:00Z'));
    expect(until).toBe(Date.parse('2026-10-12T12:00:00Z'));
    expect(index.byId('b1', 'c1')?.goalTitle).toBe('Find roles');
    expect(index.at('b1', '2026-10-11T12:01:00Z')?.cycleId).toBe('c1');
    expect(index.byId('b2', 'c1')).toBeUndefined();
  });

  it('a reader that throws leaves the bot empty instead of failing', () => {
    const index = CycleIndex.for(() => {
      throw new Error('disk');
    }, [{ botId: 'b1', at: '2026-10-11T12:01:00Z' }]);
    expect(index.at('b1', '2026-10-11T12:01:00Z')).toBeUndefined();
  });

  it('no reader: an empty index', () => {
    expect(CycleIndex.for(undefined, [{ botId: 'b1', at: 'x' }]).byId('b1', 'c1')).toBeUndefined();
  });
});

describe('toWhyCycle', () => {
  it('maps a row to a valid WhyCycle', () => {
    const c = toWhyCycle('b1', row(), { inferred: true });
    expect(c).toEqual({
      id: 'c1',
      botId: 'b1',
      startedAt: '2026-10-11T12:00:00.000Z',
      plan: 'Search roles',
      inferred: true,
    });
    expect(WhyCycleSchema.safeParse(c).success).toBe(true);
  });
});

describe('describeModeReason', () => {
  it('turns the explore reasons into words, and nothing for the rest', () => {
    expect(describeModeReason('no-surprise')).toContain('nothing had surprised it');
    expect(describeModeReason('default')).toBeUndefined();
    expect(describeModeReason(undefined)).toBeUndefined();
  });
});
