import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmQueryEntry } from '../../src/bot/llm-query-log';
import type { LLMClient } from '../../src/core/llm-client';
import { createFleetMemorySearchTool } from '../../src/tools/fleet-memory-search';
import { DailyBudget } from '../../src/watcher/budget';
import { WorkingBuffer } from '../../src/watcher/buffer';
import { Graph } from '../../src/watcher/graph';
import { instrumented } from '../../src/watcher/llm';
import { WatcherLog } from '../../src/watcher/log';
import {
  NOTICE_MIN_GAP_MS,
  Noticer,
  noticeItems,
  parseNoticeOutput,
} from '../../src/watcher/notice';
import {
  type BufferItem,
  type SensedEvent,
  WATCHER_DEFAULTS,
  type WatcherConfig,
  type WatcherLogRow,
} from '../../src/watcher/types';

const quiet = { warn: () => {} };

let dir: string;
let t: number;

interface Setup {
  reply?: () => Promise<{ text: string; usage?: Record<string, unknown> }>;
  maxPerDay?: number;
  open?: boolean;
  embed?: (text: string) => Promise<number[]>;
  cfg?: Partial<WatcherConfig['notice']>;
}

function setup(opts: Setup = {}) {
  const now = () => t;
  const graph = new Graph(join(dir, 'g'), { now });
  graph.load();
  const jarvis = graph.addNeuron({
    kind: 'entity',
    text: 'Jarvis',
    support: { bots: ['b1'] },
    createdBy: 'bot:b1',
    meta: { key: 'bot:b1', name: 'Jarvis' },
  });
  const scout = graph.addNeuron({
    kind: 'entity',
    text: 'Scout',
    support: { bots: ['b2'] },
    createdBy: 'bot:b2',
    meta: { key: 'bot:b2', name: 'Scout' },
  });
  const invoices = graph.addNeuron({
    kind: 'topic',
    text: 'Invoices and payments',
    support: { bots: ['b1'] },
    createdBy: 'bot:b1',
  });
  const rows: WatcherLogRow[] = [];
  const log = new WatcherLog(join(dir, 'log'), { now, onRow: (r) => rows.push(r) });
  const buffer = new WorkingBuffer();
  const budget = new DailyBudget({
    dir,
    now,
    limits: () => ({
      notice: { maxPerDay: opts.maxPerDay ?? 10 },
      integrate: { maxPerDay: 1, maxTokensPerDay: 1 },
    }),
    isCircuitOpen: () => opts.open === true,
  });
  const prompts: string[] = [];
  const client = {
    backend: 'claude-cli',
    generate: async () => ({ text: '' }),
    chat: async (messages: Array<{ role: string; content: string }>) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return (opts.reply ?? (async () => ({ text: '{"keep":[]}' })))();
    },
  } as unknown as LLMClient;
  const entries: LlmQueryEntry[] = [];
  const call = instrumented(
    { client, model: 'claude-haiku-5-5', backend: 'claude-cli' },
    {
      tier: 'notice',
      caller: 'watcher:notice',
      budget,
      queryLog: { append: (e) => entries.push(e) },
      now,
    }
  );
  const config: WatcherConfig = {
    ...WATCHER_DEFAULTS,
    enabled: true,
    notice: {
      ...WATCHER_DEFAULTS.notice,
      enabled: true,
      maxPerDay: opts.maxPerDay ?? 10,
      ...opts.cfg,
    },
  };
  const noticer = new Noticer({
    graph,
    buffer,
    log,
    client: call,
    budget,
    config: () => config,
    now,
    botName: (id) => (id === 'b1' ? 'Jarvis' : id === 'b2' ? 'Scout' : id),
    ...(opts.embed ? { embed: opts.embed } : {}),
    logger: quiet,
  });
  return { graph, rows, buffer, noticer, prompts, entries, budget, jarvis, scout, invoices };
}

let seq = 0;
function item(event: SensedEvent, salience = 0.6, extra: Partial<BufferItem> = {}): BufferItem {
  seq++;
  return {
    id: `b-${String(seq).padStart(8, '0')}`,
    event,
    salience,
    reasons: ['novel'],
    noticedAt: new Date(t).toISOString(),
    touched: [],
    ...extra,
  };
}

const operatorSays = (botId: string, text: string): SensedEvent => ({
  botId,
  channelKind: 'dashboard',
  chatId: 'operator',
  userId: 'operator',
  timestamp: t,
  text,
});

/** A public user's message, already reduced to topic words by tier 0. */
const userSays = (botId: string, text: string): SensedEvent => ({
  botId,
  channelKind: 'web',
  chatId: 'w-anon',
  userId: 'w-anon',
  timestamp: t,
  text,
});

const surprise = (botId: string): SensedEvent =>
  ({
    type: 'curiosity:surprise',
    botId,
    timestamp: t,
    data: { summary: 'the tax deadline moved', surprises: ['tax deadline moved to May'] },
  }) as SensedEvent;

const toolError = (botId: string, cycleId?: string): SensedEvent => ({
  type: 'tool:error',
  botId,
  timestamp: t,
  data: {
    toolName: 'web_fetch',
    error: '403 wiley.com',
    args: { url: 'secret' },
    result: 'private',
    ...(cycleId ? { cycleId } : {}),
  },
});

const usage = {
  model: 'claude-haiku-5-5',
  promptTokens: 300,
  completionTokens: 50,
  totalTokens: 350,
  costUsd: 0.004,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-notice-'));
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Noticer.run', () => {
  test('creates neurons with support, edges and a learned row per neuron', async () => {
    const s = setup({
      reply: async () => ({
        text: JSON.stringify({
          keep: [
            {
              text: 'The Acme invoice is due on Friday',
              kind: 'fact',
              confidence: 'high',
              from: ['b-00000001', 'b-00000002'],
              relatedTo: ['n-unknown', 'INVOICES'],
            },
          ],
          drop: [],
          touched: [],
        }).replace('INVOICES', s.invoices.id),
        usage,
      }),
    });
    s.buffer.push(item(operatorSays('b1', 'The Acme invoice is due on Friday')));
    s.buffer.push(item(toolError('b2', 'cyc-1')));
    const out = await s.noticer.run();
    expect(out.status).toBe('noticed');
    const created = s.graph.list().find((n) => n.text === 'The Acme invoice is due on Friday');
    expect(created).toBeDefined();
    expect(created).toMatchObject({
      kind: 'fact',
      confidence: 'high',
      createdBy: 'watcher',
      support: { bots: ['b1', 'b2'], cycles: ['cyc-1'] },
      meta: { source: 'notice', model: 'claude-haiku-5-5' },
    });
    expect(created?.pos).toHaveLength(3);
    const rels = s.graph.edgesOf(created?.id as string).map((e) => `${e.rel}:${e.to}`);
    expect(rels).toContain(`owned_by:${s.jarvis.id}`);
    expect(rels).toContain(`owned_by:${s.scout.id}`);
    expect(rels).toContain(`related:${s.invoices.id}`);
    expect(rels).toHaveLength(3);
    const learned = s.rows.find((r) => r.op === 'notice:learned');
    expect(learned?.text).toBe(
      'Learned: "The Acme invoice is due on Friday" (fact, confidence high; from Jarvis and Scout).'
    );
    expect(learned?.neuronIds).toEqual([created?.id as string]);
    const pass = s.rows.find((r) => r.op === 'notice:pass');
    expect(pass).toMatchObject({
      phase: 'notice',
      text: 'Noticed 2 events: kept 1, recognised 0, let 0 go.',
      model: 'claude-haiku-5-5',
      tokens: 350,
      costUsd: 0.004,
    });
    expect(typeof pass?.durationMs).toBe('number');
    expect(s.buffer.size()).toBe(0);
    expect(s.entries).toHaveLength(1);
  });

  test('the prompt sees the events and the touched neurons, never tool args or results', async () => {
    const s = setup();
    s.buffer.push(item(toolError('b2'), 0.6, { touched: [s.invoices.id] }));
    await s.noticer.run();
    expect(s.prompts[0]).toContain('web_fetch failed in Scout');
    expect(s.prompts[0]).toContain(`[${s.invoices.id}] topic: Invoices and payments`);
    expect(s.prompts[0]).not.toContain('secret');
    expect(s.prompts[0]).not.toContain('private');
  });

  test('a duplicate text activates the existing neuron instead of creating one', async () => {
    const s = setup({
      reply: async () => ({
        text: JSON.stringify({
          keep: [{ text: 'invoices and payments', kind: 'topic', from: ['b-00000003'] }],
        }),
      }),
    });
    seq = 2;
    s.buffer.push(item(operatorSays('b1', 'invoices')));
    const before = s.graph.size();
    const out = await s.noticer.run();
    expect(s.graph.size()).toBe(before);
    expect(s.graph.get(s.invoices.id)?.activations).toBe(1);
    expect(out).toMatchObject({ status: 'noticed' });
    const row = s.rows.find((r) => r.op === 'notice:recognised');
    expect(row?.text).toBe('Recognised again: "Invoices and payments" (1 activation).');
    expect(s.rows.find((r) => r.op === 'notice:pass')?.text).toBe(
      'Noticed 1 event: kept 0, recognised 1, let 0 go.'
    );
  });

  test('an embedding match merges too when the text differs', async () => {
    const vec = [1, 0, 0];
    const s = setup({
      embed: async () => vec,
      reply: async () => ({
        text: JSON.stringify({
          keep: [{ text: 'Money owed to suppliers', kind: 'topic', from: ['b-00000001'] }],
        }),
      }),
    });
    seq = 0;
    s.graph.setEmbedding(s.invoices.id, vec);
    s.buffer.push(item(operatorSays('b1', 'suppliers')));
    const before = s.graph.size();
    await s.noticer.run();
    expect(s.graph.size()).toBe(before);
    expect(s.graph.get(s.invoices.id)?.activations).toBe(1);
  });

  test('a new neuron keeps its embedding', async () => {
    const s = setup({
      embed: async () => [0, 1, 0],
      reply: async () => ({
        text: JSON.stringify({
          keep: [{ text: 'Boiler service is in May', kind: 'fact', from: ['b-00000001'] }],
        }),
      }),
    });
    seq = 0;
    s.buffer.push(item(operatorSays('b1', 'Boiler service is in May')));
    await s.noticer.run();
    const n = s.graph.list().find((x) => x.text === 'Boiler service is in May');
    expect(s.graph.getEmbedding(n?.id as string)).toEqual([0, 1, 0]);
  });

  test('an empty keep logs the "nothing worth keeping" row and drains the buffer', async () => {
    const s = setup({ reply: async () => ({ text: '{"keep":[],"drop":["b-00000001"]}', usage }) });
    seq = 0;
    s.buffer.push(item(toolError('b1')));
    const out = await s.noticer.run();
    expect(out.status).toBe('noticed');
    const rows = s.rows.filter((r) => r.phase === 'notice');
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('Noticed 1 event; nothing worth keeping.');
    expect(s.buffer.size()).toBe(0);
  });

  test('unparsable output logs an error row and keeps the buffer', async () => {
    const s = setup({ reply: async () => ({ text: 'Sure! Here are my thoughts.', usage }) });
    s.buffer.push(item(toolError('b1')));
    const out = await s.noticer.run();
    expect(out.status).toBe('unparsable');
    const row = s.rows.find((r) => r.phase === 'notice');
    expect(row).toMatchObject({
      op: 'notice:failed',
      text: "Could not read the model's answer as JSON. I kept the 1 event for the next pass.",
      tokens: 350,
      costUsd: 0.004,
    });
    expect(row?.text).not.toContain('Sure!');
    expect(s.buffer.size()).toBe(1);
  });

  test('a failing call logs a failed row and keeps the buffer', async () => {
    const s = setup({
      reply: async () => {
        throw new Error('spawn claude ENOENT');
      },
    });
    s.buffer.push(item(toolError('b1')));
    const out = await s.noticer.run();
    expect(out.status).toBe('failed');
    expect(s.rows.find((r) => r.phase === 'notice')?.text).toBe(
      'Could not notice: the model call failed ("spawn claude ENOENT"). I kept the 1 event for the next pass.'
    );
    expect(s.buffer.size()).toBe(1);
  });

  test('an exhausted budget logs once a day and skips the call', async () => {
    const s = setup({ maxPerDay: 0 });
    s.buffer.push(item(toolError('b1')));
    expect((await s.noticer.run()).status).toBe('capped');
    expect((await s.noticer.run()).status).toBe('capped');
    const rows = s.rows.filter((r) => r.phase === 'notice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: 'notice:capped',
      text: "Reached today's noticing budget (0 calls). I keep sensing and will notice again tomorrow.",
    });
    expect(s.prompts).toHaveLength(0);
    expect(s.buffer.size()).toBe(1);
  });

  test('an open breaker pauses noticing with one row until a call goes through', async () => {
    const s = setup({ open: true });
    s.buffer.push(item(toolError('b1')));
    expect((await s.noticer.run()).status).toBe('breaker');
    expect((await s.noticer.run()).status).toBe('breaker');
    const rows = s.rows.filter((r) => r.op === 'notice:paused');
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe(
      'Claude CLI is rate-limited across the fleet (circuit open). Noticing is paused until it recovers.'
    );
    expect(s.prompts).toHaveLength(0);
  });

  test('nothing salient: no call and no row', async () => {
    const s = setup();
    s.buffer.push(item(toolError('b1'), 0.1));
    expect((await s.noticer.run()).status).toBe('idle');
    expect(s.prompts).toHaveLength(0);
    expect(s.rows.filter((r) => r.phase === 'notice')).toHaveLength(0);
  });

  test('a fact from a non-operator message is kept only as a topic', async () => {
    const s = setup({
      reply: async () => ({
        text: JSON.stringify({
          keep: [{ text: 'Card number and street', kind: 'fact', from: ['b-00000001'] }],
        }),
      }),
    });
    seq = 0;
    s.buffer.push(
      item({
        botId: 'b1',
        channelKind: 'web',
        chatId: 'c1',
        timestamp: t,
        text: 'card number street',
      })
    );
    await s.noticer.run();
    const n = s.graph.list().find((x) => x.text === 'Card number and street');
    expect(n?.kind).toBe('topic');
  });

  test('the prompt marks operator items and not the others', async () => {
    const s = setup();
    s.buffer.push(item(operatorSays('b1', 'Pay Acme'), 0.6, { fromOperator: true }));
    s.buffer.push(
      item({ botId: 'b1', channelKind: 'web', chatId: 'c1', timestamp: t, text: 'pizza order' })
    );
    await s.noticer.run();
    const lines = s.prompts[0].split('\n').filter((l) => l.startsWith('- [b-'));
    expect(lines[0]).toContain('from the operator');
    expect(lines[1]).not.toContain('from the operator');
  });

  test('entries without a known supporting event or with a bad kind are skipped', async () => {
    const s = setup({
      reply: async () => ({
        text: JSON.stringify({
          keep: [
            { text: 'Nobody said this', kind: 'fact', from: ['b-nope'] },
            { text: 'A grand insight', kind: 'insight', from: ['b-00000001'] },
            { text: '', kind: 'fact', from: ['b-00000001'] },
          ],
        }),
      }),
    });
    seq = 0;
    s.buffer.push(item(toolError('b1')));
    const before = s.graph.size();
    await s.noticer.run();
    expect(s.graph.size()).toBe(before);
  });

  test('touched ids the model names are activated once, unknown ones ignored', async () => {
    const s = setup({
      reply: async () => ({
        text: JSON.stringify({ keep: [], touched: [s.invoices.id, 'n-nope'] }),
      }),
    });
    s.buffer.push(item(toolError('b1')));
    await s.noticer.run();
    expect(s.graph.get(s.invoices.id)?.activations).toBe(1);
  });

  test('a second run while one is in flight shares it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = setup({
      reply: async () => {
        await gate;
        return { text: '{"keep":[]}' };
      },
    });
    s.buffer.push(item(toolError('b1')));
    const a = s.noticer.run();
    const b = s.noticer.run();
    release();
    await Promise.all([a, b]);
    expect(s.prompts).toHaveLength(1);
  });
});

// Changed deliberately on 2026-10-24 (O2, docs/plans/watcher-optimizations-plan.md):
// the pass used to be due every `notice.everyMs` (5 min) with anything
// salient, or early at NOTICE_EARLY_FACTOR × the bar. It now wakes on
// salience (`notice.wakeSalience`, an operator message at once) or when the
// oldest salient item waited `notice.maxWaitMs`; the 5-min cadence is gone.
describe('Noticer.wake / due', () => {
  test('one salient item waits for the age ceiling, not a 5-min cadence', () => {
    const s = setup();
    s.buffer.push(item(toolError('b1'), 0.5));
    t += 300_000;
    expect(s.noticer.wake()).toBeNull();
    expect(s.noticer.due()).toBe(false);
    t += WATCHER_DEFAULTS.notice.maxWaitMs - 300_000;
    expect(s.noticer.wake()).toBe('age');
    expect(s.noticer.due()).toBe(true);
  });

  test('salience adding up to wakeSalience wakes it, but never within the minimum gap', () => {
    const s = setup();
    s.buffer.push(item(toolError('b1'), 0.5));
    s.buffer.push(item(toolError('b2'), 0.5));
    expect(s.noticer.wake()).toBeNull();
    t += NOTICE_MIN_GAP_MS;
    expect(s.noticer.wake()).toBe('salience');
  });

  test('an operator message wakes it after the minimum gap, whatever wakeSalience says', () => {
    const s = setup({ cfg: { wakeSalience: 50 } });
    s.buffer.push(item(operatorSays('b1', 'drop the Acme lead'), 0.7, { fromOperator: true }));
    t += NOTICE_MIN_GAP_MS;
    expect(s.noticer.wake()).toBe('salience');
  });

  test('a raised wake line (the stakes) is honoured', () => {
    const s = setup();
    s.buffer.push(item(toolError('b1'), 0.6));
    s.buffer.push(item(toolError('b2'), 0.6));
    t += NOTICE_MIN_GAP_MS;
    expect(s.noticer.wake()).toBe('salience');
    expect(s.noticer.wake({ wakeSalience: 2 })).toBeNull();
  });

  test('is never due with nothing salient', () => {
    const s = setup();
    t += 10 * 300_000;
    expect(s.noticer.due()).toBe(false);
  });

  test('the pass row records the trigger and the stakes that drove it', async () => {
    const s = setup();
    s.buffer.push(item(toolError('b1')));
    await s.noticer.run({ trigger: 'age', drivenBy: ['noticeBudgetPressure'] });
    const row = s.rows.find((r) => r.op === 'notice:pass');
    expect(row?.trigger).toBe('age');
    expect(row?.drivenBy).toEqual(['noticeBudgetPressure']);
  });

  test('a pass without a trigger is manual', async () => {
    const s = setup();
    s.buffer.push(item(toolError('b1')));
    await s.noticer.run();
    expect(s.rows.find((r) => r.op === 'notice:pass')?.trigger).toBe('manual');
  });
});

describe('parseNoticeOutput', () => {
  test('reads fenced JSON and fills missing lists', () => {
    expect(parseNoticeOutput('```json\n{"keep":[{"text":"a","kind":"fact"}]}\n```', quiet)).toEqual(
      {
        keep: [{ text: 'a', kind: 'fact' }],
        drop: [],
        touched: [],
      }
    );
  });

  test('null on prose or a missing keep list', () => {
    expect(parseNoticeOutput('nothing to say', quiet)).toBeNull();
    expect(parseNoticeOutput('{"drop":[]}', quiet)).toBeNull();
  });
});

describe('noticeItems', () => {
  test('renders bot name, what, a whitelisted detail and the operator flag', () => {
    const rows = noticeItems(
      [item(toolError('b2')), item(operatorSays('b1', 'hi there'), 0.5, { fromOperator: true })],
      (id) => (id === 'b2' ? 'Scout' : 'Jarvis')
    );
    expect(rows[0]).toMatchObject({
      botId: 'b2',
      bot: 'Scout',
      what: 'web_fetch failed in Scout',
      fromOperator: false,
    });
    expect(rows[0].detail).toContain('error: 403 wiley.com');
    expect(rows[0].detail).not.toContain('secret');
    expect(rows[1]).toMatchObject({
      fromOperator: true,
      what: 'the operator wrote to Jarvis about hi there',
    });
  });
});

describe('Noticer provenance (phase 3)', () => {
  const keepOf =
    (text: string, from: string[], kind = 'fact') =>
    async () => ({ text: JSON.stringify({ keep: [{ text, kind, from }] }) });

  test('a neuron an operator message supports is marked operatorSourced', async () => {
    const op = item(operatorSays('b1', 'My daughter starts school on Monday'), 0.9, {
      fromOperator: true,
    });
    const s = setup({ reply: keepOf('The operator daughter starts school on Monday', [op.id]) });
    s.buffer.push(op);
    const out = await s.noticer.run();
    expect(out.status).toBe('noticed');
    const n = (out as { created: Array<{ meta?: Record<string, string> }> }).created[0];
    expect(n.meta?.operatorSourced).toBe('true');
  });

  // What the operator's bots work on (cycles, tools, surprises, goals) is
  // operator material: only the operator may read it back.
  test('a neuron bot activity supports is operatorSourced', async () => {
    const e = item(toolError('b1', 'c-1'));
    const s = setup({ reply: keepOf('wiley.com blocks the fetcher', [e.id], 'pattern') });
    s.buffer.push(e);
    const out = await s.noticer.run();
    const n = (out as { created: Array<{ meta?: Record<string, string> }> }).created[0];
    expect(n.meta?.operatorSourced).toBe('true');
  });

  test('a neuron a curiosity surprise supports is operatorSourced', async () => {
    const e = item(surprise('b1'));
    const s = setup({ reply: keepOf('Jarvis learned the tax deadline moved', [e.id]) });
    s.buffer.push(e);
    const out = await s.noticer.run();
    const n = (out as { created: Array<{ meta?: Record<string, string> }> }).created[0];
    expect(n.meta?.operatorSourced).toBe('true');
  });

  test('a neuron only non-operator messages support is not operatorSourced', async () => {
    const a = item(userSays('b1', 'weather'));
    const b = item(userSays('b1', 'umbrella'));
    const s = setup({ reply: keepOf('Users of Jarvis ask about the weather', [a.id, b.id]) });
    s.buffer.push(a);
    s.buffer.push(b);
    const out = await s.noticer.run();
    const n = (out as { created: Array<{ meta?: Record<string, string> }> }).created[0];
    expect(n.meta?.operatorSourced).toBeUndefined();
  });

  // The prompt shows the full text of every touched neuron: if one of them is
  // operator material, what the model writes may restate it.
  test('an operator-sourced touched neuron shown in the prompt marks what is created', async () => {
    const a = item(userSays('b1', 'invoices'));
    const s = setup({ reply: keepOf('Users of Jarvis ask about invoices', [a.id], 'topic') });
    s.graph.patchMeta(s.invoices.id, { operatorSourced: 'true' });
    a.touched = [s.invoices.id];
    s.buffer.push(a);
    const out = await s.noticer.run();
    const n = (out as { created: Array<{ meta?: Record<string, string> }> }).created[0];
    expect(n.meta?.operatorSourced).toBe('true');
  });

  test('a touched neuron that is not operator-sourced does not mark it', async () => {
    const a = item(userSays('b1', 'invoices'));
    const s = setup({ reply: keepOf('Users of Jarvis ask about invoices', [a.id], 'topic') });
    a.touched = [s.invoices.id];
    s.buffer.push(a);
    const out = await s.noticer.run();
    const n = (out as { created: Array<{ meta?: Record<string, string> }> }).created[0];
    expect(n.meta?.operatorSourced).toBeUndefined();
  });

  test('a user message plus bot activity is operatorSourced', async () => {
    const a = item(userSays('b1', 'weather'));
    const b = item(surprise('b1'));
    const s = setup({ reply: keepOf('Jarvis looks into the weather', [a.id, b.id]) });
    s.buffer.push(a);
    s.buffer.push(b);
    const out = await s.noticer.run();
    const n = (out as { created: Array<{ meta?: Record<string, string> }> }).created[0];
    expect(n.meta?.operatorSourced).toBe('true');
  });

  test('fleet_memory_search never shows an anonymous caller what a surprise taught', async () => {
    const e = item(surprise('b1'));
    const s = setup({ reply: keepOf('Jarvis learned the tax deadline moved to May', [e.id]) });
    s.buffer.push(e);
    expect((await s.noticer.run()).status).toBe('noticed');
    const tool = createFleetMemorySearchTool(() => ({ graph: s.graph }));
    const query = { query: 'tax deadline moved', _botId: 'b1' };
    const anon = await tool.execute(
      { ...query, _requester: { isOperator: false, channelKind: 'web', address: 'w-anon' } },
      quiet as never
    );
    expect(anon.content).not.toContain('tax deadline');
    const op = await tool.execute({ ...query, _actor: 'operator' }, quiet as never);
    expect(op.content).toContain('tax deadline');
  });

  test('records the earliest supporting event time as eventAt (latency to notice)', async () => {
    const early = item({ ...(toolError('b1') as object), timestamp: t - 120_000 } as SensedEvent);
    const late = item(toolError('b1'));
    const s = setup({
      reply: keepOf('wiley.com blocks the fetcher', [late.id, early.id], 'pattern'),
    });
    s.buffer.push(early);
    s.buffer.push(late);
    const out = await s.noticer.run();
    const n = (out as { created: Array<{ meta?: Record<string, string> }> }).created[0];
    expect(n.meta?.eventAt).toBe(new Date(t - 120_000).toISOString());
  });
});
