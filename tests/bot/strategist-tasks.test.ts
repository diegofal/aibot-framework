/**
 * C21: the strategist's goal operations may carry tasks; its deliverable becomes
 * a task only when serves_goal resolves; a goal it completes or removes stops
 * its workers and releases its claims.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyGoalOperations,
  applyStrategistDeliverable,
  parseStrategistResult,
} from '../../src/bot/agent-strategist';
import { readGoalEvents } from '../../src/bot/goal-events';
import { SoulLoader } from '../../src/soul';
import { parseGoals } from '../../src/tools/goals';
import type { WorkerPoolApi, WorkerRunView } from '../../src/workers/types';

const quiet = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  child: () => quiet,
} as never;

const GOALS = `## Active Goals
- [ ] Research dark factories
  - status: in_progress
  - id: g-aaaaaaaa
- [ ] Write the newsletter
  - status: pending
  - id: g-bbbbbbbb
`;

let dir: string;
let loader: SoulLoader;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'strategist-tasks-'));
  writeFileSync(join(dir, 'GOALS.md'), GOALS);
  loader = new SoulLoader({ enabled: true, dir } as never, quiet);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = () => loader.getTaskStore();

describe('goal_operations.add with tasks', () => {
  test('writes the initial breakdown as agent tasks with the cycle id', () => {
    applyGoalOperations(
      'b1',
      [
        {
          action: 'add',
          goal: 'Launch the podcast',
          tasks: ['Pick a name', 'Record the pilot', '', 42 as never],
        },
      ],
      quiet,
      loader,
      { cycleId: 'cyc-1' }
    );
    const goal = parseGoals(loader.readGoals()).active.find((g) => g.text === 'Launch the podcast');
    expect(goal?.id).toMatch(/^g-/);
    const tasks = store().forGoal(goal?.id as string);
    expect(tasks.map((t) => [t.text, t.by, t.createdCycle])).toEqual([
      ['Pick a name', 'agent', 'cyc-1'],
      ['Record the pilot', 'agent', 'cyc-1'],
    ]);
    const adds = readGoalEvents(dir).filter((e) => e.op === 'task-add');
    expect(adds.every((e) => e.actor === 'agent' && e.cycleId === 'cyc-1')).toBe(true);
  });

  test('parseStrategistResult keeps goal ops tasks as given', () => {
    const r = parseStrategistResult(
      JSON.stringify({
        goal_operations: [{ action: 'add', goal: 'X', tasks: ['a', 'b'] }],
        single_deliverable: 'Do a',
        reflection: 'r',
      }),
      quiet
    );
    expect(r?.goal_operations[0].tasks).toEqual(['a', 'b']);
  });
});

describe('single_deliverable', () => {
  test('becomes a task on the goal serves_goal names (id or title)', () => {
    const id = applyStrategistDeliverable(
      loader,
      { single_deliverable: 'Draft the October issue', serves_goal: 'Write the newsletter' },
      { cycleId: 'cyc-2' }
    );
    expect(id).toMatch(/^t-/);
    expect(store().get(id as string)).toMatchObject({
      goalId: 'g-bbbbbbbb',
      text: 'Draft the October issue',
      createdCycle: 'cyc-2',
      by: 'agent',
    });
  });

  test('dedupes against an open task of the goal', () => {
    const first = applyStrategistDeliverable(
      loader,
      { single_deliverable: 'Draft the October issue', serves_goal: 'g-bbbbbbbb' },
      {}
    );
    const again = applyStrategistDeliverable(
      loader,
      { single_deliverable: 'Draft the October issue.', serves_goal: 'g-bbbbbbbb' },
      {}
    );
    expect(again).toBe(first);
    expect(store().forGoal('g-bbbbbbbb')).toHaveLength(1);
  });

  test('without a resolvable serves_goal nothing is written', () => {
    expect(applyStrategistDeliverable(loader, { single_deliverable: 'Something' }, {})).toBeNull();
    expect(
      applyStrategistDeliverable(
        loader,
        { single_deliverable: 'Something', serves_goal: 'No such goal at all' },
        {}
      )
    ).toBeNull();
    expect(store().list()).toEqual([]);
  });
});

describe('closing goals stops their workers', () => {
  function seedClaim() {
    const s = store();
    const r = s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'Find three factories' }], {
      actor: 'agent',
    });
    if (!r.ok) throw new Error(r.message);
    const id = r.results[0].id;
    s.apply([{ op: 'claim', id, runId: 'r-1', ttlMs: 60_000 }], { actor: 'system' });
    return id;
  }
  function pool(taskId: string) {
    const stopped: string[] = [];
    const runs = [
      { runId: 'r-1', botId: 'b1', taskId, goalId: 'g-aaaaaaaa', status: 'running' },
    ] as WorkerRunView[];
    const api = {
      list: () => runs,
      stop: (id: string, reason: string) => {
        stopped.push(`${id}:${reason}`);
        return true;
      },
    } as unknown as WorkerPoolApi;
    return { api, stopped };
  }

  for (const action of ['complete', 'remove'] as const) {
    test(`${action} stops the goal's runs and releases claims`, () => {
      const taskId = seedClaim();
      const { api, stopped } = pool(taskId);
      applyGoalOperations('b1', [{ action, goal: 'dark factories' }], quiet, loader, {
        cycleId: 'cyc-3',
        workerPool: api,
      });
      expect(stopped).toEqual(['r-1:goal-closed']);
      expect(store().get(taskId)?.claim).toBeUndefined();
    });
  }

  test('an update does not touch workers', () => {
    const taskId = seedClaim();
    const { api, stopped } = pool(taskId);
    applyGoalOperations(
      'b1',
      [{ action: 'update', goal: 'dark factories', notes: 'n' }],
      quiet,
      loader,
      { workerPool: api }
    );
    expect(stopped).toEqual([]);
    expect(store().get(taskId)?.claim?.runId).toBe('r-1');
  });
});

describe('strategist prompt', () => {
  test('asks for an optional task breakdown on add and explains the deliverable task', async () => {
    const { buildStrategistPrompt } = await import('../../src/bot/agent-loop-prompts');
    const { system } = buildStrategistPrompt({
      identity: 'TestBot',
      soul: 'A bot',
      motivations: 'Be helpful',
      goals: '## Goals\n- Goal 1',
      recentMemory: 'Did stuff',
      datetime: '2026-03-08T12:00:00Z',
    });
    expect(system).toContain('tasks: array of strings (for add');
    expect(system).toContain('becomes a task on that goal');
  });
});
