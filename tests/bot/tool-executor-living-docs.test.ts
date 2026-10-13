/**
 * The executor applies the living-document rules (src/productions/living-docs.ts)
 * to agent-loop cycle writes in productions, before the tool runs: the refusal
 * is the tool result the agent reads, never charged as karma. Conversations
 * and worker runs are not touched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ToolAttribution, ToolExecutor } from '../../src/bot/tool-executor';
import type { BotContext } from '../../src/bot/types';
import type { ProductionEntry } from '../../src/productions/types';
import type { Tool } from '../../src/tools/types';

const quiet: any = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
};
quiet.child = () => quiet;

let dir: string;
let ran: string[];
let karma: number[];
let entries: ProductionEntry[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'living-docs-exec-'));
  writeFileSync(join(dir, '01_brief.md'), '# Brief\n\nWhat we know so far.');
  ran = [];
  karma = [];
  entries = [
    {
      id: 'e1',
      timestamp: '2026-10-12T10:00:00.000Z',
      botId: 'b1',
      tool: 'file_write',
      path: '01_brief.md',
      action: 'create',
      description: 'Brief',
      size: 30,
      trackOnly: false,
      goalId: 'g-1',
    },
  ];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tool(name: string): Tool {
  return {
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    execute: async (args) => {
      ran.push(`${name}:${String(args.path)}`);
      return { success: true, content: 'ok' };
    },
  };
}

function executor(attribution?: ToolAttribution, livingDocs?: object) {
  const tools = [tool('file_write'), tool('file_edit')];
  const ctx = {
    config: {
      bots: [{ id: 'b1', name: 'B1' }],
      productions: { enabled: true, baseDir: dir, ...(livingDocs ? { livingDocs } : {}) },
    },
    logger: quiet,
    tools,
    toolDefinitions: tools.map((t) => t.definition),
    productionsService: {
      isEnabled: () => true,
      isTrackOnly: () => false,
      renumberFile: (_b: string, p: string) => p,
      resolveDir: () => dir,
      logProduction: () => {},
      getChangelog: () => entries,
    },
  } as unknown as BotContext;
  return new ToolExecutor(ctx, {
    botId: 'b1',
    chatId: 0,
    workDir: dir,
    ...(attribution ? { attribution } : {}),
    karmaService: {
      addEvent: (_b: string, d: number) => karma.push(d),
      recordOutcome: () => null,
    } as any,
  });
}

const cycle = (over: Partial<ToolAttribution> = {}): ToolAttribution => ({
  cycleId: 'c1',
  goalId: 'g-1',
  ...over,
});
const write = { path: '02_new.md', content: '# New\n\nAnother angle on the same question.' };

describe('living documents in the executor', () => {
  test('a cycle starting a second document for its goal is refused before the tool runs, uncharged', async () => {
    const r = await executor(cycle()).execute('file_write', write);
    expect(r.success).toBe(false);
    expect(r.content).toContain('01_brief.md');
    expect(r.failureKind).toBe('scope');
    expect(ran).toEqual([]);
    expect(karma).toEqual([]);
  });

  test('an explore cycle writes no document', async () => {
    const r = await executor(cycle({ goalId: null, exploring: true })).execute('file_write', write);
    expect(r.success).toBe(false);
    expect(r.content).toContain('exploration');
    expect(ran).toEqual([]);
  });

  test('updating the goal document runs', async () => {
    const r = await executor(cycle()).execute('file_write', { ...write, path: '01_brief.md' });
    expect(r.success).toBe(true);
    expect(ran).toHaveLength(1);
  });

  test('conversations and worker runs are not touched', async () => {
    expect((await executor().execute('file_write', write)).success).toBe(true);
    expect((await executor(cycle({ runId: 'r-1' })).execute('file_write', write)).success).toBe(
      true
    );
    expect(ran).toHaveLength(2);
  });

  test('the size cap comes from productions.livingDocs and the rules can be switched off', async () => {
    const big = { path: '01_brief.md', content: 'x'.repeat(300) };
    const capped = await executor(cycle(), { maxChars: 200 }).execute('file_write', big);
    expect(capped.success).toBe(false);
    expect(capped.content).toContain('200');
    const off = await executor(cycle(), { enabled: false }).execute('file_write', write);
    expect(off.success).toBe(true);
  });
});
