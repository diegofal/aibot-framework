/**
 * AgentLoop integration: planner backend routing, backend circuit breaker
 * skip path, and the hard engagement gate — exercised through runOne() with a
 * minimal BotContext and no real LLM.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalAgentLoopConfigSchema } from '../../config';
import { type LLMClient, LLMClientWithFallback } from '../../core/llm-client';
import { AgentLoop } from '../agent-loop';

const QUOTA_ERR = 'Ollama API error: 429 Too Many Requests — weekly usage limit reached';

function mockLogger(): any {
  const l: any = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
  l.child = () => l;
  return l;
}

function client(
  backend: 'ollama' | 'claude-cli',
  generate: () => Promise<{ text: string }>
): LLMClient & { generate: any; chat: any } {
  const c = {
    backend,
    generate: mock(generate),
    chat: mock(() => Promise.resolve({ text: 'executed' })),
    getBackendClient(b: 'ollama' | 'claude-cli') {
      return b === backend ? c : undefined;
    },
  };
  return c;
}

const idlePlan = JSON.stringify({ reasoning: 'nothing to do', plan: [], priority: 'none' });
const contentPlan = JSON.stringify({
  reasoning: 'more docs',
  plan: ['Write and create docs/guide-6.md'],
  priority: 'medium',
});
const outreachPlan = JSON.stringify({
  reasoning: 'check in',
  plan: ['Use ask_human to check in with the operator about the drafts'],
  priority: 'medium',
});

interface Harness {
  loop: AgentLoop;
  ctx: any;
  botLogger: any;
  memory: string[];
  queryLog: any[];
}

function makeHarness(opts: {
  botConfig: Record<string, unknown>;
  llmClient: LLMClient;
  agentLoop?: Record<string, unknown>;
  dataDir: string;
}): Harness {
  const botLogger = mockLogger();
  const memory: string[] = [];
  const queryLog: any[] = [];
  const soulLoader = {
    readIdentity: () => 'id',
    readSoul: () => 'soul',
    readMotivations: () => 'mot',
    readGoals: () => '',
    readRecentDailyLogs: () => '',
    readDailyLogsSince: () => '',
    appendDailyMemory: (line: string) => {
      memory.push(line);
    },
    writeGoals: () => {},
  };
  const botConfig = { name: 'Bot 1', ...opts.botConfig };
  const ctx: any = {
    config: {
      // Strategist off by default so each cycle makes exactly one planner call
      agentLoop: GlobalAgentLoopConfigSchema.parse({
        strategist: { enabled: false },
        ...(opts.agentLoop ?? {}),
      }),
      conversation: { systemPrompt: '', temperature: 0.7, maxHistory: 10 },
      bots: [botConfig],
      paths: { data: opts.dataDir },
      ollama: { models: { primary: 'glm-5.2:cloud' } },
      claudeCli: { model: 'claude-sonnet-4' },
      karma: { enabled: false },
      productions: { baseDir: join(opts.dataDir, 'productions') },
      soul: { dir: join(opts.dataDir, 'soul') },
    },
    runningBots: new Set(['bot1']),
    logger: mockLogger(),
    tools: [],
    soulLoaders: new Map([['bot1', soulLoader]]),
    llmClients: new Map([['bot1', opts.llmClient]]),
    agentFeedbackStore: { getPending: () => [] },
    askHumanStore: { consumeAnswersForBot: () => [], getPendingForBot: () => [] },
    askPermissionStore: {
      consumeDecisionsForBot: () => [],
      getPendingForBot: () => [],
      reportExecution: () => {},
    },
    llmQueryLog: { append: (e: any) => queryLog.push(e) },
    sessionManager: { listSessions: () => [] },
    getLLMClient: () => opts.llmClient,
    getActiveModel: () =>
      (botConfig as any).llmBackend === 'claude-cli' ? 'claude-sonnet-4' : 'glm-5.2:cloud',
    getBotLogger: () => botLogger,
    getSoulLoader: () => soulLoader,
    resolveBotId: (id: string) => id,
  };
  const systemPromptBuilder = { build: () => 'system' } as any;
  const toolRegistry = {
    getDefinitionsForBot: () => [],
    getDefinitionsByCategories: () => [],
  } as any;
  const loop = new AgentLoop(ctx, systemPromptBuilder, toolRegistry);
  return { loop, ctx, botLogger, memory, queryLog };
}

/** runOne() does not create schedule entries; sync them so recentActions/feedback exist. */
function syncSchedules(loop: AgentLoop): void {
  (loop as any).scheduler.syncSchedules();
}

describe('AgentLoop — planner backend routing', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'aibot-agent-loop-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('claude-cli bot: planner runs on the bare claude client, never on the ollama fallback', async () => {
    const claude = client('claude-cli', () => Promise.resolve({ text: idlePlan }));
    const ollama = client('ollama', () => Promise.resolve({ text: idlePlan }));
    const wrapped = new LLMClientWithFallback(claude, ollama, mockLogger());
    const h = makeHarness({
      botConfig: { id: 'bot1', llmBackend: 'claude-cli' },
      llmClient: wrapped,
      dataDir,
    });

    const result = await h.loop.runOne('bot1');

    expect(result.status).toBe('completed');
    expect(claude.generate).toHaveBeenCalledTimes(1);
    expect(ollama.generate).not.toHaveBeenCalled();
    const planner = h.queryLog.find((e) => e.caller === 'planner');
    expect(planner?.backend).toBe('claude-cli');
    expect(planner?.model).toBe('claude-sonnet-4');
  });

  test('claude-cli bot with plannerBackend=ollama: planner goes to the bare ollama client with the ollama model', async () => {
    const claude = client('claude-cli', () => Promise.resolve({ text: idlePlan }));
    const ollama = client('ollama', () => Promise.resolve({ text: idlePlan }));
    const wrapped = new LLMClientWithFallback(claude, ollama, mockLogger());
    const h = makeHarness({
      botConfig: { id: 'bot1', llmBackend: 'claude-cli', agentLoop: { plannerBackend: 'ollama' } },
      llmClient: wrapped,
      dataDir,
    });

    await h.loop.runOne('bot1');

    expect(ollama.generate).toHaveBeenCalledTimes(1);
    expect(claude.generate).not.toHaveBeenCalled();
    const [, genOpts] = ollama.generate.mock.calls[0];
    expect(genOpts.model).toBe('glm-5.2:cloud');
    expect(h.queryLog.find((e) => e.caller === 'planner')?.backend).toBe('ollama');
  });

  test('a claude-cli failure surfaces as an error instead of silently moving to ollama', async () => {
    const claude = client('claude-cli', () =>
      Promise.reject(new Error('Claude CLI exited with code 1'))
    );
    const ollama = client('ollama', () => Promise.resolve({ text: idlePlan }));
    const wrapped = new LLMClientWithFallback(claude, ollama, mockLogger());
    const h = makeHarness({
      botConfig: { id: 'bot1', llmBackend: 'claude-cli' },
      llmClient: wrapped,
      dataDir,
    });

    const result = await h.loop.runOne('bot1');

    expect(result.status).toBe('error');
    expect(result.summary).toContain('Claude CLI exited');
    expect(ollama.generate).not.toHaveBeenCalled();
  });
});

describe('AgentLoop — backend circuit breaker', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'aibot-agent-loop-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('three 429s open the ollama circuit; the next cycle is skipped without an LLM call or memory spam', async () => {
    const ollama = client('ollama', () => Promise.reject(new Error(QUOTA_ERR)));
    const h = makeHarness({
      botConfig: { id: 'bot1', llmBackend: 'ollama' },
      llmClient: ollama,
      dataDir,
    });
    syncSchedules(h.loop);

    for (let i = 0; i < 3; i++) {
      const r = await h.loop.runOne('bot1');
      expect(r.status).toBe('error');
    }
    const state = h.loop.getCircuitState();
    expect(state.ollama.open).toBe(true);
    expect(state.ollama.consecutiveFailures).toBe(3);
    expect(state.ollama.lastError).toContain('429');
    // weekly quota text → 6h cooldown
    expect(state.ollama.until).toBeGreaterThan(Date.now() + 5 * 3_600_000);
    expect(ollama.generate).toHaveBeenCalledTimes(3);

    const skipped = await h.loop.runOne('bot1');
    expect(skipped.status).toBe('skipped');
    expect(skipped.skippedReason).toBe('circuit-open:ollama');
    expect(skipped.summary).toMatch(
      /^Agent loop: skipped — ollama circuit open until \d{4}-\d{2}-\d{2}T/
    );
    expect(ollama.generate).toHaveBeenCalledTimes(3);
    expect((h.loop as any).scheduler.getSchedule('bot1').skippedReason).toBe('circuit-open:ollama');

    // Exactly one info log for the skip
    const skipLogs = h.botLogger.info.mock.calls.filter((c: any[]) =>
      String(c[1] ?? c[0]).startsWith('Agent loop: skipped — ollama circuit open until')
    );
    expect(skipLogs).toHaveLength(1);

    // Memory: the failure that tripped the circuit and the skip add no [ERROR] lines
    const errorLines = h.memory.filter((l) => l.includes('[ERROR]'));
    expect(errorLines.length).toBeLessThanOrEqual(2);
  });

  test('a bot on a different planner backend is not affected by the open circuit', async () => {
    const ollama = client('ollama', () => Promise.reject(new Error(QUOTA_ERR)));
    const h = makeHarness({
      botConfig: { id: 'bot1', llmBackend: 'ollama' },
      llmClient: ollama,
      dataDir,
      agentLoop: { circuitBreaker: { threshold: 1 } },
    });
    await h.loop.runOne('bot1');
    expect(h.loop.getCircuitState().ollama.open).toBe(true);

    // Same loop instance, a second bot whose planner runs on claude-cli
    const claude = client('claude-cli', () => Promise.resolve({ text: idlePlan }));
    h.ctx.config.bots.push({ id: 'bot2', name: 'Bot 2', llmBackend: 'claude-cli' });
    h.ctx.runningBots.add('bot2');
    h.ctx.getLLMClient = (id: string) => (id === 'bot2' ? claude : ollama);
    h.ctx.soulLoaders.set('bot2', h.ctx.soulLoaders.get('bot1'));

    const r = await h.loop.runOne('bot2');
    expect(r.status).toBe('completed');
    expect(claude.generate).toHaveBeenCalledTimes(1);
  });

  test('a successful planner call closes the circuit', async () => {
    let fail = true;
    const ollama = client('ollama', () =>
      fail ? Promise.reject(new Error(QUOTA_ERR)) : Promise.resolve({ text: idlePlan })
    );
    const h = makeHarness({
      botConfig: { id: 'bot1', llmBackend: 'ollama' },
      llmClient: ollama,
      dataDir,
      agentLoop: { circuitBreaker: { threshold: 1, cooldownMs: 1, weeklyQuotaCooldownMs: 1 } },
    });
    await h.loop.runOne('bot1');
    expect(h.loop.getCircuitState().ollama.open).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    fail = false;
    const probe = await h.loop.runOne('bot1'); // half-open probe
    expect(probe.status).toBe('completed');
    const state = h.loop.getCircuitState().ollama;
    expect(state.open).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
  });
});

describe('AgentLoop — hard engagement gate', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'aibot-agent-loop-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seedOutputs(loop: AgentLoop, count: number): void {
    syncSchedules(loop);
    const schedule = (loop as any).scheduler.getSchedule('bot1');
    for (let i = 0; i < count; i++) {
      schedule.recentActions.push({
        cycle: i + 1,
        timestamp: Date.now() - (count - i) * 60_000,
        tools: ['file_write'],
        planSummary: `Create file ${i}`,
      });
    }
  }

  test('default (hard): a CONTENT plan after 5 unanswered outputs is downgraded to idle', async () => {
    const ollama = client('ollama', () => Promise.resolve({ text: contentPlan }));
    const h = makeHarness({
      botConfig: { id: 'bot1', llmBackend: 'ollama' },
      llmClient: ollama,
      dataDir,
    });
    seedOutputs(h.loop, 5);

    const r = await h.loop.runOne('bot1');

    expect(r.status).toBe('completed');
    expect(r.isIdle).toBe(true);
    expect(r.plan).toEqual([]);
    expect(r.summary).toBe(
      'Engagement gate: content blocked until feedback (5 outputs, 0 feedback)'
    );
    expect(ollama.chat).not.toHaveBeenCalled();
    const gateLogs = h.botLogger.warn.mock.calls.filter((c: any[]) =>
      String(c[1] ?? c[0]).startsWith('Engagement gate: content blocked')
    );
    expect(gateLogs).toHaveLength(1);
  });

  test('hard gate lets an OUTREACH plan reach the executor', async () => {
    const ollama = client('ollama', () => Promise.resolve({ text: outreachPlan }));
    const h = makeHarness({
      botConfig: { id: 'bot1', llmBackend: 'ollama' },
      llmClient: ollama,
      dataDir,
    });
    seedOutputs(h.loop, 5);

    const r = await h.loop.runOne('bot1');

    expect(r.status).toBe('completed');
    expect(r.isIdle).toBeFalsy();
    expect(ollama.chat).toHaveBeenCalledTimes(1);
  });

  test('soft mode only annotates: the CONTENT plan still executes', async () => {
    const ollama = client('ollama', () => Promise.resolve({ text: contentPlan }));
    const h = makeHarness({
      botConfig: {
        id: 'bot1',
        llmBackend: 'ollama',
        agentLoop: { engagementGate: { enabled: true, mode: 'soft', threshold: 5 } },
      },
      llmClient: ollama,
      dataDir,
    });
    seedOutputs(h.loop, 5);

    const r = await h.loop.runOne('bot1');

    expect(r.status).toBe('completed');
    expect(r.isIdle).toBeFalsy();
    expect(ollama.chat).toHaveBeenCalledTimes(1);
  });

  test('human feedback recorded on the schedule lifts the hard gate', async () => {
    const ollama = client('ollama', () => Promise.resolve({ text: contentPlan }));
    const h = makeHarness({
      botConfig: { id: 'bot1', llmBackend: 'ollama' },
      llmClient: ollama,
      dataDir,
    });
    seedOutputs(h.loop, 5);
    (h.loop as any).scheduler.recordFeedbackEvent('bot1', 'human_message');

    const r = await h.loop.runOne('bot1');

    expect(r.status).toBe('completed');
    expect(r.isIdle).toBeFalsy();
    expect(ollama.chat).toHaveBeenCalledTimes(1);
  });
});
