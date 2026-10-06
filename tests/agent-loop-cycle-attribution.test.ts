/**
 * One agent-loop cycle: a cycleId stamped on every LLM query-log entry of the
 * cycle, the goal the planner named resolved to its id, and one row in
 * `<data>/agent-cycles/<botId>/YYYY-MM-DD.jsonl`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCycleGoal } from '../src/bot/agent-cycle-log';
import { AgentLoop } from '../src/bot/agent-loop';
import { GlobalAgentLoopConfigSchema } from '../src/config';
import { type GoalEntry, startGoal } from '../src/tools/goals';

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
  dataDir = mkdtempSync(join(tmpdir(), 'aibot-cycle-attrib-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const GOALS = `## Active Goals
- [ ] Monthly hands-on lab
  - status: in_progress
  - priority: medium
  - id: g-bbbbbbbb
`;

function makeLoop(
  plan: string,
  mode: 'periodic' | 'continuous' = 'periodic',
  goals: string = GOALS
) {
  const goalWrites: Array<{ content: string; opts: any }> = [];
  const soulLoader = {
    readIdentity: () => 'id',
    readSoul: () => 'soul',
    readMotivations: () => 'mot',
    readGoals: () => goals,
    readRecentDailyLogs: () => '',
    readDailyLogsSince: () => '',
    appendDailyMemory: () => {},
    writeGoals: (content: string, opts: any) => goalWrites.push({ content, opts }),
  };
  const llm: any = {
    backend: 'ollama',
    generate: mock(() => Promise.resolve({ text: plan })),
    chat: mock(() => Promise.resolve({ text: 'executed' })),
    getBackendClient: () => llm,
  };
  const queries: any[] = [];
  const botConfig = { id: 'bot1', name: 'Bot 1', agentLoop: { mode } };
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
    llmQueryLog: { append: (e: any) => queries.push(e) },
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
  (loop as any).scheduler.syncSchedules();
  return { loop, queries, goalWrites };
}

function cycleRows(): any[] {
  const dir = join(dataDir, 'agent-cycles', 'bot1');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) =>
    readFileSync(join(dir, f), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  );
}

describe('agent-loop cycle attribution', () => {
  test('stamps one cycleId on the cycle LLM calls and logs the cycle with its goal', async () => {
    const { loop, queries } = makeLoop(
      JSON.stringify({
        reasoning: 'lab',
        plan: ['Draft the October lab'],
        priority: 'medium',
        serves_goal: 'Monthly hands-on lab',
      })
    );
    await loop.runOne('bot1');

    expect(queries.length).toBeGreaterThan(0);
    const ids = new Set(queries.map((q) => q.cycleId));
    expect(ids.size).toBe(1);
    const [cycleId] = [...ids];
    expect(cycleId).toMatch(/^[0-9a-f-]{36}$/);
    const executor = queries.find((q) => q.caller === 'executor');
    expect(executor?.goalId).toBe('g-bbbbbbbb');

    const rows = cycleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cycleId,
      botId: 'bot1',
      status: 'completed',
      goalId: 'g-bbbbbbbb',
      goalTitle: 'Monthly hands-on lab',
      goalSource: 'planner',
      plan: ['Draft the October lab'],
      planSummary: 'Draft the October lab',
      priority: 'medium',
      toolCalls: 0,
      tools: [],
    });
    expect(typeof rows[0].durationMs).toBe('number');
    expect(Date.parse(rows[0].endedAt)).toBeGreaterThanOrEqual(Date.parse(rows[0].startedAt));
  });

  test('a plan naming no goal is logged unattributed, and each cycle gets a new id', async () => {
    const { loop } = makeLoop(
      JSON.stringify({ reasoning: 'x', plan: ['Do a thing'], priority: 'low' })
    );
    await loop.runOne('bot1');
    await loop.runOne('bot1');
    const rows = cycleRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].cycleId).not.toBe(rows[1].cycleId);
    expect(rows[0]).toMatchObject({ goalId: null, goalTitle: null, goalSource: null });
  });

  test('continuous mode resolves the planner goal too', async () => {
    const { loop } = makeLoop(
      JSON.stringify({
        reasoning: 'lab',
        plan: ['Draft the lab'],
        priority: 'medium',
        serves_goal: 'g-bbbbbbbb',
      }),
      'continuous'
    );
    await loop.runOne('bot1');
    expect(cycleRows()[0]).toMatchObject({ goalId: 'g-bbbbbbbb', goalSource: 'planner' });
  });

  test('an idle cycle is logged with status idle', async () => {
    const { loop } = makeLoop(JSON.stringify({ reasoning: 'wait', plan: [], priority: 'none' }));
    await loop.runOne('bot1');
    expect(cycleRows()[0]).toMatchObject({ status: 'idle', plan: [], toolCalls: 0 });
  });
});

describe('the goal a cycle worked on moves to In progress', () => {
  const PENDING = GOALS.replace('status: in_progress', 'status: pending');
  const plan = JSON.stringify({
    reasoning: 'lab',
    plan: ['Draft the October lab'],
    priority: 'medium',
    serves_goal: 'Monthly hands-on lab',
  });

  test('a To do goal served by a completed cycle is started, by the agent, with the cycleId', async () => {
    const { loop, goalWrites } = makeLoop(plan, 'periodic', PENDING);
    await loop.runOne('bot1');
    expect(goalWrites).toHaveLength(1);
    expect(goalWrites[0].content).toContain('status: in_progress');
    expect(goalWrites[0].opts.actor).toBe('agent');
    expect(goalWrites[0].opts.cycleId).toBe(cycleRows()[0].cycleId);
  });

  test('a goal already in progress is left alone', async () => {
    const { loop, goalWrites } = makeLoop(plan);
    await loop.runOne('bot1');
    expect(goalWrites).toHaveLength(0);
  });

  test('an idle cycle never moves a goal', async () => {
    const { loop, goalWrites } = makeLoop(
      JSON.stringify({
        reasoning: 'wait',
        plan: [],
        priority: 'none',
        serves_goal: 'Monthly hands-on lab',
      }),
      'periodic',
      PENDING
    );
    await loop.runOne('bot1');
    expect(goalWrites).toHaveLength(0);
  });
});

describe('startGoal', () => {
  test('moves a To do goal to in_progress by id; null when missing or already started', () => {
    const pending = GOALS.replace('status: in_progress', 'status: pending');
    expect(startGoal(pending, 'g-bbbbbbbb')).toContain('status: in_progress');
    expect(startGoal(GOALS, 'g-bbbbbbbb')).toBeNull();
    expect(startGoal(pending, 'g-nope')).toBeNull();
    expect(
      startGoal(pending.replace('status: pending', 'status: blocked'), 'g-bbbbbbbb')
    ).toBeNull();
  });
});

describe('resolveCycleGoal', () => {
  const goals: GoalEntry[] = [
    { text: 'Weekly brief', status: 'pending', priority: 'high', id: 'g-aaaaaaaa' },
    { text: 'Monthly hands-on lab', status: 'in_progress', priority: 'medium', id: 'g-bbbbbbbb' },
  ];

  test('planner wins, then strategist, then a manage_goals call, else null', () => {
    expect(
      resolveCycleGoal({ planner: 'Weekly brief', strategist: 'Monthly hands-on lab' }, goals)
    ).toEqual({ goalId: 'g-aaaaaaaa', goalTitle: 'Weekly brief', goalSource: 'planner' });
    expect(resolveCycleGoal({ planner: 'nope', strategist: 'g-bbbbbbbb' }, goals)).toMatchObject({
      goalId: 'g-bbbbbbbb',
      goalSource: 'strategist',
    });
    expect(
      resolveCycleGoal(
        {
          toolCalls: [
            { name: 'web_search', args: { q: 'x' } },
            { name: 'manage_goals', args: { action: 'update', goal: 'hands-on lab' } },
          ],
        },
        goals
      )
    ).toMatchObject({ goalId: 'g-bbbbbbbb', goalSource: 'manage_goals' });
    expect(resolveCycleGoal({}, goals)).toEqual({
      goalId: null,
      goalTitle: null,
      goalSource: null,
    });
  });
});
