import { describe, expect, test } from 'bun:test';
import type { Broadcast } from '../../../src/watcher/broadcast';
import {
  GUARD_IDS,
  METRIC_IDS,
  type MetricsRecords,
  computeMetrics,
  emptyRecords,
  parseMetricsWindow,
} from '../../../src/watcher/metrics';
import type { Neuron } from '../../../src/watcher/types';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;
function neuron(over: Partial<Neuron> & Pick<Neuron, 'kind'>): Neuron {
  seq++;
  return {
    id: `n-${String(seq).padStart(8, '0')}`,
    text: `neuron ${seq}`,
    support: { bots: ['b1'] },
    createdBy: 'watcher',
    createdAt: iso(NOW - H),
    lastActivatedAt: iso(NOW - H),
    activations: 1,
    ...over,
  };
}

function broadcast(over: Partial<Broadcast> = {}): Broadcast {
  seq++;
  return {
    id: `b-${String(seq).padStart(8, '0')}`,
    botId: 'b1',
    kind: 'wake',
    text: '',
    insightId: 'n-1',
    createdAt: iso(NOW - 2 * H),
    deliveredAt: iso(NOW - 2 * H),
    ...over,
  };
}

const rec = (over: Partial<MetricsRecords> = {}): MetricsRecords => ({
  ...emptyRecords(NOW),
  ...over,
});
const metric = (r: MetricsRecords, id: string, window: '7d' | '30d' = '7d') => {
  const m = computeMetrics(r, window).metrics.find((x) => x.id === id);
  if (!m) throw new Error(`no metric ${id}`);
  return m;
};
const guard = (r: MetricsRecords, id: string) => {
  const g = computeMetrics(r, '7d').guards.find((x) => x.id === id);
  if (!g) throw new Error(`no guard ${id}`);
  return g;
};

describe('parseMetricsWindow', () => {
  test('7d and 30d; default 7d; anything else is null', () => {
    expect(parseMetricsWindow(undefined)).toBe('7d');
    expect(parseMetricsWindow('7d')).toBe('7d');
    expect(parseMetricsWindow('30d')).toBe('30d');
    expect(parseMetricsWindow('24h')).toBeNull();
  });
});

describe('computeMetrics: empty records give baselines, never NaN', () => {
  test('every metric and guard is present with a finite value equal to its baseline', () => {
    const out = computeMetrics(emptyRecords(NOW), '7d');
    expect(out.metrics.map((m) => m.id)).toEqual([...METRIC_IDS]);
    expect(out.guards.map((g) => g.id)).toEqual([...GUARD_IDS]);
    for (const m of out.metrics) {
      expect(Number.isFinite(m.value)).toBe(true);
      expect(m.value).toBe(m.baseline);
      expect(m.n).toBe(0);
      expect(typeof m.target).toBe('string');
    }
    for (const g of out.guards) {
      expect(Number.isFinite(g.value)).toBe(true);
      expect(g.over).toBe(false);
    }
    expect(out.from).toBe(iso(NOW - 7 * D));
    expect(out.to).toBe(iso(NOW));
    expect(JSON.stringify(out)).not.toContain('NaN');
  });
});

describe('metric 1: cross-source insight share', () => {
  test('insights supported by two bots, or a bot plus a conversation', () => {
    const r = rec({
      neurons: [
        neuron({ kind: 'insight', support: { bots: ['b1', 'b2'] } }),
        neuron({ kind: 'insight', support: { bots: ['b1'], conversations: ['telegram:7'] } }),
        neuron({ kind: 'insight', support: { bots: ['b1'] } }),
        neuron({ kind: 'insight', support: { bots: ['b1'] } }),
        neuron({ kind: 'insight', support: { bots: ['b1', 'b2'] }, createdAt: iso(NOW - 10 * D) }),
        neuron({ kind: 'fact', support: { bots: ['b1', 'b2'] } }),
      ],
    });
    const m = metric(r, 'crossSource');
    expect(m.n).toBe(4);
    expect(m.value).toBe(0.5);
    expect(metric(r, 'crossSource', '30d').value).toBeCloseTo(3 / 5, 10);
  });
});

describe('metric 1b: contradictions', () => {
  test('confirmed per week and the dismissed share', () => {
    const r = rec({
      neurons: [
        neuron({ kind: 'contradiction', meta: { signal: 'up' } }),
        neuron({ kind: 'contradiction', meta: { signal: 'up' } }),
        neuron({ kind: 'contradiction', meta: { signal: 'down' } }),
        neuron({ kind: 'contradiction' }),
      ],
    });
    const m = metric(r, 'contradictions');
    expect(m.n).toBe(4);
    expect(m.value).toBe(2);
    expect(m.detail).toMatchObject({ flagged: 4, confirmed: 2, dismissed: 1 });
    expect(m.detail?.dismissedShare).toBeCloseTo(1 / 3, 10);
    expect(metric(r, 'contradictions', '30d').value).toBeCloseTo(2 / (30 / 7), 10);
  });
});

describe('metric 2: latency to notice', () => {
  test('median and p95 of createdAt − eventAt for notice neurons; baseline is the cycle interval', () => {
    const lat = [60_000, 120_000, 180_000, 240_000];
    const r = rec({
      neurons: lat.map((ms) =>
        neuron({
          kind: 'fact',
          createdAt: iso(NOW - H),
          meta: { source: 'notice', eventAt: iso(NOW - H - ms) },
        })
      ),
      cycles: [
        { cycleId: 'c1', botId: 'b1', startedAt: iso(NOW - 5 * H), status: 'completed' },
        { cycleId: 'c2', botId: 'b1', startedAt: iso(NOW - 3 * H), status: 'completed' },
      ],
    });
    const m = metric(r, 'latency');
    expect(m.n).toBe(4);
    expect(m.value).toBe(150_000);
    expect(m.detail?.p95).toBe(240_000);
    expect(m.baseline).toBe(2 * H);
  });

  test('integrate latency is reported apart', () => {
    const r = rec({
      neurons: [
        neuron({ kind: 'insight', meta: { source: 'integrate', eventAt: iso(NOW - 2 * H) } }),
      ],
    });
    expect(metric(r, 'latency').detail?.integrateMedian).toBe(H);
  });
});

describe('metric 3: introspection', () => {
  test('mean score in the window, per subject in detail', () => {
    const r = rec({
      introspection: [
        { ts: iso(NOW - H), subject: 'watcher', score: 1 },
        { ts: iso(NOW - H), subject: 'watcher', score: 0.5 },
        { ts: iso(NOW - H), subject: 'bot:b1', score: 0 },
        { ts: iso(NOW - 20 * D), subject: 'watcher', score: 0 },
      ],
    });
    const m = metric(r, 'introspection');
    expect(m.n).toBe(3);
    expect(m.value).toBeCloseTo(0.5, 10);
    expect(m.detail).toMatchObject({ watcher: 0.75, 'bot:b1': 0 });
  });

  test('phase 4: one summary per subject, watcher first, field match shares', () => {
    const r = rec({
      introspection: [
        {
          ts: iso(NOW - H),
          subject: 'bot:b1',
          score: 0,
          fields: { phase: 'miss', tool: 'match', goal: 'unknown', cause: 'unknown' },
        },
        {
          ts: iso(NOW - 2 * H),
          subject: 'watcher',
          score: 1,
          fields: { phase: 'match', tool: 'match', goal: 'match', cause: 'unknown' },
        },
        { ts: iso(NOW - 20 * D), subject: 'watcher', score: 0 },
      ],
    });
    const m = metric(r, 'introspection');
    expect(m.subjects?.map((x) => x.subject)).toEqual(['watcher', 'bot:b1']);
    expect(m.subjects?.[0]).toMatchObject({ n: 1, score: 1, lastAt: iso(NOW - 2 * H) });
    expect(m.subjects?.[1]?.fields).toEqual({ phase: 0, tool: 1, goal: null, cause: null });
  });
});

describe('metric 4: calibration', () => {
  test('mean Brier of predictions resolved in the window, with the frequency baseline', () => {
    const resolved = (brier: number, happened: boolean) =>
      neuron({
        kind: 'prediction',
        meta: { resolvedAt: iso(NOW - H), brier: String(brier), happened: String(happened) },
      });
    const r = rec({
      neurons: [resolved(0.04, true), resolved(0.16, false), neuron({ kind: 'prediction' })],
    });
    const m = metric(r, 'calibration');
    expect(m.n).toBe(2);
    expect(m.value).toBeCloseTo(0.1, 10);
    expect(m.baseline).toBe(0.25);
    expect(m.detail?.frequencyBrier).toBeCloseTo(0.25, 10);
  });

  test('a prediction the judge could not settle (outcome unknown) is counted apart, never scored', () => {
    const r = rec({
      neurons: [
        neuron({
          kind: 'prediction',
          meta: { resolvedAt: iso(NOW - H), brier: '0.04', happened: 'true', outcome: 'happened' },
        }),
        neuron({ kind: 'prediction', meta: { resolvedAt: iso(NOW - H), outcome: 'unknown' } }),
        // a stale brier left on an unknown is still not scored
        neuron({
          kind: 'prediction',
          meta: { resolvedAt: iso(NOW - H), outcome: 'unknown', brier: '0.64' },
        }),
      ],
    });
    const m = metric(r, 'calibration');
    expect(m.n).toBe(1);
    expect(m.value).toBeCloseTo(0.04, 10);
    expect(m.detail?.resolved).toBe(1);
    expect(m.detail?.unknown).toBe(2);
  });
});

describe('metric 5: compounding and forgetting', () => {
  test('re-activation share of old neurons cited by new insights, pruned share, canary recall', () => {
    const old1 = neuron({ kind: 'fact', createdAt: iso(NOW - 10 * D) });
    const old2 = neuron({ kind: 'fact', createdAt: iso(NOW - 10 * D) });
    const archived = neuron({
      kind: 'fact',
      createdAt: iso(NOW - 40 * D),
      archivedAt: iso(NOW - 2 * D),
    });
    const fresh = neuron({ kind: 'fact' });
    const insight = neuron({ kind: 'insight', meta: { supportNeurons: `${old1.id},${fresh.id}` } });
    const r = rec({
      neurons: [old1, old2, archived, fresh, insight],
      canaries: [
        { kind: 'check', checkedAt: iso(NOW - H), found: true },
        { kind: 'check', checkedAt: iso(NOW - H), found: false },
        { kind: 'plant', plantedAt: iso(NOW - 2 * H) },
      ],
    });
    const m = metric(r, 'compounding');
    expect(m.n).toBe(2);
    expect(m.value).toBe(0.5);
    expect(m.detail?.prunedShare).toBeCloseTo(1 / 5, 10);
    expect(m.detail?.canaryRecall).toBe(0.5);
    expect(m.detail?.canaryChecks).toBe(2);
  });
});

describe('metric 6: broadcasts that changed behaviour', () => {
  test('served share from the record or from cycle rows, with operator signals', () => {
    const a = broadcast({ servedByCycle: 'c-1', signal: 'up' });
    const b = broadcast({ signal: 'down' });
    const c = broadcast();
    const failed = broadcast({ deliveredAt: undefined, deliveryError: 'x' });
    const r = rec({
      broadcasts: [a, b, c, failed],
      cycles: [
        {
          cycleId: 'c-2',
          botId: 'b1',
          startedAt: iso(NOW - H),
          endedAt: iso(NOW - H + 1000),
          status: 'completed',
          servesBroadcast: b.id,
        },
      ],
    });
    const m = metric(r, 'causal');
    expect(m.n).toBe(3);
    expect(m.value).toBeCloseTo(2 / 3, 10);
    expect(m.detail).toMatchObject({ served: 2, up: 1, down: 1, delivered: 3, failed: 1 });
  });

  // O1: the fast lane and integrate are told apart; a record without a source is integrate's.
  test('splits delivered and served by source (fast lane vs integrate)', () => {
    const fastServed = broadcast({ kind: 'directive', source: 'fast-lane', servedByCycle: 'c-1' });
    const fast = broadcast({ kind: 'directive', source: 'fast-lane' });
    const fastFailed = broadcast({
      source: 'fast-lane',
      deliveredAt: undefined,
      deliveryError: 'x',
    });
    const integrateServed = broadcast({ source: 'integrate', servedByCycle: 'c-2' });
    const legacy = broadcast();
    const r = rec({ broadcasts: [fastServed, fast, fastFailed, integrateServed, legacy] });
    const m = metric(r, 'causal');
    expect(m.detail).toMatchObject({
      delivered: 4,
      served: 2,
      fastLaneDelivered: 2,
      fastLaneServed: 1,
      integrateDelivered: 2,
      integrateServed: 1,
    });
  });
});

describe('metric 7: novel surprises per week', () => {
  test('watcher surprises not already in any bot knowledge map', () => {
    const r = rec({
      neurons: [
        neuron({ kind: 'surprise', text: 'The heron nests on the water tower' }),
        neuron({ kind: 'surprise', text: 'Invoices arrive on Sundays now' }),
        neuron({ kind: 'surprise', text: 'old', createdAt: iso(NOW - 20 * D) }),
        neuron({ kind: 'surprise', text: 'from a bot', createdBy: 'bot:b1' }),
      ],
      knowledgeSurprises: ['the heron nests on the water tower'],
    });
    const m = metric(r, 'surprises');
    expect(m.n).toBe(2);
    expect(m.value).toBe(1);
    expect(m.detail?.novel).toBe(1);
  });
});

describe('guards', () => {
  test('cost: total spend, over when a day ran past the integrate cap', () => {
    const r = rec({
      budgetDays: [
        {
          date: '2026-10-22',
          notice: { calls: 10, tokens: 100, costUsd: 0.1 },
          integrate: { calls: 3, tokens: 1000, costUsd: 1.5 },
        },
        {
          date: '2026-10-23',
          notice: { calls: 1, tokens: 10, costUsd: 0.01 },
          integrate: { calls: 1, tokens: 10, costUsd: 0.5 },
        },
      ],
      limits: { notice: { maxPerDay: 288 }, integrate: { maxPerDay: 2, maxTokensPerDay: 600_000 } },
    });
    const g = guard(r, 'cost');
    expect(g.value).toBeCloseTo(2.11, 10);
    expect(g.over).toBe(true);
    expect(g.detail).toMatchObject({ maxIntegrateCallsPerDay: 3 });
  });

  test('cost: within the caps is not over', () => {
    const r = rec({
      budgetDays: [
        {
          date: '2026-10-23',
          notice: { calls: 1, tokens: 1, costUsd: 0 },
          integrate: { calls: 2, tokens: 10, costUsd: 0.2 },
        },
      ],
      limits: { notice: { maxPerDay: 288 }, integrate: { maxPerDay: 2, maxTokensPerDay: 600_000 } },
    });
    expect(guard(r, 'cost').over).toBe(false);
  });

  test('idle: over when the idle share is above the phase 0 baseline', () => {
    const cycles = [
      { cycleId: '1', botId: 'b1', startedAt: iso(NOW - H), status: 'idle' },
      { cycleId: '2', botId: 'b1', startedAt: iso(NOW - H), status: 'completed' },
    ];
    expect(guard(rec({ cycles, baselineIdleShare: 0.3 }), 'idle')).toMatchObject({
      value: 0.5,
      limit: 0.3,
      over: true,
    });
    expect(guard(rec({ cycles, baselineIdleShare: 0.6 }), 'idle').over).toBe(false);
    expect(guard(rec({ cycles }), 'idle').over).toBe(false);
  });

  test('conversation latency: over when a conversation waits while the watcher holds a slot', () => {
    expect(
      guard(rec({ semaphore: { queuedInteractive: 1, activeWatcher: 1 } }), 'conversation').over
    ).toBe(true);
    expect(
      guard(rec({ semaphore: { queuedInteractive: 1, activeWatcher: 0 } }), 'conversation').over
    ).toBe(false);
  });

  test('operator interruptions: watcher questions per day against the proactive cap', () => {
    const q = (day: number) => broadcast({ kind: 'question', createdAt: iso(NOW - day * D - H) });
    const r = rec({ broadcasts: [q(0), q(0), q(1)], proactiveDailyCap: 1 });
    expect(guard(r, 'interruptions')).toMatchObject({ value: 2, limit: 1, over: true });
    expect(guard(rec({ broadcasts: [q(0)], proactiveDailyCap: 5 }), 'interruptions').over).toBe(
      false
    );
  });
});

describe('O10 forgetting and consolidation', () => {
  test('graphSize: live neurons against watcher.graph.targetNeurons', () => {
    const live = [neuron({ kind: 'fact' }), neuron({ kind: 'fact' }), neuron({ kind: 'topic' })];
    const gone = neuron({ kind: 'fact', archivedAt: iso(NOW - H) });
    const r = rec({ neurons: [...live, gone], targetNeurons: 2 });
    expect(guard(r, 'graphSize')).toMatchObject({
      value: 3,
      limit: 2,
      unit: 'count',
      over: true,
      detail: { archived: 1 },
    });
    expect(guard(rec({ neurons: live }), 'graphSize')).toMatchObject({ limit: 8000, over: false });
  });

  test('metric 5 detail: archived, returned, consolidated and summaries in the window', () => {
    const inWin = iso(NOW - D);
    const before = iso(NOW - 20 * D);
    const r = rec({
      neurons: [
        neuron({ kind: 'fact', archivedAt: inWin, meta: { archivedReason: 'importance 0.01' } }),
        neuron({ kind: 'fact', archivedAt: before, meta: { archivedReason: 'importance 0.01' } }),
        // a hygiene merge is not forgetting
        neuron({ kind: 'fact', archivedAt: inWin, meta: { mergedInto: 'n-x' } }),
        neuron({
          kind: 'fact',
          archivedAt: inWin,
          meta: { mergedInto: 'n-s', consolidatedInto: 'n-s', archivedReason: 'x' },
        }),
        neuron({ kind: 'fact', meta: { archivedReason: 'importance 0.02', returnedAt: inWin } }),
        neuron({ kind: 'summary', createdAt: inWin, meta: { consolidated: 'true' } }),
      ],
    });
    expect(metric(r, 'compounding').detail).toMatchObject({
      archived: 1,
      returned: 1,
      consolidated: 1,
      summaries: 1,
    });
  });
});
