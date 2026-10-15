/**
 * Cost history from the Claude CLI's own transcripts: every `claude -p` run
 * leaves `<CLAUDE_CONFIG_DIR>/projects/-tmp/<session>.jsonl` with a
 * `cost-state` line (real cost, start time, tokens per model with cache).
 * The query log never recorded cost or cache tokens before 2026-10-15; the
 * backfill matches each session to the call that made it, by time.
 */
import { describe, expect, test } from 'bun:test';
import type { LlmQueryEntry } from '../../src/bot/llm-query-log';
import {
  type TranscriptSession,
  enrichEntries,
  matchSessions,
  parseTranscript,
} from '../../src/stats/claude-transcripts';

const costLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'cost-state',
    sessionId: 's-1',
    totalCostUSD: 0.1095952,
    startTime: Date.parse('2026-10-13T14:42:56.667Z'),
    modelUsage: {
      'claude-opus-5-5': {
        inputTokens: 2,
        outputTokens: 1489,
        cacheReadInputTokens: 10556,
        cacheCreationInputTokens: 9712,
        costUSD: 0.1095952,
      },
    },
    ...over,
  });

describe('parseTranscript', () => {
  test('reads the cost-state line, and the agent name from the prompt when there is one', () => {
    const text = [
      JSON.stringify({
        type: 'queue-operation',
        timestamp: '2026-10-13T14:42:57.435Z',
        content: '## Agent identity\nname: Jarvis-Factory\nemoji: x',
      }),
      costLine(),
    ].join('\n');
    expect(parseTranscript(text)).toEqual({
      sessionId: 's-1',
      startMs: Date.parse('2026-10-13T14:42:56.667Z'),
      costUsd: 0.1095952,
      model: 'claude-opus-5-5',
      inputTokens: 2,
      outputTokens: 1489,
      cacheReadTokens: 10556,
      cacheCreationTokens: 9712,
      agentName: 'Jarvis-Factory',
    });
  });

  test('no cost-state line: null', () => {
    expect(parseTranscript(JSON.stringify({ type: 'user' }))).toBeNull();
  });
});

const entry = (
  endIso: string,
  durationMs: number,
  over: Partial<LlmQueryEntry> = {}
): LlmQueryEntry => ({
  timestamp: endIso,
  botId: 'b1',
  caller: 'planner',
  model: 'claude-opus-5-5',
  backend: 'claude-cli',
  durationMs,
  success: true,
  ...over,
});
const session = (startIso: string, cost: number, id = startIso): TranscriptSession => ({
  sessionId: id,
  startMs: Date.parse(startIso),
  costUsd: cost,
  model: 'claude-opus-5-5',
  inputTokens: 2,
  outputTokens: 10,
  cacheReadTokens: 100,
  cacheCreationTokens: 50,
});

describe('matchSessions', () => {
  test('a session belongs to the claude-cli call whose run contains its start, the nearest one', () => {
    const entries = [
      entry('2026-10-13T10:00:30.000Z', 30_000),
      entry('2026-10-13T10:00:40.000Z', 5_000),
      entry('2026-10-13T10:00:30.000Z', 30_000, { backend: 'ollama' }),
    ];
    const sessions = [
      session('2026-10-13T10:00:01.000Z', 0.2),
      session('2026-10-13T10:00:35.500Z', 0.1),
    ];
    const { byEntry, unmatched } = matchSessions(entries, sessions);
    expect(byEntry.get(0)?.map((s) => s.costUsd)).toEqual([0.2]);
    expect(byEntry.get(1)?.map((s) => s.costUsd)).toEqual([0.1]);
    expect(byEntry.get(2)).toBeUndefined();
    expect(unmatched).toEqual([]);
  });

  test('retries: several sessions inside one call all count for it', () => {
    const { byEntry } = matchSessions(
      [entry('2026-10-13T10:00:20.000Z', 20_000)],
      [
        session('2026-10-13T10:00:01.000Z', 0, 'a'),
        session('2026-10-13T10:00:05.000Z', 0, 'b'),
        session('2026-10-13T10:00:12.000Z', 0.3, 'c'),
      ]
    );
    expect(byEntry.get(0)?.map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
  });

  test('a session with no call around it stays unmatched; an entry that already has a cost is skipped', () => {
    const { byEntry, unmatched } = matchSessions(
      [entry('2026-10-13T10:00:20.000Z', 5_000, { costUsd: 1 })],
      [session('2026-10-13T10:00:16.000Z', 0.3), session('2026-10-13T12:00:00.000Z', 0.5)]
    );
    expect(byEntry.size).toBe(0);
    expect(unmatched.map((s) => s.costUsd)).toEqual([0.3, 0.5]);
  });
});

describe('enrichEntries', () => {
  test('adds cost, cache tokens and session ids, marked backfilled; untouched entries stay as they were', () => {
    const entries = [
      entry('2026-10-13T10:00:20.000Z', 20_000),
      entry('2026-10-13T11:00:00.000Z', 1_000),
    ];
    const { byEntry } = matchSessions(entries, [
      session('2026-10-13T10:00:01.000Z', 0.1, 'a'),
      session('2026-10-13T10:00:09.000Z', 0.2, 'b'),
    ]);
    const out = enrichEntries(entries, byEntry);
    expect(out[0]).toMatchObject({
      costUsd: 0.30000000000000004,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
      sessionIds: ['a', 'b'],
      backfilled: true,
    });
    expect(out[1]).toEqual(entries[1]);
  });
});
