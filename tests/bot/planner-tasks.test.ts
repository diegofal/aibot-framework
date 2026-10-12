/**
 * Phase 1 of the goal tasks plan (C8): the planner breaks goals down into
 * tasks (`new_tasks`), names the task its own work serves (`serves_task`) and,
 * when workers are on, hands open tasks to workers (`dispatch`). The loop
 * acts only on explicit planner output, never on explore, idle or gated cycles.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContinuousPlannerPrompt, buildPlannerPrompt } from '../../src/bot/agent-loop-prompts';
import {
  applyPlannerTasks,
  buildTaskOutputSection,
  buildWorkersSection,
  cyclePendingQuestions,
  parsePlannerTaskFields,
  resolveTaskRef,
} from '../../src/bot/agent-loop-tasks';
import { parsePlannerResult } from '../../src/bot/agent-planner';
import { writeGoalsFile } from '../../src/bot/goal-events';
import { TaskStore } from '../../src/goals/task-store';
import { parseGoals } from '../../src/tools/goals';
import type {
  DispatchRequest,
  DispatchResult,
  WorkerPoolApi,
  WorkerRunView,
} from '../../src/workers/types';

const warn = { warn: () => {} };
const logger = { info: () => {}, warn: () => {} };

const GOALS_MD = `## Active Goals
- [ ] Ship the weekly brief
  - id: g-aaaaaaaa
  - status: pending
  - priority: high
- [ ] Monthly hands-on lab
  - id: g-bbbbbbbb
  - status: in_progress
  - priority: medium

## Completed
`;

function run(over: Partial<WorkerRunView> = {}): WorkerRunView {
  return {
    runId: 'r-1',
    botId: 'b1',
    taskId: 't-111111',
    goalId: 'g-aaaaaaaa',
    dispatchCycleId: 'c0',
    taskText: 'Draft the outline',
    goalTitle: 'Ship the weekly brief',
    status: 'running',
    attempt: 1,
    step: 2,
    budget: { steps: 8, toolCalls: 40, wallMs: 3_600_000 },
    used: { steps: 2, toolCalls: 5, wallMs: 60_000 },
    createdAt: '2026-10-12T10:00:00Z',
    ...over,
  };
}

/** A fake pool that records requests and accepts every task. */
function fakePool(enabled = true): WorkerPoolApi & { requests: DispatchRequest[] } {
  const requests: DispatchRequest[] = [];
  const pool = {
    requests,
    isEnabledFor: () => enabled,
    dispatch: (req: DispatchRequest): DispatchResult[] => {
      requests.push(req);
      return req.taskIds.map((taskId, i) => ({
        taskId,
        ok: true as const,
        runId: `r-${i}`,
        queued: false,
      }));
    },
    list: () => [],
    get: () => null,
    journal: () => [],
    stop: () => false,
    retry: () => ({ taskId: '', ok: false as const, reason: 'invalid' as const, message: '' }),
    onAnswer: () => false,
    abortAll: async () => {},
    recover: () => {},
    stats: () => ({ running: 0, queued: 0, waiting: 0, byBot: {} }),
    subscribe: () => () => {},
  };
  return pool;
}

const basePrompt = {
  identity: 'I am a bot',
  soul: 'soul',
  motivations: 'motivations',
  goals: GOALS_MD,
  recentMemory: '',
  datetime: '2026-10-12',
  availableTools: ['manage_goals'],
  hasCreateTool: false,
};

// ── Prompts ──────────────────────────────────────────────────────────────

describe('planner prompt: tasks guidance', () => {
  for (const [name, build] of [
    ['periodic', buildPlannerPrompt],
    ['continuous', buildContinuousPlannerPrompt],
  ] as const) {
    test(`${name}: asks to break a goal down with new_tasks`, () => {
      const { system } = build(basePrompt);
      expect(system).toContain('new_tasks');
      expect(system).toMatch(/2.5 concrete, verifiable steps/);
      expect(system).toContain('serves_task');
    });

    test(`${name}: without workers, never mentions dispatch or a Workers block`, () => {
      const { system } = build(basePrompt);
      expect(system).not.toContain('dispatch');
      expect(system).not.toContain('## Workers');
    });

    test(`${name}: with workers, shows the Workers block and the dispatch field`, () => {
      const { system } = build({
        ...basePrompt,
        workers: {
          runs: [
            run({ lastReport: { kind: 'progress', note: 'outline half done' } }),
            run({
              runId: 'r-2',
              taskId: 't-222222',
              taskText: 'Collect sources',
              status: 'done',
              endedAt: '2026-10-12T11:00:00Z',
              outcome: { kind: 'done', note: 'twelve sources saved' },
            }),
          ],
          endedSinceMs: Date.parse('2026-10-12T09:00:00Z'),
        },
      });
      expect(system).toContain('## Workers');
      expect(system).toContain('t-111111');
      expect(system).toContain('step 2/8');
      expect(system).toContain('outline half done');
      expect(system).toContain('twelve sources saved');
      expect(system).toContain('"dispatch"');
    });

    test(`${name}: "extra tasks" lines now speak about plan scope, not goal tasks`, () => {
      const { system } = build({ ...basePrompt, singleDeliverable: 'Write the brief' });
      expect(system).not.toContain('Do NOT add extra tasks');
      expect(system).not.toContain('Do NOT add tasks beyond');
      expect(system).not.toContain('Adding extra tasks beyond the assigned deliverable');
      expect(system).toMatch(/scope creep/i);
    });
  }
});

describe('buildWorkersSection', () => {
  test('lists active runs and only runs that ended since the previous cycle', () => {
    const text = buildWorkersSection({
      runs: [
        run({ status: 'queued', step: 0 }),
        run({
          runId: 'r-3',
          taskId: 't-333333',
          status: 'waiting',
          wait: { kind: 'ask', id: 'q1', question: 'Which API?', since: '2026-10-12T10:30:00Z' },
        }),
        run({
          runId: 'r-old',
          taskId: 't-999999',
          status: 'blocked',
          endedAt: '2026-10-11T08:00:00Z',
          outcome: { kind: 'blocked', note: 'old news' },
        }),
        run({
          runId: 'r-new',
          taskId: 't-444444',
          status: 'failed',
          endedAt: '2026-10-12T11:00:00Z',
          outcome: { kind: 'budget', note: 'ran out of steps' },
        }),
      ],
      endedSinceMs: Date.parse('2026-10-12T00:00:00Z'),
    });
    expect(text).toContain('queued');
    expect(text).toContain('Which API?');
    expect(text).toContain('ran out of steps');
    expect(text).not.toContain('old news');
  });

  test('says so when no worker runs', () => {
    expect(buildWorkersSection({ runs: [] })).toMatch(/no worker/i);
  });

  test('task output section mentions dispatch only with workers', () => {
    expect(buildTaskOutputSection({ workersEnabled: false })).not.toContain('dispatch');
    expect(buildTaskOutputSection({ workersEnabled: true })).toContain('dispatch');
  });
});

// ── Parsing ──────────────────────────────────────────────────────────────

describe('parse planner task fields', () => {
  test('keeps valid new_tasks, dispatch and serves_task', () => {
    const r = parsePlannerResult(
      JSON.stringify({
        reasoning: 'r',
        plan: ['a'],
        priority: 'medium',
        new_tasks: { goal: 'g-aaaaaaaa', tasks: ['Draft outline', 'Collect sources'] },
        dispatch: ['t-111111'],
        serves_task: 't-222222',
      }),
      warn
    );
    expect(r?.new_tasks).toEqual({
      goal: 'g-aaaaaaaa',
      tasks: ['Draft outline', 'Collect sources'],
    });
    expect(r?.dispatch).toEqual(['t-111111']);
    expect(r?.serves_task).toBe('t-222222');
  });

  test('old outputs without the fields still parse, with no task fields', () => {
    const r = parsePlannerResult('{"reasoning":"r","plan":["a"],"priority":"high"}', warn);
    expect(r).not.toBeNull();
    expect(r?.new_tasks).toBeUndefined();
    expect(r?.dispatch).toBeUndefined();
    expect(r?.serves_task).toBeUndefined();
  });

  test('drops junk and caps new_tasks at 5 single-line items of ≤ 200 chars', () => {
    const f = parsePlannerTaskFields({
      new_tasks: {
        goal: '  Ship the weekly brief ',
        tasks: [
          'one',
          42,
          '',
          'two\nlines',
          'x'.repeat(201),
          'three',
          'four',
          'five',
          'six',
          'seven',
        ],
      },
      dispatch: ['t-1', 7, '', 't-1', 't-2'],
      serves_task: 12,
    });
    expect(f.new_tasks?.goal).toBe('Ship the weekly brief');
    expect(f.new_tasks?.tasks).toEqual(['one', 'three', 'four', 'five', 'six']);
    expect(f.dispatch).toEqual(['t-1', 't-2']);
    expect(f.serves_task).toBeUndefined();
  });

  test('new_tasks without a goal or tasks is dropped; non-array dispatch is dropped', () => {
    expect(parsePlannerTaskFields({ new_tasks: { tasks: ['a'] } }).new_tasks).toBeUndefined();
    expect(
      parsePlannerTaskFields({ new_tasks: { goal: 'g', tasks: [] } }).new_tasks
    ).toBeUndefined();
    expect(parsePlannerTaskFields({ new_tasks: 'do stuff' }).new_tasks).toBeUndefined();
    expect(parsePlannerTaskFields({ dispatch: 't-1' }).dispatch).toBeUndefined();
  });
});

// ── Loop ─────────────────────────────────────────────────────────────────

describe('applyPlannerTasks', () => {
  let dir: string;
  let store: TaskStore;
  const goals = () => parseGoals(GOALS_MD).active;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'planner-tasks-'));
    writeFileSync(join(dir, 'GOALS.md'), GOALS_MD);
    store = new TaskStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base = () => ({
    botId: 'b1',
    cycleId: 'c1',
    store,
    goals: goals(),
    logger,
    exploring: false,
    idle: false,
    gateBlocked: false,
    hardGateActive: false,
  });

  test('writes new_tasks from explicit output, as the agent, stamped with the cycle', () => {
    const out = applyPlannerTasks({
      ...base(),
      fields: {
        new_tasks: { goal: 'Ship the weekly brief', tasks: ['Draft outline', 'Collect sources'] },
      },
    });
    expect(out.newTaskIds).toHaveLength(2);
    const tasks = store.forGoal('g-aaaaaaaa');
    expect(tasks.map((t) => t.text)).toEqual(['Draft outline', 'Collect sources']);
    expect(tasks.every((t) => t.by === 'agent' && t.createdCycle === 'c1')).toBe(true);
  });

  test('writes nothing without explicit output', () => {
    const out = applyPlannerTasks({ ...base(), fields: {} });
    expect(out.newTaskIds).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  test('never writes or dispatches on explore, idle or gated cycles', () => {
    const pool = fakePool();
    for (const flags of [{ exploring: true }, { idle: true }, { gateBlocked: true }]) {
      const out = applyPlannerTasks({
        ...base(),
        ...flags,
        workerPool: pool,
        fields: {
          new_tasks: { goal: 'g-aaaaaaaa', tasks: ['Draft outline', 'Collect sources'] },
          dispatch: ['Draft outline'],
        },
      });
      expect(out.newTaskIds).toEqual([]);
      expect(out.dispatched).toEqual([]);
      expect(out.skipped).toBeDefined();
    }
    expect(store.list()).toEqual([]);
    expect(pool.requests).toEqual([]);
  });

  test('skips new_tasks for an unknown goal or a goal that already has open tasks', () => {
    applyPlannerTasks({
      ...base(),
      fields: { new_tasks: { goal: 'No such goal', tasks: ['A step'] } },
    });
    expect(store.list()).toEqual([]);
    store.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'Existing step' }], {
      actor: 'operator',
    });
    const out = applyPlannerTasks({
      ...base(),
      fields: { new_tasks: { goal: 'g-aaaaaaaa', tasks: ['Another step'] } },
    });
    expect(out.newTaskIds).toEqual([]);
    expect(store.forGoal('g-aaaaaaaa').map((t) => t.text)).toEqual(['Existing step']);
  });

  test('dispatches the named tasks, resolving tasks just added by their text', () => {
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'Book the room' }], { actor: 'agent' });
    const existing = store.forGoal('g-bbbbbbbb')[0].id;
    const pool = fakePool();
    const out = applyPlannerTasks({
      ...base(),
      workerPool: pool,
      fields: {
        new_tasks: { goal: 'g-aaaaaaaa', tasks: ['Draft outline', 'Collect sources'] },
        dispatch: ['collect sources', existing, 't-nothere'],
      },
    });
    const added = store.forGoal('g-aaaaaaaa').find((t) => t.text === 'Collect sources')?.id;
    expect(pool.requests).toEqual([
      { botId: 'b1', taskIds: [added as string, existing], cycleId: 'c1' },
    ]);
    expect(out.dispatched).toEqual([
      { taskId: added as string, ok: true, runId: 'r-0' },
      { taskId: existing, ok: true, runId: 'r-1' },
    ]);
  });

  test('never dispatches when workers are disabled or absent', () => {
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'Book the room' }], { actor: 'agent' });
    const id = store.list()[0].id;
    const disabled = fakePool(false);
    const out = applyPlannerTasks({ ...base(), workerPool: disabled, fields: { dispatch: [id] } });
    expect(disabled.requests).toEqual([]);
    expect(out.dispatched).toEqual([]);
    const none = applyPlannerTasks({ ...base(), fields: { dispatch: [id] } });
    expect(none.dispatched).toEqual([]);
  });

  test('under the hard engagement gate a content task is not dispatched', () => {
    store.apply(
      [
        { op: 'add', goalId: 'g-bbbbbbbb', text: 'Write a blog post about the lab' },
        { op: 'add', goalId: 'g-bbbbbbbb', text: 'Research venue prices online' },
      ],
      { actor: 'agent' }
    );
    const [content, research] = store.forGoal('g-bbbbbbbb').map((t) => t.id);
    const pool = fakePool();
    const out = applyPlannerTasks({
      ...base(),
      hardGateActive: true,
      workerPool: pool,
      fields: { dispatch: [content, research] },
    });
    expect(pool.requests[0]?.taskIds).toEqual([research]);
    expect(out.dispatched).toContainEqual({
      taskId: content,
      ok: false,
      reason: 'engagement-gate',
    });
  });

  test('records pool refusals and survives a pool that throws', () => {
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'Book the room' }], { actor: 'agent' });
    const id = store.list()[0].id;
    const refusing = fakePool();
    refusing.dispatch = (req) =>
      req.taskIds.map((taskId) => ({ taskId, ok: false, reason: 'cap', message: 'full' }));
    const out = applyPlannerTasks({ ...base(), workerPool: refusing, fields: { dispatch: [id] } });
    expect(out.dispatched).toEqual([{ taskId: id, ok: false, reason: 'cap' }]);

    const throwing = fakePool();
    throwing.dispatch = () => {
      throw new Error('boom');
    };
    const out2 = applyPlannerTasks({ ...base(), workerPool: throwing, fields: { dispatch: [id] } });
    expect(out2.dispatched).toEqual([{ taskId: id, ok: false, reason: 'error' }]);
  });

  test('serves_task resolves to an open task (id or text), not to a dispatched one', () => {
    store.apply(
      [
        { op: 'add', goalId: 'g-bbbbbbbb', text: 'Book the room' },
        { op: 'add', goalId: 'g-bbbbbbbb', text: 'Send invitations' },
      ],
      { actor: 'agent' }
    );
    const [book, send] = store.forGoal('g-bbbbbbbb').map((t) => t.id);
    const out = applyPlannerTasks({ ...base(), fields: { serves_task: 'send invitations' } });
    expect(out.servesTask).toEqual({ id: send, text: 'Send invitations', goalId: 'g-bbbbbbbb' });

    const pool = fakePool();
    const out2 = applyPlannerTasks({
      ...base(),
      workerPool: pool,
      fields: { serves_task: book, dispatch: [book] },
    });
    expect(out2.servesTask).toBeUndefined();

    const out3 = applyPlannerTasks({ ...base(), fields: { serves_task: 't-zzzzzz' } });
    expect(out3.servesTask).toBeUndefined();
  });

  test('resolveTaskRef: id, then exact text (case-insensitive), open tasks only', () => {
    store.apply([{ op: 'add', goalId: 'g-bbbbbbbb', text: 'Book the room' }], { actor: 'agent' });
    const t = store.list()[0];
    expect(resolveTaskRef(t.id, store.list())?.id).toBe(t.id);
    expect(resolveTaskRef('  BOOK the room ', store.list())?.id).toBe(t.id);
    expect(resolveTaskRef('Book', store.list())).toBeNull();
    store.apply([{ op: 'move', id: t.id, lane: 'done' }], { actor: 'agent' });
    expect(resolveTaskRef(t.id, store.list())).toBeNull();
  });
});

describe('cyclePendingQuestions', () => {
  test('drops questions a worker run asked (they carry a runId)', () => {
    const qs = [
      { id: 'q1', question: 'cycle' },
      { id: 'q2', question: 'worker', runId: 'r-1' },
      { id: 'q3', question: 'empty run id', runId: '' },
    ];
    expect(cyclePendingQuestions(qs).map((q) => q.id)).toEqual(['q1', 'q3']);
  });
});

describe('new_tasks for a goal written before ids (M8)', () => {
  const LEGACY = `## Active Goals
- [ ] Ship the weekly brief
  - status: pending
  - priority: high

## Completed
`;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'planner-tasks-legacy-'));
    writeFileSync(join(dir, 'GOALS.md'), LEGACY);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('assigns the goal an id first, then writes the tasks under it', () => {
    const store = new TaskStore(dir);
    const path = join(dir, 'GOALS.md');
    let assigned = 0;
    const out = applyPlannerTasks({
      botId: 'b1',
      cycleId: 'c1',
      store,
      goals: parseGoals(LEGACY).active,
      logger,
      exploring: false,
      idle: false,
      gateBlocked: false,
      hardGateActive: false,
      fields: { new_tasks: { goal: 'Ship the weekly brief', tasks: ['Draft', 'Send'] } },
      assignGoalIds: () => {
        assigned++;
        writeGoalsFile(path, readFileSync(path, 'utf-8'), { actor: 'agent' });
        return parseGoals(readFileSync(path, 'utf-8')).active;
      },
    });
    expect(assigned).toBe(1);
    const goalId = parseGoals(readFileSync(path, 'utf-8')).active[0].id;
    expect(goalId).toMatch(/^g-[0-9a-f]{8}$/);
    expect(out.newTaskIds).toHaveLength(2);
    expect(store.forGoal(goalId as string).map((t) => t.text)).toEqual(['Draft', 'Send']);
  });

  test('without a way to assign ids it still skips (and never throws)', () => {
    const store = new TaskStore(dir);
    const out = applyPlannerTasks({
      botId: 'b1',
      cycleId: 'c1',
      store,
      goals: parseGoals(LEGACY).active,
      logger,
      exploring: false,
      idle: false,
      gateBlocked: false,
      hardGateActive: false,
      fields: { new_tasks: { goal: 'Ship the weekly brief', tasks: ['Draft'] } },
      assignGoalIds: () => {
        throw new Error('disk full');
      },
    });
    expect(out.newTaskIds).toEqual([]);
  });
});

describe('dispatch-only planner answers (S8)', () => {
  test('plan [] parses when the answer dispatches or breaks a goal down', () => {
    const d = parsePlannerResult(
      JSON.stringify({ reasoning: 'r', plan: [], priority: 'low', dispatch: ['t-111111'] }),
      warn
    );
    expect(d?.plan).toEqual([]);
    expect(d?.dispatch).toEqual(['t-111111']);
    const n = parsePlannerResult(
      JSON.stringify({
        reasoning: 'r',
        plan: [],
        priority: 'medium',
        new_tasks: { goal: 'g-aaaaaaaa', tasks: ['A', 'B'] },
      }),
      warn
    );
    expect(n?.new_tasks?.tasks).toEqual(['A', 'B']);
  });

  test('plan [] without task fields still needs priority none', () => {
    expect(
      parsePlannerResult(JSON.stringify({ reasoning: 'r', plan: [], priority: 'low' }), warn)
    ).toBeNull();
    expect(
      parsePlannerResult(
        JSON.stringify({ reasoning: 'r', plan: [], priority: 'low', serves_task: 't-111111' }),
        warn
      )
    ).toBeNull();
  });

  test('the planner prompt says a plan may be empty when it only dispatches', () => {
    for (const build of [buildPlannerPrompt, buildContinuousPlannerPrompt] as any[]) {
      expect(build({ ...basePrompt, workers: { runs: [] } }).system).toContain(
        'empty array when you only dispatch'
      );
      expect(build(basePrompt).system).not.toContain('only dispatch');
    }
  });
});
