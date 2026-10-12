/**
 * One agent-loop cycle: a cycleId stamped on every LLM query-log entry of the
 * cycle, the goal the planner named resolved to its id, and one row in
 * `<data>/agent-cycles/<botId>/YYYY-MM-DD.jsonl`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explainCycle, resolveCycleGoal } from '../src/bot/agent-cycle-log';
import { AgentLoop } from '../src/bot/agent-loop';
import { CuriosityService } from '../src/bot/curiosity/service';
import { TraitRegisters } from '../src/bot/trait-registers';
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
  goals: string = GOALS,
  generate?: (prompt: string, opts: { system?: string }) => Promise<{ text: string }>
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
    generate: mock(generate ?? (() => Promise.resolve({ text: plan }))),
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
  return { loop, queries, goalWrites, ctx };
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

  test('the agent:idle event carries the cycle id and a Why with the planner reasoning', async () => {
    const { loop, ctx } = makeLoop(
      JSON.stringify({ reasoning: 'Waiting for feedback.', plan: [], priority: 'none' })
    );
    await loop.runOne('bot1');
    const idle = ctx.activityStream.publish.mock.calls
      .map((c: any[]) => c[0])
      .find((e: any) => e.type === 'agent:idle');
    const cycleId = cycleRows()[0].cycleId;
    expect(idle.data.reasoning).toBe('Waiting for feedback.');
    expect(idle.data.cycleId).toBe(cycleId);
    expect(idle.data.why).toMatchObject({
      what: 'Idle cycle',
      cycle: { id: cycleId, botId: 'bot1' },
      reason: { text: 'Waiting for feedback.', source: 'Planner' },
    });
  });
});

describe('a curiosity dispatch carries the cycle that produced it', () => {
  test('origin has the cycleId and goal of the cycle row', async () => {
    const plan = JSON.stringify({
      reasoning: 'lab',
      plan: ['Draft the October lab'],
      priority: 'medium',
      serves_goal: 'Monthly hands-on lab',
    });
    const extractor = JSON.stringify({
      topic: 'Lab design',
      findings: [{ claim: 'c', evidence: 'e', confidence: 'medium' }],
      surprises: [],
      open_questions: [],
      frontier: [],
      served_directive_ids: [],
      no_surprise: true,
      dispatch: {
        hook: 'Labs land better with a dataset',
        why_care: 'w',
        evidence: 'e',
        action: 'a',
      },
    });
    const editor = JSON.stringify({
      insight: 0.2,
      novelty: 0.2,
      backed: 0.9,
      verdict: 'hold',
      notes: 'n',
    });
    const { loop } = makeLoop(plan, 'periodic', GOALS, async (_p, opts) => {
      const sys = opts?.system ?? '';
      if (/distill one work cycle/i.test(sys)) return { text: extractor };
      if (/editor/i.test(sys)) return { text: editor };
      return { text: plan };
    });
    const soulDir = join(dataDir, 'soul', 'bot1');
    const svc = new CuriosityService({
      getSoulDir: () => soulDir,
      getCuriosityInputs: () => ({ global: undefined, bot: {} }),
    });
    loop.setCuriosityService(svc);
    await loop.runOne('bot1');
    await svc.waitForNavigator('bot1');

    const [row] = cycleRows();
    const [dispatch] = svc.storeFor('bot1')!.listDispatches();
    expect(dispatch?.origin).toMatchObject({
      trigger: 'insight',
      cycleId: row.cycleId,
      goalId: 'g-bbbbbbbb',
      goalTitle: 'Monthly hands-on lab',
      plan: 'Draft the October lab',
    });
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

describe('agent-loop feedback attribution', () => {
  test('feedback handled in a cycle is marked with that cycle id (why plan row 18)', async () => {
    const { loop, ctx } = makeLoop(
      JSON.stringify({ reasoning: 'x', plan: ['Do a thing'], priority: 'low' })
    );
    const applied: any[] = [];
    let served = false;
    ctx.agentFeedbackStore = {
      getPending: () => {
        if (served) return [];
        served = true;
        return [{ id: 'fb1', botId: 'bot1', content: 'Shorter', createdAt: '', status: 'pending' }];
      },
      markApplied: (...args: any[]) => applied.push(args),
    };
    await loop.runOne('bot1');
    expect(applied).toHaveLength(1);
    expect(applied[0][1]).toBe('fb1');
    expect(applied[0][3]).toEqual({ cycleId: cycleRows()[0].cycleId });
  });
});

describe('runningCycle: what a running cycle is doing, for collab events (Why row 17)', () => {
  test('during the executor: the cycle id, its plan and the goal it serves; nothing after', async () => {
    const { loop, ctx } = makeLoop(
      JSON.stringify({
        reasoning: 'lab',
        plan: ['Draft the October lab', 'Ask the researcher'],
        priority: 'medium',
        serves_goal: 'Monthly hands-on lab',
      })
    );
    let seen: unknown;
    const llm = ctx.getLLMClient();
    llm.chat = mock(() => {
      seen = loop.runningCycle('bot1');
      return Promise.resolve({ text: 'executed' });
    });
    await loop.runOne('bot1');
    expect(seen).toMatchObject({
      plan: 'Draft the October lab; Ask the researcher',
      goalId: 'g-bbbbbbbb',
      goalTitle: 'Monthly hands-on lab',
    });
    expect((seen as { cycleId: string }).cycleId).toBe(cycleRows()[0].cycleId);
    expect(loop.runningCycle('bot1')).toBeUndefined();
  });
});

describe('the cycle row says why (why-everywhere row 11)', () => {
  test('an idle cycle records the planner reasoning; the strategist did not run', async () => {
    const { loop } = makeLoop(
      JSON.stringify({ reasoning: 'Waiting for feedback.', plan: [], priority: 'none' })
    );
    await loop.runOne('bot1');
    expect(cycleRows()[0]).toMatchObject({
      status: 'idle',
      reason: 'Waiting for feedback.',
      reasonSource: 'planner',
      strategistRan: false,
    });
    expect(cycleRows()[0].reflection).toBeUndefined();
  });

  test('a cycle skipped by an open circuit records the skippedReason', async () => {
    const { loop } = makeLoop('{}');
    (loop as any).circuitBreaker.shouldSkip = () => ({ skip: true, until: Date.now() + 60_000 });
    await loop.runOne('bot1');
    expect(cycleRows()[0]).toMatchObject({
      status: 'skipped',
      reason: 'circuit-open:ollama',
      reasonSource: 'circuit-breaker',
      strategistRan: false,
    });
  });

  test('a strategist run records its reflection and the trait deltas it applied, with their reasons', async () => {
    const strategist = JSON.stringify({
      goal_operations: [],
      single_deliverable: 'Draft the October lab',
      reflection: 'Three web_fetch errors on the same host this week.',
      trait_adjustments: { caution: 0.03 },
      trait_reasons: { caution: 'web_fetch failed on the same host three times.' },
    });
    const plan = JSON.stringify({ reasoning: 'r', plan: ['Draft'], priority: 'medium' });
    const { loop, ctx } = makeLoop(plan, 'periodic', GOALS, (_p, opts) =>
      Promise.resolve({ text: /strategic oversight/i.test(opts?.system ?? '') ? strategist : plan })
    );
    ctx.config.bots[0].agentLoop.strategist = { enabled: true, everyCycles: 1 };
    const sched = (loop as any).scheduler.getSchedule('bot1');
    sched.strategistCycleCount = 1;
    sched.lastStrategistAt = null;
    const traits = new TraitRegisters(join(dataDir, 'traits'), mockLogger());
    traits.load('bot1');
    loop.setTraitRegisters(traits);
    await loop.runOne('bot1');
    const row = cycleRows()[0];
    expect(row).toMatchObject({
      strategistRan: true,
      reflection: 'Three web_fetch errors on the same host this week.',
      traitAdjustments: { caution: 0.03 },
    });
    const snap = traits.getHistory('bot1').at(-1);
    expect(snap).toMatchObject({
      source: 'strategist',
      cycleId: row.cycleId,
      reasons: { caution: 'web_fetch failed on the same host three times.' },
    });
  });
});

describe('explainCycle', () => {
  const base = { plannerReasoning: '', strategistRan: false, summary: '' };

  test('idle: the engagement gate wins over the planner', () => {
    expect(
      explainCycle('idle', {
        ...base,
        plannerReasoning: 'post more',
        idleRule: 'Engagement gate: content blocked until feedback (6 outputs, 0 feedback)',
      })
    ).toEqual({
      reason: 'Engagement gate: content blocked until feedback (6 outputs, 0 feedback)',
      reasonSource: 'engagement-gate',
      strategistRan: false,
    });
    expect(explainCycle('idle', { ...base, summary: 'Planner produced no plan steps.' })).toEqual({
      reason: 'Planner produced no plan steps.',
      reasonSource: 'planner',
      strategistRan: false,
    });
  });

  test('skipped and error say what stopped them; completed has no reason', () => {
    expect(
      explainCycle('skipped', { ...base, summary: 'API call quota exceeded for tenant' })
    ).toMatchObject({ reason: 'API call quota exceeded for tenant', reasonSource: 'system' });
    expect(explainCycle('error', { ...base, summary: 'Agent loop error: boom' })).toMatchObject({
      reason: 'Agent loop error: boom',
      reasonSource: 'error',
    });
    expect(explainCycle('error', undefined)).toEqual({ strategistRan: false });
    expect(explainCycle('completed', { ...base, plannerReasoning: 'x' })).toEqual({
      strategistRan: false,
    });
  });

  test('the reflection is capped at 600 chars', () => {
    const out = explainCycle('completed', {
      ...base,
      strategistRan: true,
      strategistReflection: 'x'.repeat(900),
    });
    expect(out.strategistRan).toBe(true);
    expect(out.reflection?.length).toBe(600);
    expect(out.reflection?.endsWith('…')).toBe(true);
  });
});
