/**
 * The agent loop acts on the planner's task fields (goal tasks plan, phase 1):
 * writes `new_tasks` through the TaskStore, dispatches named tasks to the
 * worker pool when workers are on, stamps the served task on the cycle's work
 * and records all of it on the cycle row. Never on an idle cycle.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
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
import * as curiosityRunner from '../../src/bot/curiosity/runner';
import { writeGoalsFile } from '../../src/bot/goal-events';
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
    onAnswer: () => false,
    abortAll: async () => {},
    recover: () => {},
    stats: () => ({ running: 0, queued: 0, waiting: 0, byBot: {} }),
    subscribe: () => () => {},
  };
}

function makeLoop(
  plan: string | string[],
  pool?: WorkerPoolApi,
  opts: { goalsOnDisk?: boolean; extraCtx?: Record<string, unknown> } = {}
) {
  const goalsPath = join(soulDir, 'GOALS.md');
  const readGoals = () => (opts.goalsOnDisk ? readFileSync(goalsPath, 'utf-8') : GOALS);
  // A list of answers is served in order; the last one repeats.
  const answers = Array.isArray(plan) ? [...plan] : [plan];
  const soulLoader = {
    readIdentity: () => 'id',
    readSoul: () => 'soul',
    readMotivations: () => 'mot',
    readGoals,
    readTasks: () => store.listForGoals(readGoals()),
    getTaskStore: () => store,
    readRecentDailyLogs: () => '',
    readDailyLogsSince: () => '',
    appendDailyMemory: () => {},
    writeGoals: (content: string) => {
      if (opts.goalsOnDisk) writeGoalsFile(goalsPath, content, { actor: 'agent' });
    },
  };
  const systems: string[] = [];
  const llm: any = {
    backend: 'ollama',
    generate: mock((_p: string, opts: { system?: string }) => {
      systems.push(opts?.system ?? '');
      const text = answers.length > 1 ? (answers.shift() as string) : answers[0];
      return Promise.resolve({ text });
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
    ...(opts.extraCtx ?? {}),
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
    // Deliberately changed (S8): an empty plan that names tasks to write or
    // dispatch is a dispatch-only cycle (tests below). Idle is an empty plan
    // with nothing to write or dispatch; its serves_task is not stamped.
    const pool = fakePool(true);
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'Book the room' }], { actor: 'agent' });
    const { loop } = makeLoop(
      JSON.stringify({
        reasoning: 'waiting',
        plan: [],
        priority: 'none',
        serves_task: store.list()[0].id,
      }),
      pool
    );
    await loop.runOne('bot1');
    expect(store.list()).toHaveLength(1);
    expect(pool.requests).toEqual([]);
    const [row] = cycleRows();
    expect(row.status).toBe('idle');
    expect(row.newTasks).toBeUndefined();
    expect(row.taskId).toBeUndefined();
  });

  test('a cycle the engagement gate turns down still writes its breakdown, never dispatches', async () => {
    const pool = fakePool(true);
    // six unreviewed creates and no feedback: the hard gate holds content back
    const now = Date.now();
    const changelog = Array.from({ length: 6 }, (_, i) => ({
      timestamp: new Date(now - (i + 1) * 60_000).toISOString(),
      action: 'create',
      path: `0${i}_draft.md`,
    }));
    const { loop } = makeLoop(
      JSON.stringify({
        reasoning: 'write the handout',
        plan: ['Write the lab handout and save it to productions'],
        priority: 'medium',
        serves_goal: 'g-bbbbbbbb',
        new_tasks: { goal: 'g-bbbbbbbb', tasks: ['Pick the lab topic', 'Book the room'] },
        dispatch: ['Book the room'],
      }),
      pool,
      { extraCtx: { productionsService: { getChangelog: () => changelog } } }
    );
    await loop.runOne('bot1');
    const [row] = cycleRows();
    expect(row.status).toBe('idle');
    expect(row.reason).toContain('Engagement gate');
    expect(store.forGoal('g-bbbbbbbb').map((t) => t.text)).toEqual([
      'Pick the lab topic',
      'Book the room',
    ]);
    expect(row.newTasks).toHaveLength(2);
    expect(pool.requests).toEqual([]);
  });

  test('a standing_goal answer reaches GOALS.md as kind: standing', async () => {
    const { loop } = makeLoop(
      JSON.stringify({
        reasoning: 'a recurring duty',
        plan: ['Do one round of the lab prep'],
        priority: 'medium',
        serves_goal: 'g-bbbbbbbb',
        standing_goal: 'g-bbbbbbbb',
      }),
      undefined,
      { goalsOnDisk: true }
    );
    await loop.runOne('bot1');
    expect(readFileSync(join(soulDir, 'GOALS.md'), 'utf-8')).toContain('- kind: standing');
  });

  test('the cycle row records what the planner was offered and what it answered about tasks', async () => {
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'Book the room' }], { actor: 'agent' });
    const pool = fakePool(true);
    const { loop } = makeLoop(
      JSON.stringify({
        reasoning: 'r',
        plan: ['Book the room'],
        priority: 'medium',
        serves_task: store.list()[0].id,
      }),
      pool
    );
    await loop.runOne('bot1');
    const [row] = cycleRows();
    expect(row.plannerTasks).toEqual({
      serves_task: store.list()[0].id,
      workersOffered: true,
      openTasks: 1,
    });
  });

  test('an idle answer still records the planner task answer (nothing offered to dispatch)', async () => {
    const { loop } = makeLoop(JSON.stringify({ reasoning: 'nothing', plan: [], priority: 'none' }));
    await loop.runOne('bot1');
    const [row] = cycleRows();
    expect(row.status).toBe('idle');
    expect(row.plannerTasks).toEqual({ workersOffered: false, openTasks: 0 });
  });

  test('N7: priority none stays idle even with new_tasks and dispatch; nothing is written', async () => {
    const pool = fakePool(true);
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'Book the room' }], { actor: 'agent' });
    const id = store.list()[0].id;
    const { loop, llm } = makeLoop(
      JSON.stringify({
        reasoning: 'waiting for the operator',
        plan: [],
        priority: 'none',
        new_tasks: { goal: 'g-bbbbbbbb', tasks: ['Send invitations'] },
        dispatch: [id],
      }),
      pool
    );
    const result = await loop.runOne('bot1');
    expect(result.isIdle).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(pool.requests).toEqual([]);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(cycleRows()[0].status).toBe('idle');
  });

  test('N7: an add-only cycle (new_tasks, no dispatch) earns no repetition karma', async () => {
    const pool = fakePool(true);
    const answer = (task: string) =>
      JSON.stringify({
        reasoning: 'break it down',
        plan: [],
        priority: 'low',
        new_tasks: { goal: 'g-bbbbbbbb', tasks: [task] },
      });
    const { loop, ctx } = makeLoop(
      ['Book the room', 'Send invitations', 'Order food', 'Print badges'].map(answer),
      pool
    );
    ctx.config.karma = { enabled: true };
    const karma = {
      addEvent: mock(() => {}),
      recordOutcome: mock(() => null),
      renderForPrompt: () => '',
    };
    (loop as any).karmaService = karma;
    for (let i = 0; i < 4; i++) {
      await loop.runOne('bot1');
      // The goal has no open task again (new_tasks only breaks down such a goal).
      for (const t of store.list().filter((x) => x.lane !== 'done'))
        store.apply([{ op: 'move', id: t.id, lane: 'done' }], { actor: 'operator' });
    }
    expect(store.list()).toHaveLength(4);
    expect(karma.addEvent).not.toHaveBeenCalled();
  });

  test('dispatch-only: an empty plan that dispatches is a completed cycle with no executor', async () => {
    // Deliberately changed (N7): priority was 'none'; an idle answer now stays
    // idle, so a dispatch-only answer needs a real priority.
    const pool = fakePool(true);
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'Book the room' }], { actor: 'agent' });
    const id = store.list()[0].id;
    const { loop, llm } = makeLoop(
      JSON.stringify({ reasoning: 'hand it off', plan: [], priority: 'low', dispatch: [id] }),
      pool
    );
    const result = await loop.runOne('bot1');
    expect(pool.requests).toHaveLength(1);
    expect(pool.requests[0].taskIds).toEqual([id]);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.isIdle).toBe(false);
    expect(result.summary).toBe('Dispatched 1 task(s) to workers');
    const [row] = cycleRows();
    expect(row.status).toBe('completed');
    expect(row.dispatched).toEqual([{ taskId: id, runId: `run-${id}`, ok: true }]);
  });

  test('dispatch-only: new_tasks plus dispatch of one of them by its text', async () => {
    const pool = fakePool(true);
    const { loop, llm } = makeLoop(
      JSON.stringify({
        reasoning: 'break down and hand off',
        plan: [],
        priority: 'low',
        new_tasks: { goal: 'g-bbbbbbbb', tasks: ['Book the room', 'Send invitations'] },
        dispatch: ['Book the room'],
      }),
      pool
    );
    const result = await loop.runOne('bot1');
    expect(store.forGoal('g-bbbbbbbb')).toHaveLength(2);
    expect(pool.requests).toHaveLength(1);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.summary).toBe('Added 2 task(s); dispatched 1 task(s) to workers');
    expect(cycleRows()[0].status).toBe('completed');
  });

  test('dispatch-only: repeated dispatch cycles earn no repetition karma', async () => {
    const pool = fakePool(true);
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'Book the room' }], { actor: 'agent' });
    const id = store.list()[0].id;
    const { loop, ctx } = makeLoop(
      JSON.stringify({ reasoning: 'r', plan: [], priority: 'low', dispatch: [id] }),
      pool
    );
    ctx.config.karma = { enabled: true };
    const karma = {
      addEvent: mock(() => {}),
      recordOutcome: mock(() => null),
      renderForPrompt: () => '',
    };
    (loop as any).karmaService = karma;
    await loop.runOne('bot1');
    await loop.runOne('bot1');
    expect(pool.requests).toHaveLength(2);
    expect(karma.addEvent).not.toHaveBeenCalled();
    expect(karma.recordOutcome).not.toHaveBeenCalled();
  });

  test('dispatch-only: when nothing could be dispatched the cycle is idle', async () => {
    const pool = fakePool(true);
    const { loop, llm } = makeLoop(
      JSON.stringify({ reasoning: 'r', plan: [], priority: 'low', dispatch: ['t-ffffff'] }),
      pool
    );
    const result = await loop.runOne('bot1');
    expect(pool.requests).toEqual([]);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.isIdle).toBe(true);
    expect(cycleRows()[0].status).toBe('idle');
  });

  test('ended runs stay in the Workers block until a planner call succeeds (M5)', async () => {
    const ended = {
      runId: 'r-2',
      botId: 'bot1',
      taskId: 't-dddddd',
      goalId: 'g-bbbbbbbb',
      dispatchCycleId: null,
      taskText: 'Book the room',
      goalTitle: 'Monthly hands-on lab',
      status: 'done',
      attempt: 1,
      step: 3,
      budget: { steps: 8, toolCalls: 40, wallMs: 1 },
      used: { steps: 3, toolCalls: 4, wallMs: 1 },
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      endedAt: new Date(Date.now() - 60_000).toISOString(),
      outcome: { kind: 'done', note: 'room booked' },
    } as unknown as WorkerRunView;
    const pool = fakePool(true, [ended]);
    const ok = JSON.stringify({ reasoning: 'r', plan: ['x'], priority: 'low' });
    // First cycle: the planner answers garbage on both attempts (parse fails).
    const { loop, systems } = makeLoop(['not json', 'still not json', ok], pool);
    const plannerPrompts = () => systems.filter((s) => s.includes('JSON Schema'));
    await loop.runOne('bot1');
    expect(plannerPrompts()[0]).toContain('t-dddddd');
    await loop.runOne('bot1');
    // the failed cycle did not mark the ended run as seen
    expect(plannerPrompts()[2]).toContain('t-dddddd');
    // the successful one did
    await loop.runOne('bot1');
    expect(plannerPrompts()[3]).not.toContain('t-dddddd');
  });

  test('new_tasks for a goal written before ids gives it an id first (M8)', async () => {
    writeFileSync(
      join(soulDir, 'GOALS.md'),
      '## Active Goals\n- [ ] Monthly hands-on lab\n  - status: in_progress\n  - priority: medium\n\n## Completed\n'
    );
    const { loop } = makeLoop(
      JSON.stringify({
        reasoning: 'r',
        plan: ['Pick the lab topic'],
        priority: 'medium',
        new_tasks: {
          goal: 'Monthly hands-on lab',
          tasks: ['Pick the lab topic', 'Book the room'],
        },
      }),
      undefined,
      { goalsOnDisk: true }
    );
    await loop.runOne('bot1');
    const md = readFileSync(join(soulDir, 'GOALS.md'), 'utf-8');
    const goalId = md.match(/id: (g-[0-9a-f]{8})/)?.[1];
    expect(goalId).toBeTruthy();
    expect(store.forGoal(goalId as string).map((t) => t.text)).toEqual([
      'Pick the lab topic',
      'Book the room',
    ]);
    expect(cycleRows()[0].newTasks).toHaveLength(2);
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

  test('an explore cycle marks its attribution exploring, so its executor writes no document', async () => {
    const begin = spyOn(curiosityRunner, 'beginCuriosityCycle').mockResolvedValue({
      botId: 'bot1',
      decision: { mode: 'explore', reason: 'budget' },
      frontierItem: null,
      proposals: [],
      curiosityBlock: '',
      navigatorStarted: false,
    } as never);
    const finish = spyOn(curiosityRunner, 'finishCuriosityCycle').mockResolvedValue(
      undefined as never
    );
    try {
      const { loop, llm } = makeLoop(
        JSON.stringify({ reasoning: 'r', plan: ['Look into X'], priority: 'medium' })
      );
      (loop as any).buildCuriosityDeps = () => ({});
      let seen: any;
      llm.chat = mock(() => {
        seen = { ...(loop as any).cycleAttribution.get('bot1') };
        return Promise.resolve({ text: 'executed' });
      });
      await loop.runOne('bot1');
      expect(begin).toHaveBeenCalled();
      expect(seen.exploring).toBe(true);
    } finally {
      begin.mockRestore();
      finish.mockRestore();
    }
  });

  test('the executor prompt shows the document cap and each document size', async () => {
    const prod = join(dataDir, 'productions', 'bot1');
    mkdirSync(prod, { recursive: true });
    writeFileSync(join(prod, '01_brief.md'), 'x'.repeat(11_000));
    const { loop, llm } = makeLoop(
      JSON.stringify({ reasoning: 'r', plan: ['Tighten the brief'], priority: 'medium' }),
      undefined,
      {
        extraCtx: {
          productionsService: {
            isEnabled: () => true,
            resolveDir: () => prod,
            getChangelog: () => [
              { path: '01_brief.md', action: 'create', goalId: 'g-bbbbbbbb', timestamp: 't' },
            ],
          },
        },
      }
    );
    let prompt = '';
    llm.chat = mock((messages: Array<{ content: string }>) => {
      prompt = messages.map((m) => m.content).join(' ');
      return Promise.resolve({ text: 'executed' });
    });
    await loop.runOne('bot1');
    expect(prompt).toContain('Limit: 12,000 characters per document.');
    expect(prompt).toContain('01_brief.md (goal g-bbbbbbbb): 11,000 / 12,000 — 1,000 left');
  });
  test('auto-dispatch: a plan with no task fields still hands an open task to a worker', async () => {
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'List the lab equipment needed' }], {
      actor: 'agent',
    });
    const id = store.list()[0].id;
    const pool = fakePool(true);
    const { loop } = makeLoop(
      JSON.stringify({ reasoning: 'r', plan: ['Draft the agenda'], priority: 'medium' }),
      pool
    );
    await loop.runOne('bot1');
    expect(pool.requests).toHaveLength(1);
    expect(pool.requests[0].taskIds).toEqual([id]);
    const [row] = cycleRows();
    expect(row.dispatched).toEqual([{ taskId: id, runId: `run-${id}`, ok: true, auto: true }]);
  });

  test('auto-dispatch: off with workers.autoDispatch false', async () => {
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'List the lab equipment needed' }], {
      actor: 'agent',
    });
    const pool = fakePool(true);
    const { loop, ctx } = makeLoop(
      JSON.stringify({ reasoning: 'r', plan: ['Draft the agenda'], priority: 'medium' }),
      pool
    );
    ctx.config.workers = { autoDispatch: false };
    await loop.runOne('bot1');
    expect(pool.requests).toEqual([]);
  });
});
