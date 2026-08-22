import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aggregateLlm,
  llmDaily,
  readLlmEntries,
  topErrors,
} from '../../../src/stats/readers/llm-query-log';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

const NOW = Date.UTC(2026, 7, 21, 12);
const DAY = 86_400_000;

let dir: string;
beforeEach(() => {
  dir = createTempDir('stats-llm');
});
afterEach(() => removeTempDir(dir));

function entry(over: Record<string, unknown>) {
  return {
    timestamp: new Date(NOW - 3_600_000).toISOString(),
    botId: 'b1',
    caller: 'planner',
    model: 'qwen',
    backend: 'ollama',
    durationMs: 1000,
    success: true,
    promptTokens: 100,
    completionTokens: 20,
    ...over,
  };
}

function writeDay(botId: string, ms: number, lines: unknown[]) {
  const d = join(dir, botId);
  mkdirSync(d, { recursive: true });
  const date = new Date(ms).toISOString().slice(0, 10);
  writeFileSync(join(d, `${date}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

describe('readLlmEntries', () => {
  it('returns [] when the bot dir is missing', () => {
    expect(readLlmEntries(dir, 'ghost', NOW - DAY, NOW)).toEqual([]);
  });
  it('only reads day files inside the window and filters by timestamp', () => {
    writeDay('b1', NOW, [entry({}), entry({ timestamp: new Date(NOW - 2 * DAY).toISOString() })]);
    writeDay('b1', NOW - 10 * DAY, [entry({ timestamp: new Date(NOW - 10 * DAY).toISOString() })]);
    const got = readLlmEntries(dir, 'b1', NOW - DAY, NOW);
    expect(got).toHaveLength(1);
  });
  it('ignores non-date files', () => {
    mkdirSync(join(dir, 'b1'), { recursive: true });
    writeFileSync(join(dir, 'b1', 'notes.txt'), 'x');
    expect(readLlmEntries(dir, 'b1', 0, NOW)).toEqual([]);
  });
});

describe('aggregateLlm', () => {
  it('returns zeros / nulls for no entries', () => {
    const s = aggregateLlm([]);
    expect(s.calls).toBe(0);
    expect(s.failRate).toBe(0);
    expect(s.avgDurationMs).toBe(0);
    expect(s.lastError).toBeNull();
    expect(s.lastCallAt).toBeNull();
    expect(s.byCaller).toEqual({});
  });
  it('aggregates calls, failures, tokens, callers and models', () => {
    const s = aggregateLlm([
      entry({}),
      entry({ success: false, error: 'timeout', caller: 'executor', durationMs: 3000 }),
      entry({ model: 'claude', backend: 'claude-cli', promptTokens: 50, completionTokens: 5 }),
    ] as never);
    expect(s.calls).toBe(3);
    expect(s.failed).toBe(1);
    expect(s.failRate).toBeCloseTo(1 / 3, 3);
    expect(s.avgDurationMs).toBe(Math.round(5000 / 3));
    expect(s.promptTokens).toBe(250);
    expect(s.completionTokens).toBe(45);
    expect(s.byCaller.planner).toEqual({ calls: 2, failed: 0 });
    expect(s.byCaller.executor).toEqual({ calls: 1, failed: 1 });
    expect(s.byModel.qwen.calls).toBe(2);
    expect(s.byModel.claude.promptTokens).toBe(50);
    expect(s.lastError).toBe('timeout');
    expect(s.lastCallAt).toBe(new Date(NOW - 3_600_000).toISOString());
  });
});

describe('llmDaily / topErrors', () => {
  it('buckets by UTC date sorted ascending', () => {
    const d = llmDaily([
      entry({}),
      entry({ timestamp: new Date(NOW - DAY).toISOString(), success: false, error: 'x' }),
    ] as never);
    expect(d).toHaveLength(2);
    expect(d[0].date < d[1].date).toBe(true);
    expect(d[0]).toEqual({ date: '2026-08-20', calls: 1, failed: 1, promptTokens: 100 });
  });
  it('groups errors by normalised message and sorts by count', () => {
    const t = topErrors(
      [
        entry({ success: false, error: 'HTTP 500 after 1234ms' }),
        entry({ success: false, error: 'HTTP 500 after 99ms' }),
        entry({ success: false, error: 'other' }),
        entry({}),
      ] as never,
      5
    );
    expect(t[0]).toEqual({ message: 'HTTP N after Nms', count: 2 });
    expect(t).toHaveLength(2);
  });
});
