/**
 * The agent loop acts on the planner's task fields (goal tasks plan, phase 1):
 * writes `new_tasks` through the TaskStore, dispatches named tasks to the
 * worker pool when workers are on, stamps the served task on the cycle's work
 * and records all of it on the cycle row. Never on an idle cycle.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/bot/agent-loop';
import { GlobalAgentLoopConfigSchema } from '../../src/config';
import { TaskStore } from '../../src/goals/task-store';
import type { DispatchRequest, WorkerPoolApi, WorkerRunView } from '../../src/workers/types';

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

const GOALS = `## Active Goals
- [ ] Monthly hands-on lab
  - status: in_progress
  - priority: medium
  - id: g-bbbbbbbb
`;

let dataDir: string;
let soulDir: string;
let store: TaskStore;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aibot-planner-tasks-'));
  soulDir = join(dataDir, 'soul');
  mkdirSync(soulDir, { recursive: true });
  writeFileSync(join(soulDir, 'GOALS.md'), GOALS);
  store = new TaskStore(soulDir);
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function fakePool(
  enabled: boolean,
  runs: WorkerRunView[] = []
): WorkerPoolApi & { requests: DispatchRequest[] } {
  const requests: DispatchRequest[] = [];
  return {
    requests,
    isEnabledFor: () => enabled,
    dispatch: (req) => {
      requests.push(req);
      return req.taskIds.map((taskId) => ({
        taskId,
        ok: true,
        runId: `run-${taskId}`,
        queued: true,
      }));
    },
    list: () => runs,
    get: () => null,
    journal: () => [],
    stop: () => false,
    retry: () => ({ taskId: '', ok: false, reason: 'invalid', message: '' }),
    onAnswer: () => {},
    abortAll: async () => {},
    recover: () => {},
    stats: () => ({ running: 0, queued: 0, waiting: 0, byBot: {} }),
    subscribe: () => () => {},
  };
}

function makeLoop(plan: string, pool?: WorkerPoolApi) {
  const soulLoader = {
    readIdentity: () => 'id',
    readSoul: () => 'soul',
    readMotivations: () => 'mot',
    readGoals: () => GOALS,
    readTasks: () => store.listForGoals(GOALS),
    getTaskStore: () => store,
    readRecentDailyLogs: () => '',
    readDailyLogsSince: () => '',
    appendDailyMemory: () => {},
    writeGoals: () => {},
  };
  const systems: string[] = [];
  const llm: any = {
    backend: 'ollama',
    generate: mock((_p: string, opts: { system?: string }) => {
      systems.push(opts?.system ?? '');
      return Promise.resolve({ text: plan });
    }),
    chat: mock(() => Promise.resolve({ text: 'executed' })),
    getBackendClient: () => llm,
  };
  const botConfig = { id: 'bot1', name: 'Bot 1', agentLoop: { mode: 'periodic' } };
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
      soul: { dir: soulDir },
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
    ...(pool ? { workerPool: pool } : {}),
  };
  const loop = new AgentLoop(
    ctx,
    { build: () => 'system' } as any,
    { getDefinitionsForBot: () => [], getDefinitionsByCategories: () => [] } as any
  );
  (loop as any).scheduler.syncSchedules();
  return { loop, ctx, llm, systems };
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

describe('agent loop: planner task fields', () => {
  test('writes new_tasks, dispatches the named ones and records both on the cycle row', async () => {
    const pool = fakePool(true);
    const { loop } = makeLoop(
      JSON.stringify({
        reasoning: 'break the lab down',
        plan: ['Pick the lab topic'],
        priority: 'medium',
        serves_goal: 'g-bbbbbbbb',
        new_tasks: {
          goal: 'g-bbbbbbbb',
          tasks: ['Pick the lab topic', 'Book the room', 'Send invitations'],
        },
        dispatch: ['Book the room'],
        serves_task: 'Pick the lab topic',
      }),
      pool
    );
    await loop.runOne('bot1');
    const tasks = store.forGoal('g-bbbbbbbb');
    expect(tasks.map((t) => t.text)).toEqual([
      'Pick the lab topic',
      'Book the room',
      'Send invitations',
    ]);
    const [pick, book] = tasks.map((t) => t.id);
    expect(pool.requests).toHaveLength(1);
    expect(pool.requests[0].taskIds).toEqual([book]);
    const [row] = cycleRows();
    expect(pool.requests[0].cycleId).toBe(row.cycleId);
    expect(tasks[0].createdCycle).toBe(row.cycleId);
    expect(row.newTasks).toEqual(tasks.map((t) => t.id));
    expect(row.dispatched).toEqual([{ taskId: book, runId: `run-${book}`, ok: true }]);
    expect(row.taskId).toBe(pick);
    expect(row.taskText).toBe('Pick the lab topic');
  });

  test('the executor runs with the served task on its attribution', async () => {
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'Book the room' }], { actor: 'agent' });
    const id = store.list()[0].id;
    const { loop, llm } = makeLoop(
      JSON.stringify({
        reasoning: 'r',
        plan: ['Book the room'],
        priority: 'medium',
        serves_task: id,
      })
    );
    let seen: any;
    llm.chat = mock(() => {
      seen = { ...(loop as any).cycleAttribution.get('bot1') };
      return Promise.resolve({ text: 'executed' });
    });
    await loop.runOne('bot1');
    expect(seen.taskId).toBe(id);
    // the task names its goal, so the cycle is attributed to it
    expect(seen.goalId).toBe('g-bbbbbbbb');
  });

  test('an idle cycle writes no task and dispatches nothing', async () => {
    const pool = fakePool(true);
    const { loop } = makeLoop(
      JSON.stringify({
        reasoning: 'waiting',
        plan: [],
        priority: 'none',
        new_tasks: { goal: 'g-bbbbbbbb', tasks: ['Book the room', 'Send invitations'] },
        dispatch: ['Book the room'],
      }),
      pool
    );
    await loop.runOne('bot1');
    expect(store.list()).toEqual([]);
    expect(pool.requests).toEqual([]);
    expect(cycleRows()[0].newTasks).toBeUndefined();
  });

  test('without workers: no dispatch call, no Workers block, no dispatch in the prompt', async () => {
    const pool = fakePool(false);
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'Book the room' }], { actor: 'agent' });
    const { loop, systems } = makeLoop(
      JSON.stringify({
        reasoning: 'r',
        plan: ['x'],
        priority: 'low',
        dispatch: [store.list()[0].id],
      }),
      pool
    );
    await loop.runOne('bot1');
    expect(pool.requests).toEqual([]);
    const planner = systems.find((s) => s.includes('JSON Schema')) ?? '';
    expect(planner).toContain('new_tasks');
    expect(planner).not.toContain('dispatch');
  });

  test('pending questions a worker run asked stay out of the planner (they show as its wait)', async () => {
    const { loop, ctx, systems } = makeLoop(
      JSON.stringify({ reasoning: 'r', plan: ['x'], priority: 'low' })
    );
    ctx.askHumanStore.getPendingForBot = () => [
      { id: 'q1', botId: 'bot1', chatId: 0, question: 'Cycle question?', createdAt: 1 },
      {
        id: 'q2',
        botId: 'bot1',
        chatId: 0,
        question: 'Worker question?',
        createdAt: 1,
        runId: 'r-9',
      },
    ];
    await loop.runOne('bot1');
    const planner = systems.find((s) => s.includes('JSON Schema')) ?? '';
    expect(planner).toContain('Cycle question?');
    expect(planner).not.toContain('Worker question?');
  });

  test('with workers: the planner sees the Workers block from the pool', async () => {
    const pool = fakePool(true, [
      {
        runId: 'r-1',
        botId: 'bot1',
        taskId: 't-abcdef',
        goalId: 'g-bbbbbbbb',
        dispatchCycleId: null,
        taskText: 'Book the room',
        goalTitle: 'Monthly hands-on lab',
        status: 'running',
        attempt: 1,
        step: 3,
        budget: { steps: 8, toolCalls: 40, wallMs: 1 },
        used: { steps: 3, toolCalls: 4, wallMs: 1 },
        createdAt: new Date().toISOString(),
      },
    ]);
    const { loop, systems } = makeLoop(
      JSON.stringify({ reasoning: 'r', plan: ['x'], priority: 'low' }),
      pool
    );
    await loop.runOne('bot1');
    const planner = systems.find((s) => s.includes('JSON Schema')) ?? '';
    expect(planner).toContain('## Workers');
    expect(planner).toContain('t-abcdef');
    expect(planner).toContain('step 3/8');
  });
});
