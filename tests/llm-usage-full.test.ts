/**
 * Usage as Claude bills it: the CLI reports cache reads and writes apart from
 * `input_tokens` (live, a planner call logged promptTokens: 2) and its own
 * `total_cost_usd`. Both are kept, summed across tool rounds and written to the
 * query log with the account that served the call.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmQueryLog, claudeAccountOf, usageExtras } from '../src/bot/llm-query-log';
import { parseClaudeUsage } from '../src/claude-cli';
import { mergeTokenUsage } from '../src/core/tool-runner';

const cli = {
  model: 'claude-opus-5-5',
  session_id: 'sess-1',
  total_cost_usd: 0.4123,
  usage: {
    input_tokens: 2,
    output_tokens: 945,
    cache_read_input_tokens: 41_000,
    cache_creation_input_tokens: 6_500,
  },
};

describe('full Claude usage', () => {
  test('parseClaudeUsage keeps cache reads, cache writes and the reported cost', () => {
    expect(parseClaudeUsage(cli as never)).toEqual({
      model: 'claude-opus-5-5',
      promptTokens: 2,
      completionTokens: 945,
      totalTokens: 947,
      cacheReadTokens: 41_000,
      cacheCreationTokens: 6_500,
      costUsd: 0.4123,
      sessionId: 'sess-1',
    });
  });

  test('tool rounds add up cache tokens and cost', () => {
    const a = parseClaudeUsage(cli as never);
    const merged = mergeTokenUsage(a, a);
    expect(merged?.cacheReadTokens).toBe(82_000);
    expect(merged?.cacheCreationTokens).toBe(13_000);
    expect(merged?.costUsd).toBeCloseTo(0.8246, 6);
    expect(
      mergeTokenUsage(a, { model: 'm', promptTokens: 1, completionTokens: 1, totalTokens: 2 })
        ?.costUsd
    ).toBeCloseTo(0.4123, 6);
  });

  test('usageExtras: only the fields that exist', () => {
    expect(usageExtras(parseClaudeUsage(cli as never))).toEqual({
      cacheReadTokens: 41_000,
      cacheCreationTokens: 6_500,
      costUsd: 0.4123,
      sessionIds: ['sess-1'],
    });
    expect(usageExtras(undefined)).toEqual({});
  });

  test('claudeAccountOf: the account folder name; the original login is "default"', () => {
    expect(claudeAccountOf('/app/data/claude-accounts/work-2')).toBe('work-2');
    expect(claudeAccountOf('/app/data/claude')).toBe('default');
    expect(claudeAccountOf(undefined)).toBe('default');
  });
});

describe('LlmQueryLog stamps the Claude account on claude-cli calls', () => {
  let dir: string;
  const prev = process.env.CLAUDE_CONFIG_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qlog-'));
  });
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test('claude-cli entries get the active account; ollama entries none', () => {
    process.env.CLAUDE_CONFIG_DIR = '/app/data/claude-accounts/work-2';
    const log = new LlmQueryLog(dir, { warn() {} } as never);
    const base = {
      timestamp: '2026-10-15T12:00:00.000Z',
      botId: 'b1',
      caller: 'planner',
      model: 'm',
      durationMs: 1,
      success: true,
    } as const;
    log.append({ ...base, backend: 'claude-cli' });
    log.append({ ...base, backend: 'ollama' });
    const rows = readFileSync(join(dir, 'b1', '2026-10-15.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows[0].account).toBe('work-2');
    expect(rows[1].account).toBeUndefined();
  });
});
