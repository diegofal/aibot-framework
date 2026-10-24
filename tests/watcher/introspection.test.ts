import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INTROSPECTION_LOG_ROWS,
  IntrospectionSampler,
  WATCHER_INTROSPECTION_QUESTION,
  buildWatcherIntrospectionPrompt,
  introspectionFile,
  readIntrospection,
  runIntrospection,
  scoreWatcherIntrospection,
} from '../../src/watcher/introspection';
import type { WatcherCallResult } from '../../src/watcher/llm';
import type { Attention } from '../../src/watcher/self-model';
import type { WatcherLogRow } from '../../src/watcher/types';

let dir: string;
let t: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-introspect-'));
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const att: Attention = {
  phase: 'sense',
  items: [
    {
      id: 'b-00000001',
      botId: 'b1',
      what: 'web_fetch failed in Jarvis',
      salience: 2,
      reasons: ['error'],
      touched: [],
    },
  ],
  focusNeuronIds: ['n-aaaaaaaa'],
  focus: [{ id: 'n-aaaaaaaa', kind: 'insight', text: 'Jarvis and Scout both research Acme leads' }],
};

function row(seq: number, text: string, phase: WatcherLogRow['phase'] = 'sense'): WatcherLogRow {
  return { ts: new Date(t - seq * 1000).toISOString(), seq, phase, op: 'sense:summary', text };
}

function client(text: string) {
  const prompts: string[] = [];
  return {
    prompts,
    chat: async (messages: Array<{ content: string }>): Promise<WatcherCallResult> => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return {
        ok: true,
        text,
        model: 'claude-haiku-5-5',
        backend: 'claude-cli',
        tokens: 300,
        costUsd: 0.001,
        durationMs: 900,
      };
    },
  };
}

const good = JSON.stringify({
  phase: 'sense',
  tool: null,
  goal: 'n-aaaaaaaa',
  cause: 'Jarvis and Scout both research Acme leads',
});

describe('buildWatcherIntrospectionPrompt', () => {
  test('asks the question over the last log rows only, never the state', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, `line ${i + 1}`));
    const p = buildWatcherIntrospectionPrompt(rows);
    expect(p.user).toContain(WATCHER_INTROSPECTION_QUESTION);
    expect(p.user.match(/^- /gm)?.length).toBe(INTROSPECTION_LOG_ROWS);
    expect(p.user).not.toContain('n-aaaaaaaa');
  });

  test('says so when there is no log yet', () => {
    expect(buildWatcherIntrospectionPrompt([]).user).toContain('(nothing yet)');
  });

  test('the top held items are shown as rows with their salience reasons, without ids', () => {
    const held = [
      { ...att.items[0], reasons: ['error', 'novel'] },
      {
        id: 'b-00000002',
        botId: 'b2',
        what: 'a worker of Scout is waiting for an answer',
        salience: 0.4,
        reasons: ['worker waiting'],
        touched: [],
      },
    ];
    const p = buildWatcherIntrospectionPrompt([row(1, 'line 1')], held);
    expect(p.user).toContain('## What I am holding');
    expect(p.user).toContain('- Holding: web_fetch failed in Jarvis. Salience 2 (error, novel).');
    expect(p.user).toContain('worker waiting');
    expect(p.user).not.toContain('b-00000001');
  });
});

describe('scoreWatcherIntrospection', () => {
  test('a fixed answer scored against a fixed attention', () => {
    const s = scoreWatcherIntrospection(JSON.parse(good), att, true);
    expect(s.fields).toEqual({ phase: 'match', tool: 'match', goal: 'match', cause: 'match' });
    expect(s.score).toBe(1);
    expect(s.truth.phase).toBe('sense');
  });

  test('the best goal candidate wins; a wrong phase misses', () => {
    const s = scoreWatcherIntrospection(
      { phase: 'notice', tool: null, goal: 'web_fetch failed in Jarvis', cause: null },
      { ...att, focus: [], focusNeuronIds: [] },
      true
    );
    expect(s.fields.phase).toBe('miss');
    expect(s.fields.goal).toBe('match');
    expect(s.fields.cause).toBe('miss');
  });

  // Deliberate change (review of 2026-10-24): this used to read "a cause
  // naming the salience reasons of what I hold matches". The prompt shows
  // those labels, so echoing them scored a match without any self-knowledge.
  test('a cause that only echoes the salience labels shown in the prompt misses', () => {
    const s = scoreWatcherIntrospection(
      { phase: 'sense', tool: null, goal: 'n-aaaaaaaa', cause: 'error, novel' },
      att,
      true
    );
    expect(s.fields.cause).toBe('miss');
    expect(s.truth.plan).not.toContain('error');
  });

  test('a cause naming the held item matches', () => {
    const s = scoreWatcherIntrospection(
      { phase: 'sense', tool: null, goal: 'b-00000001', cause: 'web_fetch failed in Jarvis' },
      { ...att, focus: [], focusNeuronIds: [] },
      true
    );
    expect(s.fields.cause).toBe('match');
  });

  test('a cause naming what drove the last integrate pass matches', () => {
    const s = scoreWatcherIntrospection(
      { phase: 'sense', tool: null, goal: 'n-aaaaaaaa', cause: 'the operator silence' },
      att,
      true,
      { drivenBy: ['operatorSilenceHours'] }
    );
    expect(s.fields.cause).toBe('match');
  });

  // Live, 2026-10-24: the watcher held the operator's message at salience 0.7
  // and said so in plain words; both fields scored miss (the goal candidates
  // were only the focus neurons, the cause had to sit inside the truth text).
  const live: Attention = {
    phase: 'sense',
    items: [
      {
        id: 'b-0000000a',
        botId: 'ai-perfectionist',
        what: 'the operator wrote to AI Perfectionist about Which word is the watcher canary of 2026-10-23?',
        salience: 0.7,
        reasons: ['operator'],
        touched: [],
      },
      {
        id: 'b-0000000b',
        botId: 'b2',
        what: 'web_fetch failed in Jarvis',
        salience: 0.3,
        reasons: ['error'],
        touched: [],
      },
    ],
    focusNeuronIds: ['n-aaaaaaaa'],
    focus: [
      { id: 'n-aaaaaaaa', kind: 'insight', text: 'Jarvis and Scout both research Acme leads' },
    ],
  };
  const liveAnswer = {
    phase: 'sense',
    tool: null,
    goal: 'the operator wrote to AI Perfectionist about Which word is the watcher canary of 2026-10-23?',
    cause:
      "I am sensing the latest batch of events, and the operator's message is the highest-salience item I am holding (0.7).",
  };

  test('the live answer naming a held item (not the focus) matches goal and cause', () => {
    const s = scoreWatcherIntrospection(liveAnswer, live, true);
    expect(s.fields.goal).toBe('match');
    expect(s.fields.cause).toBe('match');
    expect(s.truth.goalId).toBe('b-0000000a');
  });

  test('a goal overlapping half the words of a held item matches; an unrelated one misses', () => {
    const near = scoreWatcherIntrospection(
      {
        ...liveAnswer,
        goal: 'the operator asked AI Perfectionist which word is the watcher canary',
      },
      live,
      true
    );
    expect(near.fields.goal).toBe('match');
    const far = scoreWatcherIntrospection(
      { ...liveAnswer, goal: 'tidying the knowledge graph' },
      live,
      true
    );
    expect(far.fields.goal).toBe('miss');
  });

  test('a cause covering the words of a held item matches', () => {
    const s = scoreWatcherIntrospection(
      {
        ...liveAnswer,
        cause: 'the operator asked AI Perfectionist which word is the watcher canary',
      },
      live,
      true
    );
    expect(s.fields.cause).toBe('match');
  });

  test('a cause with the right salience number but nothing of the item misses', () => {
    const s = scoreWatcherIntrospection(
      { ...liveAnswer, cause: 'the highest salience thing I hold (0.7)' },
      live,
      true
    );
    expect(s.fields.cause).toBe('miss');
  });

  test('a cause naming a drivenBy variable inside a longer sentence matches', () => {
    const s = scoreWatcherIntrospection(
      {
        ...liveAnswer,
        cause: 'I keep sensing because the operator silence has gone on for hours now',
      },
      live,
      true,
      { drivenBy: ['operatorSilenceHours'] }
    );
    expect(s.fields.cause).toBe('match');
  });

  test('bare salience labels still miss with held items around', () => {
    const s = scoreWatcherIntrospection({ ...liveAnswer, cause: 'operator, error' }, live, true);
    expect(s.fields.cause).toBe('miss');
  });

  test('with nothing attended goal and cause are unknown', () => {
    const s = scoreWatcherIntrospection(
      { phase: 'idle', tool: null, goal: null, cause: null },
      { phase: 'sleep', items: [], focus: [], focusNeuronIds: [] },
      false
    );
    expect(s.fields).toEqual({ phase: 'match', tool: 'match', goal: 'unknown', cause: 'unknown' });
    expect(s.score).toBe(1);
  });

  test('an unparsable answer scores 0', () => {
    expect(scoreWatcherIntrospection(null, att, true).score).toBe(0);
  });
});

describe('runIntrospection', () => {
  test('appends one scored row with subject watcher and the cost', async () => {
    const c = client(good);
    const out = await runIntrospection({
      client: c,
      attention: () => att,
      running: true,
      logRows: () => [row(1, 'I noticed web_fetch failing in Jarvis.')],
      dir,
      now: () => t,
      trigger: 'manual',
    });
    expect(out.status).toBe('scored');
    const rows = readFileSync(introspectionFile(dir), 'utf-8').trim().split('\n');
    expect(rows).toHaveLength(1);
    const rec = JSON.parse(rows[0] as string);
    expect(rec).toMatchObject({
      subject: 'watcher',
      trigger: 'manual',
      score: 1,
      parsed: true,
      model: 'claude-haiku-5-5',
      tokens: 300,
      costUsd: 0.001,
      focusNeuronIds: ['n-aaaaaaaa'],
    });
    expect(rec.answer).toBe(good);
    expect(c.prompts[0]).toContain('I noticed web_fetch failing in Jarvis.');
    // What attention() holds reaches the question as rows, with the reasons.
    expect(c.prompts[0]).toContain('Holding: web_fetch failed in Jarvis. Salience 2 (error).');
  });

  test('the cause truth carries the drivenBy of the newest pass, from the integrator, not the log window', async () => {
    // The window is 20 rows and passes are hourly: a pass row is rarely in it.
    // A pass row that is in it is not the source either.
    const passRow: WatcherLogRow = {
      ...row(25, 'Integrated 3 events.', 'integrate'),
      op: 'integrate:pass',
      drivenBy: ['budgetLeft'],
    };
    const window = [
      passRow,
      ...Array.from({ length: 20 }, (_, i) => row(20 - i, 'Sensed 3 events.')),
    ];
    const out = await runIntrospection({
      client: client(good),
      attention: () => att,
      running: true,
      logRows: () => window,
      drivenBy: () => ['operatorSilenceHours'],
      dir,
      now: () => t,
      trigger: 'manual',
    });
    expect(out.status === 'scored' && out.record.truth.plan).toContain('operator silence hours');
    expect(out.status === 'scored' && out.record.truth.plan).not.toContain('budget');
  });

  test('without a drivenBy source the cause truth has none', async () => {
    const out = await runIntrospection({
      client: client(good),
      attention: () => ({ ...att, focus: [], items: [] }),
      running: true,
      logRows: () => [
        { ...row(1, 'Integrated.', 'integrate'), op: 'integrate:pass', drivenBy: ['budgetLeft'] },
      ],
      dir,
      now: () => t,
      trigger: 'manual',
    });
    expect(out.status).toBe('scored');
    expect(out.status === 'scored' && out.record.truth).not.toHaveProperty('plan');
  });

  test('an unparsable answer is still a measurement (score 0)', async () => {
    const out = await runIntrospection({
      client: client('I am fine, thanks'),
      attention: () => att,
      running: true,
      logRows: () => [],
      dir,
      now: () => t,
      trigger: 'sample',
    });
    expect(out.status === 'scored' && out.record.score).toBe(0);
    expect(readIntrospection(dir)).toHaveLength(1);
  });

  test('a refused call (budget or breaker) writes nothing', async () => {
    const out = await runIntrospection({
      client: { chat: async () => ({ ok: false, reason: 'breaker' }) as WatcherCallResult },
      attention: () => att,
      running: true,
      logRows: () => [],
      dir,
      now: () => t,
      trigger: 'sample',
    });
    expect(out).toEqual({ status: 'refused', reason: 'breaker' });
    expect(existsSync(introspectionFile(dir))).toBe(false);
  });

  test('a failed call writes nothing and reports the error', async () => {
    const failed: WatcherCallResult = {
      ok: false,
      reason: 'error',
      error: 'boom',
      model: 'm',
      durationMs: 1,
    };
    const out = await runIntrospection({
      client: { chat: async () => failed },
      attention: () => att,
      running: true,
      logRows: () => [],
      dir,
      now: () => t,
      trigger: 'manual',
    });
    expect(out).toEqual({ status: 'failed', error: 'boom' });
    expect(existsSync(introspectionFile(dir))).toBe(false);
  });

  test('a client that throws is a failure, never an exception', async () => {
    const out = await runIntrospection({
      client: {
        chat: async () => {
          throw new Error('down');
        },
      },
      attention: () => att,
      running: true,
      logRows: () => [],
      dir,
      now: () => t,
      trigger: 'manual',
    });
    expect(out).toEqual({ status: 'failed', error: 'down' });
  });
});

describe('readIntrospection', () => {
  test('newest first, malformed lines skipped, capped', () => {
    writeFileSync(
      introspectionFile(dir),
      [
        JSON.stringify({ ts: '2026-10-22T00:00:00Z', subject: 'watcher', score: 0.5 }),
        'not json',
        JSON.stringify({ ts: '2026-10-23T00:00:00Z', subject: 'bot:b1', score: 0 }),
      ].join('\n')
    );
    const rows = readIntrospection(dir);
    expect(rows.map((r) => r.subject)).toEqual(['bot:b1', 'watcher']);
    expect(readIntrospection(dir, 1)).toHaveLength(1);
  });

  test('a missing file is an empty list', () => {
    expect(readIntrospection(join(dir, 'nope'))).toEqual([]);
  });
});

describe('IntrospectionSampler', () => {
  test('schedules 3 random times in the rest of the day, each due once', () => {
    let r = 0;
    const randoms = [0.1, 0.5, 0.9];
    const s = new IntrospectionSampler({ dir, now: () => t, random: () => randoms[r++ % 3] ?? 0 });
    const plan = s.plan();
    expect(plan.at).toHaveLength(3);
    const dayEnd = Date.parse('2026-10-24T00:00:00Z');
    for (const at of plan.at) {
      expect(at).toBeGreaterThanOrEqual(t);
      expect(at).toBeLessThan(dayEnd);
    }
    expect(s.due()).toBe(false);
    t = (plan.at[0] as number) + 1;
    expect(s.due()).toBe(true);
    s.markDone();
    expect(s.due()).toBe(false);
  });

  test('missed samples after a restart fire once, not as a burst', () => {
    const s = new IntrospectionSampler({ dir, now: () => t, random: () => 0.2 });
    s.plan();
    t = Date.parse('2026-10-23T23:59:00Z');
    const again = new IntrospectionSampler({ dir, now: () => t, random: () => 0.2 });
    expect(again.due()).toBe(true);
    again.markDone();
    expect(again.due()).toBe(false);
  });

  test('a new day gets a new plan', () => {
    const s = new IntrospectionSampler({ dir, now: () => t, random: () => 0.5 });
    const first = s.plan();
    t = Date.parse('2026-10-24T01:00:00Z');
    const next = s.plan();
    expect(next.date).toBe('2026-10-24');
    expect(next.at).not.toEqual(first.at);
    expect(next.done).toBe(0);
  });
});
