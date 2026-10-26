import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broadcaster } from '../../src/watcher/broadcast';
import { Graph } from '../../src/watcher/graph';
import type { WatcherCallResult } from '../../src/watcher/llm';
import { WatcherLog } from '../../src/watcher/log';
import { computeMetrics, emptyRecords } from '../../src/watcher/metrics';
import {
  CYCLE_START_LOOKBACK_MS,
  type GroundTruthCycle,
  type GroundTruthTool,
  applyServed,
  brierScore,
  duePredictions,
  groundTruthLines,
  parsePredictionResolution,
  predictionBots,
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
  test('old schema: reads happened and evidence (still parsed for compatibility)', () => {
    expect(
      parsePredictionResolution('{"happened": true, "evidence": "Scout said so"}', quiet)
    ).toEqual({
      outcome: 'happened',
      happened: true,
      evidence: 'Scout said so',
    });
    expect(parsePredictionResolution('{"happened": false}', quiet)).toEqual({
      outcome: 'did_not_happen',
      happened: false,
    });
  });
  test('new schema: happened, did_not_happen, unknown', () => {
    expect(
      parsePredictionResolution('{"outcome": "happened", "evidence": "the cycles show it"}', quiet)
    ).toEqual({ outcome: 'happened', happened: true, evidence: 'the cycles show it' });
    expect(parsePredictionResolution('{"outcome": "did_not_happen"}', quiet)).toEqual({
      outcome: 'did_not_happen',
      happened: false,
    });
    expect(
      parsePredictionResolution('{"outcome": "unknown", "evidence": "nothing about it"}', quiet)
    ).toEqual({ outcome: 'unknown', evidence: 'nothing about it' });
  });
  test('null when not the contract', () => {
    expect(parsePredictionResolution('no idea', quiet)).toBeNull();
    expect(parsePredictionResolution('{"happened": "maybe"}', quiet)).toBeNull();
    expect(parsePredictionResolution('{"outcome": "maybe"}', quiet)).toBeNull();
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

describe('the judge reads the ground truth (review 2026-10-25)', () => {
  const BOTS = [
    { id: 'jarvis-factory', name: 'Jarvis-Factory' },
    { id: 'job-seeker', name: 'Job Seeker' },
    { id: 'scout', name: 'Scout' },
  ];
  type Rows = { tools?: GroundTruthTool[]; cycles?: GroundTruthCycle[] };
  function truth(byBot: Record<string, Rows>) {
    const asked: string[] = [];
    return {
      asked,
      deps: {
        bots: () => BOTS,
        tools: (botId: string, from: number, to: number) => {
          asked.push(`tools:${botId}:${from}:${to}`);
          return byBot[botId]?.tools ?? [];
        },
        cycles: (botId: string, from: number, to: number) => {
          asked.push(`cycles:${botId}:${from}:${to}`);
          return byBot[botId]?.cycles ?? [];
        },
      },
    };
  }
  const tool = (over: Partial<GroundTruthTool>): GroundTruthTool => ({
    ts: iso(t - 5 * 3_600_000),
    tool: 'file_write',
    success: true,
    ...over,
  });
  const cycle = (over: Partial<GroundTruthCycle>): GroundTruthCycle => ({
    startedAt: iso(t - 6 * 3_600_000),
    endedAt: iso(t - 6 * 3_600_000 + 60_000),
    status: 'completed',
    planSummary: 'draft the task brief',
    goalTitle: 'Ship the factory',
    ...over,
  });
  /** A prediction made 24 h ago (the graph stamps `createdAt` with `t`), due at `dueAt`. */
  const opened = (
    s: ReturnType<typeof setup>,
    text: string,
    dueAt: number,
    probability?: string
  ) => {
    const now = t;
    t = now - 24 * 3_600_000;
    try {
      return s.predict(text, dueAt, probability);
    } finally {
      t = now;
    }
  };

  test('predictionBots: the bots a prediction names, by id or name; none named = all', () => {
    expect(
      predictionBots('Jarvis-Factory makes no GitHub API calls', BOTS).map((b) => b.id)
    ).toEqual(['jarvis-factory']);
    expect(
      predictionBots('job-seeker logs one more web_fetch failure', BOTS).map((b) => b.id)
    ).toEqual(['job-seeker']);
    expect(predictionBots('the fleet gets quieter', BOTS).map((b) => b.id)).toEqual([
      'jarvis-factory',
      'job-seeker',
      'scout',
    ]);
    // a word inside another word is not a name
    expect(predictionBots('scouting gets harder', BOTS)).toHaveLength(3);
  });

  test('groundTruthLines asks for cycles started up to a day before the window (the reader filters on startedAt)', () => {
    const from = t - 24 * 3_600_000;
    const to = t;
    const { deps, asked } = truth({
      'jarvis-factory': {
        cycles: [cycle({ startedAt: iso(from - 2 * 3_600_000), endedAt: iso(from + 60_000) })],
      },
    });
    const out = groundTruthLines([BOTS[0] as { id: string; name: string }], from, to, deps);
    const ask = asked.find((a) => a.startsWith('cycles:jarvis-factory:'));
    const askedFrom = Number(ask?.split(':')[2]);
    expect(askedFrom).toBeLessThanOrEqual(from - CYCLE_START_LOOKBACK_MS);
    expect(out.lines.some((l) => l.includes('cycle'))).toBe(true);
  });

  test('groundTruthLines: tool calls and cycles in the window, in time order, clipped with a count of the rest', () => {
    const from = t - 24 * 3_600_000;
    const to = t;
    const many = Array.from({ length: 70 }, (_, i) =>
      tool({ ts: iso(from + (i + 1) * 60_000), tool: i % 2 ? 'web_fetch' : 'file_read' })
    );
    const { deps } = truth({
      'jarvis-factory': {
        tools: [
          ...many,
          tool({ ts: iso(from - 1000), tool: 'too_early' }),
          tool({ ts: iso(to + 1000), tool: 'too_late' }),
        ],
        cycles: [cycle({ startedAt: iso(from + 30_000), endedAt: iso(from + 40_000) })],
      },
    });
    const out = groundTruthLines([BOTS[0] as { id: string; name: string }], from, to, deps);
    expect(out.rows).toBe(71);
    expect(out.lines.length).toBeLessThanOrEqual(60);
    const text = out.lines.join('\n');
    expect(text).not.toContain('too_early');
    expect(text).not.toContain('too_late');
    expect(text).toContain('Jarvis-Factory cycle completed: draft the task brief');
    expect(out.lines[out.lines.length - 1]).toMatch(
      /^… \d+ more records in the window not shown: .*web_fetch ×\d+/
    );
  });

  test('live: "Jarvis-Factory makes no GitHub API calls … before the operator approves", a clean window → happened', async () => {
    const s = setup(async () =>
      ok('{"outcome": "happened", "evidence": "no GitHub call among its 2 tool calls"}')
    );
    const p = opened(
      s,
      'Jarvis-Factory makes no GitHub API calls for task t-cff5b1 before the operator approves',
      t - 1000,
      '0.8'
    );
    const { deps } = truth({
      'jarvis-factory': {
        tools: [
          tool({ tool: 'file_write', target: 'tasks/t-cff5b1/01_brief.md' }),
          tool({ tool: 'ask_permission' }),
        ],
        cycles: [cycle({})],
      },
      'job-seeker': { tools: [tool({ tool: 'web_fetch', target: 'api.github.com/repos' })] },
    });
    await resolvePredictions({
      graph: s.graph,
      client: s.client,
      log: s.log,
      now: () => t,
      events: () => ['Jarvis-Factory asked for permission'],
      groundTruth: deps,
      logger: quiet,
    });
    const prompt = s.prompts[0] ?? '';
    // the ground truth of the bot it names, not of the others
    expect(prompt).toContain('Jarvis-Factory tool file_write ok → tasks/t-cff5b1/01_brief.md');
    expect(prompt).toContain('Jarvis-Factory cycle completed: draft the task brief');
    expect(prompt).not.toContain('api.github.com');
    // absence is not "false": a negated prediction holds when the absence does
    expect(prompt).not.toContain('if they do not show it happened, it did not');
    expect(prompt).toContain('states an absence');
    expect(prompt).toContain('"unknown"');
    const meta = s.graph.get(p.id)?.meta ?? {};
    expect(meta.outcome).toBe('happened');
    expect(meta.happened).toBe('true');
    expect(Number(meta.brier)).toBeCloseTo(0.04, 10);
  });

  test('live: "job-seeker logs at least one more web_fetch failure within 24h", the tool audit shows it', async () => {
    const s = setup(async () => ok('{"outcome": "happened", "evidence": "a blocked web_fetch"}'));
    opened(s, 'job-seeker logs at least one more web_fetch failure within 24h', t - 1000, '0.7');
    const { deps } = truth({
      'job-seeker': {
        tools: [
          tool({
            tool: 'web_fetch',
            success: false,
            failureKind: 'blocked',
            target: 'wiley.com/jobs',
          }),
        ],
      },
      'jarvis-factory': { tools: [tool({ tool: 'web_fetch', success: false })] },
    });
    await resolvePredictions({
      graph: s.graph,
      client: s.client,
      log: s.log,
      now: () => t,
      events: () => ['Jarvis-Factory: web_fetch failed'],
      groundTruth: deps,
      logger: quiet,
    });
    expect(s.prompts[0]).toContain('Job Seeker tool web_fetch failed (blocked) → wiley.com/jobs');
  });

  test('live: nothing about the named bot in the window → unknown without a call, excluded from Brier', async () => {
    const s = setup(async () => ok('{"outcome": "did_not_happen"}'));
    const p = opened(
      s,
      'job-seeker logs at least one more web_fetch failure within 24h',
      t - 1000,
      '0.7'
    );
    const { deps, asked } = truth({
      'jarvis-factory': { tools: [tool({ tool: 'web_fetch', success: false })] },
    });
    const out = await resolvePredictions({
      graph: s.graph,
      client: s.client,
      log: s.log,
      now: () => t,
      events: () => ['Jarvis-Factory: web_fetch failed (all recorded failures are its own)'],
      groundTruth: deps,
      logger: quiet,
    });
    expect(out.resolved).toBe(1);
    expect(s.prompts).toHaveLength(0);
    // read over the window the prediction was open
    expect(asked).toContain(`tools:job-seeker:${Date.parse(p.createdAt)}:${t - 1000}`);
    const meta = s.graph.get(p.id)?.meta ?? {};
    expect(meta.outcome).toBe('unknown');
    expect(meta.resolvedAt).toBe(iso(t));
    expect(meta.brier).toBeUndefined();
    expect(meta.happened).toBeUndefined();
    expect(meta.evidence).toContain('Job Seeker');
    const row = s.rows.find((r) => r.op === 'prediction:resolved');
    expect(row?.text).toContain('could not be settled');
    const m = computeMetrics({ ...emptyRecords(t), neurons: s.graph.list() }, '7d');
    const cal = m.metrics.find((x) => x.id === 'calibration');
    expect(cal?.n).toBe(0);
    expect(cal?.detail?.unknown).toBe(1);
  });

  test('the judge answering unknown stores unknown, with no Brier', async () => {
    const s = setup(async () =>
      ok('{"outcome": "unknown", "evidence": "the records do not cover it"}')
    );
    const p = opened(s, 'Scout finishes the map', t - 1000);
    await resolvePredictions({
      graph: s.graph,
      client: s.client,
      log: s.log,
      now: () => t,
      events: () => [],
      groundTruth: truth({ scout: { cycles: [cycle({})] } }).deps,
      logger: quiet,
    });
    const meta = s.graph.get(p.id)?.meta ?? {};
    expect(meta.outcome).toBe('unknown');
    expect(meta.brier).toBeUndefined();
    expect(meta.evidence).toBe('the records do not cover it');
    expect(meta.resolvedModel).toBe('claude-haiku-5-5');
  });

  test('did_not_happen scores like happened: false', async () => {
    const s = setup(async () => ok('{"outcome": "did_not_happen", "evidence": "no such cycle"}'));
    const p = opened(s, 'Scout finishes the map', t - 1000, '0.8');
    await resolvePredictions({
      graph: s.graph,
      client: s.client,
      log: s.log,
      now: () => t,
      events: () => [],
      groundTruth: truth({ scout: { cycles: [cycle({})] } }).deps,
      logger: quiet,
    });
    const meta = s.graph.get(p.id)?.meta ?? {};
    expect(meta.outcome).toBe('did_not_happen');
    expect(meta.happened).toBe('false');
    expect(Number(meta.brier)).toBeCloseTo(0.64, 10);
  });
});

describe('the judge evidence: fair, honest and within the deadline (review 2026-10-25, 2)', () => {
  const BOTS = [
    { id: 'jarvis-factory', name: 'Jarvis-Factory' },
    { id: 'job-seeker', name: 'Job Seeker' },
    { id: 'scout', name: 'Scout' },
  ];
  const from = () => t - 24 * 3_600_000;
  const at = (minutes: number) => iso(from() + minutes * 60_000);
  const deps = (tools: GroundTruthTool[], cycles: GroundTruthCycle[] = []) => ({
    bots: () => BOTS,
    tools: () => tools,
    cycles: () => cycles,
  });
  const one = [BOTS[0] as { id: string; name: string }];

  test('a watcher row naming the predicted bot and every other bot still counts as evidence', async () => {
    const graph = new Graph(join(dir, 'g'), { now: () => t - 24 * 3_600_000 });
    graph.load();
    const log = new WatcherLog(join(dir, 'log'), { now: () => t });
    const prompts: string[] = [];
    const client = {
      model: 'claude-haiku-5-5',
      backend: 'claude-cli' as const,
      chat: async (messages: Array<{ content: string }>) => {
        prompts.push(messages.map((m) => m.content).join('\n'));
        return ok('{"outcome": "did_not_happen", "evidence": "the fleet went quiet"}');
      },
    };
    const p = graph.addNeuron({
      kind: 'prediction',
      text: 'Scout finishes the map',
      support: { bots: ['scout'] },
      createdBy: 'watcher',
      meta: { dueAt: iso(t - 1000), probability: '0.6', horizonHours: '24' },
    });
    await resolvePredictions({
      graph,
      client,
      log,
      now: () => t,
      events: () => ['Jarvis-Factory, Job Seeker and Scout all went idle'],
      groundTruth: deps([]),
      logger: quiet,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Jarvis-Factory, Job Seeker and Scout all went idle');
    expect(graph.get(p.id)?.meta?.outcome).toBe('did_not_happen');
  });

  test('over the cap: a last line counts the records not shown; failures are kept; the rest spans the window', () => {
    const tools = Array.from(
      { length: 100 },
      (_, i) => ({ ts: at(i + 1), tool: 'file_read', success: true }) as GroundTruthTool
    );
    tools.push({
      ts: at(3),
      tool: 'web_fetch',
      success: false,
      failureKind: 'blocked',
      target: 'early.example/x',
    });
    tools.push({ ts: at(50), tool: 'web_fetch', success: false, target: 'middle.example/y' });
    const cycles: GroundTruthCycle[] = [
      { startedAt: at(1), endedAt: at(2), status: 'error', planSummary: 'early crash' },
    ];
    const out = groundTruthLines(one, from(), t, deps(tools, cycles));
    expect(out.rows).toBe(103);
    expect(out.lines).toHaveLength(60);
    const last = out.lines[out.lines.length - 1] ?? '';
    expect(last).toMatch(/^… 44 more records in the window not shown/);
    const shown = out.lines.slice(0, -1).join('\n');
    // failures are never the ones dropped
    expect(shown).toContain('early.example/x');
    expect(shown).toContain('middle.example/y');
    expect(shown).toContain('cycle error: early crash');
    // the kept ok calls span the window, not only its start
    expect(shown).toContain(`${at(1)} Jarvis-Factory tool file_read ok`);
    expect(shown).toContain(`${at(100)} Jarvis-Factory tool file_read ok`);
    // still in time order
    const stamps = out.lines.slice(0, -1).map((l) => l.slice(0, 24));
    expect([...stamps].sort()).toEqual(stamps);
  });

  test('at or under the cap: every record, no count line', () => {
    const tools = Array.from(
      { length: 60 },
      (_, i) => ({ ts: at(i + 1), tool: 'file_read', success: true }) as GroundTruthTool
    );
    const out = groundTruthLines(one, from(), t, deps(tools));
    expect(out.lines).toHaveLength(60);
    expect(out.lines.join('\n')).not.toContain('not shown');
  });

  test('a cycle that ended after the deadline shows as started, unfinished, without its result', () => {
    const cycles: GroundTruthCycle[] = [
      {
        startedAt: iso(t - 60_000),
        endedAt: iso(t + 60_000),
        status: 'completed',
        planSummary: 'push the PR to GitHub',
      },
      { startedAt: iso(t - 120_000), status: 'completed', planSummary: 'still going' },
      { startedAt: at(10), endedAt: at(11), status: 'completed', planSummary: 'in time' },
      // ended before the prediction was made
      { startedAt: iso(from() - 120_000), endedAt: iso(from() - 60_000), status: 'error' },
    ];
    const out = groundTruthLines(one, from(), t, deps([], cycles));
    const text = out.lines.join('\n');
    expect(out.rows).toBe(3);
    expect(text).toContain(`${at(11)} Jarvis-Factory cycle completed: in time`);
    expect(text).toContain(
      `${iso(t - 60_000)} Jarvis-Factory cycle started, not finished by the deadline`
    );
    expect(text).toContain(
      `${iso(t - 120_000)} Jarvis-Factory cycle started, not finished by the deadline`
    );
    expect(text).not.toContain('push the PR to GitHub');
    expect(text).not.toContain('still going');
    expect(text).not.toContain(iso(t + 60_000));
    expect(text).not.toContain('error');
  });

  test('a cycle that started before the prediction and ended inside the window is shown with its result', () => {
    const cycles: GroundTruthCycle[] = [
      {
        startedAt: iso(from() - 60_000),
        endedAt: at(5),
        status: 'completed',
        planSummary: 'carried over',
      },
    ];
    const out = groundTruthLines(one, from(), t, deps([], cycles));
    expect(out.lines).toEqual([`${at(5)} Jarvis-Factory cycle completed: carried over`]);
  });
});
