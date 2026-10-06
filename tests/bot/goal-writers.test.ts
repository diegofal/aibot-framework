/**
 * Every GOALS.md writer goes through writeGoalsFile, so each change lands in
 * goal-events.jsonl with who made it and, inside a cycle, which cycle.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyGoalOperations } from '../../src/bot/agent-strategist';
import { readGoalEvents } from '../../src/bot/goal-events';
import { SoulLoader } from '../../src/soul';
import { createGoalsTool, parseGoals } from '../../src/tools/goals';

const quiet = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  child: () => quiet,
} as never;

let dir: string;
let loader: SoulLoader;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goal-writers-'));
  writeFileSync(join(dir, 'GOALS.md'), '## Active Goals\n- [ ] Existing\n  - status: pending\n');
  loader = new SoulLoader({ enabled: true, dir } as never, quiet);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SoulLoader.writeGoals', () => {
  test('logs events as the given actor, assigns ids, and still backs up', () => {
    loader.writeGoals('## Active Goals\n- [ ] Existing\n  - status: in_progress\n', {
      actor: 'strategist',
      cycleId: 'cyc-9',
    });
    const [ev] = readGoalEvents(dir);
    expect(ev).toMatchObject({ op: 'status', actor: 'strategist', cycleId: 'cyc-9' });
    expect(parseGoals(loader.readGoals()).active[0].id).toMatch(/^g-/);
    expect(existsSync(join(dir, '.versions'))).toBe(true);
    expect(readdirSync(join(dir, '.versions')).some((f) => f.startsWith('GOALS.md'))).toBe(true);
  });

  test('defaults to actor agent', () => {
    loader.writeGoals('## Active Goals\n- [ ] Existing\n- [ ] New one\n');
    expect(readGoalEvents(dir).map((e) => [e.op, e.actor])).toEqual([['add', 'agent']]);
  });
});

describe('manage_goals', () => {
  test('writes as the agent and carries the cycle it ran in', async () => {
    const tool = createGoalsTool(() => loader);
    const res = await tool.execute(
      {
        action: 'update',
        goal: 'Existing',
        status: 'in_progress',
        _botId: 'b1',
        _cycleId: 'cyc-3',
      },
      quiet
    );
    expect(res.success).toBe(true);
    expect(readGoalEvents(dir)).toEqual([
      expect.objectContaining({
        op: 'status',
        actor: 'agent',
        cycleId: 'cyc-3',
        to: 'in_progress',
      }),
    ]);
  });
});

describe('strategist / curiosity goal operations', () => {
  test('default to actor strategist; curiosity passes its own actor', () => {
    applyGoalOperations('b1', [{ action: 'add', goal: 'From strategist' }], quiet, loader, {
      cycleId: 'cyc-4',
    });
    applyGoalOperations('b1', [{ action: 'add', goal: 'From navigator' }], quiet, loader, {
      actor: 'curiosity',
    });
    expect(readGoalEvents(dir).map((e) => [e.title, e.actor, e.cycleId ?? null])).toEqual([
      ['From strategist', 'strategist', 'cyc-4'],
      ['From navigator', 'curiosity', null],
    ]);
  });
});
