/**
 * Fixture for the goal detail sidebar (`buildGoalDetail`): one bot (`g1`) with
 * two active goals and a completed one, and six agent-loop cycles:
 * - `exact`: recorded in agent-cycles with goalId → exact
 * - `other`: recorded, serves the other goal → excluded
 * - `manage`: no ids, calls manage_goals naming the lab goal → inferred
 * - `file`: no ids, writes the file named in the goal notes → inferred
 * - `unrelated`: no ids, no link → excluded
 * - `weak`: no ids, its outcome summary shares the goal's words → weak
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig, Config } from '../../src/config';
import { createTempDir } from '../helpers/temp-dir';
import { DAY, H, makeBot, makeConfig } from './fixture';

export const LAB_GOAL =
  'Monthly hands-on lab: one weekend exercise on the most in-demand FDE skill';

export interface GoalDetailFixture {
  dir: string;
  now: number;
  config: Config;
  bot: BotConfig;
  soulDir: string;
  t: {
    exact: number;
    other: number;
    manage: number;
    file: number;
    unrelated: number;
    weak: number;
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function jsonl(path: string, rows: unknown[]) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

function writeByDay(botDir: string, rows: Array<{ timestamp: string }>) {
  const byDay = new Map<string, unknown[]>();
  for (const r of rows) {
    const key = r.timestamp.slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), r]);
  }
  for (const [key, list] of byDay) jsonl(join(botDir, `${key}.jsonl`), list);
}

export function createGoalDetailFixture(): GoalDetailFixture {
  const dir = createTempDir('goal-detail-fixture');
  const now = Date.now();
  const bot = makeBot({ id: 'g1', name: 'Goal Bot' });
  const config = makeConfig(dir, [bot]);
  const soulDir = join(dir, 'tenants', '__admin__', 'bots', 'g1', 'soul');
  const workDir = join(dir, 'productions', 'g1');
  const t = {
    exact: now - 20 * H,
    other: now - 10 * H,
    manage: now - 5 * DAY,
    file: now - 4 * DAY,
    unrelated: now - 3 * DAY,
    weak: now - 2 * DAY,
  };

  mkdirSync(soulDir, { recursive: true });
  writeFileSync(
    join(soulDir, 'GOALS.md'),
    [
      '## Active Goals',
      `- [ ] ${LAB_GOAL}`,
      '  - status: in_progress',
      '  - priority: medium',
      '  - notes: October lab drafted: 05_monthly_lab.md',
      '  - source: operator:2026-10-04',
      '  - created: 2026-10-04',
      '  - id: g-lab00001',
      `  - started: ${iso(t.exact)}`,
      `  - updated: ${iso(t.exact + 60_000)}`,
      '- [ ] Weekly brief every Monday',
      '  - status: pending',
      '  - priority: high',
      '  - source: agent',
      '  - id: g-brief001',
      '',
      '## Completed',
      '- [x] Prior mission',
      '  - completed: 2026-10-03',
      '',
    ].join('\n')
  );
  jsonl(join(soulDir, 'goal-events.jsonl'), [
    {
      ts: iso(now - 30 * H),
      goalId: 'g-lab00001',
      title: LAB_GOAL,
      op: 'add',
      to: 'pending',
      actor: 'operator',
    },
    {
      ts: iso(t.exact + 50_000),
      goalId: 'g-lab00001',
      title: LAB_GOAL,
      op: 'status',
      from: 'pending',
      to: 'in_progress',
      actor: 'tool',
      cycleId: 'c-exact',
    },
    {
      ts: iso(t.other),
      goalId: 'g-brief001',
      title: 'Weekly brief every Monday',
      op: 'add',
      actor: 'agent',
    },
  ]);

  // ── agent-cycles: the two recorded cycles ──
  const cycle = (id: string, start: number, goalId: string, goalTitle: string, plan: string) => ({
    cycleId: id,
    botId: 'g1',
    startedAt: iso(start),
    endedAt: iso(start + 60_000),
    durationMs: 60_000,
    status: 'completed',
    focus: null,
    planSummary: plan,
    plan: [plan],
    priority: 'high',
    toolCalls: 2,
    tools: ['file_write', 'manage_goals'],
    goalId,
    goalTitle,
    goalSource: 'planner',
  });
  const recorded = [
    cycle('c-exact', t.exact, 'g-lab00001', LAB_GOAL, 'Draft the October lab'),
    cycle('c-other', t.other, 'g-brief001', 'Weekly brief every Monday', 'Write the brief'),
  ];
  writeByDay(
    join(dir, 'agent-cycles', 'g1'),
    recorded.map((c) => ({ ...c, timestamp: c.startedAt }))
  );

  // ── LLM query log (timestamp = end of the call) ──
  const llm = (
    start: number,
    offsetMs: number,
    durationMs: number,
    caller: string,
    extra = {}
  ) => ({
    timestamp: iso(start + offsetMs),
    botId: 'g1',
    caller,
    model: 'claude-sonnet',
    backend: 'claude-cli',
    durationMs,
    success: true,
    promptTokens: 100,
    completionTokens: 50,
    ...extra,
  });
  const ids = (cycleId: string, goalId: string) => ({ cycleId, goalId });
  writeByDay(join(dir, 'llm-query-log', 'g1'), [
    llm(t.manage, 2_000, 1_000, 'planner'),
    llm(t.manage, 60_000, 50_000, 'executor'),
    llm(t.file, 2_000, 1_000, 'planner'),
    llm(t.file, 60_000, 50_000, 'executor'),
    llm(t.unrelated, 2_000, 1_000, 'planner'),
    llm(t.unrelated, 60_000, 50_000, 'executor'),
    llm(t.weak, 2_000, 1_000, 'planner'),
    llm(t.weak, 60_000, 50_000, 'executor', { success: false, error: 'timed out' }),
    llm(t.exact, 2_000, 1_000, 'planner', ids('c-exact', 'g-lab00001')),
    llm(t.exact, 60_000, 50_000, 'executor', ids('c-exact', 'g-lab00001')),
    llm(t.other, 2_000, 1_000, 'planner', ids('c-other', 'g-brief001')),
    llm(t.other, 60_000, 50_000, 'executor', ids('c-other', 'g-brief001')),
    // A conversation call between cycles is never part of one.
    llm(t.unrelated, 600_000, 500, 'conversation'),
  ]);

  // ── Tool audit ──
  const tool = (ts: number, toolName: string, args: Record<string, unknown>, extra = {}) => ({
    timestamp: iso(ts),
    botId: 'g1',
    chatId: 0,
    toolName,
    args,
    success: true,
    result: 'ok',
    durationMs: 5,
    retryAttempts: 0,
    ...extra,
  });
  writeByDay(join(dir, 'tool-audit', 'g1'), [
    tool(t.manage + 30_000, 'manage_goals', {
      action: 'update',
      goal: 'Monthly hands-on lab',
      status: 'in_progress',
    }),
    tool(t.file + 30_000, 'file_write', { path: '05_monthly_lab.md' }),
    tool(t.unrelated + 30_000, 'exec', { command: 'ls' }, { success: false, result: 'Exit 2' }),
    tool(
      t.exact + 30_000,
      'file_write',
      { path: '05_monthly_lab.md' },
      ids('c-exact', 'g-lab00001')
    ),
    tool(
      t.exact + 50_000,
      'manage_goals',
      { action: 'update', goal: 'Monthly hands-on lab', status: 'in_progress' },
      ids('c-exact', 'g-lab00001')
    ),
    tool(t.other + 30_000, 'file_write', { path: '02_brief.md' }, ids('c-other', 'g-brief001')),
  ]);

  // ── Productions changelog ──
  const prod = (ts: number, path: string, action: string, extra = {}) => ({
    id: `p-${ts}`,
    timestamp: iso(ts),
    botId: 'g1',
    tool: 'file_write',
    path,
    action,
    description: `Wrote ${path}`,
    size: 1200,
    trackOnly: false,
    ...extra,
  });
  jsonl(join(workDir, 'changelog.jsonl'), [
    prod(t.file + 31_000, '05_monthly_lab.md', 'create', {
      evaluation: { status: 'approved', evaluatedAt: iso(t.file + 2 * H) },
    }),
    prod(t.exact + 31_000, '05_monthly_lab.md', 'edit', ids('c-exact', 'g-lab00001')),
    prod(t.other + 31_000, '02_brief.md', 'create', ids('c-other', 'g-brief001')),
  ]);
  writeFileSync(join(workDir, '05_monthly_lab.md'), '# Lab');

  // ── Outcome ledger: the weak cycle's summary shares the goal's words ──
  jsonl(join(dir, 'outcome-ledger', 'g1', 'outcomes.jsonl'), [
    {
      id: 'o1',
      botId: 'g1',
      timestamp: t.weak + 60_000,
      type: 'CONTENT',
      description: 'Sketch a weekend exercise for the most in-demand FDE skill',
      toolCalls: [],
      status: 'produced',
    },
  ]);

  // ── Asks: one inside the exact cycle, tagged ──
  jsonl(join(dir, 'conversations', 'g1', 'conversations.jsonl'), [
    {
      id: 'ask-1',
      botId: 'g1',
      type: 'inbox',
      title: 'Which skill for the October lab?',
      createdAt: iso(t.exact + 40_000),
      updatedAt: iso(t.exact + 40_000),
      messageCount: 1,
      inboxStatus: 'pending',
      cycleId: 'c-exact',
      goalId: 'g-lab00001',
    },
  ]);

  // ── Karma: the approval of the file the `file` cycle produced ──
  jsonl(join(dir, 'karma', 'g1', 'events.jsonl'), [
    {
      id: 'k1',
      botId: 'g1',
      timestamp: iso(t.file + 2 * H),
      delta: 3,
      reason: 'Production approved: "05_monthly_lab.md"',
      source: 'production',
      kind: 'productionApproved',
      metadata: { path: '05_monthly_lab.md' },
    },
  ]);

  return { dir, now, config, bot, soulDir, t };
}
