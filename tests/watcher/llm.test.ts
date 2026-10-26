import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmQueryEntry } from '../../src/bot/llm-query-log';
import type { Config } from '../../src/config';
import {
  ClaudeCliLLMClient,
  type LLMChatOptions,
  type LLMClient,
  OllamaLLMClient,
} from '../../src/core/llm-client';
import type { ChatMessage } from '../../src/ollama';
import { DailyBudget } from '../../src/watcher/budget';
import { type KillState, WATCHER_KILL_ENV } from '../../src/watcher/kill';
import {
  WATCHER_QUERY_BOT_ID,
  type WatcherTierClient,
  createWatcherClients,
  instrumented,
} from '../../src/watcher/llm';
import { WATCHER_DEFAULTS } from '../../src/watcher/types';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

let dir: string;
let t: number;

function config(notice: Partial<typeof WATCHER_DEFAULTS.notice> = {}): Config {
  return {
    agentLoop: { claudeTimeout: 90_000 },
    ollama: { models: { primary: 'qwen3:8b' } },
    watcher: {
      ...WATCHER_DEFAULTS,
      enabled: true,
      notice: { ...WATCHER_DEFAULTS.notice, ...notice },
    },
  } as unknown as Config;
}

function fakeClient(
  backend: 'claude-cli' | 'ollama',
  reply: () => Promise<{ text: string; usage?: Record<string, unknown> }>
) {
  const calls: Array<{ messages: ChatMessage[]; opts?: LLMChatOptions }> = [];
  const client = {
    backend,
    generate: async () => ({ text: '' }),
    chat: async (messages: ChatMessage[], opts?: LLMChatOptions) => {
      calls.push({ messages, opts });
      return reply();
    },
  } as unknown as LLMClient;
  return { client, calls };
}

function budget(maxPerDay = 5, open = false) {
  return new DailyBudget({
    dir,
    now: () => t,
    limits: () => ({ notice: { maxPerDay }, integrate: { maxPerDay, maxTokensPerDay: 10_000 } }),
    isCircuitOpen: () => open,
  });
}

const ollamaStub = {} as never;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-llm-'));
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('createWatcherClients', () => {
  test('one Claude CLI client per tier, bound to the configured model', () => {
    const clients = createWatcherClients(config(), { logger: noopLogger });
    expect(clients.notice.client).toBeInstanceOf(ClaudeCliLLMClient);
    expect(clients.notice).toMatchObject({ model: 'claude-haiku-5-5', backend: 'claude-cli' });
    expect((clients.notice.client as unknown as { model: string }).model).toBe('claude-haiku-5-5');
    expect(clients.integrate.client).toBeInstanceOf(ClaudeCliLLMClient);
    expect((clients.integrate.client as unknown as { model: string }).model).toBe(
      'claude-opus-5-5'
    );
  });

  test('notice on Ollama uses the shared client and its primary model for a claude- default', () => {
    const clients = createWatcherClients(config({ backend: 'ollama' }), {
      logger: noopLogger,
      ollama: ollamaStub,
    });
    expect(clients.notice.client).toBeInstanceOf(OllamaLLMClient);
    expect(clients.notice).toMatchObject({ backend: 'ollama', model: 'qwen3:8b' });
    expect(clients.integrate.backend).toBe('claude-cli');
  });

  test('an explicit Ollama model is kept', () => {
    const clients = createWatcherClients(config({ backend: 'ollama', model: 'llama3.2' }), {
      logger: noopLogger,
      ollama: ollamaStub,
    });
    expect(clients.notice.model).toBe('llama3.2');
  });

  test('backend ollama without an Ollama client falls back to Claude CLI', () => {
    const clients = createWatcherClients(config({ backend: 'ollama' }), { logger: noopLogger });
    expect(clients.notice.backend).toBe('claude-cli');
  });
});

describe('instrumented', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

  test('calls with priority watcher and logs one entry under __watcher__', async () => {
    const { client, calls } = fakeClient('claude-cli', async () => ({
      text: '{"keep":[]}',
      usage: {
        model: 'claude-haiku-5-5',
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        costUsd: 0.003,
      },
    }));
    const tier: WatcherTierClient = { client, model: 'claude-haiku-5-5', backend: 'claude-cli' };
    const entries: LlmQueryEntry[] = [];
    const b = budget();
    const call = instrumented(tier, {
      tier: 'notice',
      caller: 'watcher:notice',
      budget: b,
      queryLog: { append: (e) => entries.push(e) },
      now: () => t,
    });
    const res = await call.chat(messages, { temperature: 0.2 });
    expect(res).toMatchObject({
      ok: true,
      text: '{"keep":[]}',
      model: 'claude-haiku-5-5',
      tokens: 120,
      costUsd: 0.003,
    });
    expect(calls[0].opts).toMatchObject({ priority: 'watcher', temperature: 0.2 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      botId: WATCHER_QUERY_BOT_ID,
      caller: 'watcher:notice',
      model: 'claude-haiku-5-5',
      backend: 'claude-cli',
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      costUsd: 0.003,
      success: true,
    });
    expect(typeof entries[0].durationMs).toBe('number');
    expect(b.used('notice')).toMatchObject({ calls: 1, tokens: 120, costUsd: 0.003 });
  });

  test('the Ollama path passes the model per call', async () => {
    const { client, calls } = fakeClient('ollama', async () => ({ text: 'ok' }));
    const call = instrumented(
      { client, model: 'qwen3:8b', backend: 'ollama' },
      { tier: 'notice', caller: 'watcher:notice', budget: budget() }
    );
    await call.chat(messages);
    expect(calls[0].opts).toMatchObject({ model: 'qwen3:8b', priority: 'watcher' });
  });

  test('a refused budget makes no call and logs nothing', async () => {
    const { client, calls } = fakeClient('claude-cli', async () => ({ text: 'x' }));
    const entries: LlmQueryEntry[] = [];
    const call = instrumented(
      { client, model: 'm', backend: 'claude-cli' },
      {
        tier: 'notice',
        caller: 'watcher:notice',
        budget: budget(0),
        queryLog: { append: (e) => entries.push(e) },
      }
    );
    expect(await call.chat(messages)).toEqual({ ok: false, reason: 'cap' });
    expect(calls).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  test('an open breaker makes no call', async () => {
    const { client, calls } = fakeClient('claude-cli', async () => ({ text: 'x' }));
    const call = instrumented(
      { client, model: 'm', backend: 'claude-cli' },
      { tier: 'notice', caller: 'watcher:notice', budget: budget(5, true) }
    );
    expect(await call.chat(messages)).toEqual({ ok: false, reason: 'breaker' });
    expect(calls).toHaveLength(0);
  });

  test('a failing call is logged, counted, fed to the breaker and never throws', async () => {
    const { client } = fakeClient('claude-cli', async () => {
      throw new Error('429 rate limited');
    });
    const entries: LlmQueryEntry[] = [];
    const failures: string[] = [];
    const b = budget();
    const call = instrumented(
      { client, model: 'm', backend: 'claude-cli' },
      {
        tier: 'notice',
        caller: 'watcher:notice',
        budget: b,
        queryLog: { append: (e) => entries.push(e) },
        breaker: {
          recordFailure: (backend) => {
            failures.push(backend);
          },
          recordSuccess: () => {},
        },
      }
    );
    const res = await call.chat(messages);
    expect(res).toMatchObject({ ok: false, reason: 'error', error: '429 rate limited' });
    expect(entries[0]).toMatchObject({ success: false, error: '429 rate limited', model: 'm' });
    expect(failures).toEqual(['claude-cli']);
    expect(b.used('notice').calls).toBe(1);
  });

  test('a success closes the breaker for the backend', async () => {
    const { client } = fakeClient('claude-cli', async () => ({ text: 'ok' }));
    const ok: string[] = [];
    const call = instrumented(
      { client, model: 'm', backend: 'claude-cli' },
      {
        tier: 'notice',
        caller: 'watcher:notice',
        budget: budget(),
        breaker: { recordFailure: () => {}, recordSuccess: (b) => ok.push(b) },
      }
    );
    await call.chat(messages);
    expect(ok).toEqual(['claude-cli']);
  });

  test('a throwing query log does not fail the call', async () => {
    const { client } = fakeClient('claude-cli', async () => ({ text: 'ok' }));
    const call = instrumented(
      { client, model: 'm', backend: 'claude-cli' },
      {
        tier: 'notice',
        caller: 'watcher:notice',
        budget: budget(),
        queryLog: {
          append: () => {
            throw new Error('disk full');
          },
        },
      }
    );
    expect((await call.chat(messages)).ok).toBe(true);
  });
});

describe('instrumented: concurrent calls never exceed the cap', () => {
  test('two calls started together with one call left: only one reaches the backend', async () => {
    const b = budget(1);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client = {
      backend: 'claude-cli',
      generate: async () => ({ text: '' }),
      chat: async () => {
        calls++;
        await gate;
        return { text: 'ok' };
      },
    } as unknown as LLMClient;
    const c = instrumented(
      { client, model: 'm', backend: 'claude-cli' },
      { tier: 'notice', caller: 'watcher:notice', budget: b }
    );
    const first = c.chat([{ role: 'user', content: 'a' }]);
    const second = c.chat([{ role: 'user', content: 'b' }]);
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect((await first).ok).toBe(true);
    expect(await second).toEqual({ ok: false, reason: 'cap' });
    expect(calls).toBe(1);
  });
});

describe('instrumented: hard kill (C1) and monthly ceiling (C6)', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
  const killed: KillState = { killed: true, source: 'file' };

  test('killed: no call, no reservation, no query log, no pass record', async () => {
    const { client, calls } = fakeClient('claude-cli', async () => ({ text: 'x' }));
    const entries: LlmQueryEntry[] = [];
    const b = budget(1);
    let reserves = 0;
    const counting = {
      dir: b.dir,
      reserve: (tier: 'notice' | 'integrate') => {
        reserves++;
        return b.reserve(tier);
      },
      record: b.record.bind(b),
    };
    const call = instrumented(
      { client, model: 'm', backend: 'claude-cli' },
      {
        tier: 'notice',
        caller: 'watcher:notice',
        budget: counting,
        queryLog: { append: (e) => entries.push(e) },
        kill: () => killed,
      }
    );
    expect(await call.chat(messages)).toEqual({ ok: false, reason: 'killed' });
    expect(calls).toHaveLength(0);
    expect(reserves).toBe(0); // checked BEFORE the budget
    expect(entries).toHaveLength(0);
    expect(b.used('notice').calls).toBe(0);
    expect(readdirSync(dir).some((n) => n === 'passes')).toBe(false);
  });

  test('the switch is read per call: clearing it lets the next call through', async () => {
    const { client, calls } = fakeClient('claude-cli', async () => ({ text: 'ok' }));
    let state: KillState = killed;
    const call = instrumented(
      { client, model: 'm', backend: 'claude-cli' },
      { tier: 'notice', caller: 'watcher:notice', budget: budget(), kill: () => state }
    );
    expect((await call.chat(messages)).ok).toBe(false);
    state = { killed: false };
    expect((await call.chat(messages)).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('onRefused hears every refusal before a call, killed included', async () => {
    const { client } = fakeClient('claude-cli', async () => ({ text: 'ok' }));
    const heard: string[] = [];
    const refuse = (kill: KillState, max: number) =>
      instrumented(
        { client, model: 'm', backend: 'claude-cli' },
        {
          tier: 'notice',
          caller: 'watcher:notice',
          budget: budget(max),
          kill: () => kill,
          onRefused: (r) => {
            heard.push(r);
            throw new Error('a throwing listener never fails the call');
          },
        }
      ).chat(messages);
    expect((await refuse(killed, 5)).ok).toBe(false);
    expect((await refuse({ killed: false }, 0)).ok).toBe(false);
    expect((await refuse({ killed: false }, 5)).ok).toBe(true);
    expect(heard).toEqual(['killed', 'cap']);
  });

  test('a kill reader that throws is not a kill', async () => {
    const { client } = fakeClient('claude-cli', async () => ({ text: 'ok' }));
    const call = instrumented(
      { client, model: 'm', backend: 'claude-cli' },
      {
        tier: 'notice',
        caller: 'watcher:notice',
        budget: budget(),
        kill: () => {
          throw new Error('boom');
        },
      }
    );
    expect((await call.chat(messages)).ok).toBe(true);
  });

  test('by default the environment kills', async () => {
    const before = process.env[WATCHER_KILL_ENV];
    const { client, calls } = fakeClient('claude-cli', async () => ({ text: 'ok' }));
    try {
      process.env[WATCHER_KILL_ENV] = '1';
      const call = instrumented(
        { client, model: 'm', backend: 'claude-cli' },
        { tier: 'notice', caller: 'watcher:notice', budget: budget() }
      );
      expect(await call.chat(messages)).toEqual({ ok: false, reason: 'killed' });
      expect(calls).toHaveLength(0);
    } finally {
      if (before === undefined) delete process.env[WATCHER_KILL_ENV];
      else process.env[WATCHER_KILL_ENV] = before;
    }
  });

  test('by default the sentinel next to the watcher dir kills (<data>/watcher-kill)', async () => {
    const data = join(dir, 'data');
    const watcherDir = join(data, 'watcher');
    mkdirSync(watcherDir, { recursive: true });
    const b = new DailyBudget({
      dir: watcherDir,
      now: () => t,
      limits: () => ({ notice: { maxPerDay: 5 }, integrate: { maxPerDay: 5, maxTokensPerDay: 1 } }),
    });
    const { client, calls } = fakeClient('claude-cli', async () => ({ text: 'ok' }));
    const call = instrumented(
      { client, model: 'm', backend: 'claude-cli' },
      { tier: 'notice', caller: 'watcher:notice', budget: b }
    );
    expect((await call.chat(messages)).ok).toBe(true);
    writeFileSync(join(data, 'watcher-kill'), '');
    expect(await call.chat(messages)).toEqual({ ok: false, reason: 'killed' });
    expect(calls).toHaveLength(1);
  });

  test('an explicit sentinel path is honoured', async () => {
    const sentinel = join(dir, 'elsewhere-kill');
    writeFileSync(sentinel, '');
    const { client, calls } = fakeClient('claude-cli', async () => ({ text: 'ok' }));
    const call = instrumented(
      { client, model: 'm', backend: 'claude-cli' },
      {
        tier: 'notice',
        caller: 'watcher:notice',
        budget: budget(),
        killSentinelPath: sentinel,
      }
    );
    expect(await call.chat(messages)).toEqual({ ok: false, reason: 'killed' });
    expect(calls).toHaveLength(0);
  });

  test('the monthly ceiling refuses the call before it is made', async () => {
    const { client, calls } = fakeClient('claude-cli', async () => ({ text: 'ok' }));
    const b = new DailyBudget({
      dir,
      now: () => t,
      limits: () => ({ notice: { maxPerDay: 5 }, integrate: { maxPerDay: 5, maxTokensPerDay: 1 } }),
      monthlyCeilingUsd: () => 0,
    });
    const call = instrumented(
      { client, model: 'm', backend: 'claude-cli' },
      { tier: 'notice', caller: 'watcher:notice', budget: b, kill: () => ({ killed: false }) }
    );
    expect(await call.chat(messages)).toEqual({ ok: false, reason: 'ceiling' });
    expect(calls).toHaveLength(0);
  });
});
