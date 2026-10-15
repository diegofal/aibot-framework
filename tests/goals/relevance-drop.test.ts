/**
 * "No longer applies": a goal or task that was superseded, became impossible
 * or stopped serving the agent's purpose is dropped with a reason, never left
 * open forever or marked done falsely. Goals: `manage_goals drop` and the
 * strategist's `drop` op (to Completed with `- dropped: <reason>`, goal event
 * `drop`). Tasks: `manage_goals drop_task` and the strategist's `drop_tasks`
 * (removed from the store, the reason on the `task-remove` event).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStrategistPrompt } from '../../src/bot/agent-loop-prompts';
import { buildTaskOutputSection } from '../../src/bot/agent-loop-tasks';
import {
  applyDropTasks,
  applyGoalOperations,
  parseStrategistResult,
} from '../../src/bot/agent-strategist';
import { diffGoals, readGoalEvents } from '../../src/bot/goal-events';
import { SoulLoader } from '../../src/soul';
import { createGoalsTool, parseGoals, serializeGoals } from '../../src/tools/goals';
import type { WorkerPoolApi } from '../../src/workers/types';
import { cardHtml } from '../../web/pages/fleet-board-helpers.js';

const logger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  trace: mock(() => {}),
  child: () => logger,
} as any;

const md = `## Active Goals
- [ ] Research dark factories
  - status: in_progress
  - priority: high
  - id: g-aaaaaaaa
- [ ] Write the newsletter
  - status: pending
  - priority: medium
  - id: g-bbbbbbbb

## Completed
(none yet)
`;

let dir: string;
let soul: SoulLoader;
const store = () => soul.getTaskStore();
const stops: Array<[string, string]> = [];
const pool = {
  list: () => [{ runId: 'r-1', botId: 'b', taskId: 'x', goalId: 'g-aaaaaaaa', status: 'running' }],
  stop: (runId: string, reason: string) => {
    stops.push([runId, reason]);
    return true;
  },
} as unknown as WorkerPoolApi;
const run = (args: Record<string, unknown>) =>
  createGoalsTool(() => soul, { getWorkerPool: () => pool }).execute(
    { _botId: 'b', ...args },
    logger
  );
function addTask(goalId: string, text: string): string {
  const r = store().apply([{ op: 'add', goalId, text }], { actor: 'agent' });
  if (!r.ok) throw new Error(r.message);
  return r.results[0].id;
}

beforeEach(() => {
  stops.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'relevance-drop-'));
  writeFileSync(join(dir, 'GOALS.md'), md, 'utf-8');
  soul = new SoulLoader(
    { enabled: true, dir, versioning: { enabled: false, maxVersionsPerFile: 10 } } as any,
    logger
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('GOALS.md: dropped', () => {
  test('parse and serialize round-trip the dropped reason, active and completed', () => {
    const { active, completed } = parseGoals(md);
    active[0].dropped = 'Superseded by the operator';
    const done = { ...active[1], status: 'completed', dropped: 'No longer serves the purpose' };
    const out = serializeGoals([active[0]], [done]);
    expect(out).toContain('  - dropped: Superseded by the operator');
    expect(out).toContain('  - dropped: No longer serves the purpose');
    const again = parseGoals(out);
    expect(again.active[0].dropped).toBe('Superseded by the operator');
    expect(again.completed[0].dropped).toBe('No longer serves the purpose');
  });
});

describe('diffGoals: drop', () => {
  test('a goal moved to completed with a dropped reason is a drop, to = reason', () => {
    const before = parseGoals(md);
    const after = parseGoals(md);
    const [g] = after.active.splice(0, 1);
    after.completed.push({ ...g, status: 'completed', dropped: 'Impossible now' });
    expect(diffGoals(before, after).map((e) => [e.op, e.from, e.to])).toEqual([
      ['drop', 'in_progress', 'Impossible now'],
    ]);
  });

  test('a plain completion is still complete', () => {
    const before = parseGoals(md);
    const after = parseGoals(md);
    const [g] = after.active.splice(0, 1);
    after.completed.push({ ...g, status: 'completed' });
    expect(diffGoals(before, after).map((e) => e.op)).toEqual(['complete']);
  });
});

describe('manage_goals drop', () => {
  test('moves the goal to Completed with the reason, records a drop event and closes its workers', async () => {
    const taskId = addTask('g-aaaaaaaa', 'Find three factories');
    store().apply([{ op: 'claim', id: taskId, runId: 'r-1', ttlMs: 60_000 }], {
      actor: 'system',
    });
    const res = await run({
      action: 'drop',
      goal: 'dark factories',
      reason: 'The operator moved on to a new market',
      _cycleId: 'c-7',
    });
    expect(res.success).toBe(true);
    expect(res.content).toContain('dropped');
    const { active, completed } = parseGoals(soul.readGoals());
    expect(active.map((g) => g.id)).toEqual(['g-bbbbbbbb']);
    expect(completed[0]).toMatchObject({
      id: 'g-aaaaaaaa',
      status: 'completed',
      dropped: 'The operator moved on to a new market',
    });
    expect(completed[0].completed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const ev = readGoalEvents(dir).find((e) => e.op === 'drop');
    expect(ev).toMatchObject({
      goalId: 'g-aaaaaaaa',
      to: 'The operator moved on to a new market',
      reason: 'The operator moved on to a new market',
      actor: 'agent',
      cycleId: 'c-7',
    });
    expect(stops).toEqual([['r-1', 'goal-closed']]);
    expect(store().get(taskId)?.claim).toBeFalsy();
  });

  test('needs a reason and an existing goal', async () => {
    expect((await run({ action: 'drop', goal: 'dark factories' })).success).toBe(false);
    expect(
      (await run({ action: 'drop', goal: 'no such goal', reason: 'x is gone now' })).success
    ).toBe(false);
    expect(parseGoals(soul.readGoals()).active).toHaveLength(2);
    expect(stops).toEqual([]);
  });

  test('an unknown action names drop and drop_task', async () => {
    const res = await run({ action: 'nope' });
    expect(res.content).toContain('drop');
    expect(res.content).toContain('drop_task');
  });
});

describe('manage_goals drop_task', () => {
  test('removes the task and keeps the reason on the task-remove event', async () => {
    const taskId = addTask('g-aaaaaaaa', 'Call the Shenzhen supplier');
    const res = await run({
      action: 'drop_task',
      task: taskId,
      reason: 'The supplier closed',
      _cycleId: 'c-8',
    });
    expect(res.success).toBe(true);
    expect(store().get(taskId)).toBeFalsy();
    const ev = readGoalEvents(dir).find((e) => e.op === 'task-remove');
    expect(ev).toMatchObject({
      taskId,
      note: 'The supplier closed',
      actor: 'agent',
      cycleId: 'c-8',
    });
  });

  test('a missing reason is refused and the task stays', async () => {
    const taskId = addTask('g-aaaaaaaa', 'Call the Shenzhen supplier');
    const res = await run({ action: 'drop_task', task: taskId });
    expect(res.success).toBe(false);
    expect(res.content).toContain('reason');
    expect(store().get(taskId)).toBeTruthy();
  });

  test('a task a worker holds follows the claim rules: refused', async () => {
    const taskId = addTask('g-aaaaaaaa', 'Call the Shenzhen supplier');
    store().apply([{ op: 'claim', id: taskId, runId: 'r-9', ttlMs: 60_000 }], {
      actor: 'system',
    });
    const res = await run({ action: 'drop_task', task: taskId, reason: 'Not needed' });
    expect(res.success).toBe(false);
    expect(store().get(taskId)).toBeTruthy();
  });
});

describe('strategist: drop and drop_tasks', () => {
  test('a drop op moves the goal to Completed with the reason and stops its workers', () => {
    const taskId = addTask('g-aaaaaaaa', 'Find three factories');
    store().apply([{ op: 'claim', id: taskId, runId: 'r-1', ttlMs: 60_000 }], {
      actor: 'system',
    });
    applyGoalOperations(
      'b',
      [{ action: 'drop', goal: 'dark factories', reason: 'Off-purpose since the pivot' }],
      logger,
      soul,
      { cycleId: 'c-9', workerPool: pool }
    );
    const { completed } = parseGoals(soul.readGoals());
    expect(completed[0]).toMatchObject({
      id: 'g-aaaaaaaa',
      dropped: 'Off-purpose since the pivot',
    });
    const ev = readGoalEvents(dir).find((e) => e.op === 'drop');
    expect(ev).toMatchObject({ actor: 'strategist', to: 'Off-purpose since the pivot' });
    expect(stops).toEqual([['r-1', 'goal-closed']]);
  });

  test('a drop op without a reason still drops, with a default reason', () => {
    applyGoalOperations('b', [{ action: 'drop', goal: 'newsletter' }], logger, soul);
    const { completed } = parseGoals(soul.readGoals());
    expect(completed[0].dropped).toBeTruthy();
  });

  test('a drop op naming the goal by id drops exactly that goal', () => {
    applyGoalOperations(
      'b',
      [{ action: 'drop', goal: 'g-bbbbbbbb', reason: 'Superseded' }],
      logger,
      soul
    );
    const { active, completed } = parseGoals(soul.readGoals());
    expect(completed.map((g) => g.id)).toEqual(['g-bbbbbbbb']);
    expect(active.map((g) => g.id)).toEqual(['g-aaaaaaaa']);
  });

  test('a goal the operator set is never dropped by the strategist: it stays, logged', () => {
    writeFileSync(
      join(dir, 'GOALS.md'),
      md.replace('  - id: g-bbbbbbbb', '  - source: operator\n  - id: g-bbbbbbbb'),
      'utf-8'
    );
    applyGoalOperations(
      'b',
      [{ action: 'drop', goal: 'g-bbbbbbbb', reason: 'Looks stale' }],
      logger,
      soul
    );
    const { active, completed } = parseGoals(soul.readGoals());
    expect(active.map((g) => g.id)).toContain('g-bbbbbbbb');
    expect(completed).toEqual([]);
  });

  test('parseStrategistResult keeps valid drop_tasks and drops junk', () => {
    const r = parseStrategistResult(
      JSON.stringify({
        goal_operations: [],
        single_deliverable: 'Do a',
        reflection: 'r',
        drop_tasks: [
          { task: 't-aaaaaa', reason: 'Superseded' },
          { task: '', reason: 'x' },
          { task: 't-bbbbbb' },
          'junk',
          42,
        ],
      }),
      logger
    );
    expect(r?.drop_tasks).toEqual([{ task: 't-aaaaaa', reason: 'Superseded' }]);
    const none = parseStrategistResult(
      JSON.stringify({ single_deliverable: 'Do a', reflection: 'r', drop_tasks: 'x' }),
      logger
    );
    expect(none?.drop_tasks).toBeUndefined();
  });

  test('applyDropTasks removes each named task with its reason; unknown ids are skipped', () => {
    const a = addTask('g-aaaaaaaa', 'Find three factories');
    const b = addTask('g-bbbbbbbb', 'Draft the October issue');
    const dropped = applyDropTasks(
      'b',
      [
        { task: a, reason: 'Superseded by the new market' },
        { task: 't-ffffff', reason: 'x' },
      ],
      logger,
      soul,
      { cycleId: 'c-10' }
    );
    expect(dropped).toEqual([a]);
    expect(store().get(a)).toBeFalsy();
    expect(store().get(b)).toBeTruthy();
    const ev = readGoalEvents(dir).find((e) => e.op === 'task-remove');
    expect(ev).toMatchObject({ taskId: a, note: 'Superseded by the new market', cycleId: 'c-10' });
  });
});

describe('prompts', () => {
  test('the strategist has a RELEVANCE CHECK and documents drop and drop_tasks', () => {
    const { system } = buildStrategistPrompt({
      identity: 'TestBot',
      soul: 'A bot',
      motivations: 'Be helpful',
      goals: md,
      recentMemory: 'Did stuff',
      datetime: '2026-10-15T12:00:00Z',
    });
    expect(system).toContain('RELEVANCE CHECK');
    expect(system).toContain('"add" | "complete" | "update" | "remove" | "drop"');
    expect(system).toContain('drop_tasks');
  });

  test('the planner Tasks block says to drop a task that no longer applies, never mark it done', () => {
    const text = buildTaskOutputSection({ workersEnabled: false });
    expect(text).toContain('drop_task');
    expect(text).toContain('never mark it done');
  });
});

describe('stats reader: dropped reaches the Agent Home', () => {
  test('a dropped goal carries its reason; others carry null', async () => {
    const { readGoals } = await import('../../src/stats/readers/soul');
    await run({ action: 'drop', goal: 'newsletter', reason: 'Nobody reads it' });
    const detail = readGoals(dir).detail;
    expect(detail.find((g) => g.id === 'g-bbbbbbbb')?.dropped).toBe('Nobody reads it');
    expect(detail.find((g) => g.id === 'g-aaaaaaaa')?.dropped).toBeNull();
  });
});

describe('board: a dropped goal in Done', () => {
  test('shows a dropped tag with the reason instead of the check', () => {
    const html = cardHtml(
      {
        id: 'g-aaaaaaaa',
        text: 'Research dark factories',
        status: 'completed',
        section: 'completed',
        dropped: 'Off-purpose <since> the pivot',
      },
      false
    );
    expect(html).toContain('fb-tag dropped');
    expect(html).toContain('title="Off-purpose &lt;since&gt; the pivot"');
    expect(html).not.toContain('✓');
    const done = cardHtml(
      { id: 'g-b', text: 'Done one', status: 'completed', section: 'completed' },
      false
    );
    expect(done).toContain('✓');
    expect(done).not.toContain('dropped');
  });
});
