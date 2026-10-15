/**
 * Usage per bot: calls, tokens as Claude bills them (input, cache reads and
 * writes, output), the cost the CLI reported, by caller, by account and by day.
 */
import { describe, expect, test } from 'bun:test';
import type { LlmQueryEntry } from '../../src/bot/llm-query-log';
import { summarizeUsage } from '../../src/stats/usage-aggregator';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const e = (over: Partial<LlmQueryEntry>): LlmQueryEntry => ({
  timestamp: '2026-10-15T10:00:00.000Z',
  botId: 'b1',
  caller: 'planner',
  model: 'claude-opus-5-5',
  backend: 'claude-cli',
  durationMs: 1000,
  success: true,
  promptTokens: 2,
  completionTokens: 100,
  ...over,
});

describe('summarizeUsage', () => {
  const entries = {
    b1: [
      e({ cacheReadTokens: 40_000, cacheCreationTokens: 5_000, costUsd: 0.4, account: 'default' }),
      e({
        caller: 'worker',
        costUsd: 0.1,
        account: 'work-2',
        timestamp: '2026-10-14T10:00:00.000Z',
      }),
      e({ caller: 'conversation', success: false, completionTokens: 0, promptTokens: 0 }),
    ],
    b2: [e({ botId: 'b2', costUsd: 1.5, account: 'default' })],
  };
  const out = summarizeUsage(entries, { b1: 'Bot One', b2: 'Bot Two' }, '7d', NOW);

  test('per bot: calls, failed, every token kind, cost; most expensive first', () => {
    expect(out.bots.map((b) => b.botId)).toEqual(['b2', 'b1']);
    const b1 = out.bots[1];
    expect(b1).toMatchObject({
      name: 'Bot One',
      calls: 3,
      failed: 1,
      inputTokens: 4,
      cacheReadTokens: 40_000,
      cacheCreationTokens: 5_000,
      outputTokens: 200,
      totalTokens: 45_204,
    });
    expect(b1.costUsd).toBeCloseTo(0.5, 6);
  });

  test('by caller and by account', () => {
    const b1 = out.bots[1];
    expect(b1.byCaller.planner.calls).toBe(1);
    expect(b1.byCaller.worker.costUsd).toBeCloseTo(0.1, 6);
    expect(Object.keys(b1.byAccount).sort()).toEqual(['default', 'work-2']);
  });

  test('daily series over the window, oldest first, ending today', () => {
    const b1 = out.bots[1];
    expect(b1.daily).toHaveLength(7);
    expect(b1.daily.at(-1)).toMatchObject({ date: '2026-10-15', calls: 2 });
    expect(b1.daily.at(-2)?.costUsd).toBeCloseTo(0.1, 6);
  });

  test('fleet totals, by account, and since when cost is known', () => {
    expect(out.fleet.calls).toBe(4);
    expect(out.fleet.costUsd).toBeCloseTo(2.0, 6);
    expect(out.fleet.byAccount.default.calls).toBe(2);
    expect(out.costReportedSince).toBe('2026-10-14T10:00:00.000Z');
  });

  test('no entries: zeros, no cost date', () => {
    const empty = summarizeUsage({ b1: [] }, { b1: 'B' }, '24h', NOW);
    expect(empty.fleet.calls).toBe(0);
    expect(empty.costReportedSince).toBeNull();
    expect(empty.bots[0].daily).toHaveLength(1);
  });
});

describe('buildUsage: sessions no bot could be tied to', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const { buildUsage } = require('../../src/stats/usage-aggregator');

  test('admins see a "Not attributed" row; tenants and empty logs do not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-'));
    try {
      mkdirSync(join(dir, '_unattributed'));
      writeFileSync(
        join(dir, '_unattributed', '2026-10-15.jsonl'),
        `${JSON.stringify(e({ botId: '_unattributed', caller: 'unlogged', costUsd: 0.7 }))}\n`
      );
      const ctx: any = { now: () => NOW, dirs: { llmQueryLog: dir } };
      const bots: any = [{ id: 'b1', name: 'B1' }];
      const admin = buildUsage(ctx, bots, '7d', { includeUnattributed: true });
      expect(admin.bots.map((b: any) => b.name)).toContain('Not attributed to a bot');
      expect(admin.fleet.costUsd).toBeCloseTo(0.7, 6);
      expect(buildUsage(ctx, bots, '7d').bots.map((b: any) => b.botId)).toEqual(['b1']);
      rmSync(join(dir, '_unattributed'), { recursive: true });
      expect(
        buildUsage(ctx, bots, '7d', { includeUnattributed: true }).bots.map((b: any) => b.botId)
      ).toEqual(['b1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
