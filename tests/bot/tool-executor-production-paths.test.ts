/**
 * The executor logs successful file_write/file_edit calls as productions.
 * Bookkeeping files (changelog.jsonl, summary.json, INDEX.md, index.html) and
 * anything under archived/ are not outputs: logging them put the changelog
 * itself into Needs You, and "Clear stale" then archived three bots' history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ToolExecutor } from '../../src/bot/tool-executor';
import type { BotContext } from '../../src/bot/types';
import type { Tool } from '../../src/tools/types';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} };

let dir: string;
let logged: string[];

beforeEach(() => {
  dir = createTempDir('exec-prod-paths');
  logged = [];
});
afterEach(() => removeTempDir(dir));

function fileTool(name: string): Tool {
  return {
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    execute: async () => ({ success: true, content: 'ok' }),
  };
}

function executor(): ToolExecutor {
  const tools = [fileTool('file_write'), fileTool('file_edit')];
  const productionsService = {
    isEnabled: () => true,
    isTrackOnly: () => false,
    resolveDir: () => dir,
    renumberFile: (_b: string, p: string) => p,
    logProduction: (e: { path: string }) => {
      logged.push(e.path);
    },
  };
  const ctx = {
    config: { bots: [{ id: 'b1', name: 'B', model: 'm', workDir: dir }] },
    logger: { ...quiet, child: () => quiet },
    tools,
    toolDefinitions: tools.map((t) => t.definition),
    productionsService,
  } as unknown as BotContext;
  return new ToolExecutor(ctx, { botId: 'b1', chatId: 0 });
}

describe('ToolExecutor — productions logging skips bookkeeping and archived paths', () => {
  it('does not log writes to bookkeeping files', async () => {
    const ex = executor();
    for (const path of ['changelog.jsonl', 'summary.json', 'INDEX.md', 'index.html']) {
      await ex.execute('file_write', { path, content: '{"a":1}' });
    }
    expect(logged).toEqual([]);
  });

  it('does not log edits under archived/', async () => {
    await executor().execute('file_edit', {
      path: 'archived/22_paraphrase_proxy.ts',
      old_text: 'a',
      new_text: 'export const realContent = 42;',
    });
    expect(logged).toEqual([]);
  });

  it('still logs an ordinary output', async () => {
    await executor().execute('file_write', {
      path: '01_ideas.md',
      content: '# Ideas\n\nA real paragraph about something worth reading, long enough to pass.',
    });
    expect(logged).toEqual(['01_ideas.md']);
  });
});
