import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../src/config';
import { Graph } from '../../src/watcher/graph';
import { computeMetrics, emptyRecords } from '../../src/watcher/metrics';
import { WATCHER_DEFAULTS } from '../../src/watcher/types';
import { Watcher } from '../../src/watcher/watcher';

const DAY = 86_400_000;
let root: string;
let t: number;
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watcher-forget-'));
  t = Date.parse('2026-10-01T10:00:00Z');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function make(target: number) {
  const config = {
    bots: [],
    paths: { data: join(root, 'data') },
    soul: {},
    operator: {},
    watcher: {
      ...WATCHER_DEFAULTS,
      enabled: true,
      graph: { ...WATCHER_DEFAULTS.graph, targetNeurons: target },
      forget: { threshold: 0.15, graceDays: 7 },
    },
  } as unknown as Config;
  return new Watcher({
    config: () => config,
    logger: noopLogger,
    activityStream: new EventEmitter(),
    hooks: new EventEmitter(),
    botManager: {
      getChannelState: () => undefined,
      getUserDirectory: () => ({ list: () => [], findByChannel: () => undefined }) as never,
    },
    now: () => t,
  });
}

const fact = (g: Graph, text: string, extra: Record<string, unknown> = {}) =>
  g.addNeuron({
    kind: 'fact',
    text,
    support: { bots: ['b1'] },
    createdBy: 'bot:b1',
    activations: 1,
    ...extra,
  } as never);

describe('forgetting by importance (maintainNow)', () => {
  test('archives the lowest under the threshold until the graph is at the target, and logs it', async () => {
    const w = make(3);
    const used = fact(w.graph, 'used a lot', { activations: 30 });
    const low = [1, 2, 3, 4].map((i) => fact(w.graph, `forgettable ${i}`));
    t += 10 * DAY;
    // used again recently: it keeps a use score above the threshold
    for (let i = 0; i < 5; i++) w.graph.activate(used.id);
    await w.maintainNow();
    const live = w.graph.list().filter((n) => !n.archivedAt);
    expect(live.length).toBe(3);
    expect(w.graph.get(used.id)?.archivedAt).toBeUndefined();
    const archived = w.graph.list().filter((n) => n.archivedAt);
    expect(archived.length).toBe(2);
    for (const n of archived) {
      expect(low.map((l) => l.id)).toContain(n.id);
      expect(n.meta?.archivedReason).toBe('importance 0.00: never used, one bot, no consequence');
    }
    const row = w.log.recent(20).find((r) => r.op === 'forget:archive');
    expect(row).toBeDefined();
    expect(row?.phase).toBe('sleep');
    expect(row?.text).toContain('Forgot 2 neurons');
    expect(row?.text).toContain('0.00');
    expect(row?.neuronIds?.sort()).toEqual(archived.map((n) => n.id).sort());
  });

  test('under the target nothing is forgotten, however old (the age rule is gone)', async () => {
    const w = make(100);
    const n = fact(w.graph, 'old and unused');
    t += 90 * DAY;
    await w.maintainNow();
    expect(w.graph.get(n.id)?.archivedAt).toBeUndefined();
    expect(w.log.recent(20).some((r) => r.op === 'forget:archive')).toBe(false);
  });

  test('the grace period and protected neurons are never forgotten', async () => {
    const w = make(0);
    const entity = w.graph.addNeuron({
      kind: 'entity',
      text: 'bot b1',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
    });
    const goal = w.graph.addNeuron({
      kind: 'goal',
      text: 'ship it',
      support: { bots: ['b1'] },
      createdBy: 'bot:b1',
    });
    const liked = fact(w.graph, 'the operator liked this', { meta: { signal: 'up' } });
    const old = fact(w.graph, 'old fact');
    t += 10 * DAY;
    const young = fact(w.graph, 'young fact');
    await w.maintainNow();
    for (const id of [entity.id, goal.id, liked.id, young.id])
      expect(w.graph.get(id)?.archivedAt).toBeUndefined();
    expect(w.graph.get(old.id)?.archivedAt).toBeDefined();
    // the header's live / archived counts
    expect(w.state().archived).toBe(1);
  });

  test('a forgotten neuron touched again comes back and its return is counted', async () => {
    const w = make(0);
    const n = fact(w.graph, 'forgotten then needed');
    t += 10 * DAY;
    await w.maintainNow();
    expect(w.graph.get(n.id)?.archivedAt).toBeDefined();
    t += DAY;
    w.graph.activate(n.id);
    const back = w.graph.get(n.id);
    expect(back?.archivedAt).toBeUndefined();
    expect(back?.meta?.returnedAt).toBe(new Date(t).toISOString());
    const m = computeMetrics({ ...emptyRecords(t), neurons: w.graph.list() }, '7d');
    const compounding = m.metrics.find((x) => x.id === 'compounding');
    expect(compounding?.detail?.returned).toBe(1);
    expect(compounding?.detail?.archived).toBe(0);
  });

  test('a merged drop that fires is not a return (its keeper fires)', () => {
    const g = new Graph(join(root, 'g'), { now: () => t });
    g.load();
    const keep = fact(g, 'keeper');
    const drop = fact(g, 'drop');
    g.mergeInto(keep.id, [drop.id]);
    g.activate(drop.id);
    expect(g.get(drop.id)?.meta?.returnedAt).toBeUndefined();
    expect(g.get(keep.id)?.meta?.returnedAt).toBeUndefined();
  });
});
