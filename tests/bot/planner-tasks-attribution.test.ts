/**
 * Phase 1 attribution: the task a cycle served travels on its tool calls
 * (tool:end → audit, productions, the tool's `_taskId` → asks), task actions
 * of `manage_goals` resolve the cycle's goal, and the cycle Why names the
 * task it served, the tasks it created and the runs it dispatched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resolveCycleGoal } from '../../src/bot/agent-cycle-log';
import { AskHumanStore } from '../../src/bot/ask-human-store';
import { toolEndToAuditEntry } from '../../src/bot/tool-audit-log';
import { type ToolEndEvent, ToolExecutor } from '../../src/bot/tool-executor';
import type { BotContext } from '../../src/bot/types';
import type { StoredTask } from '../../src/goals/task-store';
import { type GoalEntry, goalFromManageGoalsArgs } from '../../src/tools/goals';
import type { Tool, ToolResult } from '../../src/tools/types';
import { cycleToWhy } from '../../src/why/builders/cycle';
import { WhySchema } from '../../src/why/types';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} };

describe('taskId on the cycle work', () => {
  let dir: string;
  let logged: Array<Record<string, unknown>>;
  let seenArgs: Record<string, unknown>[];
  beforeEach(() => {
    dir = createTempDir('exec-task-attrib');
    logged = [];
    seenArgs = [];
  });
  afterEach(() => removeTempDir(dir));

  function tool(name: string, result: ToolResult): Tool {
    return {
      definition: {
        type: 'function',
        function: { name, description: name, parameters: { type: 'object', properties: {} } },
      },
      execute: async (args) => {
        seenArgs.push(args);
        return result;
      },
    };
  }

  it('stamps taskId on tool:end, the audit entry and the production; the tool sees _taskId', async () => {
    const tools = [tool('file_write', { success: true, content: 'ok' })];
    const ctx = {
      config: { bots: [{ id: 'b1', name: 'B', model: 'm', workDir: dir }] },
      logger: { ...quiet, child: () => quiet },
      tools,
      toolDefinitions: tools.map((t) => t.definition),
      productionsService: {
        isEnabled: () => true,
        isTrackOnly: () => false,
        resolveDir: () => dir,
        renumberFile: (_b: string, p: string) => p,
        logProduction: (e: Record<string, unknown>) => logged.push(e),
      },
    } as unknown as BotContext;
    const ex = new ToolExecutor(ctx, {
      botId: 'b1',
      chatId: 0,
      attribution: { cycleId: 'cyc-1', goalId: 'g-1', taskId: 't-abc123' },
    });
    const ends: ToolEndEvent[] = [];
    ex.on('tool:end', (e) => ends.push(e));
    await ex.execute('file_write', {
      path: '01_brief.md',
      content: '# Brief\n\nA real paragraph about something worth reading, long enough to pass.',
    });
    expect(ends[0]).toMatchObject({ cycleId: 'cyc-1', goalId: 'g-1', taskId: 't-abc123' });
    expect(toolEndToAuditEntry(ends[0])).toMatchObject({ taskId: 't-abc123' });
    expect(logged[0]).toMatchObject({ taskId: 't-abc123' });
    expect(seenArgs[0]._taskId).toBe('t-abc123');
  });

  it('an ask keeps the taskId it was asked for', () => {
    const store = new AskHumanStore(quiet as never);
    const { id, promise } = store.ask('b1', 1, 'Which room?', undefined, Date.now(), {
      cycleId: 'c1',
      goalId: 'g-1',
      taskId: 't-abc123',
    });
    promise.catch(() => {}); // dispose() rejects the pending question
    expect(store.getPendingForBot('b1').find((q) => q.id === id)).toMatchObject({
      taskId: 't-abc123',
    });
    store.dispose();
  });
});

describe('resolveCycleGoal from task actions', () => {
  const goals: GoalEntry[] = [
    { text: 'Weekly brief', status: 'pending', priority: 'high', id: 'g-aaaaaaaa' },
    { text: 'Monthly hands-on lab', status: 'in_progress', priority: 'medium', id: 'g-bbbbbbbb' },
  ];
  const tasks = [
    { id: 't-111111', goalId: 'g-bbbbbbbb', text: 'Book the room', lane: 'todo' },
  ] as StoredTask[];

  it('add_task names its goal', () => {
    expect(
      goalFromManageGoalsArgs({ action: 'add_task', goal: 'Weekly brief', task: 'x' }, goals)?.id
    ).toBe('g-aaaaaaaa');
  });

  it('update_task / note_task resolve through the task’s goal in the store', () => {
    expect(
      goalFromManageGoalsArgs(
        { action: 'update_task', task: 't-111111', lane: 'done' },
        goals,
        tasks
      )?.id
    ).toBe('g-bbbbbbbb');
    expect(
      goalFromManageGoalsArgs(
        { action: 'note_task', task: 'book the room', note: 'n' },
        goals,
        tasks
      )?.id
    ).toBe('g-bbbbbbbb');
    expect(
      goalFromManageGoalsArgs({ action: 'note_task', task: 't-zzzzzz' }, goals, tasks)
    ).toBeNull();
  });

  it('resolveCycleGoal uses them', () => {
    expect(
      resolveCycleGoal(
        {
          toolCalls: [{ name: 'manage_goals', args: { action: 'update_task', task: 't-111111' } }],
          tasks,
        },
        goals
      )
    ).toMatchObject({ goalId: 'g-bbbbbbbb', goalSource: 'manage_goals' });
  });
});

describe('cycleToWhy names its tasks and runs', () => {
  const row = {
    cycleId: 'c1',
    startedAt: '2026-10-12T10:00:00.000Z',
    status: 'completed',
    planSummary: 'Pick the lab topic',
    toolCalls: 1,
    tools: ['file_write'],
    goalId: 'g-bbbbbbbb',
    goalTitle: 'Monthly hands-on lab',
    goalSource: 'planner',
    taskId: 't-111111',
    taskText: 'Pick the lab topic',
    newTasks: ['t-111111', 't-222222'],
    dispatched: [
      { taskId: 't-222222', runId: 'r-1', ok: true },
      { taskId: 't-333333', ok: false, reason: 'cap' },
    ],
  };

  it('task served as a note, created tasks and dispatched runs as related items', () => {
    const w = cycleToWhy({ botId: 'b1', cycle: row });
    expect(w.notes).toContainEqual({ label: 'Task', text: 'Pick the lab topic (t-111111)' });
    expect(w.related?.label).toBe('Tasks');
    const texts = (w.related?.items ?? []).map((i) => i.text);
    expect(texts).toContain('Created task t-111111');
    expect(texts).toContain('Created task t-222222');
    expect(texts).toContain('Dispatched t-222222 to a worker (run r-1)');
    expect(texts).toContain('Did not dispatch t-333333: cap');
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('a row without task fields has no Tasks block', () => {
    const { taskId: _a, taskText: _b, newTasks: _c, dispatched: _d, ...plain } = row;
    const w = cycleToWhy({ botId: 'b1', cycle: plain });
    expect(w.related).toBeUndefined();
    expect(w.notes ?? []).not.toContainEqual(expect.objectContaining({ label: 'Task' }));
  });
});
