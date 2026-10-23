import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUMAN_INBOUND_HOOK, OPERATOR_MESSAGE_HOOK } from '../../src/bot/agent-loop-utils';
import type { LlmQueryEntry } from '../../src/bot/llm-query-log';
import type { Config } from '../../src/config';
import type { LLMClient } from '../../src/core/llm-client';
import { graphFiles } from '../../src/watcher/paths';
import { WATCHER_DEFAULTS, type WatcherEvent } from '../../src/watcher/types';
import { Watcher, type WatcherDeps, createFleetWatcher } from '../../src/watcher/watcher';

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

  test('the operator is recognised by config.operator.telegramChatId', async () => {
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
    const texts = watcher.buffer.items().map((i) => (i.event as { text?: string }).text);
    expect(texts).toEqual(['Pay the Acme invoice', 'acme invoice']);
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
      getToolRegistry: () => ({
        setFleetMemory: () => {},
        createExecutor:
          (chatId: number, botId: string) =>
          async (name: string, args: Record<string, unknown>) => {
            calls.push(`exec:${chatId}:${botId}:${name}:${args.chatId}:${args.message}`);
            return { success: true, content: 'Message sent to the operator (chat 42)' };
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
      'exec:0:b1:send_proactive_message:operator:Fleet watcher: Who owns Acme?',
    ]);
    const goals = require('node:fs').readFileSync(join(root, 'souls', 'b1', 'GOALS.md'), 'utf-8');
    expect(goals).toContain('Merge the lead lists');
    expect(goals).toContain('source: watcher');
  });
});
