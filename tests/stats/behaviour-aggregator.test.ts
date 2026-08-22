import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildBehaviour } from '../../src/stats/behaviour-aggregator';
import { createStatsContext } from '../../src/stats/context';
import { removeTempDir } from '../helpers/temp-dir';
import { DAY, type StatsFixture, createStatsFixture } from './fixture';

let fx: StatsFixture;
beforeEach(() => {
  fx = createStatsFixture();
});
afterEach(() => removeTempDir(fx.dir));

describe('buildBehaviour', () => {
  it('production without feedback counts content entries newer than the last feedback', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const b = buildBehaviour(ctx, [fx.bots.b1, fx.bots.b2, fx.bots.b3], '7d');
    expect(b.window).toBe('7d');
    expect(b.productionWithoutFeedback).toEqual([
      {
        botId: 'b1',
        outputsSinceFeedback: 1,
        lastFeedbackAt: new Date(fx.now - 3 * DAY).toISOString(),
      },
    ]);
  });

  it('ask economics buckets by question length with median time-to-answer', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const b = buildBehaviour(ctx, [fx.bots.b1], '7d');
    expect(b.askEconomics.buckets.map((x) => x.bucket)).toEqual([
      '<300',
      '300-600',
      '600-1200',
      '>1200',
    ]);
    expect(b.askEconomics.buckets[0]).toEqual({
      bucket: '<300',
      sent: 1,
      answered: 0,
      medianTimeToAnswerMs: null,
    });
    expect(b.askEconomics.buckets[1]).toEqual({
      bucket: '300-600',
      sent: 1,
      answered: 1,
      medianTimeToAnswerMs: 300_000,
    });
    expect(b.askEconomics.buckets[3].sent).toBe(0);
  });

  it('collaboration graph merges tool-audit edges with log-only send failures', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const b = buildBehaviour(ctx, [fx.bots.b1, fx.bots.b2, fx.bots.b3], '7d');
    expect(b.collaboration.nodes.map((n) => n.botId)).toEqual(['b1', 'b2', 'b3']);
    expect(b.collaboration.edges).toEqual([
      { from: 'b1', to: 'b2', calls: 1, failed: 1 },
      { from: 'b1', to: 'b3', calls: 1, failed: 1 },
    ]);
  });

  it('mesh counts, trait variance timeline and fleet drift vector', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const b = buildBehaviour(ctx, [fx.bots.b1, fx.bots.b2, fx.bots.b3], '7d');
    expect(b.mesh).toEqual({ byBot: { b1: 1 }, total: 1 });
    expect(b.traitVariance).toHaveLength(2);
    expect(b.traitVariance[0].timestamp).toBeLessThan(b.traitVariance[1].timestamp);
    expect(Object.keys(b.traitVariance[1].variance)).toEqual(['curiosity', 'caution']);
    expect(b.fleetDriftVector).toEqual({ curiosity: 0.2, caution: 0 });
  });

  it('is scoped: bots outside the list contribute nothing', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const b = buildBehaviour(ctx, [fx.bots.b3], '7d');
    expect(b.productionWithoutFeedback).toEqual([]);
    expect(b.mesh).toEqual({ byBot: {}, total: 0 });
    expect(b.collaboration.edges).toEqual([]);
    expect(b.fleetDriftVector).toEqual({});
    expect(b.traitVariance).toEqual([]);
  });
});
