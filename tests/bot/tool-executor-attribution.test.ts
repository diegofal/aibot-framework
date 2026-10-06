/**
 * Agent-loop tool calls carry the cycle and goal they ran for: the `tool:end`
 * event (→ tool audit), the productions changelog entry and the karma event
 * all get `cycleId` / `goalId`; the tool itself sees `_cycleId`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { toolEndToAuditEntry } from '../../src/bot/tool-audit-log';
import { type ToolEndEvent, ToolExecutor } from '../../src/bot/tool-executor';
import type { BotContext } from '../../src/bot/types';
import type { Tool, ToolResult } from '../../src/tools/types';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} };

let dir: string;
let logged: Array<Record<string, unknown>>;
let karma: Array<Record<string, unknown> | undefined>;
let seenArgs: Record<string, unknown>[];

beforeEach(() => {
  dir = createTempDir('exec-attrib');
  logged = [];
  karma = [];
  seenArgs = [];
});
afterEach(() => removeTempDir(dir));

function tool(name: string, result: ToolResult): Tool {
  return {
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    execute: async (args) => {
      seenArgs.push(args);
      return result;
    },
  };
}

function executor(attribution?: { cycleId: string; goalId: string | null }): ToolExecutor {
  const tools = [
    tool('file_write', { success: true, content: 'ok' }),
    tool('boom', { success: false, content: 'bad' }),
  ];
  const productionsService = {
    isEnabled: () => true,
    isTrackOnly: () => false,
    resolveDir: () => dir,
    renumberFile: (_b: string, p: string) => p,
    logProduction: (e: Record<string, unknown>) => {
      logged.push(e);
    },
  };
  const karmaService = {
    recordOutcome: (_b: string, _k: string, _r: string, metadata?: Record<string, unknown>) => {
      karma.push(metadata);
      return null;
    },
    addEvent: () => null,
  };
  const ctx = {
    config: { bots: [{ id: 'b1', name: 'B', model: 'm', workDir: dir }] },
    logger: { ...quiet, child: () => quiet },
    tools,
    toolDefinitions: tools.map((t) => t.definition),
    productionsService,
  } as unknown as BotContext;
  return new ToolExecutor(ctx, {
    botId: 'b1',
    chatId: 0,
    karmaService: karmaService as never,
    ...(attribution ? { attribution } : {}),
  });
}

const content = '# Brief\n\nA real paragraph about something worth reading, long enough to pass.';

describe('ToolExecutor — cycle and goal attribution', () => {
  it('stamps tool:end, the audit entry, the production and karma with cycleId/goalId', async () => {
    const ex = executor({ cycleId: 'cyc-1', goalId: 'g-12345678' });
    const ends: ToolEndEvent[] = [];
    ex.on('tool:end', (e) => ends.push(e));
    await ex.execute('file_write', { path: '01_brief.md', content });
    await ex.execute('boom', {});
    expect(ends.map((e) => [e.cycleId, e.goalId])).toEqual([
      ['cyc-1', 'g-12345678'],
      ['cyc-1', 'g-12345678'],
    ]);
    expect(toolEndToAuditEntry(ends[0])).toMatchObject({ cycleId: 'cyc-1', goalId: 'g-12345678' });
    expect(logged[0]).toMatchObject({ cycleId: 'cyc-1', goalId: 'g-12345678' });
    expect(karma[0]).toMatchObject({ cycleId: 'cyc-1', goalId: 'g-12345678' });
    expect(seenArgs[0]._cycleId).toBe('cyc-1');
    expect(seenArgs[0]._goalId).toBe('g-12345678');
  });

  it('reads the goal at call time, so a goal resolved mid-cycle applies to later calls', async () => {
    const attribution = { cycleId: 'cyc-2', goalId: null as string | null };
    const ex = executor(attribution);
    const ends: ToolEndEvent[] = [];
    ex.on('tool:end', (e) => ends.push(e));
    await ex.execute('file_write', { path: '01_a.md', content });
    attribution.goalId = 'g-abcdef12';
    await ex.execute('file_write', { path: '02_b.md', content });
    expect(ends.map((e) => e.goalId)).toEqual([undefined, 'g-abcdef12']);
    expect(ends[0]).not.toHaveProperty('goalId');
  });

  it('adds nothing outside an agent-loop cycle', async () => {
    const ex = executor();
    const ends: ToolEndEvent[] = [];
    ex.on('tool:end', (e) => ends.push(e));
    await ex.execute('file_write', { path: '01_c.md', content });
    expect(ends[0]).not.toHaveProperty('cycleId');
    expect(logged[0]).not.toHaveProperty('cycleId');
    expect(seenArgs[0]).not.toHaveProperty('_cycleId');
    expect(toolEndToAuditEntry(ends[0])).not.toHaveProperty('cycleId');
  });
});
