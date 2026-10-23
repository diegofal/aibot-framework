import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUMAN_INBOUND_HOOK, OPERATOR_MESSAGE_HOOK } from '../../src/bot/agent-loop-utils';
import type { LlmQueryEntry } from '../../src/bot/llm-query-log';
import type { Config } from '../../src/config';
import type { LLMClient } from '../../src/core/llm-client';
import { ProactiveThrottle } from '../../src/tools/send-proactive-message';
import { graphFiles } from '../../src/watcher/paths';
import { WATCHER_DEFAULTS, type WatcherEvent } from '../../src/watcher/types';
import {
  Watcher,
  type WatcherDeps,
  createFleetWatcher,
  deliverWatcherQuestion,
} from '../../src/watcher/watcher';

let root: string;
let t: number;
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

function soul(id: string, name: string) {
  const dir = join(root, 'souls', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `name: ${name}\n`);
  writeFileSync(
    join(dir, 'GOALS.md'),
    '# Goals\n\n## Active\n\n- [ ] Ship it\n  - id: g-aaaaaaaa\n  - status: in_progress\n  - priority: high\n\n## Completed\n'
  );
  return dir;
}

function make(overrides: Partial<WatcherDeps> = {}, watcherCfg: Record<string, unknown> = {}) {
  const config = {
    bots: [{ id: 'b1', name: 'b1', soulDir: soul('b1', 'Jarvis'), enabled: true }],
    paths: { data: join(root, 'data') },
    soul: {},
    operator: { telegramChatId: 42 },
    watcher: { ...WATCHER_DEFAULTS, enabled: true, ...watcherCfg },
  } as unknown as Config;
  const activityStream = new EventEmitter();
  const hooks = new EventEmitter();
  const directory = {
    list: () => [],
    findByChannel: () => undefined,
  };
  const deps: WatcherDeps = {
    config: () => config,
    logger: noopLogger,
    activityStream,
    hooks,
    botManager: {
      getChannelState: () => ({ kind: 'telegram', state: 'ok', lastError: null, checkedAt: null }),
      getUserDirectory: () => directory as never,
    },
    now: () => t,
    ...overrides,
  };
  const watcher = new Watcher(deps);
  const events: WatcherEvent[] = [];
  watcher.on('event', (e: WatcherEvent) => events.push(e));
  return { watcher, events, config, activityStream, hooks };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watcher-w-'));
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Watcher', () => {
  test('start() without state writes the wake row, returns, then is born in the background', async () => {
    const { watcher, events } = make();
    const state = await watcher.start();
    expect(state.running).toBe(true);
    expect(state.phase).toBe('birth');
    expect(watcher.log.recent(10).at(-1)?.op).toBe('birth:wake');
    await watcher.idle();
    const after = watcher.state();
    expect(after.bornAt).toBe('2026-10-23T10:00:00.000Z');
    expect(after.phase).toBe('sense');
    expect(after.counts.entity).toBe(1);
    expect(after.counts.goal).toBe(1);
    expect(after.linkStatus).toBe('no-embeddings');
    const types = new Set(events.map((e) => e.type));
    for (const type of ['watcher:log', 'watcher:neuron', 'watcher:edge', 'watcher:state'])
      expect(types.has(type as WatcherEvent['type'])).toBe(true);
    const neuronEvent = events.find((e) => e.type === 'watcher:neuron');
    expect(JSON.stringify(neuronEvent)).not.toContain('embedding');
    await watcher.stop();
  });

  // Birth publishes neurons before the layout; a connected page must get the
  // final positions, not keep the fallback shell ones.
  test('birth publishes the final layout of the neurons it published', async () => {
    const { watcher, events } = make();
    await watcher.start();
    await watcher.idle();
    const layouts = events.filter((e) => e.type === 'watcher:layout');
    expect(layouts.length).toBeGreaterThan(0);
    const last = layouts.at(-1)?.data as { positions: Record<string, number[]> };
    for (const n of watcher.graph.list()) expect(last.positions[n.id]).toEqual(n.pos as number[]);
    await watcher.stop();
  });

  test('every event is also emitted under its own name', async () => {
    const { watcher } = make();
    const logs: WatcherEvent[] = [];
    watcher.on('watcher:log', (e: WatcherEvent) => logs.push(e));
    await watcher.start();
    expect(logs[0].type).toBe('watcher:log');
    expect(logs[0].ts).toBeDefined();
    await watcher.stop();
  });

  test('start() with state logs the wake row and resyncs a new bot', async () => {
    const first = make();
    await first.watcher.start();
    await first.watcher.idle();
    t += 6 * 3_600_000;
    await first.watcher.stop();
    t += 1000;
    const second = make();
    second.config.bots.push({
      id: 'b2',
      name: 'b2',
      soulDir: soul('b2', 'Scout'),
      enabled: true,
    } as never);
    await second.watcher.start();
    const wake = second.watcher.log.recent(50).find((r) => r.op === 'wake');
    expect(wake?.text).toBe('Waking up. 2 neurons, last awake less than a minute ago.');
    await second.watcher.idle();
    expect(second.watcher.state().counts.entity).toBe(2);
    expect(second.watcher.log.recent(1)[0].text).toBe(
      'Caught up on what changed while I slept: 1 new bot, 1 new goal, 0 new people.'
    );
    await second.watcher.stop();
  });

  test('start() on an unfinished birth resumes it', async () => {
    const first = make();
    await first.watcher.start();
    await first.watcher.stop();
    const second = make();
    await second.watcher.start();
    const rows = second.watcher.log.recent(50);
    await second.watcher.idle();
    expect(second.watcher.state().bornAt).toBeDefined();
    expect(rows.some((r) => r.text.startsWith('Waking up'))).toBe(true);
    await second.watcher.stop();
  });

  test('stop() compacts the graph, persists the buffer and says goodnight', async () => {
    const { watcher, activityStream } = make();
    await watcher.start();
    await watcher.idle();
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    const state = await watcher.stop();
    expect(state.running).toBe(false);
    expect(state.phase).toBe('sleep');
    const dir = join(root, 'data', 'watcher');
    expect(existsSync(graphFiles(dir).graph)).toBe(true);
    expect(existsSync(join(dir, 'buffer.json'))).toBe(true);
    expect(watcher.log.recent(1)[0].text).toBe('Going to sleep. 2 neurons.');
  });

  test('after start the watcher senses the fleet; after stop it does not', async () => {
    const { watcher, activityStream } = make();
    await watcher.start();
    await watcher.idle();
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    expect(watcher.buffer.size()).toBe(1);
    expect(watcher.state().lastTickAt).toBe('2026-10-23T10:00:00.000Z');
    await watcher.stop();
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    expect(watcher.buffer.size()).toBe(1);
  });

  // Telegram never emits a human_inbound (the operator's private chat arrives on
  // operator_message): one claiming the operator's chat id is not the operator.
  test('a human_inbound is never the operator, even on the operator chat id', async () => {
    const { watcher, hooks } = make();
    await watcher.start();
    await watcher.idle();
    hooks.emit(HUMAN_INBOUND_HOOK, {
      botId: 'b1',
      channelKind: 'telegram',
      chatId: '42',
      timestamp: t,
      text: 'Pay the Acme invoice',
    });
    hooks.emit(HUMAN_INBOUND_HOOK, {
      botId: 'b1',
      channelKind: 'web',
      chatId: 'w',
      timestamp: t,
      text: 'Pay the Acme invoice',
    });
    const items = watcher.buffer.items();
    expect(items.map((i) => (i.event as { text?: string }).text)).toEqual([
      'acme invoice',
      'acme invoice',
    ]);
    expect(items.every((i) => i.fromOperator === undefined)).toBe(true);
    await watcher.stop();
  });

  test('a throwing stage ends in a log row and lastError, not an exception', async () => {
    const { watcher } = make({
      botManager: {
        getChannelState: () => undefined,
        getUserDirectory: () =>
          ({
            list: () => {
              throw new Error('directory broke');
            },
            findByChannel: () => undefined,
          }) as never,
      },
    });
    await expect(watcher.start()).resolves.toBeDefined();
    await watcher.idle();
    expect(watcher.state().lastError).toBe(
      'Could not finish birth:people (directory broke). Moving on.'
    );
    expect(watcher.state().bornAt).toBeDefined();
    await watcher.stop();
  });

  test('start() twice is a no-op and stop() when stopped returns the state', async () => {
    const { watcher } = make();
    expect((await watcher.stop()).running).toBe(false);
    await watcher.start();
    await watcher.start();
    expect(watcher.log.recent(50).filter((r) => r.op === 'birth:wake')).toHaveLength(1);
    await watcher.stop();
  });

  test('readBirth returns the birth record', async () => {
    const { watcher } = make();
    expect(watcher.readBirth()).toBeNull();
    await watcher.start();
    await watcher.idle();
    expect(watcher.readBirth()?.finishedAt).toBeDefined();
    await watcher.stop();
  });
});

function noticeClient(reply: string | (() => string)) {
  const prompts: string[] = [];
  const client = {
    backend: 'claude-cli',
    generate: async () => ({ text: '' }),
    chat: async (messages: Array<{ content: string }>) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return {
        text: typeof reply === 'string' ? reply : reply(),
        usage: {
          model: 'claude-haiku-5-5',
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        },
      };
    },
  } as unknown as LLMClient;
  return { client, prompts };
}

const noticeOn = { notice: { ...WATCHER_DEFAULTS.notice, enabled: true } };

describe('Watcher noticing (phase 2)', () => {
  test('the notice timer starts only after birth, and only when notice is enabled', async () => {
    const { client } = noticeClient('{"keep":[]}');
    const llm = { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' as const } };
    const on = make({ llm }, noticeOn);
    await on.watcher.start();
    expect(on.watcher.noticing).toBe(false);
    await on.watcher.idle();
    expect(on.watcher.noticing).toBe(true);
    await on.watcher.stop();
    expect(on.watcher.noticing).toBe(false);

    const off = make({ llm });
    await off.watcher.start();
    await off.watcher.idle();
    expect(off.watcher.noticing).toBe(false);
    expect(await off.watcher.noticeNow()).toBeNull();
    await off.watcher.stop();
  });

  test('an operator message becomes a watcher neuron, logged under __watcher__', async () => {
    let firstId = '';
    const { client, prompts } = noticeClient(() =>
      JSON.stringify({
        keep: [
          {
            text: 'The boiler is serviced in May',
            kind: 'fact',
            confidence: 'high',
            from: [firstId],
          },
        ],
      })
    );
    const entries: LlmQueryEntry[] = [];
    const { watcher, hooks, events } = make(
      {
        llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } },
        queryLog: { append: (e) => entries.push(e) },
      },
      noticeOn
    );
    await watcher.start();
    await watcher.idle();
    hooks.emit(OPERATOR_MESSAGE_HOOK, {
      botId: 'b1',
      channelKind: 'dashboard',
      timestamp: t,
      text: 'The boiler is serviced in May',
    });
    const first = watcher.buffer.items()[0];
    expect(first.fromOperator).toBe(true);
    firstId = first.id;
    const out = await watcher.noticeNow();
    expect(out?.status).toBe('noticed');
    expect(prompts[0]).toContain('from the operator');
    const n = watcher.graph.list().find((x) => x.text === 'The boiler is serviced in May');
    expect(n).toMatchObject({ kind: 'fact', createdBy: 'watcher', support: { bots: ['b1'] } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ botId: '__watcher__', caller: 'watcher:notice' });
    expect(watcher.budget.used('notice').calls).toBe(1);
    expect(
      events.some((e) => e.type === 'watcher:neuron' && (e.data as { id: string }).id === n?.id)
    ).toBe(true);
    expect(watcher.state().phase).toBe('sense');
    await watcher.stop();
  });

  test('an open fleet breaker stops the call before it is made', async () => {
    const { client, prompts } = noticeClient('{"keep":[]}');
    const { watcher, activityStream } = make(
      {
        llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } },
        breaker: { isOpen: () => true, recordFailure: () => ({}), recordSuccess: () => {} },
      },
      noticeOn
    );
    await watcher.start();
    await watcher.idle();
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    activityStream.emit('activity', { type: 'worker:waiting', botId: 'b1', timestamp: t });
    expect((await watcher.noticeNow())?.status).toBe('breaker');
    expect(prompts).toHaveLength(0);
    await watcher.stop();
  });

  // Changed in phase 3 (privacy decision): no genuine dashboard surface emits a
  // `human_inbound` (threads emit `operator_message`; every channel adapter
  // stamps its own kind), so a `human_inbound` claiming `dashboard` is not trusted.
  test('a human_inbound that claims the dashboard channel is not the operator', async () => {
    const { watcher, hooks } = make();
    await watcher.start();
    await watcher.idle();
    hooks.emit(HUMAN_INBOUND_HOOK, {
      botId: 'b1',
      channelKind: 'dashboard',
      chatId: 'x',
      timestamp: t,
      text: 'Pay the Acme invoice',
    });
    expect(watcher.buffer.items()[0].fromOperator).toBeUndefined();
    expect(watcher.buffer.items()[0].event).not.toHaveProperty('text', 'Pay the Acme invoice');
    await watcher.stop();
  });

  test('fleetMemory() is the graph while running, undefined when stopped', async () => {
    const { watcher } = make();
    expect(watcher.fleetMemory()).toBeUndefined();
    await watcher.start();
    expect(watcher.fleetMemory()?.graph).toBe(watcher.graph);
    await watcher.stop();
    expect(watcher.fleetMemory()).toBeUndefined();
  });
});

describe('createFleetWatcher', () => {
  const manager = (embedCalls: string[]) => ({
    getActivityStream: () => new EventEmitter() as never,
    getHooks: () => new EventEmitter() as never,
    getChannelState: () => undefined,
    getUserDirectory: () => ({ list: () => [], findByChannel: () => undefined }) as never,
    getOllamaClient: () =>
      ({
        embed: async (text: string, model: string) => {
          embedCalls.push(`${model}:${text}`);
          return { embedding: [1, 2], model };
        },
      }) as never,
  });

  test('nothing when the watcher is off', () => {
    const config = { paths: { data: root }, watcher: WATCHER_DEFAULTS } as unknown as Config;
    expect(createFleetWatcher(config, noopLogger, manager([]))).toBeUndefined();
  });

  test('a watcher when on, embedding through the shared Ollama client', async () => {
    const calls: string[] = [];
    const config = {
      bots: [],
      paths: { data: root },
      soul: { search: { embeddingModel: 'nomic' } },
      watcher: { ...WATCHER_DEFAULTS, enabled: true },
    } as unknown as Config;
    const w = createFleetWatcher(config, noopLogger, manager(calls));
    expect(w).toBeInstanceOf(Watcher);
    expect(await (w as unknown as { deps: WatcherDeps }).deps.embed?.('hi')).toEqual([1, 2]);
    expect(calls).toEqual(['nomic:hi']);
  });

  test('wires the notice client, query log, breaker and fleet_memory_search', async () => {
    const config = {
      bots: [],
      paths: { data: root },
      soul: {},
      agentLoop: { claudeTimeout: 1000 },
      watcher: { ...WATCHER_DEFAULTS, enabled: true },
    } as unknown as Config;
    const breaker = { isOpen: () => false, recordFailure: () => ({}), recordSuccess: () => {} };
    const queryLog = { append: () => {} };
    let source: (() => unknown) | undefined;
    const w = createFleetWatcher(config, noopLogger, {
      ...manager([]),
      getCircuitBreaker: () => breaker,
      getLlmQueryLog: () => queryLog,
      getToolRegistry: () => ({
        setFleetMemory: (s: () => unknown) => {
          source = s;
        },
      }),
    }) as Watcher;
    const deps = (w as unknown as { deps: WatcherDeps }).deps;
    expect(deps.llm?.notice?.model).toBe('claude-haiku-5-5');
    expect(deps.llm?.integrate?.model).toBe('claude-opus-5-5');
    expect(deps.breaker).toBe(breaker);
    expect(deps.queryLog).toBe(queryLog);
    expect(source).toBeDefined();
    expect(source?.()).toBeUndefined();
    await w.start();
    expect((source?.() as { graph: unknown }).graph).toBe(w.graph);
    await w.stop();
  });

  test('no embed without an embedding model', () => {
    const config = {
      bots: [],
      paths: { data: root },
      soul: { search: { embeddingModel: '' } },
      watcher: { ...WATCHER_DEFAULTS, enabled: true },
    } as unknown as Config;
    const w = createFleetWatcher(config, noopLogger, manager([]));
    expect((w as unknown as { deps: WatcherDeps }).deps.embed).toBeUndefined();
  });
});

// ── phase 3: integration, broadcasts, signals ──

function integrateClient(reply: () => string) {
  const prompts: string[] = [];
  const client = {
    backend: 'claude-cli',
    generate: async () => ({ text: '' }),
    chat: async (messages: Array<{ content: string }>) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return {
        text: reply(),
        usage: {
          model: 'claude-opus-5-5',
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          costUsd: 0.05,
        },
      };
    },
  } as unknown as LLMClient;
  return { client, prompts };
}

const integrateOn = { integrate: { ...WATCHER_DEFAULTS.integrate, enabled: true } };

describe('Watcher integration (phase 3)', () => {
  function withIntegrate(reply: (w: Watcher) => string, extra: Partial<WatcherDeps> = {}) {
    const ref: { w?: Watcher } = {};
    const { client, prompts } = integrateClient(() => reply(ref.w as Watcher));
    const woke: string[] = [];
    const m = make(
      {
        llm: { integrate: { client, model: 'claude-opus-5-5', backend: 'claude-cli' } },
        broadcastDelivery: {
          wake: (b) => {
            woke.push(b);
          },
        },
        ...extra,
      },
      integrateOn
    );
    ref.w = m.watcher;
    return { ...m, prompts, woke };
  }
  const goalId = (w: Watcher) => w.graph.list().find((n) => n.kind === 'goal')?.id as string;
  const answer = (w: Watcher) =>
    JSON.stringify({
      insights: [{ text: 'Jarvis keeps failing on the same fetch', support: [goalId(w)] }],
      broadcasts: [{ bot: 'b1', kind: 'wake', text: '', insightIndex: 0 }],
      attending: [goalId(w)],
    });

  test('the integrate timer starts after birth and only with integrate enabled', async () => {
    const on = withIntegrate(answer);
    await on.watcher.start();
    expect(on.watcher.integrating).toBe(false);
    await on.watcher.idle();
    expect(on.watcher.integrating).toBe(true);
    await on.watcher.stop();
    expect(on.watcher.integrating).toBe(false);

    const { client } = integrateClient(() => '{}');
    const off = make({ llm: { integrate: { client, model: 'm', backend: 'claude-cli' } } });
    await off.watcher.start();
    await off.watcher.idle();
    expect(off.watcher.integrating).toBe(false);
    expect(await off.watcher.integrateNow()).toBeNull();
    await off.watcher.stop();
  });

  test('sensed events accumulate; integrateNow writes the insight, wakes the bot, stores attending', async () => {
    const s = withIntegrate(answer);
    await s.watcher.start();
    await s.watcher.idle();
    s.activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    const out = await s.watcher.integrateNow();
    expect(out?.status).toBe('integrated');
    expect(s.prompts[0]).toContain('## What happened since my last thought');
    expect(s.watcher.graph.list().some((n) => n.kind === 'insight')).toBe(true);
    expect(s.woke).toEqual(['b1']);
    expect(s.watcher.state().attending).toEqual([goalId(s.watcher)]);
    expect(s.watcher.state().phase).toBe('sense');
    expect(s.watcher.budget.used('integrate').calls).toBe(1);
    await s.watcher.stop();
  });

  // Integration reads fleet-wide goals and knowledge: none of it may reach a
  // tenant bot as a directive, goal, question or wake.
  test('tenant bots are never in the bot list nor broadcast targets', async () => {
    const tenantAnswer = (w: Watcher) =>
      JSON.stringify({
        insights: [{ text: 'Jarvis keeps failing on the same fetch', support: [goalId(w)] }],
        broadcasts: [
          { bot: 't1', kind: 'wake', text: '', insightIndex: 0 },
          { bot: 'b1', kind: 'wake', text: '', insightIndex: 0 },
        ],
        attending: [],
      });
    const s = withIntegrate(tenantAnswer);
    const cfg = s.config as unknown as {
      bots: Array<Record<string, unknown>>;
      multiTenant?: { enabled: boolean };
    };
    cfg.bots.push({
      id: 't1',
      name: 't1',
      soulDir: soul('t1', 'Acme'),
      enabled: true,
      tenantId: 'acme',
    });
    cfg.multiTenant = { enabled: true };
    await s.watcher.start();
    await s.watcher.idle();
    s.activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    await s.watcher.integrateNow();
    expect(s.prompts[0]).toContain('- b1: ');
    expect(s.prompts[0]).not.toContain('- t1: ');
    expect(s.woke).toEqual(['b1']);
    expect(s.watcher.broadcaster.list().map((b) => b.botId)).toEqual(['b1']);
    await s.watcher.stop();
  });

  test('broadcasts: delivered ones are pending for the planner', async () => {
    const s = withIntegrate(answer);
    await s.watcher.start();
    await s.watcher.idle();
    s.activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    await s.watcher.integrateNow();
    const pending = s.watcher.broadcaster.pendingFor('b1');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'wake', botId: 'b1' });
    await s.watcher.stop();
  });

  test('signalNeuron stores 👍/👎 on insights and keeps taste.json counts', async () => {
    const s = withIntegrate(answer);
    await s.watcher.start();
    await s.watcher.idle();
    s.activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    await s.watcher.integrateNow();
    const insight = s.watcher.graph.list().find((n) => n.kind === 'insight') as { id: string };
    expect(s.watcher.signalNeuron(insight.id, 'up')?.meta?.signal).toBe('up');
    expect(s.watcher.signalNeuron(goalId(s.watcher), 'up')).toBeUndefined();
    expect(s.watcher.signalNeuron('n-nope', 'down')).toBeUndefined();
    const b = s.watcher.broadcaster.list()[0];
    expect(s.watcher.signalBroadcast(b.id, 'down')?.signal).toBe('down');
    expect(s.watcher.taste()).toMatchObject({
      neurons: { insight: { up: 1, down: 0 } },
      broadcasts: { wake: { up: 0, down: 1 } },
    });
    expect(existsSync(join(root, 'data', 'watcher', 'taste.json'))).toBe(true);
    await s.watcher.stop();
  });

  test('a served cycle row marks the broadcast served on the outcomes pass', async () => {
    const s = withIntegrate(answer, {
      readCycles: (botId) =>
        botId === 'b1'
          ? [
              {
                cycleId: 'c-9',
                botId: 'b1',
                startedAt: new Date(t + 1000).toISOString(),
                endedAt: new Date(t + 2000).toISOString(),
                status: 'completed',
                servesBroadcast: s2().watcher.broadcaster.list()[0]?.id,
              } as never,
            ]
          : [],
    });
    const s2 = () => s;
    await s.watcher.start();
    await s.watcher.idle();
    s.activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    await s.watcher.integrateNow();
    t += 5000;
    await s.watcher.outcomesNow();
    expect(s.watcher.broadcaster.list()[0].servedByCycle).toBe('c-9');
    await s.watcher.stop();
  });
});

describe('createFleetWatcher broadcasts wiring (phase 3)', () => {
  test('publishes the broadcaster to the bot manager and wires the four entry points', async () => {
    const config = {
      bots: [{ id: 'b1', name: 'b1', soulDir: soul('b1', 'Jarvis'), enabled: true }],
      paths: { data: join(root, 'data') },
      soul: {},
      operator: { telegramChatId: 42 },
      watcher: { ...WATCHER_DEFAULTS, enabled: true },
    } as unknown as Config;
    const calls: string[] = [];
    let published: unknown;
    const w = createFleetWatcher(config, noopLogger, {
      getActivityStream: () => new EventEmitter() as never,
      getHooks: () => new EventEmitter() as never,
      getChannelState: () => undefined,
      getUserDirectory: () => ({ list: () => [], findByChannel: () => undefined }) as never,
      getOllamaClient: () => ({ embed: async () => ({ embedding: [1] }) }) as never,
      requestImmediateAgentRun: (botId, opts) => {
        calls.push(`wake:${botId}:${opts?.feedback}`);
      },
      getCuriosityService: () => ({
        recordDirective: (botId: string, text: string, source: string) => {
          calls.push(`directive:${botId}:${text}:${source}`);
        },
      }),
      // A question goes out through the shared throttle and the bot's route, never its executor.
      getToolRegistry: () => ({
        setFleetMemory: () => {},
        getProactiveThrottle: () => ({ check: () => ({ allowed: true }), record: () => {} }),
      }),
      getOperatorTelegramRoute: (botId: string) => ({
        api: {
          sendMessage: async (chatId: number, text: string) => {
            calls.push(`telegram:${botId}:${chatId}:${text}`);
          },
        },
      }),
      setWatcherBroadcasts: (source) => {
        published = source;
      },
    }) as Watcher;
    expect(published).toBe(w.broadcaster);
    const d = (w as unknown as { deps: WatcherDeps }).deps.broadcastDelivery;
    d?.wake?.('b1');
    d?.directive?.('b1', 'Check the lead');
    expect(await d?.question?.('b1', 'Who owns Acme?')).toEqual({
      ok: true,
      detail: 'Message sent to the operator (chat 42)',
    });
    await d?.goal?.('b1', 'Merge the lead lists', 'Two bots chase it');
    expect(calls).toEqual([
      'wake:b1:false',
      'directive:b1:Check the lead:watcher',
      'telegram:b1:42:Fleet watcher: Who owns Acme?',
    ]);
    const goals = require('node:fs').readFileSync(join(root, 'souls', 'b1', 'GOALS.md'), 'utf-8');
    expect(goals).toContain('Merge the lead lists');
    expect(goals).toContain('source: watcher');
  });
});

// ── phase 4: self-model, interoception, introspection ──

describe('Watcher self-model (phase 4)', () => {
  function noticeClient(reply: string) {
    const prompts: string[] = [];
    const client = {
      backend: 'claude-cli',
      generate: async () => ({ text: '' }),
      chat: async (messages: Array<{ content: string }>) => {
        prompts.push(messages.map((m) => m.content).join('\n'));
        return {
          text: reply,
          usage: { model: 'claude-haiku-5-5', totalTokens: 100, costUsd: 0.001 },
        };
      },
    } as unknown as LLMClient;
    return { client, prompts };
  }

  test('interoception reads karma, semaphore, breaker, budget and operator silence', async () => {
    const { watcher, hooks } = make({
      karmaScores: () => [50, 70],
      semaphore: () => ({
        limit: 3,
        active: 1,
        queued: 0,
        queuedByPriority: { interactive: 0, loop: 0, worker: 0, watcher: 0 },
        activeByPriority: { interactive: 0, loop: 0, worker: 0, watcher: 1 },
      }),
      breaker: {
        isOpen: (b) => b === 'claude-cli',
        recordFailure: () => ({}),
        recordSuccess: () => {},
      },
      llm: { notice: { client: noticeClient('{}').client, model: 'm', backend: 'claude-cli' } },
    });
    await watcher.start();
    await watcher.idle();
    expect(watcher.interoception().operatorSilenceHours).toBeNull();
    hooks.emit(OPERATOR_MESSAGE_HOOK, {
      botId: 'b1',
      channelKind: 'telegram',
      timestamp: t,
      text: 'please look at the boiler',
    });
    // Sensing runs right after the publish call (a batch on the next macrotask).
    await new Promise((r) => setImmediate(r));
    t += 2 * 3_600_000;
    const i = watcher.interoception();
    expect(i.fleetKarmaAvg).toBe(60);
    expect(i.breakerOpen).toEqual(['claude-cli']);
    expect(i.semaphore?.activeWatcher).toBe(1);
    expect(i.operatorSilenceHours).toBe(2);
    expect(i.budgetUsedToday).toEqual({ notice: 0, integrate: 0, tokens: 0, usd: 0 });
    await watcher.stop();
  });

  test('attention carries the phase and what the last pass attends to', async () => {
    const { watcher, activityStream } = make();
    await watcher.start();
    await watcher.idle();
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    const att = watcher.attention();
    expect(att.phase).toBe('sense');
    expect(att.items.length).toBeGreaterThan(0);
    expect(att.focusNeuronIds).toEqual([]);
    await watcher.stop();
    expect(watcher.attention().phase).toBe('sleep');
  });

  test('selfStateFor: undefined asleep; awake it has the bot presence, cycle and fleet focus', async () => {
    const { watcher, activityStream } = make({
      runningCycle: (id) => (id === 'b1' ? { cycleId: 'c-1', goalTitle: 'Ship it' } : undefined),
    });
    expect(watcher.selfStateFor('b1')).toBeUndefined();
    await watcher.start();
    await watcher.idle();
    activityStream.emit('activity', {
      type: 'agent:phase',
      botId: 'b1',
      timestamp: t,
      phase: 'executor',
    });
    const s = watcher.selfStateFor('b1');
    expect(s?.presence).toMatchObject({ executing: true, phase: 'executor' });
    expect(s?.cycle).toEqual({ cycleId: 'c-1', goalTitle: 'Ship it' });
    expect(s?.fleetFocus).toEqual([]);
    expect(watcher.selfStateFor('b2')?.cycle).toBeUndefined();
    await watcher.stop();
    expect(watcher.selfStateFor('b1')).toBeUndefined();
  });

  test('a running-cycle reader that throws leaves the cycle out', async () => {
    const { watcher } = make({
      runningCycle: () => {
        throw new Error('down');
      },
    });
    await watcher.start();
    await watcher.idle();
    expect(watcher.selfStateFor('b1')?.cycle).toBeUndefined();
    await watcher.stop();
  });

  test('introspect asks the notice model as watcher:introspect, scores and appends a row', async () => {
    const { client, prompts } = noticeClient(
      JSON.stringify({ phase: 'sense', tool: null, goal: null, cause: null })
    );
    const entries: LlmQueryEntry[] = [];
    const { watcher } = make({
      llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } },
      queryLog: { append: (e) => entries.push(e) },
    });
    await watcher.start();
    await watcher.idle();
    const out = await watcher.introspect('manual');
    expect(out.status).toBe('scored');
    expect(entries.at(-1)).toMatchObject({ botId: '__watcher__', caller: 'watcher:introspect' });
    expect(prompts[0]).toContain('## My recent log');
    expect(watcher.introspection().map((r) => r.subject)).toEqual(['watcher']);
    expect(watcher.log.recent(5).some((r) => r.op === 'introspect')).toBe(true);
    expect(watcher.budget.used('notice').calls).toBe(1);
    await watcher.stop();
  });

  test('introspect is unavailable without a notice client or while asleep', async () => {
    const { watcher } = make();
    expect(await watcher.introspect('manual')).toEqual({
      status: 'unavailable',
      reason: 'The watcher is asleep',
    });
    await watcher.start();
    await watcher.idle();
    expect((await watcher.introspect('manual')).status).toBe('unavailable');
    await watcher.stop();
  });

  test('the daily sampler takes a due sample once, and only with notice enabled', async () => {
    const reply = JSON.stringify({ phase: 'sense', tool: null, goal: null, cause: null });
    const notice = {
      client: noticeClient(reply).client,
      model: 'm',
      backend: 'claude-cli' as const,
    };
    const on = make({ llm: { notice }, random: () => 0 }, noticeOn);
    await on.watcher.start();
    await on.watcher.idle();
    expect(on.watcher.sampleTick()).toBe(true);
    expect(on.watcher.sampleTick()).toBe(false);
    // stop() aborts a sample still in flight: let this one land first.
    await on.watcher.introspect('sample');
    await on.watcher.stop();
    expect(on.watcher.introspection()[0]).toMatchObject({ subject: 'watcher', trigger: 'sample' });

    rmSync(join(root, 'data'), { recursive: true, force: true });
    const off = make({ llm: { notice }, random: () => 0 });
    await off.watcher.start();
    await off.watcher.idle();
    expect(off.watcher.sampleTick()).toBe(false);
    await off.watcher.stop();
  });

  test('the integrate prompt shows How I am and What I am attending to', async () => {
    const { client, prompts } = integrateClient(() => '{"insights":[]}');
    const { watcher, activityStream } = make(
      {
        llm: { integrate: { client, model: 'claude-opus-5-5', backend: 'claude-cli' } },
        karmaScores: () => [40],
      },
      integrateOn
    );
    await watcher.start();
    await watcher.idle();
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    await watcher.integrateNow();
    expect(prompts[0]).toContain('## How I am');
    expect(prompts[0]).toContain('- fleetKarmaAvg: 40');
    expect(prompts[0]).toContain('## What I am attending to');
    expect(prompts[0]).toContain('- phase: integrate');
    await watcher.stop();
  });
});

describe('createFleetWatcher (phase 4)', () => {
  test('publishes the self-state source and wires karma, semaphore and the running cycle', () => {
    const config = {
      bots: [{ id: 'b1', name: 'b1', enabled: true }],
      paths: { data: root },
      soul: {},
      watcher: { ...WATCHER_DEFAULTS, enabled: true },
    } as unknown as Config;
    let published: unknown;
    const w = createFleetWatcher(config, noopLogger, {
      getActivityStream: () => new EventEmitter() as never,
      getHooks: () => new EventEmitter() as never,
      getChannelState: () => undefined,
      getUserDirectory: () => ({ list: () => [], findByChannel: () => undefined }) as never,
      getOllamaClient: () => ({ embed: async () => ({ embedding: [] }) }) as never,
      getKarmaService: () => ({
        getAllScores: (ids: string[]) => ids.map(() => ({ current: 55 })),
      }),
      getRunningCycle: (id: string) => (id === 'b1' ? { cycleId: 'c-9' } : undefined),
      setWatcherSelfState: (s: unknown) => {
        published = s;
      },
    }) as Watcher;
    expect(published).toBe(w);
    const deps = (w as unknown as { deps: WatcherDeps }).deps;
    expect(deps.karmaScores?.()).toEqual([55]);
    expect(deps.runningCycle?.('b1')).toEqual({ cycleId: 'c-9' });
    expect(typeof deps.semaphore?.().limit).toBe('number');
  });
});

describe('Watcher stop (shutdown never hangs on a model call)', () => {
  const settle = () => new Promise((r) => setTimeout(r, 5));

  test('stop aborts an in-flight notice call and still compacts and persists', async () => {
    const signals: AbortSignal[] = [];
    const client = {
      backend: 'claude-cli',
      generate: async () => ({ text: '' }),
      // Never resolves, never listens to the signal: the worst a client can do.
      chat: (_m: unknown, opts?: { signal?: AbortSignal }) => {
        if (opts?.signal) signals.push(opts.signal);
        return new Promise(() => {});
      },
    } as unknown as LLMClient;
    const { watcher, activityStream } = make(
      { llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } } },
      noticeOn
    );
    await watcher.start();
    await watcher.idle();
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    activityStream.emit('activity', { type: 'worker:waiting', botId: 'b1', timestamp: t });
    await settle();
    const pass = watcher.noticeNow();
    await settle();
    expect(signals).toHaveLength(1);
    const started = Date.now();
    const state = await watcher.stop();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signals[0].aborted).toBe(true);
    expect(state.running).toBe(false);
    expect(state.phase).toBe('sleep');
    expect(existsSync(graphFiles(join(root, 'data', 'watcher')).graph)).toBe(true);
    expect(watcher.log.recent(1)[0].op).toBe('sleep');
    expect((await pass)?.status).not.toBe('noticed');
  });

  test('an aborted call does not count as a backend failure', async () => {
    const failures: string[] = [];
    const client = {
      backend: 'claude-cli',
      generate: async () => ({ text: '' }),
      chat: () => new Promise(() => {}),
    } as unknown as LLMClient;
    const { watcher, activityStream } = make(
      {
        llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } },
        breaker: {
          isOpen: () => false,
          recordFailure: (b) => {
            failures.push(b);
            return {};
          },
          recordSuccess: () => {},
        },
      },
      noticeOn
    );
    await watcher.start();
    await watcher.idle();
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    await settle();
    void watcher.noticeNow();
    await settle();
    await watcher.stop();
    expect(failures).toEqual([]);
  });

  test('stop is bounded even when a pass hangs on something that cannot be aborted', async () => {
    let itemId = '';
    let hang = false;
    let embedCalls = 0;
    let callsAtBirth = 0;
    const { client } = noticeClient(() =>
      JSON.stringify({
        keep: [
          {
            text: 'The boiler is serviced in May',
            kind: 'fact',
            confidence: 'high',
            from: [itemId],
          },
        ],
      })
    );
    const { watcher, activityStream } = make(
      {
        llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } },
        // After birth the embedder never answers, and it takes no signal.
        embed: (): Promise<number[]> => {
          embedCalls++;
          return hang ? new Promise(() => {}) : Promise.resolve([1, 0]);
        },
        stopTimeoutMs: 50,
      },
      noticeOn
    );
    await watcher.start();
    await watcher.idle();
    hang = true;
    callsAtBirth = embedCalls;
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    activityStream.emit('activity', { type: 'worker:waiting', botId: 'b1', timestamp: t });
    await settle();
    itemId =
      watcher.buffer.items().find((i) => (i.event as { type?: string }).type === 'worker:waiting')
        ?.id ?? '';
    void watcher.noticeNow();
    await settle();
    expect(embedCalls).toBeGreaterThan(callsAtBirth);
    const started = Date.now();
    const state = await watcher.stop();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(state.running).toBe(false);
    expect(existsSync(graphFiles(join(root, 'data', 'watcher')).graph)).toBe(true);
  });
});

describe('Watcher start that fails', () => {
  test('reports not running: state, fleetMemory, selfStateFor and a later start behave', async () => {
    let broken = true;
    const real = new EventEmitter();
    const stream = {
      on: (event: string, fn: (...a: unknown[]) => void) => {
        if (broken) throw new Error('stream unavailable');
        real.on(event, fn);
        return stream;
      },
      off: (event: string, fn: (...a: unknown[]) => void) => {
        real.off(event, fn);
        return stream;
      },
    };
    const { watcher } = make({ activityStream: stream as never });
    const state = await watcher.start();
    expect(state.running).toBe(false);
    expect(state.phase).toBe('sleep');
    expect(state.lastError).toContain('stream unavailable');
    expect(watcher.state().running).toBe(false);
    expect(watcher.fleetMemory()).toBeUndefined();
    expect(watcher.selfStateFor('b1')).toBeUndefined();
    await watcher.idle();
    expect(watcher.noticing).toBe(false);
    expect(watcher.integrating).toBe(false);

    broken = false;
    const again = await watcher.start();
    expect(again.running).toBe(true);
    await watcher.idle();
    expect(watcher.fleetMemory()).toBeDefined();
    await watcher.stop();
  });
});

describe('Watcher stop during birth (cancellation is per run)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const rowsAfterSleep = (w: Watcher) => {
    const rows = w.log.recent(500);
    const sleepSeq = Math.max(...rows.filter((r) => r.op === 'sleep').map((r) => r.seq));
    return rows.filter((r) => r.seq > sleepSeq);
  };

  test('a birth abandoned by stop never writes after the sleep row', async () => {
    let embedCalls = 0;
    const { watcher } = make({
      // Slow and deaf to the signal: outlives stop's bound.
      embed: async (): Promise<number[]> => {
        embedCalls++;
        await sleep(150);
        return [1, 0];
      },
      stopTimeoutMs: 30,
    });
    await watcher.start();
    for (let i = 0; i < 100 && embedCalls === 0; i++) await sleep(5);
    expect(embedCalls).toBeGreaterThan(0);
    await watcher.stop();
    const callsAtStop = embedCalls;
    await sleep(500);
    expect(rowsAfterSleep(watcher)).toEqual([]);
    expect(watcher.readBirth()?.finishedAt).toBeUndefined();
    expect(watcher.readBirth()?.done).not.toContain('link');
    expect(embedCalls).toBe(callsAtStop);
    expect(watcher.state().phase).toBe('sleep');
  });

  test('a start after a stop that abandoned a hung birth returns promptly and is born', async () => {
    let hang = true;
    let embedCalls = 0;
    const { watcher } = make({
      embed: (): Promise<number[]> => {
        embedCalls++;
        return hang ? new Promise(() => {}) : Promise.resolve([1, 0]);
      },
      stopTimeoutMs: 30,
    });
    await watcher.start();
    for (let i = 0; i < 100 && embedCalls === 0; i++) await sleep(5);
    expect(embedCalls).toBeGreaterThan(0);
    await watcher.stop();
    hang = false;
    const started = Date.now();
    const state = await watcher.start();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(state.running).toBe(true);
    await watcher.idle();
    expect(watcher.readBirth()?.finishedAt).toBeDefined();
    expect(watcher.state().phase).toBe('sense');
    await watcher.stop();
  });
});

describe('Watcher stop during a pass (cancellation is per run)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const rowsAfterSleep = (w: Watcher) => {
    const rows = w.log.recent(500);
    const sleepSeq = Math.max(...rows.filter((r) => r.op === 'sleep').map((r) => r.seq));
    return rows.filter((r) => r.seq > sleepSeq);
  };
  /** An embedder that is fast during birth and, once `gate` is on, waits for `release`. */
  function gatedEmbed() {
    const g = { on: false, calls: 0, waiting: [] as Array<() => void> };
    const embed = (): Promise<number[]> => {
      if (!g.on) return Promise.resolve([1, 0]);
      g.calls++;
      return new Promise((resolve) => g.waiting.push(() => resolve([0, 1])));
    };
    const release = () => {
      for (const r of g.waiting.splice(0)) r();
    };
    return { g, embed, release };
  }

  test('a notice pass abandoned by stop writes nothing after the sleep row and keeps the buffer', async () => {
    let itemId = '';
    const { client } = noticeClient(() =>
      JSON.stringify({
        keep: [{ text: 'The boiler is serviced in May', kind: 'fact', from: [itemId] }],
      })
    );
    const { g, embed, release } = gatedEmbed();
    const { watcher, activityStream } = make(
      {
        llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } },
        embed,
        stopTimeoutMs: 30,
      },
      noticeOn
    );
    await watcher.start();
    await watcher.idle();
    g.on = true;
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    activityStream.emit('activity', { type: 'worker:waiting', botId: 'b1', timestamp: t });
    await sleep(5);
    const before = watcher.buffer.items().map((i) => i.id);
    itemId =
      watcher.buffer.items().find((i) => (i.event as { type?: string }).type === 'worker:waiting')
        ?.id ?? '';
    const neuronsBefore = watcher.graph.list().length;
    const pass = watcher.noticeNow();
    for (let i = 0; i < 100 && g.calls === 0; i++) await sleep(5);
    expect(g.calls).toBe(1);
    await watcher.stop();
    release();
    await pass;
    await sleep(20);
    expect(rowsAfterSleep(watcher)).toEqual([]);
    expect(watcher.graph.list().length).toBe(neuronsBefore);
    expect(watcher.buffer.items().map((i) => i.id)).toEqual(before);
    expect(watcher.state().phase).toBe('sleep');
    // What stop persisted is what the next start restores.
    g.on = false;
    await watcher.start();
    expect(
      watcher.buffer
        .items()
        .map((i) => i.id)
        .filter((id) => before.includes(id))
    ).toEqual(before);
    await watcher.idle();
    await watcher.stop();
  });

  test('an integrate pass abandoned by stop writes no neuron, row or broadcast after the sleep row', async () => {
    const { g, embed, release } = gatedEmbed();
    const ref: { w?: Watcher } = {};
    const { client } = integrateClient(() => {
      const goal = ref.w?.graph.list().find((n) => n.kind === 'goal')?.id as string;
      return JSON.stringify({
        insights: [{ text: 'Jarvis keeps failing on the same fetch', support: [goal] }],
        broadcasts: [{ bot: 'b1', kind: 'wake', text: '', insightIndex: 0 }],
        attending: [goal],
      });
    });
    const woke: string[] = [];
    const { watcher, activityStream } = make(
      {
        llm: { integrate: { client, model: 'claude-opus-5-5', backend: 'claude-cli' } },
        broadcastDelivery: { wake: (b) => void woke.push(b) },
        embed,
        stopTimeoutMs: 30,
      },
      integrateOn
    );
    ref.w = watcher;
    await watcher.start();
    await watcher.idle();
    g.on = true;
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    const pass = watcher.integrateNow();
    for (let i = 0; i < 100 && g.calls === 0; i++) await sleep(5);
    expect(g.calls).toBe(1);
    await watcher.stop();
    release();
    await pass;
    await sleep(20);
    expect(rowsAfterSleep(watcher)).toEqual([]);
    expect(watcher.graph.list().some((n) => n.kind === 'insight')).toBe(false);
    expect(woke).toEqual([]);
    expect(watcher.broadcaster.list()).toEqual([]);
    expect(watcher.state().phase).toBe('sleep');
  });

  test('a stale pass that settles during the next start never resets its phase nor feeds it', async () => {
    let itemId = '';
    const { client } = noticeClient(() =>
      JSON.stringify({
        keep: [{ text: 'The boiler is serviced in May', kind: 'fact', from: [itemId] }],
      })
    );
    const { g, embed, release } = gatedEmbed();
    const { watcher, activityStream, config } = make(
      {
        llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } },
        embed,
        stopTimeoutMs: 30,
      },
      noticeOn
    );
    await watcher.start();
    await watcher.idle();
    g.on = true;
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    activityStream.emit('activity', { type: 'worker:waiting', botId: 'b1', timestamp: t });
    await sleep(5);
    itemId =
      watcher.buffer.items().find((i) => (i.event as { type?: string }).type === 'worker:waiting')
        ?.id ?? '';
    const stale = watcher.noticeNow();
    for (let i = 0; i < 100 && g.calls === 0; i++) await sleep(5);
    expect(g.calls).toBe(1);
    await watcher.stop();
    // A new bot and no birth record: the next start is a birth that embeds the
    // new neurons through the same gate, so it is still in phase birth.
    config.bots.push({
      id: 'b2',
      name: 'b2',
      soulDir: soul('b2', 'Scout'),
      enabled: true,
    } as never);
    rmSync(join(root, 'data', 'watcher', 'birth.json'), { force: true });
    await watcher.start();
    for (let i = 0; i < 100 && g.calls < 2; i++) await sleep(5);
    expect(g.calls).toBeGreaterThanOrEqual(2);
    expect(watcher.state().phase).toBe('birth');
    // Only the stale pass's embedding answers: its .finally must leave the resync alone.
    const staleRelease = g.waiting.shift() as () => void;
    staleRelease();
    await stale;
    await sleep(10);
    expect(watcher.state().phase).toBe('birth');
    expect(watcher.graph.list().some((n) => n.text === 'The boiler is serviced in May')).toBe(
      false
    );
    release();
    await watcher.idle();
    expect(watcher.state().phase).toBe('sense');
    // The live run notices for itself (not the stale pass's promise).
    g.on = false;
    const fresh = await watcher.noticeNow();
    expect(fresh?.status).toBe('noticed');
    await watcher.stop();
  });
});

describe('Watcher question broadcasts and the shared throttle (one pass)', () => {
  test("two questions in one pass: the second is deferred, B's cap is untouched, later B is reached", async () => {
    const throttle = new ProactiveThrottle(
      () => ({ cooldownMs: 3_600_000, dailyCap: 10 }),
      () => t
    );
    const sent: string[] = [];
    const woke: string[] = [];
    const qDeps = {
      throttle,
      operatorChatId: (): number | undefined => 42,
      telegram: () => ({
        api: { sendMessage: async (_c: number, text: string) => void sent.push(text) },
      }),
      now: () => t,
      logger: noopLogger,
    };
    let reply = '';
    const { client } = integrateClient(() => reply);
    const { watcher, activityStream, config } = make(
      {
        llm: { integrate: { client, model: 'claude-opus-5-5', backend: 'claude-cli' } },
        broadcastDelivery: {
          question: (botId, text) => deliverWatcherQuestion(qDeps, botId, text),
          wake: (b) => void woke.push(b),
        },
      },
      integrateOn
    );
    config.bots.push({
      id: 'b2',
      name: 'b2',
      soulDir: soul('b2', 'Scout'),
      enabled: true,
    } as never);
    await watcher.start();
    await watcher.idle();
    const goal = watcher.graph.list().find((n) => n.kind === 'goal')?.id as string;
    reply = JSON.stringify({
      insights: [
        { text: 'Jarvis waits on a missing API key', support: [goal] },
        { text: 'Scout repeats a search nobody reads', support: [goal] },
      ],
      broadcasts: [
        { bot: 'b1', kind: 'question', text: 'Is the key coming?', insightIndex: 0 },
        { bot: 'b2', kind: 'question', text: 'Should Scout stop?', insightIndex: 1 },
      ],
      attending: [goal],
    });
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    const out = await watcher.integrateNow();
    expect(out?.status).toBe('integrated');
    const statuses = out?.status === 'integrated' ? out.broadcasts.map((b) => b.status) : [];
    expect(statuses).toEqual(['delivered', 'deferred']);
    expect(watcher.broadcaster.countToday('b2')).toBe(0);
    expect(sent).toHaveLength(1);
    // A later wake for B goes out.
    const insight = watcher.graph
      .list()
      .find((n) => n.kind === 'insight' && n.text.startsWith('Scout'))?.id as string;
    const wake = await watcher.broadcaster.send({
      botId: 'b2',
      kind: 'wake',
      text: '',
      insightId: insight,
    });
    expect(wake.status).toBe('delivered');
    expect(woke).toEqual(['b2']);
    // After the cooldown, B's question is retryable and lands.
    t += 3_600_001;
    const retry = await watcher.broadcaster.send({
      botId: 'b2',
      kind: 'question',
      text: 'Should Scout stop?',
      insightId: insight,
    });
    expect(retry.status).toBe('delivered');
    expect(sent).toHaveLength(2);
    await watcher.stop();
  });
});

describe('Watcher: embedding what birth could not', () => {
  test('a graph born no-embeddings is linked at the next start once an embedder works', async () => {
    const first = make();
    await first.watcher.start();
    await first.watcher.idle();
    expect(first.watcher.state().linkStatus).toBe('no-embeddings');
    await first.watcher.stop();
    t += 1000;
    const second = make({ embed: async () => [1, 0, 0] });
    await second.watcher.start();
    await second.watcher.idle();
    expect(second.watcher.state().linkStatus).toBe('ok');
    expect(second.watcher.graph.embeddedIds().length).toBe(second.watcher.graph.liveCount());
    expect(second.watcher.log.recent(50).filter((r) => r.op === 'maintain:link').length).toBe(1);
    await second.watcher.stop();
  });

  test('daily maintenance embeds and links once the embedder comes back', async () => {
    let up = false;
    const { watcher } = make({
      embed: async () => {
        if (!up) throw new Error('ollama down');
        return [1, 0, 0];
      },
    });
    await watcher.start();
    await watcher.idle();
    expect(watcher.state().linkStatus).toBe('no-embeddings');
    up = true;
    await watcher.maintainNow();
    expect(watcher.state().linkStatus).toBe('ok');
    expect(watcher.graph.embeddedIds().length).toBe(watcher.graph.liveCount());
    await watcher.stop();
  });
});
