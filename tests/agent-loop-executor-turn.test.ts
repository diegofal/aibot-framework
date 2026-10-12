/**
 * The cycle executor on runExecutorTurn: blocked tools refused at execution,
 * a per-cycle abort signal that fires when maxDurationMs runs out, and the
 * fleet-wide backend circuit breaker shared through BotContext and fed by
 * executor failures.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/bot/agent-loop';
import { BackendCircuitBreaker } from '../src/bot/agent-retry-engine';
import { GlobalAgentLoopConfigSchema } from '../src/config';
import type { Tool } from '../src/tools/types';

function mockLogger(): any {
  const l: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  l.child = () => l;
  return l;
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aibot-exec-turn-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const PLAN = JSON.stringify({ reasoning: 'r', plan: ['Do it'], priority: 'medium' });

function tool(name: string, ran: string[]): Tool {
  return {
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    execute: async () => {
      ran.push(name);
      return { success: true, content: 'ok' };
    },
  };
}

function makeLoop(opts: {
  chat: (messages: any[], o: any) => Promise<any>;
  agentLoop?: Record<string, unknown>;
  bot?: Record<string, unknown>;
  tools?: Tool[];
  circuitBreaker?: BackendCircuitBreaker;
  backend?: string;
}) {
  const soulLoader = {
    readIdentity: () => 'id',
    readSoul: () => 'soul',
    readMotivations: () => 'mot',
    readGoals: () => '',
    readRecentDailyLogs: () => '',
    readDailyLogsSince: () => '',
    appendDailyMemory: () => {},
    writeGoals: () => {},
  };
  const llm: any = {
    backend: opts.backend ?? 'ollama',
    generate: mock(() => Promise.resolve({ text: PLAN })),
    chat: mock(opts.chat),
    getBackendClient: () => llm,
  };
  const tools = opts.tools ?? [];
  const botConfig = { id: 'bot1', name: 'Bot 1', agentLoop: { mode: 'periodic' }, ...opts.bot };
  const ctx: any = {
    config: {
      agentLoop: GlobalAgentLoopConfigSchema.parse({
        strategist: { enabled: false },
        ...opts.agentLoop,
      }),
      conversation: { systemPrompt: '', temperature: 0.7, maxHistory: 10 },
      bots: [botConfig],
      paths: { data: dataDir },
      ollama: { models: { primary: 'm' } },
      claudeCli: { model: 'c' },
      karma: { enabled: false },
      productions: { baseDir: join(dataDir, 'productions') },
      soul: { dir: join(dataDir, 'soul') },
    },
    runningBots: new Set(['bot1']),
    logger: mockLogger(),
    tools,
    toolDefinitions: tools.map((t) => t.definition),
    soulLoaders: new Map([['bot1', soulLoader]]),
    llmClients: new Map([['bot1', llm]]),
    agentFeedbackStore: { getPending: () => [] },
    askHumanStore: { consumeAnswersForBot: () => [], getPendingForBot: () => [] },
    askPermissionStore: {
      consumeDecisionsForBot: () => [],
      getPendingForBot: () => [],
      reportExecution: () => {},
    },
    sessionManager: { listSessions: () => [] },
    getLLMClient: () => llm,
    getActiveModel: () => 'm',
    getBotLogger: () => mockLogger(),
    getSoulLoader: () => soulLoader,
    resolveBotId: (id: string) => id,
    ...(opts.circuitBreaker ? { circuitBreaker: opts.circuitBreaker } : {}),
  };
  const defs = tools.map((t) => t.definition);
  const loop = new AgentLoop(
    ctx,
    { build: () => 'system' } as any,
    { getDefinitionsForBot: () => defs, getDefinitionsByCategories: () => defs } as any
  );
  (loop as any).scheduler.syncSchedules();
  return { loop, ctx, llm };
}

describe('cycle executor — permissions', () => {
  test('a tool blocked for the agent loop is refused at execution', async () => {
    const ran: string[] = [];
    let result: any;
    const { loop } = makeLoop({
      tools: [tool('web_fetch', ran)],
      bot: { toolPermissions: { web_fetch: { agentLoop: 'blocked' } } },
      chat: async (_m, o) => {
        result = await o.toolExecutor('web_fetch', { url: 'https://x.test' });
        return { text: 'done' };
      },
    });
    await loop.runOne('bot1');
    expect(ran).toEqual([]);
    expect(result.success).toBe(false);
  });

  test('a confirm tool still runs unchecked when the flag is off', async () => {
    const ran: string[] = [];
    const { loop } = makeLoop({
      tools: [tool('browser', ran)],
      chat: async (_m, o) => {
        await o.toolExecutor('browser', { action: 'open' });
        return { text: 'done' };
      },
    });
    await loop.runOne('bot1');
    expect(ran).toEqual(['browser']);
  });
});

describe('cycle executor — abort', () => {
  test('the executor gets a signal that aborts when maxDurationMs runs out', async () => {
    let signal: AbortSignal | undefined;
    const { loop } = makeLoop({
      agentLoop: { maxDurationMs: 300 },
      chat: (_m, o) => {
        signal = o.signal;
        return new Promise(() => {});
      },
    });
    const result = await loop.runOne('bot1');
    expect(result.status).toBe('error');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
  });

  test('a cycle that completes does not leave its signal aborted mid-run', async () => {
    let signal: AbortSignal | undefined;
    let abortedDuringChat: boolean | undefined;
    const { loop } = makeLoop({
      chat: async (_m, o) => {
        signal = o.signal;
        abortedDuringChat = o.signal.aborted;
        return { text: 'done' };
      },
    });
    const result = await loop.runOne('bot1');
    expect(result.status).toBe('completed');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(abortedDuringChat).toBe(false);
  });
});

describe('shared backend circuit breaker', () => {
  test('AgentLoop uses the breaker from BotContext', () => {
    const breaker = new BackendCircuitBreaker();
    const { loop } = makeLoop({ circuitBreaker: breaker, chat: async () => ({ text: '' }) });
    breaker.recordFailure('ollama', new Error('fetch failed'));
    expect((loop as any).circuitBreaker).toBe(breaker);
    expect(loop.getCircuitState().ollama).toBeDefined();
  });

  test('without one in the context, AgentLoop creates it and publishes it there', () => {
    const { loop, ctx } = makeLoop({ chat: async () => ({ text: '' }) });
    expect(ctx.circuitBreaker).toBeInstanceOf(BackendCircuitBreaker);
    expect((loop as any).circuitBreaker).toBe(ctx.circuitBreaker);
  });

  test('executor quota failures open the shared circuit for the executor backend', async () => {
    const breaker = new BackendCircuitBreaker({
      enabled: true,
      threshold: 1,
      cooldownMs: 60_000,
      weeklyQuotaCooldownMs: 120_000,
    });
    const { loop } = makeLoop({
      circuitBreaker: breaker,
      backend: 'claude-cli',
      chat: async () => {
        throw new Error('Ollama API error: 429 Too Many Requests');
      },
    });
    const result = await loop.runOne('bot1');
    expect(result.status).toBe('error');
    expect(breaker.isOpen('claude-cli')).toBe(true);
  });
});
