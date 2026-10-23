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

  test('a dashboard-channel human_inbound counts as the operator', async () => {
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
    expect(watcher.buffer.items()[0].fromOperator).toBe(true);
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
