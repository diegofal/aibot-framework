import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broadcaster } from '../../src/watcher/broadcast';
import { Graph } from '../../src/watcher/graph';
import type { WatcherCallResult } from '../../src/watcher/llm';
import { WatcherLog } from '../../src/watcher/log';
import {
  applyServed,
  brierScore,
  duePredictions,
  parsePredictionResolution,
  resolvePredictions,
  servedFromCycles,
} from '../../src/watcher/outcomes';
import type { WatcherLogRow } from '../../src/watcher/types';

let dir: string;
let t: number;
const quiet = { warn: () => {} };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-outcomes-'));
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const iso = (ms: number) => new Date(ms).toISOString();

describe('brierScore', () => {
  test('squared error of the forecast', () => {
    expect(brierScore(0.7, true)).toBeCloseTo(0.09, 10);
    expect(brierScore(0.7, false)).toBeCloseTo(0.49, 10);
    expect(brierScore(1, true)).toBe(0);
  });
  test('clamps out-of-range probabilities', () => {
    expect(brierScore(1.5, false)).toBe(1);
    expect(brierScore(-1, false)).toBe(0);
    expect(brierScore(Number.NaN, true)).toBe(0.25);
  });
});

describe('servedFromCycles / applyServed', () => {
  const b = (id: string, botId: string, createdAt: number) => ({
    id,
    botId,
    kind: 'wake' as const,
    text: 'x',
    insightId: `n-${id}`,
    createdAt: iso(createdAt),
    deliveredAt: iso(createdAt),
  });
  const row = (over: Record<string, unknown>) => ({
    cycleId: 'c-1',
    botId: 'b1',
    startedAt: iso(t + 1000),
    endedAt: iso(t + 2000),
    status: 'completed',
    servesBroadcast: 'b-1',
    ...over,
  });

  test('a completed cycle of the same bot naming the broadcast serves it', () => {
    expect(servedFromCycles([b('b-1', 'b1', t)], [row({})])).toEqual([
      { id: 'b-1', cycleId: 'c-1', at: iso(t + 2000) },
    ]);
  });

  test('idle, error, another bot, earlier cycles and already served do not', () => {
    const list = [b('b-1', 'b1', t), { ...b('b-2', 'b1', t), servedByCycle: 'c-0' }];
    expect(
      servedFromCycles(list, [
        row({ status: 'idle' }),
        row({ status: 'error' }),
        row({ botId: 'b2' }),
        row({ endedAt: iso(t - 1000) }),
        row({ servesBroadcast: 'b-2', cycleId: 'c-5' }),
        row({ servesBroadcast: undefined }),
      ])
    ).toEqual([]);
  });

  test('the first serving cycle wins', () => {
    const out = servedFromCycles(
      [b('b-1', 'b1', t)],
      [row({ cycleId: 'c-2', endedAt: iso(t + 5000) }), row({})]
    );
    expect(out).toEqual([{ id: 'b-1', cycleId: 'c-1', at: iso(t + 2000) }]);
  });

  test('applyServed marks the broadcaster', async () => {
    const br = new Broadcaster({ dir, now: () => t, delivery: { wake: () => {} } });
    const sent = await br.send({ botId: 'b1', kind: 'wake', text: '', insightId: 'n-1' });
    const id = sent.broadcast?.id as string;
    expect(applyServed(br, [row({ servesBroadcast: id })])).toBe(1);
    expect(br.get(id)?.servedByCycle).toBe('c-1');
    expect(applyServed(br, [row({ servesBroadcast: id })])).toBe(0);
  });
});

describe('parsePredictionResolution', () => {
  test('reads happened and evidence', () => {
    expect(
      parsePredictionResolution('{"happened": true, "evidence": "Scout said so"}', quiet)
    ).toEqual({
      happened: true,
      evidence: 'Scout said so',
    });
  });
  test('null when not the contract', () => {
    expect(parsePredictionResolution('no idea', quiet)).toBeNull();
    expect(parsePredictionResolution('{"happened": "maybe"}', quiet)).toBeNull();
  });
});

function setup(reply: () => Promise<WatcherCallResult>) {
  const graph = new Graph(join(dir, 'g'), { now: () => t });
  graph.load();
  const rows: WatcherLogRow[] = [];
  const log = new WatcherLog(join(dir, 'log'), { now: () => t, onRow: (r) => rows.push(r) });
  const prompts: string[] = [];
  const client = {
    model: 'claude-haiku-5-5',
    backend: 'claude-cli' as const,
    chat: async (messages: Array<{ content: string }>) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return reply();
    },
  };
  const predict = (text: string, dueAt: number, probability = '0.7') =>
    graph.addNeuron({
      kind: 'prediction',
      text,
      support: { bots: ['b1'] },
      createdBy: 'watcher',
      meta: { dueAt: iso(dueAt), probability, horizonHours: '24' },
    });
  return { graph, rows, log, client, prompts, predict };
}

const ok = (text: string): WatcherCallResult => ({
  ok: true,
  text,
  model: 'claude-haiku-5-5',
  backend: 'claude-cli',
  tokens: 100,
  costUsd: 0.001,
  durationMs: 10,
});

describe('duePredictions', () => {
  test('unresolved, live predictions whose horizon passed, oldest due first', () => {
    const s = setup(async () => ok('{}'));
    const later = s.predict('later', t - 1000);
    const first = s.predict('first', t - 5000);
    s.predict('not yet', t + 1000);
    const done = s.predict('done', t - 9000);
    s.graph.patchMeta(done.id, { resolvedAt: iso(t) });
    const archived = s.predict('archived', t - 9000);
    s.graph.archive(archived.id);
    expect(duePredictions(s.graph, t).map((n) => n.id)).toEqual([first.id, later.id]);
  });
});

describe('resolvePredictions', () => {
  test('asks tier 1, stores the resolution with Brier and logs it', async () => {
    const s = setup(async () => ok('{"happened": true, "evidence": "the log shows it"}'));
    const p = s.predict('Scout finishes the map', t - 1000, '0.8');
    const out = await resolvePredictions({
      graph: s.graph,
      client: s.client,
      log: s.log,
      now: () => t,
      events: () => ['Scout finished the map'],
      logger: quiet,
    });
    expect(out).toEqual({ resolved: 1, stopped: undefined });
    expect(s.prompts[0]).toContain('Scout finishes the map');
    expect(s.prompts[0]).toContain('Scout finished the map');
    const meta = s.graph.get(p.id)?.meta ?? {};
    expect(meta.happened).toBe('true');
    expect(Number(meta.brier)).toBeCloseTo(0.04, 10);
    expect(meta.resolvedAt).toBe(iso(t));
    expect(meta.resolvedModel).toBe('claude-haiku-5-5');
    expect(meta.evidence).toBe('the log shows it');
    expect(s.rows.some((r) => r.op === 'prediction:resolved' && r.costUsd === 0.001)).toBe(true);
  });

  test('a refused call stops the pass and resolves nothing', async () => {
    const s = setup(async () => ({ ok: false, reason: 'cap' }));
    s.predict('a', t - 1000);
    s.predict('b', t - 1000);
    const out = await resolvePredictions({
      graph: s.graph,
      client: s.client,
      log: s.log,
      now: () => t,
      events: () => [],
      logger: quiet,
    });
    expect(out).toEqual({ resolved: 0, stopped: 'cap' });
    expect(s.prompts).toHaveLength(1);
  });

  test('an unparsable answer leaves the prediction open', async () => {
    const s = setup(async () => ok('not json'));
    const p = s.predict('a', t - 1000);
    const out = await resolvePredictions({
      graph: s.graph,
      client: s.client,
      log: s.log,
      now: () => t,
      events: () => [],
      logger: quiet,
    });
    expect(out.resolved).toBe(0);
    expect(s.graph.get(p.id)?.meta?.resolvedAt).toBeUndefined();
  });

  test('at most `max` predictions per pass', async () => {
    const s = setup(async () => ok('{"happened": false}'));
    for (let i = 0; i < 5; i++) s.predict(`p${i}`, t - 1000);
    const out = await resolvePredictions({
      graph: s.graph,
      client: s.client,
      log: s.log,
      now: () => t,
      events: () => [],
      max: 2,
      logger: quiet,
    });
    expect(out.resolved).toBe(2);
    expect(s.prompts).toHaveLength(2);
  });
});

describe('resolvePredictions: a failed call', () => {
  test('skips that prediction and goes on with the next', async () => {
    let n = 0;
    const s = setup(async () =>
      n++ === 0
        ? { ok: false, reason: 'error', error: 'boom', model: 'm', durationMs: 1 }
        : ok('{"happened": true}')
    );
    const a = s.predict('a', t - 2000);
    const b = s.predict('b', t - 1000);
    const out = await resolvePredictions({
      graph: s.graph,
      client: s.client,
      log: s.log,
      now: () => t,
      events: () => [],
      logger: quiet,
    });
    expect(out.resolved).toBe(1);
    expect(s.graph.get(a.id)?.meta?.resolvedAt).toBeUndefined();
    expect(s.graph.get(b.id)?.meta?.happened).toBe('true');
  });
});
