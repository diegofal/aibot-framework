/**
 * Writers (agent A) → reader (agent B): the goal sidebar built from what the
 * real goal-event, cycle, LLM and tool-audit writers put on disk.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentCycleLog } from '../../src/bot/agent-cycle-log';
import { writeGoalsFile } from '../../src/bot/goal-events';
import { LlmQueryLog } from '../../src/bot/llm-query-log';
import { ToolAuditLog } from '../../src/bot/tool-audit-log';
import { createStatsContext } from '../../src/stats/context';
import { buildGoalDetail } from '../../src/stats/goal-detail-aggregator';
import { resolveBotPaths } from '../../src/stats/paths';
import { appendGoal, parseGoals, setGoalStatus } from '../../src/tools/goals';
import { createTempDir } from '../helpers/temp-dir';
import { makeBot, makeConfig } from './fixture';

const silent = { warn() {}, info() {}, error() {}, debug() {} } as never;
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe('goal detail from the real writers', () => {
  it('shows an exact cycle with its LLM and tool calls and the operator status history', () => {
    const dir = createTempDir('goal-e2e');
    temps.push(dir);
    const bot = makeBot();
    const config = makeConfig(dir, [bot]);
    const { soulDir } = resolveBotPaths(config, bot);
    mkdirSync(soulDir, { recursive: true });
    const goalsPath = join(soulDir, 'GOALS.md');

    writeGoalsFile(
      goalsPath,
      appendGoal(null, {
        text: 'Ship the brief',
        status: 'pending',
        priority: 'high',
        source: 'operator',
      }),
      { actor: 'operator' }
    );
    writeGoalsFile(
      goalsPath,
      setGoalStatus(readFileSync(goalsPath, 'utf-8'), 'Ship the brief', 'in_progress') as string,
      { actor: 'operator' }
    );
    const goal = parseGoals(readFileSync(goalsPath, 'utf-8')).active[0];
    expect(goal.id).toMatch(/^g-[0-9a-f]{8}$/);

    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    const cycleId = 'cyc-1';
    new LlmQueryLog(join(dir, 'llm-query-log'), silent).append({
      timestamp: at(60_000),
      botId: bot.id,
      caller: 'executor',
      model: 'm',
      backend: 'claude-cli',
      totalTokens: 1234,
      durationMs: 30_000,
      success: true,
      cycleId,
      goalId: goal.id,
    });
    new ToolAuditLog(join(dir, 'tool-audit'), silent).append({
      timestamp: at(70_000),
      botId: bot.id,
      chatId: 0,
      toolName: 'file_write',
      args: { path: 'x.md' },
      success: true,
      result: 'ok',
      durationMs: 5,
      retryAttempts: 0,
      cycleId,
      goalId: goal.id,
    });
    new AgentCycleLog(join(dir, 'agent-cycles')).append({
      cycleId,
      botId: bot.id,
      startedAt: at(120_000),
      endedAt: at(50_000),
      durationMs: 70_000,
      status: 'completed',
      focus: 'brief',
      planSummary: 'Write the brief',
      plan: ['write'],
      priority: 'high',
      toolCalls: 1,
      tools: ['file_write'],
      goalId: goal.id,
      goalTitle: goal.text,
      goalSource: 'planner',
    });

    const ctx = createStatsContext({ config, now: () => now });
    const detail = buildGoalDetail(ctx, bot, { id: goal.id });
    expect(detail).not.toBeNull();
    const cycle = detail?.cycles.find((c) => c.cycleId === cycleId);
    expect(cycle?.attribution).toBe('exact');
    expect(cycle?.llmCalls).toHaveLength(1);
    expect(cycle?.toolCalls.map((t) => t.name)).toEqual(['file_write']);
    const statuses = (detail?.timeline ?? []).map((e) => (e as { to?: string }).to);
    expect(statuses).toContain('in_progress');
  });
});
