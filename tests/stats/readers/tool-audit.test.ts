import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aggregateTools,
  engagementFromTools,
  readToolEntries,
  toolsDaily,
} from '../../../src/stats/readers/tool-audit';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

const NOW = Date.UTC(2026, 7, 21, 12);
const DAY = 86_400_000;

let dir: string;
beforeEach(() => {
  dir = createTempDir('stats-tools');
});
afterEach(() => removeTempDir(dir));

function entry(over: Record<string, unknown>) {
  return {
    timestamp: new Date(NOW - 60_000).toISOString(),
    botId: 'b1',
    chatId: 0,
    toolName: 'file_write',
    args: {},
    success: true,
    result: 'ok',
    durationMs: 5,
    retryAttempts: 0,
    ...over,
  };
}

function writeDay(botId: string, ms: number, lines: unknown[]) {
  const d = join(dir, botId);
  mkdirSync(d, { recursive: true });
  const date = new Date(ms).toISOString().slice(0, 10);
  writeFileSync(join(d, `${date}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

describe('readToolEntries', () => {
  it('returns [] for a missing bot', () => {
    expect(readToolEntries(dir, 'nope', 0, NOW)).toEqual([]);
  });
  it('reads only files within the window', () => {
    writeDay('b1', NOW, [entry({})]);
    writeDay('b1', NOW - 9 * DAY, [entry({ timestamp: new Date(NOW - 9 * DAY).toISOString() })]);
    expect(readToolEntries(dir, 'b1', NOW - 7 * DAY, NOW)).toHaveLength(1);
    expect(readToolEntries(dir, 'b1', NOW - 30 * DAY, NOW)).toHaveLength(2);
  });
});

describe('aggregateTools', () => {
  it('zeros for no entries', () => {
    expect(aggregateTools([], 0)).toEqual({
      calls: 0,
      failed: 0,
      failRate: 0,
      top: [],
      loopBreaks: 0,
      blocked: 0,
      exitNonzero: 0,
      notFound: 0,
      policy: 0,
    });
  });
  it('ranks tools by call count with failures and passes loopBreaks through', () => {
    const s = aggregateTools(
      [
        entry({}),
        entry({}),
        entry({ toolName: 'web_search', success: false }),
        entry({ toolName: 'web_search' }),
        entry({ toolName: 'ask_human' }),
      ] as never,
      2
    );
    expect(s.calls).toBe(5);
    expect(s.failed).toBe(1);
    expect(s.top[0]).toEqual({ name: 'file_write', count: 2, failed: 0 });
    expect(s.top[1]).toEqual({ name: 'web_search', count: 2, failed: 1 });
    expect(s.loopBreaks).toBe(2);
  });
  it('limits top to 10 tools', () => {
    const many = Array.from({ length: 15 }, (_, i) => entry({ toolName: `t${i}` }));
    expect(aggregateTools(many as never, 0).top).toHaveLength(10);
  });
});

describe('toolsDaily / engagementFromTools', () => {
  it('buckets per day', () => {
    const d = toolsDaily([
      entry({}),
      entry({ timestamp: new Date(NOW - DAY).toISOString(), success: false }),
    ] as never);
    expect(d).toEqual([
      { date: '2026-08-20', calls: 1, failed: 1 },
      { date: '2026-08-21', calls: 1, failed: 0 },
    ]);
  });
  it('counts asks, proactive messages, collaborate calls and edges', () => {
    const e = engagementFromTools(
      [
        entry({ toolName: 'ask_human' }),
        entry({ toolName: 'send_message' }),
        entry({ toolName: 'send_message', success: false }),
        entry({ toolName: 'collaborate', args: { targetBotId: 'b2' } }),
        entry({ toolName: 'collaborate', args: { targetBotId: 'b2' }, success: false }),
        entry({ toolName: 'delegate', args: { targetBotId: 'b3' } }),
        entry({ toolName: 'mesh_publish' }),
      ] as never,
      'b1'
    );
    expect(e.asksSent).toBe(1);
    expect(e.messagesSentProactive).toBe(1);
    expect(e.collaborateCalls).toBe(3);
    expect(e.collaborateFailed).toBe(1);
    expect(e.meshPublishCalls).toBe(1);
    expect(e.edges).toEqual([
      { from: 'b1', to: 'b2', calls: 2, failed: 1 },
      { from: 'b1', to: 'b3', calls: 1, failed: 0 },
    ]);
  });
});

describe('aggregateTools failure kinds', () => {
  const entries = [
    entry({ success: true }),
    entry({ toolName: 'web_fetch', success: false }), // old entry, no kind
    entry({ toolName: 'web_fetch', success: false, failureKind: 'error' }),
    entry({ toolName: 'web_fetch', success: false, failureKind: 'not-found' }),
    entry({ toolName: 'web_fetch', success: false, failureKind: 'policy' }),
    entry({ toolName: 'web_fetch', success: false, failureKind: 'blocked' }),
    entry({ toolName: 'web_fetch', success: false, failureKind: 'blocked' }),
    entry({ toolName: 'exec', success: false, failureKind: 'exit-nonzero' }),
  ];

  it('excludes site refusals and non-zero exits from failed and counts them apart', () => {
    const s = aggregateTools(entries as any, 0);
    expect(s.calls).toBe(8);
    expect(s.failed).toBe(4);
    expect(s.failRate).toBeCloseTo(4 / 8);
    expect(s.blocked).toBe(2);
    expect(s.exitNonzero).toBe(1);
    expect(s.notFound).toBe(1);
    expect(s.policy).toBe(1);
  });

  it('per-tool failed uses the same rule', () => {
    const s = aggregateTools(entries as any, 0);
    const wf = s.top.find((t) => t.name === 'web_fetch');
    expect(wf?.failed).toBe(4);
    expect(s.top.find((t) => t.name === 'exec')?.failed).toBe(0);
  });

  it('toolsDaily counts failed with the same rule', () => {
    const days = toolsDaily(entries as any);
    expect(days).toHaveLength(1);
    expect(days[0].failed).toBe(4);
    expect(days[0].calls).toBe(8);
  });
});
