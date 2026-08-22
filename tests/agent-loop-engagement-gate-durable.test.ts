/**
 * Engagement gate — durable output sourcing (regression).
 *
 * The gate used to count outputs from `BotSchedule.recentActions`, an
 * in-memory window that resets with the container. Three restarts in a day
 * left it at 1–3 entries and the gate never fired, while the outcome ledger
 * showed 65 unconsumed outputs. These tests drive a full agent-loop cycle
 * with an empty recent-actions window and a loaded ledger.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/bot/agent-loop';
import { OutcomeLedger } from '../src/bot/outcome-ledger';
import { GlobalAgentLoopConfigSchema } from '../src/config';

const HOUR = 3_600_000;

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

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aibot-engagement-gate-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const contentPlan = JSON.stringify({
  reasoning: 'more docs',
  plan: ['Write and create docs/guide-66.md'],
  priority: 'medium',
});
const outreachPlan = JSON.stringify({
  reasoning: 'check in',
  plan: ['Use ask_human to check in with the operator about the drafts'],
  priority: 'medium',
});

/** Seed `count` CONTENT outcomes into the ledger, all `agedHours` old. */
function seedLedger(count: number, agedHours = 4): string {
  const ledgerDir = join(dataDir, 'outcome-ledger');
  mkdirSync(join(ledgerDir, 'bot1'), { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        id: `e${i}`,
        botId: 'bot1',
        timestamp: Date.now() - agedHours * HOUR,
        type: 'CONTENT',
        description: `guide ${i}`,
        toolCalls: [],
        status: 'produced',
      })
    );
  }
  writeFileSync(join(ledgerDir, 'bot1', 'outcomes.jsonl'), `${lines.join('\n')}\n`, 'utf-8');
  return ledgerDir;
}

function makeLoop(plan: string, ledgerDir?: string) {
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
    backend: 'ollama',
    generate: mock(() => Promise.resolve({ text: plan })),
    chat: mock(() => Promise.resolve({ text: 'executed' })),
    getBackendClient: () => llm,
  };
  const botConfig = { id: 'bot1', name: 'Bot 1' };
  const ctx: any = {
    config: {
      agentLoop: GlobalAgentLoopConfigSchema.parse({ strategist: { enabled: false } }),
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
    tools: [],
    soulLoaders: new Map([['bot1', soulLoader]]),
    llmClients: new Map([['bot1', llm]]),
    agentFeedbackStore: { getPending: () => [] },
    askHumanStore: { consumeAnswersForBot: () => [], getPendingForBot: () => [] },
    askPermissionStore: {
      consumeDecisionsForBot: () => [],
      getPendingForBot: () => [],
      reportExecution: () => {},
    },
    llmQueryLog: { append: () => {} },
    sessionManager: { listSessions: () => [] },
    getLLMClient: () => llm,
    getActiveModel: () => 'm',
    getBotLogger: () => mockLogger(),
    getSoulLoader: () => soulLoader,
    resolveBotId: (id: string) => id,
    activityStream: { publish: mock(() => {}) },
  };
  const loop = new AgentLoop(
    ctx,
    { build: () => 'system' } as any,
    { getDefinitionsForBot: () => [], getDefinitionsByCategories: () => [] } as any
  );
  if (ledgerDir) loop.setOutcomeLedger(new OutcomeLedger(ledgerDir, mockLogger()));
  const scheduler = (loop as any).scheduler;
  scheduler.syncSchedules();
  return { loop, ctx, scheduler };
}

describe('engagement gate reads the outcome ledger, not the in-memory window', () => {
  test('REGRESSION: 65 ledger outputs and no feedback gate a CONTENT plan with an empty window', async () => {
    const ledgerDir = seedLedger(65);
    const { loop, scheduler } = makeLoop(contentPlan, ledgerDir);
    expect(scheduler.getSchedule('bot1').recentActions).toEqual([]);

    const result = await loop.runOne('bot1');

    expect(result.summary).toBe(
      'Engagement gate: content blocked until feedback (65 outputs, 0 feedback)'
    );
    expect(result.toolCalls).toEqual([]);
  });

  test('one real feedback event un-gates the same bot', async () => {
    const ledgerDir = seedLedger(65);
    const { loop, scheduler } = makeLoop(contentPlan, ledgerDir);
    // A human replied one hour ago — after every ledger entry.
    scheduler.getSchedule('bot1').feedbackEvents = [
      { timestamp: Date.now() - HOUR, source: 'human_message' },
    ];

    const result = await loop.runOne('bot1');

    expect(result.summary).not.toContain('Engagement gate');
  });

  test('OUTREACH still passes while the gate is triggered', async () => {
    const ledgerDir = seedLedger(65);
    const { loop } = makeLoop(outreachPlan, ledgerDir);

    const result = await loop.runOne('bot1');

    expect(result.summary).not.toContain('Engagement gate');
  });

  test('a bot below the threshold is not gated', async () => {
    const ledgerDir = seedLedger(2);
    const { loop } = makeLoop(contentPlan, ledgerDir);

    const result = await loop.runOne('bot1');

    expect(result.summary).not.toContain('Engagement gate');
  });

  test('no ledger and no productions means no gate (nothing durable to count)', async () => {
    const { loop } = makeLoop(contentPlan);

    const result = await loop.runOne('bot1');

    expect(result.summary).not.toContain('Engagement gate');
  });
});
