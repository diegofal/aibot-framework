import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmWatcherStopped,
  graphFilesGuard,
  parseRejudgeArgs,
  runRejudge,
} from '../../../scripts/watcher/rejudge';
import { Graph } from '../../../src/watcher/graph';
import type { WatcherCallResult } from '../../../src/watcher/llm';

let dir: string;
let t: number;
const H = 3_600_000;
const quiet = { warn: () => {} };
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-rejudge-'));
  t = Date.parse('2026-10-25T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ok = (text: string): WatcherCallResult => ({
  ok: true,
  text,
  model: 'claude-haiku-5-5',
  backend: 'claude-cli',
  tokens: 100,
  durationMs: 10,
});

function setup(replies: Array<() => WatcherCallResult>) {
  const graph = new Graph(join(dir, 'g'), { now: () => t });
  graph.load();
  const prompts: string[] = [];
  let i = 0;
  const client = {
    chat: async (messages: Array<{ content: string }>) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      const r = replies[Math.min(i, replies.length - 1)] as () => WatcherCallResult;
      i++;
      return r();
    },
  };
  const resolved = (text: string, meta: Record<string, string> = {}) => {
    const n = graph.addNeuron({
      kind: 'prediction',
      text,
      support: { bots: ['jarvis-factory'] },
      createdBy: 'watcher',
      meta: { dueAt: iso(t + 24 * H), probability: '0.8' },
    });
    graph.patchMeta(n.id, {
      resolvedAt: iso(t + 25 * H),
      happened: 'false',
      brier: '0.64',
      evidence: 'the watcher records show no GitHub API calls by Jarvis-Factory',
      ...meta,
    });
    return n;
  };
  const groundTruth = {
    bots: () => [
      { id: 'jarvis-factory', name: 'Jarvis-Factory' },
      { id: 'job-seeker', name: 'Job Seeker' },
    ],
    tools: (botId: string) =>
      botId === 'jarvis-factory'
        ? [{ ts: iso(t + H), tool: 'file_write', success: true, target: 'tasks/t-cff5b1/brief.md' }]
        : [],
    cycles: () => [],
  };
  return { graph, client, prompts, resolved, groundTruth };
}

describe('parseRejudgeArgs', () => {
  test('dry run by default; --apply writes; --limit caps', () => {
    expect(parseRejudgeArgs([])).toEqual({ apply: false });
    expect(parseRejudgeArgs(['--apply', '--limit', '5'])).toEqual({ apply: true, limit: 5 });
    expect(parseRejudgeArgs(['--dry-run'])).toEqual({ apply: false });
  });
});

describe('runRejudge', () => {
  test('dry run: judges every resolved prediction again with ground truth, writes nothing', async () => {
    const s = setup([() => ok('{"outcome": "happened", "evidence": "only a file_write"}')]);
    const p = s.resolved(
      'Jarvis-Factory makes no GitHub API calls for task t-cff5b1 before the operator approves'
    );
    s.graph.addNeuron({
      kind: 'prediction',
      text: 'still open',
      support: { bots: [] },
      createdBy: 'watcher',
      meta: { dueAt: iso(t + 48 * H) },
    });
    const before = JSON.stringify(s.graph.get(p.id));
    const report = await runRejudge({
      graph: s.graph,
      client: s.client,
      events: () => [],
      groundTruth: s.groundTruth,
      logger: quiet,
      now: () => t + 30 * H,
      apply: false,
    });
    expect(report.rows).toEqual([
      {
        id: p.id,
        text: p.text,
        previous: 'did_not_happen',
        next: 'happened',
        evidence: 'only a file_write',
        changed: true,
      },
    ]);
    expect(report.applied).toBe(0);
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]).toContain('Jarvis-Factory tool file_write ok → tasks/t-cff5b1/brief.md');
    expect(JSON.stringify(s.graph.get(p.id))).toBe(before);
  });

  test('--apply: stores the new outcome and Brier, the old outcome, when; keeps resolvedAt', async () => {
    const s = setup([() => ok('{"outcome": "happened", "evidence": "only a file_write"}')]);
    const p = s.resolved('Jarvis-Factory makes no GitHub API calls');
    const report = await runRejudge({
      graph: s.graph,
      client: s.client,
      events: () => [],
      groundTruth: s.groundTruth,
      logger: quiet,
      now: () => t + 30 * H,
      apply: true,
    });
    expect(report.applied).toBe(1);
    const meta = s.graph.get(p.id)?.meta ?? {};
    expect(meta.outcome).toBe('happened');
    expect(meta.happened).toBe('true');
    expect(Number(meta.brier)).toBeCloseTo(0.04, 10);
    expect(meta.previousHappened).toBe('false');
    expect(meta.rejudgedAt).toBe(iso(t + 30 * H));
    expect(meta.resolvedAt).toBe(iso(t + 25 * H));
    expect(meta.evidence).toBe('only a file_write');
    // already re-judged: a second run leaves it alone
    const again = await runRejudge({
      graph: s.graph,
      client: s.client,
      events: () => [],
      groundTruth: s.groundTruth,
      logger: quiet,
      now: () => t + 31 * H,
      apply: true,
    });
    expect(again.rows).toEqual([]);
  });

  test('--apply with nothing recorded about the bot: unknown, the old Brier removed', async () => {
    const s = setup([() => ok('{"outcome": "did_not_happen"}')]);
    const p = s.resolved('job-seeker logs at least one more web_fetch failure within 24h');
    const report = await runRejudge({
      graph: s.graph,
      client: s.client,
      events: () => [],
      groundTruth: s.groundTruth,
      logger: quiet,
      now: () => t + 30 * H,
      apply: true,
    });
    expect(s.prompts).toHaveLength(0);
    expect(report.rows[0]?.next).toBe('unknown');
    const meta = s.graph.get(p.id)?.meta ?? {};
    expect(meta.outcome).toBe('unknown');
    expect(meta.brier).toBeUndefined();
    expect(meta.happened).toBeUndefined();
    expect(meta.previousHappened).toBe('false');
  });

  test('a refused call stops the run; an unreadable answer is reported and left alone', async () => {
    const s = setup([() => ok('not json'), () => ({ ok: false, reason: 'cap' })]);
    const a = s.resolved('Jarvis-Factory ships the brief');
    s.resolved('Jarvis-Factory opens a PR');
    const report = await runRejudge({
      graph: s.graph,
      client: s.client,
      events: () => [],
      groundTruth: s.groundTruth,
      logger: quiet,
      now: () => t + 30 * H,
      apply: true,
    });
    expect(report.stopped).toBe('cap');
    expect(report.rows).toEqual([
      {
        id: a.id,
        text: a.text,
        previous: 'did_not_happen',
        next: null,
        changed: false,
      },
    ]);
    expect(s.graph.get(a.id)?.meta?.rejudgedAt).toBeUndefined();
    expect(report.applied).toBe(0);
  });

  test('--limit caps how many it judges', async () => {
    const s = setup([() => ok('{"outcome": "happened"}')]);
    for (let i = 0; i < 3; i++) s.resolved(`Jarvis-Factory does thing ${i}`);
    const report = await runRejudge({
      graph: s.graph,
      client: s.client,
      events: () => [],
      groundTruth: s.groundTruth,
      logger: quiet,
      now: () => t + 30 * H,
      apply: false,
      limit: 2,
    });
    expect(report.rows).toHaveLength(2);
  });
});

describe('--apply never writes over a running watcher (review 2026-10-25, 3)', () => {
  test('parseRejudgeArgs reads --watcher-url and --token', () => {
    expect(
      parseRejudgeArgs(['--apply', '--watcher-url', 'http://127.0.0.1:3000', '--token', 'k'])
    ).toEqual({ apply: true, watcherUrl: 'http://127.0.0.1:3000', token: 'k' });
  });

  test('confirmWatcherStopped: only a reported running:false passes', async () => {
    const asked: Array<{ url: string; auth?: string }> = [];
    const fake = (res: () => Response): typeof fetch =>
      (async (url: string, init?: RequestInit) => {
        asked.push({
          url: String(url),
          auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
        });
        return res();
      }) as never;
    const json =
      (body: unknown, status = 200) =>
      () =>
        new Response(JSON.stringify(body), { status });
    expect(
      await confirmWatcherStopped(
        'http://h:3000/',
        'k',
        fake(json({ enabled: true, running: false }))
      )
    ).toEqual({ ok: true });
    expect(asked[0]).toEqual({ url: 'http://h:3000/api/watcher', auth: 'Bearer k' });
    const running = await confirmWatcherStopped('http://h', 'k', fake(json({ running: true })));
    expect(running.ok).toBe(false);
    expect(await confirmWatcherStopped('http://h', 'k', fake(json({ enabled: false })))).toEqual({
      ok: true,
    });
    expect((await confirmWatcherStopped('http://h', 'k', fake(json({}, 401)))).ok).toBe(false);
    expect((await confirmWatcherStopped('http://h', 'k', fake(json({ enabled: true })))).ok).toBe(
      false
    );
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as never;
    expect((await confirmWatcherStopped('http://h', 'k', down)).ok).toBe(false);
  });

  test('graph files changed between load and write: the guard names them', () => {
    const g = join(dir, 'w');
    mkdirSync(g, { recursive: true });
    writeFileSync(join(g, 'neurons.jsonl'), 'a\n');
    const guard = graphFilesGuard(g);
    expect(guard()).toBeNull();
    appendFileSync(join(g, 'neurons.jsonl'), 'b\n');
    expect(guard()).toContain('neurons.jsonl');
  });

  test('a guard that refuses: nothing is written, the run says why', async () => {
    const s = setup([() => ok('{"outcome": "happened", "evidence": "only a file_write"}')]);
    const p = s.resolved('Jarvis-Factory makes no GitHub API calls');
    const before = JSON.stringify(s.graph.get(p.id));
    const report = await runRejudge({
      graph: s.graph,
      client: s.client,
      events: () => [],
      groundTruth: s.groundTruth,
      logger: quiet,
      now: () => t + 30 * H,
      apply: true,
      beforeWrite: () => 'neurons.jsonl changed since load: is the watcher running?',
    });
    expect(report.applied).toBe(0);
    expect(report.aborted).toContain('neurons.jsonl changed');
    expect(report.rows[0]?.next).toBe('happened');
    expect(JSON.stringify(s.graph.get(p.id))).toBe(before);
  });

  test('the guard runs after every model call, before the first write', async () => {
    const s = setup([() => ok('{"outcome": "happened"}')]);
    const a = s.resolved('Jarvis-Factory ships the brief');
    const b = s.resolved('Jarvis-Factory opens a PR');
    let callsAtGuard = -1;
    const report = await runRejudge({
      graph: s.graph,
      client: s.client,
      events: () => [],
      groundTruth: s.groundTruth,
      logger: quiet,
      now: () => t + 30 * H,
      apply: true,
      beforeWrite: () => {
        callsAtGuard = s.prompts.length;
        expect(s.graph.get(a.id)?.meta?.rejudgedAt).toBeUndefined();
        return null;
      },
    });
    expect(callsAtGuard).toBe(2);
    expect(report.applied).toBe(2);
    expect(s.graph.get(b.id)?.meta?.rejudgedAt).toBeDefined();
  });
});
