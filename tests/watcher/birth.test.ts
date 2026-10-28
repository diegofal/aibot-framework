import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContactEntry } from '../../src/bot/user-directory';
import type { Config } from '../../src/config';
import { parseIdentityName } from '../../src/soul';
import {
  type BirthDeps,
  beginBirth,
  continueBirth,
  linkMissing,
  linkUnembedded,
  readBirthRecord,
  relayout,
  runResync,
} from '../../src/watcher/birth';
import { Graph } from '../../src/watcher/graph';
import { WatcherLog } from '../../src/watcher/log';
import { birthFile } from '../../src/watcher/paths';
import { WATCHER_DEFAULTS, type WatcherLogRow } from '../../src/watcher/types';

let root: string;
let t: number;
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

const GOALS_B1 = `# Goals

## Active

- [ ] Research suppliers
  - id: g-11111111
  - status: in_progress
  - priority: high

- [ ] Write the newsletter
  - id: g-22222222
  - status: pending
  - priority: medium

## Completed
`;

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function fixture() {
  const s1 = join(root, 'souls', 'b1');
  const s2 = join(root, 'souls', 'b2');
  write(join(s1, 'IDENTITY.md'), 'name: Jarvis\nemoji: x\nvibe: the operator assistant\n');
  write(join(s1, 'GOALS.md'), GOALS_B1);
  write(
    join(s1, 'TASKS.json'),
    JSON.stringify({
      version: 1,
      rev: 1,
      tasks: [
        {
          id: 't-aaaaaa',
          goalId: 'g-11111111',
          text: 'List five suppliers',
          lane: 'todo',
          order: 0,
          by: 'agent',
          createdAt: 'x',
        },
        {
          id: 't-bbbbbb',
          goalId: 'g-11111111',
          text: 'Done one',
          lane: 'done',
          order: 1,
          by: 'agent',
          createdAt: 'x',
        },
      ],
    })
  );
  write(
    join(s1, 'KNOWLEDGE.json'),
    JSON.stringify({
      version: 1,
      topics: [
        {
          id: 'tp1',
          name: 'Suppliers',
          depth: 1,
          firstSeen: '2026-10-01T00:00:00Z',
          lastTouched: '2026-10-20T00:00:00Z',
          cycles: 4,
          findings: [{ id: 'f1', claim: 'Acme ships on Mondays', confidence: 'high', at: 'x' }],
          surprises: [{ id: 's1', text: 'Acme has no website', at: 'x' }],
          openQuestions: ['Who else ships to us?'],
          outputs: [],
        },
      ],
      frontier: [
        {
          id: 'fr1',
          question: 'Is there a cheaper supplier?',
          whyInteresting: 'cost',
          distance: 1,
          surpriseScore: 0.5,
          createdAt: 'x',
          status: 'open',
        },
        {
          id: 'fr2',
          question: 'Dropped one',
          whyInteresting: 'x',
          distance: 1,
          surpriseScore: 0.5,
          createdAt: 'x',
          status: 'dropped',
        },
      ],
      interests: [],
      updatedAt: null,
    })
  );
  write(
    join(s1, 'MEMORY.md'),
    '# Memory\n\n## People\n- Ana prefers mornings\n- Ana works at Acme\n'
  );
  write(
    join(s1, 'memory', '2026-10-01.md'),
    '- [09:00] The office moved to Elm street\n- [09:05] [agent-loop] noise\n'
  );
  write(join(s1, 'memory', 'users', 'u1', '2026-10-01.md'), '- [10:00] SECRET_PRIVATE fact\n');
  write(join(s1, 'memory', 'archive', '2026-09-01.md'), '- [10:00] ARCHIVED_FACT\n');
  write(join(s2, 'IDENTITY.md'), 'name: Scout\n');
  write(join(s2, 'KNOWLEDGE.json'), '{not json');
  write(
    join(root, 'data', 'agent-cycles', 'b1', '2026-10-22.jsonl'),
    `${[
      {
        cycleId: 'c1',
        startedAt: '2026-10-22T08:00:00Z',
        endedAt: '2026-10-22T08:05:00Z',
        status: 'completed',
        goalId: 'g-11111111',
      },
      {
        cycleId: 'c2',
        startedAt: '2026-10-22T09:00:00Z',
        endedAt: '2026-10-22T09:05:00Z',
        status: 'completed',
        goalId: 'g-11111111',
      },
      { cycleId: 'c3', startedAt: '2026-10-22T10:00:00Z', status: 'idle' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`
  );
  return { s1, s2 };
}

const contact = (id: string, name: string, addr: string, role?: string): ContactEntry => ({
  id,
  displayName: name,
  channels: [{ kind: 'telegram', address: addr, verified: true }],
  firstSeen: 0,
  lastSeen: 0,
  ...(role ? { metadata: { role } } : {}),
});

function deps(overrides: Partial<BirthDeps> = {}) {
  const { s1, s2 } = fixture();
  const config = {
    bots: [
      { id: 'b1', name: 'b1', soulDir: s1, llmBackend: 'claude-cli', enabled: true },
      { id: 'b2', name: 'b2', soulDir: s2, enabled: true },
    ],
    paths: { data: join(root, 'data') },
    soul: { search: { concurrency: 2 } },
    operator: { email: 'ana@example.com' },
    watcher: WATCHER_DEFAULTS,
  } as unknown as Config;
  const now = () => t;
  const dir = join(root, 'data', 'watcher');
  const graph = new Graph(dir, { now });
  graph.load();
  const rows: WatcherLogRow[] = [];
  const log = new WatcherLog(join(dir, 'log'), { now, onRow: (r) => rows.push(r) });
  const directory = {
    list: (botId: string) =>
      botId === 'b1'
        ? [contact('c1', 'Ana', 'addr-op-555', 'operator'), contact('c2', 'Bo', 'addr-bo-777')]
        : [contact('c9', 'Ana', 'addr-op-555', 'operator')],
  };
  const d: BirthDeps = {
    config,
    graph,
    log,
    dir,
    now,
    logger: noopLogger,
    channelState: (id) =>
      id === 'b1'
        ? { kind: 'telegram', state: 'ok', lastError: null, checkedAt: null }
        : id === 'b2'
          ? { kind: 'headless', state: 'missing', lastError: null, checkedAt: null }
          : undefined,
    userDirectory: directory,
    ...overrides,
  };
  return { d, rows, graph, config };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watcher-birth-'));
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function born(overrides: Partial<BirthDeps> = {}) {
  const ctx = deps(overrides);
  const record = beginBirth(ctx.d);
  const final = await continueBirth(ctx.d, record);
  return { ...ctx, record: final };
}

describe('birth', () => {
  test('beginBirth writes the wake row and birth.json synchronously', () => {
    const { d, rows } = deps();
    const record = beginBirth(d);
    expect(rows.map((r) => r.op)).toEqual(['birth:wake']);
    expect(rows[0].text).toBe(
      'Waking up for the first time. Looking around: 2 bots, 1 tenant, Claude CLI and Ollama available.'
    );
    expect(record.done).toEqual(['wake']);
    expect(readBirthRecord(d.dir)?.done).toEqual(['wake']);
  });

  test('runs every stage in order and records the counts', async () => {
    const { rows, record, graph } = await born();
    const stageOps = [...new Set(rows.map((r) => r.op))].filter((op) => op.startsWith('birth:'));
    expect(stageOps).toEqual([
      'birth:wake',
      'birth:fleet',
      'birth:people',
      'birth:goals',
      'birth:knowledge',
      'birth:unreadable',
      'birth:memory',
      'birth:history',
      'birth:link',
      'birth:done',
    ]);
    const counts = graph.counts();
    expect(counts.entity).toBe(2);
    expect(counts.person).toBe(2);
    expect(counts.goal).toBe(2);
    // 1 knowledge finding + 3 shared memory facts
    expect(counts.fact).toBe(4);
    expect(counts.surprise).toBe(1);
    // open question + open frontier item
    expect(counts.question).toBe(2);
    // knowledge topic + memory category "People"
    expect(counts.topic).toBe(2);
    expect(record.finishedAt).toBe('2026-10-23T10:00:00.000Z');
    expect(record.done).toContain('done');
    expect(readBirthRecord(join(root, 'data', 'watcher'))?.finishedAt).toBeDefined();
  });

  test('every birth neuron is created by the bot it came from', async () => {
    const { graph } = await born();
    for (const n of graph.list()) expect(n.createdBy).toMatch(/^bot:b[12]$/);
  });

  test('fleet rows name the bot, its purpose, channel and goals', async () => {
    const { rows } = await born();
    const met = rows.filter((r) => r.op === 'birth:fleet').map((r) => r.text);
    expect(met).toEqual([
      'Met Jarvis: "the operator assistant" (telegram ok, 2 active goals).',
      'Met Scout (dashboard only, 0 active goals).',
    ]);
  });

  test('people are merged across bots, the operator first', async () => {
    const { rows, graph } = await born();
    const met = rows.filter((r) => r.op === 'birth:people').map((r) => r.text);
    expect(met[0]).toBe('Met Ana (operator, telegram + email), known to 2 bots.');
    expect(met[1]).toBe('Met Bo (telegram), known to 1 bot.');
    const ana = graph.list().find((n) => n.kind === 'person' && n.text === 'Ana');
    expect(graph.neighbours(ana?.id ?? '').filter((x) => x.edge.rel === 'knows')).toHaveLength(2);
    expect(JSON.stringify(graph.snapshot())).not.toContain('addr-');
  });

  test('goals carry open tasks and an owned_by edge', async () => {
    const { rows, graph } = await born();
    expect(rows.find((r) => r.op === 'birth:goals')?.text).toBe(
      'Learned what Jarvis is working on: 2 goals, 1 open task.'
    );
    const g = graph.findByKey('goal:b1:g-11111111');
    expect(g?.meta?.openTasks).toBe('1');
    expect(g?.meta?.tasks).toBe('List five suppliers');
    expect(graph.neighbours(g?.id ?? '').some((x) => x.edge.rel === 'owned_by')).toBe(true);
  });

  test('knowledge items keep the bot confidence and point at their topic', async () => {
    const { rows, graph } = await born();
    expect(
      rows.some(
        (r) =>
          r.text ===
          `Learned from Jarvis's knowledge map: "Acme ships on Mondays" (fact, confidence high).`
      )
    ).toBe(true);
    const f = graph.findByKey('fact:b1:f1');
    expect(f?.confidence).toBe('high');
    const topic = graph.findByKey('topic:b1:tp1');
    expect(
      graph.neighbours(f?.id ?? '').some((x) => x.neuron.id === topic?.id && x.edge.rel === 'about')
    ).toBe(true);
    expect(graph.list().some((n) => n.text === 'Dropped one')).toBe(false);
  });

  test('memory: shared facts only, never memory/users or memory/archive', async () => {
    const { rows, graph } = await born();
    const texts = graph.list().map((n) => n.text);
    expect(texts).toContain('Ana prefers mornings');
    expect(texts).toContain('The office moved to Elm street');
    const all = JSON.stringify({ texts, rows });
    expect(all).not.toContain('SECRET_PRIVATE');
    expect(all).not.toContain('ARCHIVED_FACT');
    expect(all).not.toContain('noise');
    expect(rows.some((r) => r.text === 'Remembered from Jarvis: "Ana prefers mornings".')).toBe(
      true
    );
  });

  test('an unreadable file is reported, never skipped silently', async () => {
    const { rows, record } = await born();
    expect(record.unreadable).toEqual(['b2/KNOWLEDGE.json']);
    expect(rows.find((r) => r.op === 'birth:unreadable')?.text).toBe(
      'Could not read b2/KNOWLEDGE.json (invalid JSON).'
    );
    expect(rows.find((r) => r.op === 'birth:done')?.text).toContain(
      'Could not read: b2/KNOWLEDGE.json.'
    );
  });

  test('history sets activations on goals from the cycles that served them', async () => {
    const { rows, graph } = await born();
    const g = graph.findByKey('goal:b1:g-11111111');
    expect(g?.activations).toBe(2);
    expect(g?.lastActivatedAt).toBe('2026-10-22T09:05:00.000Z');
    expect(graph.findByKey('topic:b1:tp1')?.activations).toBe(4);
    expect(rows.find((r) => r.op === 'birth:history')?.text).toBe(
      'Reviewed 30 days of history: 3 cycles. 1 goal was worked on, 1 never.'
    );
  });

  test('no embeddings when embed is undefined: no related edges, every neuron placed', async () => {
    const { record, graph, rows } = await born();
    expect(record.linkStatus).toBe('no-embeddings');
    expect(graph.snapshot().edges.some((e) => e.rel === 'related')).toBe(false);
    expect(graph.list().every((n) => Array.isArray(n.pos))).toBe(true);
    expect(rows.find((r) => r.op === 'birth:link')?.text).toBe(
      'Could not embed what I know (no embedding model configured). Placing neurons by kind, without related edges.'
    );
  });

  test('embeddings via a fake embed link related neurons and place them in the ball', async () => {
    const embed = async (text: string) =>
      /acme/i.test(text) ? [1, 0.05, 0] : [0, 1, Math.random()];
    const { record, graph } = await born({ embed });
    expect(record.linkStatus).toBe('ok');
    const related = graph.snapshot().edges.filter((e) => e.rel === 'related');
    expect(related.length).toBeGreaterThan(0);
    for (const n of graph.list()) {
      const p = n.pos ?? [9, 9, 9];
      expect(Math.hypot(...p)).toBeLessThanOrEqual(1);
    }
  });

  test('a failing embed marks no-embeddings and birth still finishes', async () => {
    const embed = async () => {
      throw new Error('ollama down');
    };
    const { record, rows } = await born({ embed });
    expect(record.linkStatus).toBe('no-embeddings');
    expect(record.finishedAt).toBeDefined();
    expect(rows.find((r) => r.op === 'birth:link')?.text).toContain('ollama down');
  });

  test('an embedder that dies mid-way: a row says where it stopped and birth ends partial', async () => {
    let calls = 0;
    const embed = async () => {
      calls++;
      if (calls > 3) throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      return [1, 0, 0];
    };
    const { record, rows, graph } = await born({ embed });
    const total = graph.list().filter((n) => !n.archivedAt).length;
    expect(graph.embeddedIds().length).toBe(3);
    expect(record.linkStatus).toBe('partial');
    const row = rows.filter((r) => r.op === 'birth:link').at(-1);
    expect(row?.text).toContain(`after 3 of ${total}`);
    expect(row?.text).toContain('ECONNREFUSED');
  });

  test('resumes from a half-done birth.json', async () => {
    const { d, rows } = deps();
    write(
      birthFile(d.dir),
      JSON.stringify({
        stage: 'knowledge',
        done: ['wake', 'fleet', 'people', 'goals'],
        startedAt: '2026-10-23T09:00:00.000Z',
        counts: {},
        unreadable: [],
      })
    );
    const record = readBirthRecord(d.dir);
    if (!record) throw new Error('record');
    const final = await continueBirth(d, record);
    expect(rows.some((r) => r.op === 'birth:fleet')).toBe(false);
    expect(rows.some((r) => r.op === 'birth:knowledge')).toBe(true);
    expect(final.done).toContain('done');
  });

  test('a throwing stage ends in a log row and birth goes on', async () => {
    const { rows, record } = await born({
      userDirectory: {
        list: () => {
          throw new Error('directory broke');
        },
      },
    });
    expect(rows.find((r) => r.op === 'birth:failed')?.text).toBe(
      'Could not finish birth:people (directory broke). Moving on.'
    );
    expect(record.finishedAt).toBeDefined();
  });

  test('a cancelled birth stops between stages and stays unfinished', async () => {
    let stages = 0;
    const ctx = deps();
    const record = beginBirth(ctx.d);
    const final = await continueBirth({ ...ctx.d, isCancelled: () => stages++ >= 2 }, record);
    expect(final.finishedAt).toBeUndefined();
    expect(final.done).not.toContain('done');
  });

  test('a missing readable birth.json reads null', () => {
    expect(readBirthRecord(join(root, 'nope'))).toBeNull();
    write(join(root, 'bad', 'birth.json'), '{');
    expect(readBirthRecord(join(root, 'bad'))).toBeNull();
  });
});

describe('resync', () => {
  test('creates only what is new since the last wake', async () => {
    const ctx = await born();
    const before = ctx.graph.size();
    const s3 = join(root, 'souls', 'b3');
    write(join(s3, 'IDENTITY.md'), 'name: Newbie\n');
    (ctx.config.bots as unknown[]).push({ id: 'b3', name: 'b3', soulDir: s3, enabled: true });
    ctx.rows.length = 0;
    const result = await runResync(ctx.d);
    expect(result).toEqual({ bots: 1, goals: 0, people: 0 });
    expect(ctx.graph.size()).toBe(before + 1);
    expect(ctx.rows.map((r) => r.text)).toContain('Met Newbie (channel unknown, 0 active goals).');
    expect(ctx.rows.at(-1)?.text).toBe(
      'Caught up on what changed while I slept: 1 new bot, 0 new goals, 0 new people.'
    );
    expect(ctx.graph.findByKey('bot:b3')?.pos).toBeDefined();
  });

  test('renames an entity neuron whose bot now has another display name (persisted, emitted)', async () => {
    const ctx = await born();
    const old = ctx.graph.findByKey('bot:b2');
    expect(old?.meta?.name).toBe('Scout');
    writeFileSync(join(root, 'souls', 'b2', 'IDENTITY.md'), '**Name:** Scout Prime\n');
    const changes: string[] = [];
    ctx.graph.onChange = (c) => {
      if (c.type === 'neuron') changes.push(c.neuron.id);
    };
    ctx.rows.length = 0;
    const result = await runResync(ctx.d);
    expect(result.bots).toBe(0);
    const n = ctx.graph.findByKey('bot:b2');
    expect(n?.id).toBe(old?.id);
    expect(n?.meta?.name).toBe('Scout Prime');
    expect(n?.text.startsWith('Scout Prime')).toBe(true);
    expect(n?.text).not.toContain('*');
    expect(changes).toEqual([old?.id as string]);
    expect(ctx.rows.map((r) => r.text)).toContain('Scout is now called Scout Prime.');
    expect(ctx.graph.findSimilarText('Scout Prime', 0.5).map((x) => x.id)).toContain(old?.id);

    const reread = new Graph(ctx.d.dir);
    reread.load();
    expect(reread.findByKey('bot:b2')?.meta?.name).toBe('Scout Prime');

    changes.length = 0;
    const rev = ctx.graph.getRev();
    await runResync(ctx.d);
    expect(changes).toEqual([]);
    expect(ctx.graph.getRev()).toBe(rev);
  });
});

describe('relayout', () => {
  test('places every neuron inside the unit ball', async () => {
    const { graph } = await born();
    relayout(graph);
    for (const n of graph.list())
      expect(Math.hypot(...(n.pos ?? [2, 0, 0]))).toBeLessThanOrEqual(1);
  });
});

describe('birth: privacy of what it reads (operator-sourced)', () => {
  const sourced = (n: { meta?: Record<string, string> } | undefined) =>
    n?.meta?.operatorSourced === 'true';

  test('people from the contact directories are operator-sourced', async () => {
    const { graph } = await born();
    const people = graph.list().filter((n) => n.kind === 'person');
    expect(people.length).toBeGreaterThan(0);
    for (const n of people) expect(sourced(n)).toBe(true);
  });

  test('goals from GOALS.md are operator-sourced', async () => {
    const { graph } = await born();
    const goals = graph.list().filter((n) => n.kind === 'goal');
    expect(goals.length).toBeGreaterThan(0);
    for (const n of goals) expect(sourced(n)).toBe(true);
  });

  test('memory facts and their category topics are operator-sourced', async () => {
    const { graph } = await born();
    const memory = graph.list().filter((n) => n.meta?.stage === 'birth:memory');
    expect(memory.some((n) => n.kind === 'fact')).toBe(true);
    expect(memory.some((n) => n.kind === 'topic')).toBe(true);
    for (const n of memory) expect(sourced(n)).toBe(true);
  });

  test('knowledge-map items are operator-sourced (cycles the operator steers)', async () => {
    const { graph } = await born();
    const knowledge = graph.list().filter((n) => n.meta?.stage === 'birth:knowledge');
    expect(knowledge.length).toBeGreaterThan(0);
    for (const n of knowledge) expect(sourced(n)).toBe(true);
  });

  test('the bots themselves (fleet entities) are not', async () => {
    const { graph } = await born();
    const bots = graph.list().filter((n) => n.kind === 'entity');
    expect(bots).toHaveLength(2);
    for (const n of bots) expect(sourced(n)).toBe(false);
  });

  test('resync marks what it adds the same way', async () => {
    const { d, graph } = await born();
    write(
      join(root, 'souls', 'b2', 'GOALS.md'),
      '# Goals\n\n## Active\n\n- [ ] Call the new supplier\n  - id: g-33333333\n  - status: pending\n  - priority: low\n\n## Completed\n'
    );
    await runResync(d);
    expect(sourced(graph.findByKey('goal:b2:g-33333333'))).toBe(true);
  });
});

describe('linking what birth could not embed', () => {
  const embed = async (text: string) => (/acme/i.test(text) ? [1, 0.05, 0] : [0, 1, 0.1]);

  test('linkUnembedded embeds every live neuron without a vector and adds related edges', async () => {
    const { d, graph } = await born();
    expect(graph.embeddedIds().length).toBe(0);
    const res = await linkUnembedded({ ...d, embed });
    expect(res.status).toBe('ok');
    expect(res.embedded).toBe(graph.liveCount());
    expect(graph.embeddedIds().length).toBe(graph.liveCount());
    expect(res.edges).toBeGreaterThan(0);
    expect(graph.snapshot().edges.some((e) => e.rel === 'related')).toBe(true);
  });

  test('linkUnembedded with a failing embedder and nothing embedded: no-embeddings with the reason', async () => {
    const { d } = await born();
    const res = await linkUnembedded({
      ...d,
      embed: async () => {
        throw new Error('ollama down');
      },
    });
    expect(res.status).toBe('no-embeddings');
    expect(res.failure).toContain('ollama down');
  });

  test('linkMissing: a graph born no-embeddings is linked once an embedder works, birth.json says ok, one row', async () => {
    const { d, graph, rows } = await born();
    expect(readBirthRecord(d.dir)?.linkStatus).toBe('no-embeddings');
    const before = rows.length;
    const res = await linkMissing({ ...d, embed });
    expect(res?.status).toBe('ok');
    expect(readBirthRecord(d.dir)?.linkStatus).toBe('ok');
    const added = rows.slice(before);
    expect(added.length).toBe(1);
    expect(added[0].op).toBe('maintain:link');
    expect(added[0].text).toMatch(
      /^Embedded \d+ neurons? I had not embedded yet: \d+ new related edges?\.$/
    );
    for (const n of graph.list())
      expect(Math.hypot(...(n.pos ?? [9, 9, 9]))).toBeLessThanOrEqual(1);
  });

  test('linkMissing does nothing without an embedder or when every live neuron has a vector', async () => {
    const { d, rows } = await born();
    const before = rows.length;
    expect(await linkMissing(d)).toBeUndefined();
    await linkMissing({ ...d, embed });
    const after = rows.length;
    expect(after).toBe(before + 1);
    expect(await linkMissing({ ...d, embed })).toBeUndefined();
    expect(rows.length).toBe(after);
  });

  test('linkMissing with the embedder still down logs one row and keeps no-embeddings', async () => {
    const { d, rows } = await born();
    const before = rows.length;
    const res = await linkMissing({
      ...d,
      embed: async () => {
        throw new Error('ollama down');
      },
    });
    expect(res?.status).toBe('no-embeddings');
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)?.op).toBe('maintain:link');
    expect(rows.at(-1)?.text).toContain('ollama down');
    expect(readBirthRecord(d.dir)?.linkStatus).toBe('no-embeddings');
  });
});

describe('birth: bot names written in markdown', () => {
  test('"**Name:** MyFirstMillion Bot" becomes the entity name without the stars', async () => {
    const { d, graph } = deps();
    writeFileSync(
      join(root, 'souls', 'b2', 'IDENTITY.md'),
      '# Identity\n\n**Name:** MyFirstMillion Bot\n**Vibe:** `frugal` and **bold**\n'
    );
    await continueBirth(d, beginBirth(d));
    const n = graph.findByKey('bot:b2');
    expect(n?.meta?.name).toBe('MyFirstMillion Bot');
    expect(n?.text.startsWith('MyFirstMillion Bot')).toBe(true);
    expect(n?.text).not.toContain('*');
    expect(n?.text).not.toContain('`');
  });

  test('a name: under "## People I serve" is not the bot (same rule as the relay)', async () => {
    const { d, graph } = deps();
    const identity = '# Identity\n\nemoji: x\n\n## People I serve\n- name: Diego\n- vibe: loud\n';
    writeFileSync(join(root, 'souls', 'b2', 'IDENTITY.md'), identity);
    await continueBirth(d, beginBirth(d));
    const n = graph.findByKey('bot:b2');
    expect(parseIdentityName(identity)).toBeNull();
    expect(n?.meta?.name).toBe('b2');
    expect(n?.text).not.toContain('Diego');
    expect(n?.text).not.toContain('loud');
  });

  test('"__Name__:" under "## Identity" → "### Basics" is the bot, as for the relay', async () => {
    const { d, graph } = deps();
    const identity = '## Identity\n### Basics\n- __Name__: Atlas\n- vibe: steady\n';
    writeFileSync(join(root, 'souls', 'b2', 'IDENTITY.md'), identity);
    await continueBirth(d, beginBirth(d));
    const n = graph.findByKey('bot:b2');
    expect(parseIdentityName(identity)).toBe('Atlas');
    expect(n?.meta?.name).toBe('Atlas');
    expect(n?.text).toBe('Atlas: steady');
  });
});

describe('birth: bookkeeping lines of the daily logs', () => {
  test('operational traces are not facts; the real fact next to them is', async () => {
    const { d, graph } = deps();
    writeFileSync(
      join(root, 'souls', 'b1', 'memory', '2026-10-02.md'),
      [
        '- [08:00] ask_human 264a4318 enviada: el recordatorio ÚNICO del dry run GitHub t-cff5b1 …',
        '- [08:01] task_progress: drafted section 2',
        '- [08:02] t-cff5b1',
        '- [08:03] https://example.com/x',
        '- [08:04] The supplier in Rosario closes on Mondays',
        '',
      ].join('\n')
    );
    await continueBirth(d, beginBirth(d));
    const texts = graph
      .list()
      .filter((n) => n.meta?.source === 'memory/2026-10-02.md')
      .map((n) => n.text);
    expect(texts).toEqual(['The supplier in Rosario closes on Mondays']);
  });
});

describe('linking: an embedder that is down', () => {
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
  function addPending(graph: Graph, n: number) {
    for (let i = 0; i < n; i++)
      graph.addNeuron({
        kind: 'fact',
        text: `pending fact ${i}`,
        support: [],
        createdBy: 'watcher',
      });
  }

  test('linkUnembedded stops at the first batch where every embed failed, even with vectors in the graph', async () => {
    const { d, graph } = await born();
    const first = graph.list()[0];
    graph.setEmbedding(first.id, [1, 0, 0]);
    addPending(graph, 100);
    let calls = 0;
    const res = await linkUnembedded({
      ...d,
      embed: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        throw refused();
      },
    });
    expect(res.embedded).toBe(0);
    expect(res.failure).toContain('ECONNREFUSED');
    // concurrency 2: the two embeds in flight, never the rest of the batch nor the next batches
    expect(calls).toBeLessThanOrEqual(2);
    // The graph has vectors but this run stopped at an error: partial (was 'ok', which hid the stop).
    expect(res.status).toBe('partial');
  });

  test('linkUnembedded keeps the first real error when a later batch fails after some embedded', async () => {
    const { d, graph } = await born();
    addPending(graph, 80);
    let calls = 0;
    const res = await linkUnembedded({
      ...d,
      embed: async () => {
        calls++;
        if (calls > 40) throw refused();
        return [1, 0, 0];
      },
    });
    expect(res.embedded).toBeGreaterThan(0);
    expect(res.failure).toContain('ECONNREFUSED');
  });

  test('a neuron archived while its embed is pending gets no vector and no edges; a live one in the batch is linked', async () => {
    const { d, graph } = await born();
    // Everything already in the graph is embedded away from the test vectors.
    for (const n of graph.list()) graph.setEmbedding(n.id, [0, 0, 1]);
    const neighbour = graph.addNeuron({
      kind: 'fact',
      text: 'live neighbour',
      support: [],
      createdBy: 'watcher',
    });
    graph.setEmbedding(neighbour.id, [1, 0, 0]);
    const doomed = graph.addNeuron({
      kind: 'fact',
      text: 'doomed fact',
      support: [],
      createdBy: 'watcher',
    });
    const live = graph.addNeuron({
      kind: 'fact',
      text: 'live fact',
      support: [],
      createdBy: 'watcher',
    });
    // The snapshot the start's backfill took before maintenance ran.
    const pending = [doomed, live];
    const res = await linkUnembedded(
      {
        ...d,
        embed: async (text: string) => {
          await new Promise((r) => setTimeout(r, 2));
          // Maintenance archives the doomed neuron while its embed is in flight.
          if (text.includes('doomed')) graph.archive(doomed.id, { archivedReason: 'forgotten' });
          return [1, 0, 0];
        },
      },
      { pending }
    );
    expect(graph.get(doomed.id)?.archivedAt).toBeTruthy();
    expect(graph.getEmbedding(doomed.id)).toBeUndefined();
    expect(graph.edgesOf(doomed.id)).toHaveLength(0);
    expect(graph.getEmbedding(live.id)).toEqual([1, 0, 0]);
    const liveEdges = graph.edgesOf(live.id);
    expect(liveEdges.some((e) => e.rel === 'related' && e.to === neighbour.id)).toBe(true);
    expect(res.embedded).toBe(1);
    expect(res.edges).toBe(1);
  });

  test('a neuron archived before its embed starts is never sent to the embedder', async () => {
    const { d, graph } = await born();
    for (const n of graph.list()) graph.setEmbedding(n.id, [0, 0, 1]);
    const gone = graph.addNeuron({
      kind: 'fact',
      text: 'gone fact',
      support: [],
      createdBy: 'watcher',
    });
    graph.archive(gone.id, { archivedReason: 'forgotten' });
    const texts: string[] = [];
    const res = await linkUnembedded(
      {
        ...d,
        embed: async (text: string) => {
          texts.push(text);
          return [1, 0, 0];
        },
      },
      { pending: [gone] }
    );
    expect(texts).toHaveLength(0);
    expect(graph.getEmbedding(gone.id)).toBeUndefined();
    expect(res.embedded).toBe(0);
    expect(res.stopped).toBeUndefined();
  });

  test('linkMissing with the embedder refusing: the row names the real error and never claims a placement', async () => {
    const { d, graph, rows } = await born();
    graph.setEmbedding(graph.list()[0].id, [1, 0, 0]);
    const before = rows.length;
    const res = await linkMissing({
      ...d,
      embed: async () => {
        throw refused();
      },
    });
    expect(res?.embedded).toBe(0);
    expect(res?.relaidOut).toBe(false);
    const added = rows.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0].op).toBe('maintain:link');
    expect(added[0].text).toContain('ECONNREFUSED');
    expect(added[0].text).not.toContain('returned no vectors');
    expect(added[0].text).not.toContain('Placing neurons');
  });

  test('linkMissing probes once with a short timeout: a never-answering embedder costs one call', async () => {
    const { d, rows } = await born();
    let calls = 0;
    const started = Date.now();
    const res = await linkMissing(
      {
        ...d,
        embed: () => {
          calls++;
          return new Promise<number[]>(() => {});
        },
      },
      { probeTimeoutMs: 20 }
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls).toBe(1);
    expect(res?.embedded).toBe(0);
    expect(res?.failure).toMatch(/did not answer within 20 ms/);
    expect(rows.at(-1)?.op).toBe('maintain:link');
    expect(rows.at(-1)?.text).toContain('did not answer within 20 ms');
  });

  test('a cold model load: a probe that answers after 8 s is up and the backfill proceeds', async () => {
    const { d, graph } = await born();
    addPending(graph, 4);
    let calls = 0;
    const embed = () => {
      calls++;
      if (calls === 1) return new Promise<number[]>((r) => setTimeout(() => r([1, 0, 0]), 8000));
      return Promise.resolve([1, 0, 0]);
    };
    jest.useFakeTimers();
    try {
      let settled = false;
      const p = linkMissing({ ...d, embed }).finally(() => {
        settled = true;
      });
      for (let i = 0; i < 30 && !settled; i++) {
        await Promise.resolve();
        await Promise.resolve();
        jest.advanceTimersByTime(1000);
      }
      const res = await p;
      expect(res?.failure).toBeUndefined();
      expect(res?.embedded).toBeGreaterThan(0);
      expect(calls).toBeGreaterThan(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a refused connection skips the backfill at once, without waiting for the probe budget', async () => {
    const { d } = await born();
    let calls = 0;
    const started = Date.now();
    const res = await linkMissing({
      ...d,
      embed: async () => {
        calls++;
        throw refused();
      },
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls).toBe(1);
    expect(res?.embedded).toBe(0);
    expect(res?.failure).toContain('ECONNREFUSED');
  });

  test('one early rejection inside a batch never skips neurons the embedder then embeds', async () => {
    const { d, graph } = await born();
    // Keep only 32 pending neurons: one full batch.
    for (const n of graph.list()) graph.setEmbedding(n.id, [0, 0, 1]);
    addPending(graph, 32);
    let calls = 0;
    const config = { ...d.config, soul: { search: { concurrency: 3 } } } as Config;
    const res = await linkUnembedded({
      ...d,
      config,
      embed: async () => {
        calls++;
        if (calls === 1) throw refused();
        await new Promise((r) => setTimeout(r, 2));
        return [1, 0, 0];
      },
    });
    expect(calls).toBe(32);
    expect(res.embedded).toBe(31);
    expect(res.failure).toContain('ECONNREFUSED');
    // The run did not stop: the one failed embed is a note, not a partial run.
    expect(res.status).toBe('ok');
    expect(res.skipped).toBe(1);
  });

  test('linkMissing that recovers from one transient error: no "Stopped" row, the skip noted, birth.json ok', async () => {
    const { d, graph, rows } = await born();
    for (const n of graph.list()) graph.setEmbedding(n.id, [0, 0, 1]);
    addPending(graph, 32);
    let calls = 0;
    const config = { ...d.config, soul: { search: { concurrency: 3 } } } as Config;
    const res = await linkMissing({
      ...d,
      config,
      embed: async () => {
        calls++;
        // call 1 is the probe; the first embed of the batch fails once
        if (calls === 2) throw refused();
        await new Promise((r) => setTimeout(r, 2));
        return [1, 0, 0];
      },
    });
    expect(res?.embedded).toBe(31);
    expect(res?.status).toBe('ok');
    const row = rows.at(-1);
    expect(row?.op).toBe('maintain:link');
    expect(row?.text).not.toContain('Stopped');
    expect(row?.text).toContain('1 embed failed and was skipped');
    expect(readBirthRecord(d.dir)?.linkStatus).toBe('ok');
  });

  test('birth\'s link stage that recovers from one transient error ends ok, with no "Stopped" row', async () => {
    let calls = 0;
    const { rows, record } = await born({
      embed: async () => {
        calls++;
        if (calls === 1) throw refused();
        await new Promise((r) => setTimeout(r, 2));
        return [1, 0, 0];
      },
    });
    const linkRows = rows.filter((r) => r.op === 'birth:link');
    expect(linkRows.some((r) => r.text.includes('Stopped'))).toBe(false);
    expect(linkRows.some((r) => r.text.includes('1 embed failed and was skipped'))).toBe(true);
    expect(record.linkStatus).toBe('ok');
  });

  test('linkMissing whose embeds all resolve [] leaves birth.json as it was, never ok', async () => {
    const { d, graph, rows } = await born();
    graph.setEmbedding(graph.list()[0].id, [1, 0, 0]);
    addPending(graph, 40);
    const before = readBirthRecord(d.dir)?.linkStatus;
    expect(before).not.toBe('ok');
    let calls = 0;
    const res = await linkMissing({
      ...d,
      // the probe answers; every neuron's embed resolves [] without throwing
      embed: async () => (++calls === 1 ? [1, 0, 0] : []),
    });
    expect(res?.embedded).toBe(0);
    expect(res?.status).not.toBe('ok');
    expect(readBirthRecord(d.dir)?.linkStatus).toBe(before);
    expect(rows.at(-1)?.text).toContain('returned no vectors');
  });

  test('linkMissing that stops at an error after embedding some marks birth.json partial', async () => {
    const { d, graph } = await born();
    addPending(graph, 10);
    let calls = 0;
    const res = await linkMissing({
      ...d,
      embed: async () => {
        calls++;
        if (calls > 4) throw refused();
        return [1, 0, 0];
      },
    });
    expect(res?.embedded).toBeGreaterThan(0);
    expect(res?.failure).toContain('ECONNREFUSED');
    expect(readBirthRecord(d.dir)?.linkStatus).toBe('partial');
    const ok = await linkMissing({ ...d, embed: async () => [1, 0, 0] });
    expect(ok?.failure).toBeUndefined();
    expect(readBirthRecord(d.dir)?.linkStatus).toBe('ok');
  });

  test('linkMissing that embedded says it relaid out', async () => {
    const { d } = await born();
    const res = await linkMissing({ ...d, embed: async () => [1, 0, 0] });
    expect(res?.relaidOut).toBe(true);
  });
});

describe('birth: tagged error lines go through the one bookkeeping rule', () => {
  test('[error] / [agent-loop] / [tool-error] daily lines are skipped', async () => {
    const { d, graph } = deps();
    writeFileSync(
      join(root, 'souls', 'b1', 'memory', '2026-10-03.md'),
      [
        '- [08:00] [error] Claude CLI exited with code 1',
        '- [08:01] [agent-loop] Ran 3 tools',
        '- [08:02] [tool-error] web_fetch failed on wiley.com',
        '- [08:03] [ventas] El operador confirmó que el informe trimestral fue enviado al cliente Acme',
        '',
      ].join('\n')
    );
    await continueBirth(d, beginBirth(d));
    const texts = graph
      .list()
      .filter((n) => n.meta?.source === 'memory/2026-10-03.md')
      .map((n) => n.text);
    expect(texts).toEqual([
      'El operador confirmó que el informe trimestral fue enviado al cliente Acme',
    ]);
  });
});

describe('birth over disabled bots (mind reset)', () => {
  test('a disabled bot is listed in the fleet but its material is not read', async () => {
    const ctx = deps();
    (ctx.config.bots[0] as { enabled: boolean }).enabled = false;
    const record = beginBirth(ctx.d);
    await continueBirth(ctx.d, record);
    const texts = ctx.graph.list().map((n) => n.text);
    const counts = ctx.graph.counts();
    // Fleet: both bots are still entities, the disabled one says so.
    expect(counts.entity).toBe(2);
    // Goals, knowledge, memory and contacts of b1 never enter the graph.
    expect(counts.goal ?? 0).toBe(0);
    expect(texts.some((t) => t.includes('Acme'))).toBe(false);
    expect(texts.some((t) => t.includes('Elm street'))).toBe(false);
    expect(texts.some((t) => t.includes('Bo'))).toBe(false);
    // b2's operator contact is still read.
    expect(ctx.graph.list().some((n) => n.kind === 'person')).toBe(true);
  });

  test('resync after a wake skips a disabled bot too', async () => {
    const ctx = deps();
    (ctx.config.bots[0] as { enabled: boolean }).enabled = false;
    const result = await runResync(ctx.d);
    expect(result.goals).toBe(0);
    expect(ctx.graph.list().some((n) => n.text.includes('Bo'))).toBe(false);
  });
});
