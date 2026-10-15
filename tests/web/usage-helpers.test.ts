import { describe, expect, test } from 'bun:test';
import { formatUsd, usageTableHtml } from '../../web/pages/stats-helpers.js';

const row = (over: Record<string, unknown> = {}) => ({
  botId: 'b1',
  name: 'Bot One',
  calls: 120,
  failed: 3,
  inputTokens: 1_000,
  cacheReadTokens: 2_000_000,
  cacheCreationTokens: 150_000,
  outputTokens: 80_000,
  totalTokens: 2_231_000,
  costUsd: 12.345,
  durationMs: 600_000,
  byCaller: {
    planner: { calls: 20, costUsd: 2, totalTokens: 300_000 },
    executor: { calls: 60, costUsd: 9, totalTokens: 1_700_000 },
  },
  byAccount: { default: { calls: 120 } },
  daily: [
    { date: '2026-10-14', calls: 50, totalTokens: 900_000, costUsd: 5 },
    { date: '2026-10-15', calls: 70, totalTokens: 1_331_000, costUsd: 7.345 },
  ],
  ...over,
});

describe('usage table', () => {
  test('formatUsd: cents under $10, whole dollars above, -- without data', () => {
    expect(formatUsd(0.4123)).toBe('$0.41');
    expect(formatUsd(12.345)).toBe('$12');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(undefined)).toBe('--');
  });

  test('one row per bot: calls, failed, tokens with the breakdown, cost, top caller, by day', () => {
    const html = usageTableHtml([row()]);
    expect(html).toContain('Bot One');
    expect(html).toContain('120');
    expect(html).toContain('2.2M');
    expect(html).toContain('cache read 2M');
    expect(html).toContain('$12');
    expect(html).toContain('executor');
    expect((html.match(/class="stats-day-bar"/g) ?? []).length).toBe(2);
  });

  test('names are escaped; no bots says so', () => {
    expect(usageTableHtml([row({ name: '<b>x</b>' })])).not.toContain('<b>x</b>');
    expect(usageTableHtml([])).toContain('No LLM calls');
  });
});
