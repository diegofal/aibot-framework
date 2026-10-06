import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStatsContext } from '../../src/stats/context';
import {
  buildGoalDetail,
  goalOrigin,
  reconstructCycleWindows,
} from '../../src/stats/goal-detail-aggregator';
import { resolveStatsDirs } from '../../src/stats/paths';
import { readAgentCycles } from '../../src/stats/readers/agent-cycles';
import { readGoalEvents, readGoalExtras } from '../../src/stats/readers/goal-events';
import { readGoals } from '../../src/stats/readers/soul';
import { type GoalDetailFixture, LAB_GOAL, createGoalDetailFixture } from './goal-detail-fixture';

let fx: GoalDetailFixture;
beforeEach(() => {
  fx = createGoalDetailFixture();
});
afterEach(() => rmSync(fx.dir, { recursive: true, force: true }));

const ctxOf = () => createStatsContext({ config: fx.config, now: () => fx.now });

describe('goal readers', () => {
  it('resolves the agent-cycles dir next to the other stores', () => {
    expect(resolveStatsDirs(fx.config).agentCycles).toBe(join(fx.dir, 'agent-cycles'));
  });

  it('reads id/started/updated lines parseGoals does not know', () => {
    const extras = readGoalExtras(fx.soulDir);
    const lab = extras.get(LAB_GOAL.toLowerCase());
    expect(lab?.id).toBe('g-lab00001');
    expect(lab?.started).toBe(new Date(fx.t.exact).toISOString());
    expect(extras.get('weekly brief every monday')?.id).toBe('g-brief001');
  });

  it('home goals carry their id when GOALS.md has one', () => {
    const detail = readGoals(fx.soulDir).detail;
    expect(detail.find((g) => g.text === LAB_GOAL)?.id).toBe('g-lab00001');
    expect(detail.find((g) => g.text === 'Prior mission')?.id).toBeNull();
  });

  it('reads goal events and agent cycles, never throwing on missing data', () => {
    expect(readGoalEvents(fx.soulDir)).toHaveLength(3);
    expect(readGoalEvents(join(fx.dir, 'nope'))).toEqual([]);
    const cycles = readAgentCycles(
      join(fx.dir, 'agent-cycles'),
      'g1',
      fx.now - 2 * 86_400_000,
      fx.now
    );
    expect(cycles.map((c) => c.cycleId).sort()).toEqual(['c-exact', 'c-other']);
    expect(readAgentCycles(join(fx.dir, 'nope'), 'g1', 0, fx.now)).toEqual([]);
  });
});

describe('goalOrigin', () => {
  it('parses who set a goal and when', () => {
    expect(goalOrigin('operator:2026-10-04')).toEqual({ origin: 'operator', date: '2026-10-04' });
    expect(goalOrigin('operator')).toEqual({ origin: 'operator', date: null });
    expect(goalOrigin('agent')).toEqual({ origin: 'agent', date: null });
    expect(goalOrigin('strategist:2026-09-01')).toEqual({
      origin: 'strategist',
      date: '2026-09-01',
    });
    expect(goalOrigin('preset:job-seeker').origin).toBe('preset');
    expect(goalOrigin('reflection:2026-09-02').origin).toBe('reflection');
    expect(goalOrigin(null)).toEqual({ origin: 'unknown', date: null });
    expect(goalOrigin('weird')).toEqual({ origin: 'unknown', date: null });
  });
});

describe('reconstructCycleWindows', () => {
  it('groups planner→executor runs into one window and skips conversation calls', () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const base = 1_000_000_000_000;
    const windows = reconstructCycleWindows([
      { timestamp: iso(base + 2_000), caller: 'planner', durationMs: 1_000 },
      { timestamp: iso(base + 60_000), caller: 'executor', durationMs: 50_000 },
      { timestamp: iso(base + 600_000), caller: 'conversation', durationMs: 500 },
      { timestamp: iso(base + 3_600_000), caller: 'strategist', durationMs: 2_000 },
      { timestamp: iso(base + 3_610_000), caller: 'planner', durationMs: 1_000 },
      { timestamp: iso(base + 3_700_000), caller: 'executor', durationMs: 60_000 },
    ] as never);
    expect(windows).toHaveLength(2);
    expect(windows[0].startMs).toBe(base + 1_000);
    expect(windows[0].endMs).toBe(base + 60_000);
    expect(windows[0].llm).toHaveLength(2);
    expect(windows[1].llm.map((e) => e.caller)).toEqual(['strategist', 'planner', 'executor']);
  });
});

describe('buildGoalDetail', () => {
  it('returns null for an unknown goal', () => {
    expect(buildGoalDetail(ctxOf(), fx.bot, { id: 'g-nope' })).toBeNull();
    expect(buildGoalDetail(ctxOf(), fx.bot, { title: 'Nope' })).toBeNull();
  });

  it('builds the header from GOALS.md, by id or exact title', () => {
    const byId = buildGoalDetail(ctxOf(), fx.bot, { id: 'g-lab00001' });
    const byTitle = buildGoalDetail(ctxOf(), fx.bot, { title: `  ${LAB_GOAL.toUpperCase()} ` });
    expect(byTitle?.goal.id).toBe('g-lab00001');
    const g = byId?.goal;
    expect(g?.text).toBe(LAB_GOAL);
    expect(g?.status).toBe('in_progress');
    expect(g?.bucket).toBe('inProgress');
    expect(g?.origin).toBe('operator');
    expect(g?.originDate).toBe('2026-10-04');
    expect(g?.created).toBe('2026-10-04');
    expect(g?.started).toBe(new Date(fx.t.exact).toISOString());
    expect(g?.notes).toBe('October lab drafted: 05_monthly_lab.md');
  });

  it('timeline merges goal events with inferred manage_goals calls from before them', () => {
    const d = buildGoalDetail(ctxOf(), fx.bot, { id: 'g-lab00001', days: 14 });
    const tl = d?.timeline ?? [];
    expect(tl.map((e) => [e.op, e.inferred])).toEqual([
      ['status', true], // manage_goals 5 days ago, before the event log existed
      ['add', false],
      ['status', false],
    ]);
    expect(tl[0].to).toBe('in_progress');
    expect(tl[2].actor).toBe('tool');
  });

  it('attributes cycles: exact by id, inferred by manage_goals / file in notes, weak by words', () => {
    const d = buildGoalDetail(ctxOf(), fx.bot, { id: 'g-lab00001', days: 14 });
    const cycles = d?.cycles ?? [];
    expect(cycles.map((c) => [c.startedAt.slice(0, 13), c.attribution, c.reason])).toEqual([
      [new Date(fx.t.exact).toISOString().slice(0, 13), 'exact', 'cycle log'],
      [new Date(fx.t.weak).toISOString().slice(0, 13), 'weak', 'keyword overlap'],
      [new Date(fx.t.file).toISOString().slice(0, 13), 'inferred', 'file named in goal notes'],
      [
        new Date(fx.t.manage).toISOString().slice(0, 13),
        'inferred',
        'manage_goals named this goal',
      ],
    ]);
  });

  it('collects the exact cycle by cycleId: LLM calls, tools, files, asks', () => {
    const d = buildGoalDetail(ctxOf(), fx.bot, { id: 'g-lab00001', days: 14 });
    const c = d?.cycles[0];
    expect(c?.cycleId).toBe('c-exact');
    expect(c?.planSummary).toBe('Draft the October lab');
    expect(c?.llmCalls.map((l) => l.caller)).toEqual(['planner', 'executor']);
    expect(c?.toolCalls.map((t) => t.name)).toEqual(['file_write', 'manage_goals']);
    expect(c?.productions).toEqual([
      expect.objectContaining({ path: '05_monthly_lab.md', action: 'edit', review: 'pending' }),
    ]);
    expect(c?.asks.map((a) => a.title)).toEqual(['Which skill for the October lab?']);
  });

  it('inferred cycles get their rows by time window, and karma by produced file', () => {
    const d = buildGoalDetail(ctxOf(), fx.bot, { id: 'g-lab00001', days: 14 });
    const file = d?.cycles.find((c) => c.reason === 'file named in goal notes');
    expect(file?.cycleId).toBeNull();
    expect(file?.toolCalls.map((t) => t.name)).toEqual(['file_write']);
    expect(file?.productions[0]).toEqual(
      expect.objectContaining({ path: '05_monthly_lab.md', action: 'create', review: 'approved' })
    );
    expect(file?.karma.map((k) => k.delta)).toEqual([3]);
    const weak = d?.cycles.find((c) => c.attribution === 'weak');
    expect(weak?.planSummary).toContain('weekend exercise');
    expect(weak?.llmCalls[1].ok).toBe(false);
  });

  it('totals add up and the lookback window is honoured', () => {
    const d = buildGoalDetail(ctxOf(), fx.bot, { id: 'g-lab00001', days: 14 });
    expect(d?.totals).toEqual({
      cycles: 4,
      exactCycles: 1,
      inferredCycles: 3,
      llmCalls: 8,
      tokens: 8 * 150,
      toolCalls: 4,
      toolFailures: 0,
      files: 2,
      asks: 1,
    });
    expect(d?.tracking.exact).toBe(true);
    const short = buildGoalDetail(ctxOf(), fx.bot, { id: 'g-lab00001', days: 3 });
    expect(short?.days).toBe(3);
    expect(short?.cycles.map((c) => c.attribution)).toEqual(['exact', 'weak']);
  });

  it('works on data without any ids (before instrumentation)', () => {
    writeFileSync(
      join(fx.soulDir, 'GOALS.md'),
      `## Active Goals\n- [ ] ${LAB_GOAL}\n  - status: pending\n  - priority: medium\n  - notes: lab in 05_monthly_lab.md\n\n## Completed\n(none yet)\n`
    );
    rmSync(join(fx.soulDir, 'goal-events.jsonl'));
    rmSync(join(fx.dir, 'agent-cycles'), { recursive: true });
    const d = buildGoalDetail(ctxOf(), fx.bot, { title: LAB_GOAL, days: 14 });
    expect(d?.goal.id).toBeNull();
    expect(d?.tracking.exact).toBe(false);
    expect(d?.timeline.every((e) => e.inferred)).toBe(true);
    expect(d?.cycles.length).toBeGreaterThanOrEqual(2);
    expect(d?.cycles.every((c) => c.attribution !== 'exact')).toBe(true);
  });
});
