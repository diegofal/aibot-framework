/**
 * Worker tool calls carry their run (C17): `tool:start/end/error` on the
 * activity stream and the tool audit entry get `runId` / `taskId` /
 * `dispatchCycleId`, never a `cycleId`; a cycle's calls keep their `cycleId`
 * on the stream too (it used to be dropped there).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { toolEndToAuditEntry } from '../../src/bot/tool-audit-log';
import { type ToolEndEvent, ToolExecutor } from '../../src/bot/tool-executor';
import type { BotContext } from '../../src/bot/types';
import { reconstructCycleWindows } from '../../src/stats/goal-detail-aggregator';
import type { Tool, ToolResult } from '../../src/tools/types';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} };

let dir: string;
let published: Array<{ type: string; data?: Record<string, unknown> }>;

beforeEach(() => {
  dir = createTempDir('worker-attrib');
  published = [];
});
afterEach(() => removeTempDir(dir));

function tool(name: string, result: ToolResult): Tool {
  return {
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    execute: async () => result,
  };
}

function executor(attribution: Record<string, unknown>): ToolExecutor {
  const tools = [tool('ok_tool', { success: true, content: 'ok' })];
  const ctx = {
    config: { bots: [{ id: 'b1', name: 'B', model: 'm', workDir: dir }] },
    logger: { ...quiet, child: () => quiet },
    tools,
    toolDefinitions: tools.map((t) => t.definition),
    activityStream: {
      publish: (e: { type: string; data?: Record<string, unknown> }) => published.push(e),
    },
  } as unknown as BotContext;
  return new ToolExecutor(ctx, { botId: 'b1', chatId: 0, attribution: attribution as never });
}

describe('run attribution on tool events', () => {
  it('a worker call carries runId/taskId/dispatchCycleId and no cycleId', async () => {
    const ex = executor({ goalId: 'g-1', runId: 'r-1', taskId: 't-1', dispatchCycleId: 'c-9' });
    let end: ToolEndEvent | undefined;
    ex.on('tool:end', (e) => {
      end = e;
    });
    await ex.execute('ok_tool', {});
    expect(end?.runId).toBe('r-1');
    expect(end?.taskId).toBe('t-1');
    expect(end?.dispatchCycleId).toBe('c-9');
    expect(end?.cycleId).toBeUndefined();

    const audit = toolEndToAuditEntry(end as ToolEndEvent);
    expect(audit).toMatchObject({
      runId: 'r-1',
      taskId: 't-1',
      dispatchCycleId: 'c-9',
      goalId: 'g-1',
    });
    expect(audit.cycleId).toBeUndefined();

    const start = published.find((e) => e.type === 'tool:start');
    const stEnd = published.find((e) => e.type === 'tool:end');
    for (const e of [start, stEnd]) {
      expect(e?.data?.runId).toBe('r-1');
      expect(e?.data?.taskId).toBe('t-1');
      expect(e?.data?.cycleId).toBeUndefined();
    }
  });

  it('a cycle call keeps its cycleId on the activity stream', async () => {
    const ex = executor({ cycleId: 'c-1', goalId: 'g-1' });
    await ex.execute('ok_tool', {});
    const stEnd = published.find((e) => e.type === 'tool:end');
    expect(stEnd?.data?.cycleId).toBe('c-1');
    expect(stEnd?.data?.goalId).toBe('g-1');
    expect(stEnd?.data?.runId).toBeUndefined();
  });

  it('worker LLM rows never stretch a reconstructed cycle window', () => {
    const at = (ms: number) => new Date(ms).toISOString();
    const base = Date.parse('2026-10-12T10:00:00Z');
    const windows = reconstructCycleWindows([
      {
        timestamp: at(base),
        botId: 'b1',
        caller: 'planner',
        model: 'm',
        backend: 'x',
        durationMs: 1000,
        success: true,
      },
      {
        timestamp: at(base + 5000),
        botId: 'b1',
        caller: 'executor',
        model: 'm',
        backend: 'x',
        durationMs: 3000,
        success: true,
      },
      {
        timestamp: at(base + 60_000),
        botId: 'b1',
        caller: 'worker',
        model: 'm',
        backend: 'x',
        durationMs: 30_000,
        success: true,
        runId: 'r-1',
      },
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0].endMs).toBe(base + 5000);
  });
});
