import { describe, test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { ToolExecutor } from '../../src/bot/tool-executor';
import { resolveAgentConfig, type Config, type BotConfig } from '../../src/config';
import type { BotContext } from '../../src/bot/types';
import type { Tool, ToolResult } from '../../src/tools/types';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

function createMinimalConfig(overrides: Partial<Config> = {}): Config {
  return {
    bots: [],
    productions: { enabled: true, baseDir: './productions' },
    soul: { enabled: true, dir: './config/soul', search: { enabled: false } as any, memoryFlush: { enabled: true, messageThreshold: 30 }, sessionMemory: { enabled: false, indexOnStartup: false }, versioning: { enabled: true, maxVersionsPerFile: 10 } },
    ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'llama3' } },
    conversation: { enabled: true, systemPrompt: 'You are a helpful assistant.', temperature: 0.7, maxHistory: 20 },
    ...overrides,
  } as Config;
}

function createCaptureTool(name: string): { tool: Tool; getCapturedArgs: () => Record<string, unknown> } {
  let capturedArgs: Record<string, unknown> = {};
  const tool: Tool = {
    definition: {
      type: 'function',
      function: {
        name,
        description: `Tool ${name}`,
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: async (args) => {
      capturedArgs = args;
      return { success: true, content: 'ok' };
    },
  };
  return { tool, getCapturedArgs: () => capturedArgs };
}

describe('workDir', () => {
  describe('resolveAgentConfig', () => {
    test('defaults workDir to productions/<botId>', () => {
      const config = createMinimalConfig();
      const botConfig: BotConfig = { id: 'mybot', name: 'My Bot', skills: [], token: '', enabled: true };
      const resolved = resolveAgentConfig(config, botConfig);
      expect(resolved.workDir).toBe('./productions/mybot');
    });

    test('uses explicit workDir when configured', () => {
      const config = createMinimalConfig();
      const botConfig: BotConfig = { id: 'selfimprove', name: 'Self Improve', skills: [], token: '', enabled: true, workDir: '/home/user/project' };
      const resolved = resolveAgentConfig(config, botConfig);
      expect(resolved.workDir).toBe('/home/user/project');
    });

    test('uses custom productions baseDir in default', () => {
      const config = createMinimalConfig({ productions: { enabled: true, baseDir: './output' } });
      const botConfig: BotConfig = { id: 'bot1', name: 'Bot 1', skills: [], token: '', enabled: true };
      const resolved = resolveAgentConfig(config, botConfig);
      expect(resolved.workDir).toBe('./output/bot1');
    });
  });

  describe('ToolExecutor path resolution', () => {
    test('resolves file_read path relative to workDir', async () => {
      const { tool, getCapturedArgs } = createCaptureTool('file_read');
      const config = createMinimalConfig({
        bots: [{ id: 'test-bot', name: 'Test', skills: [], token: '', enabled: true, workDir: '/tmp/test-workdir' } as BotConfig],
      });
      const ctx = {
        config,
        tools: [tool],
        toolDefinitions: [tool.definition],
        logger: noopLogger,
      } as unknown as BotContext;

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      await executor.execute('file_read', { path: 'src/index.ts' });

      expect(getCapturedArgs().path).toBe(resolve('/tmp/test-workdir', 'src/index.ts'));
    });

    test('resolves file_write path relative to workDir', async () => {
      const { tool, getCapturedArgs } = createCaptureTool('file_write');
      const config = createMinimalConfig({
        bots: [{ id: 'test-bot', name: 'Test', skills: [], token: '', enabled: true, workDir: '/tmp/test-workdir' } as BotConfig],
      });
      const ctx = {
        config,
        tools: [tool],
        toolDefinitions: [tool.definition],
        logger: noopLogger,
      } as unknown as BotContext;

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      await executor.execute('file_write', { path: 'output/report.md', content: 'hello' });

      expect(getCapturedArgs().path).toBe(resolve('/tmp/test-workdir', 'output/report.md'));
    });

    test('resolves file_edit path relative to workDir', async () => {
      const { tool, getCapturedArgs } = createCaptureTool('file_edit');
      const config = createMinimalConfig({
        bots: [{ id: 'test-bot', name: 'Test', skills: [], token: '', enabled: true, workDir: '/tmp/test-workdir' } as BotConfig],
      });
      const ctx = {
        config,
        tools: [tool],
        toolDefinitions: [tool.definition],
        logger: noopLogger,
      } as unknown as BotContext;

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      await executor.execute('file_edit', { path: 'data/config.json', old_str: 'a', new_str: 'b' });

      expect(getCapturedArgs().path).toBe(resolve('/tmp/test-workdir', 'data/config.json'));
    });

    test('sets exec workdir to bot workDir when not specified', async () => {
      const { tool, getCapturedArgs } = createCaptureTool('exec');
      const config = createMinimalConfig({
        bots: [{ id: 'test-bot', name: 'Test', skills: [], token: '', enabled: true, workDir: '/tmp/test-workdir' } as BotConfig],
      });
      const ctx = {
        config,
        tools: [tool],
        toolDefinitions: [tool.definition],
        logger: noopLogger,
      } as unknown as BotContext;

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      await executor.execute('exec', { command: 'ls' });

      expect(getCapturedArgs().workdir).toBe('/tmp/test-workdir');
    });

    test('does not override exec workdir when LLM provides one', async () => {
      const { tool, getCapturedArgs } = createCaptureTool('exec');
      const config = createMinimalConfig({
        bots: [{ id: 'test-bot', name: 'Test', skills: [], token: '', enabled: true, workDir: '/tmp/test-workdir' } as BotConfig],
      });
      const ctx = {
        config,
        tools: [tool],
        toolDefinitions: [tool.definition],
        logger: noopLogger,
      } as unknown as BotContext;

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      await executor.execute('exec', { command: 'ls', workdir: '/custom/path' });

      expect(getCapturedArgs().workdir).toBe('/custom/path');
    });

    test('uses default workDir (productions/<botId>) when no workDir configured', async () => {
      const { tool, getCapturedArgs } = createCaptureTool('file_read');
      const config = createMinimalConfig({
        bots: [{ id: 'test-bot', name: 'Test', skills: [], token: '', enabled: true } as BotConfig],
      });
      const ctx = {
        config,
        tools: [tool],
        toolDefinitions: [tool.definition],
        logger: noopLogger,
      } as unknown as BotContext;

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      await executor.execute('file_read', { path: 'notes.md' });

      expect(getCapturedArgs().path).toBe(resolve('./productions/test-bot', 'notes.md'));
    });
  });
});
