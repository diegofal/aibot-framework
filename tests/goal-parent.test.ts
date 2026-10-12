/**
 * A goal made from another one remembers it (`- parent: g-…`), so the board can
 * show the operator's goal with the goals the agent spawned from it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyGoalOperations } from '../src/bot/agent-strategist';
import { appendSuggestedGoals } from '../src/skills/reflection';
import {
  createGoalsTool,
  parseGoals,
  resolveParentGoalId,
  serializeGoals,
} from '../src/tools/goals';

const logger: any = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};

const PARENT_MD =
  '## Active Goals\n- [ ] Research what people say about LLMs every day\n  - status: in_progress\n  - priority: medium\n  - id: g-7cb6a370\n- [ ] Old goal written before ids\n  - status: pending\n  - priority: low\n\n## Completed\n(none yet)\n';

describe('parent line', () => {
  test('parses and serializes `- parent:`', () => {
    const md =
      '## Active Goals\n- [ ] Child\n  - status: pending\n  - priority: medium\n  - source: reflection:2026-10-11\n  - parent: g-7cb6a370\n  - id: g-1001d015\n';
    const { active, completed } = parseGoals(md);
    expect(active[0].parent).toBe('g-7cb6a370');
    const again = parseGoals(serializeGoals(active, completed));
    expect(again.active[0].parent).toBe('g-7cb6a370');
    expect(again.active[0].id).toBe('g-1001d015');
  });

  test('a completed goal keeps its parent', () => {
    const md =
      '## Active Goals\n(no active goals)\n\n## Completed\n- [x] Child\n  - completed: 2026-10-11\n  - parent: g-7cb6a370\n';
    const { active, completed } = parseGoals(md);
    expect(completed[0].parent).toBe('g-7cb6a370');
    expect(serializeGoals(active, completed)).toContain('  - parent: g-7cb6a370');
  });

  test('a goal without a parent writes no line', () => {
    const { active, completed } = parseGoals(PARENT_MD);
    expect(serializeGoals(active, completed)).not.toContain('parent:');
  });
});

describe('resolveParentGoalId', () => {
  test('an existing id resolves to itself', () => {
    const { active, completed } = parseGoals(PARENT_MD);
    expect(resolveParentGoalId(active, completed, 'g-7cb6a370')).toBe('g-7cb6a370');
  });

  test('a title (or a piece of it) resolves to that goal id', () => {
    const { active, completed } = parseGoals(PARENT_MD);
    expect(resolveParentGoalId(active, completed, 'what people say about LLMs')).toBe('g-7cb6a370');
  });

  test('a goal without an id gets one, so the link survives the write', () => {
    const { active, completed } = parseGoals(PARENT_MD);
    const id = resolveParentGoalId(active, completed, 'Old goal written before ids');
    expect(id).toMatch(/^g-[0-9a-f]{8}$/);
    expect(active[1].id).toBe(id as string);
  });

  test('unknown, empty or missing refs resolve to undefined', () => {
    const { active, completed } = parseGoals(PARENT_MD);
    expect(resolveParentGoalId(active, completed, 'g-deadbeef')).toBeUndefined();
    expect(resolveParentGoalId(active, completed, 'zzz qqq unrelated words')).toBeUndefined();
    expect(resolveParentGoalId(active, completed, '')).toBeUndefined();
    expect(resolveParentGoalId(active, completed, undefined)).toBeUndefined();
  });
});

describe('writers record the parent', () => {
  let soulDir: string;
  beforeEach(() => {
    soulDir = mkdtempSync(join(tmpdir(), 'goal-parent-'));
    writeFileSync(join(soulDir, 'GOALS.md'), PARENT_MD);
  });
  afterEach(() => rmSync(soulDir, { recursive: true, force: true }));

  test('reflection: a suggested goal names the goal it comes from', () => {
    appendSuggestedGoals(
      soulDir,
      [{ text: 'Publish the first daily practitioner digest', parent: 'people say about LLMs' }],
      logger,
      '2026-10-11'
    );
    const { active } = parseGoals(readFileSync(join(soulDir, 'GOALS.md'), 'utf-8'));
    const child = active.find((g) => g.text.startsWith('Publish'));
    expect(child?.parent).toBe('g-7cb6a370');
  });

  test('reflection: an unknown parent is dropped, the goal is still added', () => {
    appendSuggestedGoals(
      soulDir,
      [{ text: 'Something new entirely', parent: 'no such goal anywhere zzz' }],
      logger,
      '2026-10-11'
    );
    const { active } = parseGoals(readFileSync(join(soulDir, 'GOALS.md'), 'utf-8'));
    const child = active.find((g) => g.text === 'Something new entirely');
    expect(child).toBeDefined();
    expect(child?.parent).toBeUndefined();
  });

  test('strategist: an add operation with a parent', () => {
    let stored = PARENT_MD;
    const loader: any = { readGoals: () => stored, writeGoals: (c: string) => (stored = c) };
    applyGoalOperations(
      'b',
      [{ action: 'add', goal: 'Rebuild the brief', parent: 'g-7cb6a370' }],
      logger,
      loader
    );
    const child = parseGoals(stored).active.find((g) => g.text === 'Rebuild the brief');
    expect(child?.parent).toBe('g-7cb6a370');
  });

  test('manage_goals add: `parent` names the goal this one serves', async () => {
    let stored = PARENT_MD;
    const loader: any = { readGoals: () => stored, writeGoals: (c: string) => (stored = c) };
    const tool = createGoalsTool(() => loader);
    const res = await tool.execute(
      { action: 'add', goal: 'Collect five HN threads', parent: 'LLMs every day', _botId: 'b' },
      logger
    );
    expect(res.success).toBe(true);
    const child = parseGoals(stored).active.find((g) => g.text === 'Collect five HN threads');
    expect(child?.parent).toBe('g-7cb6a370');
  });

  test('manage_goals add: the schema documents `parent`', () => {
    const tool = createGoalsTool(() => ({}) as any);
    const props = (tool.definition.function.parameters as any).properties;
    expect(props.parent?.type).toBe('string');
  });
});
