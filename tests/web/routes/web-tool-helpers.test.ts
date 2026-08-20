import { describe, expect, mock, test } from 'bun:test';
import type { Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { webGenerate } from '../../../src/web/routes/web-tool-helpers';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const mockConfig = {
  bots: [{ id: 'bot1', name: 'TestBot' }],
  improve: {
    claudePath: 'claude',
    timeout: 30_000,
  },
} as unknown as Config;

describe('webGenerate', () => {
  test('enableTools: false calls claudeGenerate (text-only)', async () => {
    const mockClaudeGenerate = mock(() => Promise.resolve({ response: 'text-only response' }));
    mock.module('../../../src/claude-cli', () => ({
      claudeGenerate: mockClaudeGenerate,
    }));

    // Re-import to pick up mock
    const { webGenerate: freshWebGenerate } = await import(
      '../../../src/web/routes/web-tool-helpers'
    );

    const result = await freshWebGenerate({
      prompt: 'Hello',
      systemPrompt: 'You are helpful.',
      botId: 'bot1',
      botManager: {} as any,
      config: mockConfig,
      logger: noopLogger,
      enableTools: false,
    });

    expect(result).toBe('text-only response');
    expect(mockClaudeGenerate).toHaveBeenCalledTimes(1);
    const callArgs = mockClaudeGenerate.mock.calls[0];
    expect(callArgs[0]).toBe('Hello');
    expect((callArgs[1] as any).systemPrompt).toBe('You are helpful.');

    // Restore
    const { claudeGenerate: orig } = await import('../../../src/claude-cli');
    mock.module('../../../src/claude-cli', () => ({ claudeGenerate: orig }));
  });

  test('enableTools: true calls llmClient.chat with the agent\'s full tool set', async () => {
    const mockChat = mock(() => Promise.resolve({ text: 'tool-enabled response' }));

    const mockToolDefs = [
      {
        type: 'function' as const,
        function: {
          name: 'web_search',
          description: 'Search',
          parameters: { type: 'object' as const, properties: {} },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'delegate_to_bot',
          description: 'Delegate',
          parameters: { type: 'object' as const, properties: {} },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'file_read',
          description: 'Read file',
          parameters: { type: 'object' as const, properties: {} },
        },
      },
    ];

    const mockExecutor = mock(async () => ({ success: true, content: 'ok' }));

    const mockBotManager = {
      getLLMClient: () => ({ chat: mockChat, backend: 'claude-cli' }),
      getActiveModel: () => 'claude-sonnet',
      getToolRegistry: () => ({
        getDefinitionsForBot: () => mockToolDefs,
        createExecutor: () => mockExecutor,
      }),
    };

    const result = await webGenerate({
      prompt: 'Search for something',
      systemPrompt: 'You are a bot.',
      botId: 'bot1',
      botManager: mockBotManager as any,
      config: mockConfig,
      logger: noopLogger,
      enableTools: true,
    });

    expect(result).toBe('tool-enabled response');
    expect(mockChat).toHaveBeenCalledTimes(1);

    const chatArgs = mockChat.mock.calls[0];
    const toolsPassed = (chatArgs[1] as any).tools;
    expect(toolsPassed).toHaveLength(3);
    expect(toolsPassed.find((t: any) => t.function.name === 'delegate_to_bot')).toBeTruthy();
    expect(toolsPassed.find((t: any) => t.function.name === 'web_search')).toBeTruthy();
    expect(toolsPassed.find((t: any) => t.function.name === 'file_read')).toBeTruthy();

    // Verify system prompt has tool awareness suffix
    const messages = chatArgs[0] as any[];
    const systemMsg = messages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toContain('You have access to tools');
  });

  test('falls back to text-only when the agent has no tools', async () => {
    const mockClaudeGenerate = mock(() => Promise.resolve({ response: 'fallback response' }));
    mock.module('../../../src/claude-cli', () => ({
      claudeGenerate: mockClaudeGenerate,
    }));

    const { webGenerate: freshWebGenerate } = await import(
      '../../../src/web/routes/web-tool-helpers'
    );

    const mockBotManager = {
      getLLMClient: () => ({
        chat: mock(() => Promise.resolve({ text: '' })),
        backend: 'claude-cli',
      }),
      getToolRegistry: () => ({
        getDefinitionsForBot: () => [],
        createExecutor: () => mock(async () => ({ success: true, content: 'ok' })),
      }),
    };

    const result = await freshWebGenerate({
      prompt: 'Test',
      systemPrompt: 'Sys',
      botId: 'bot1',
      botManager: mockBotManager as any,
      config: mockConfig,
      logger: noopLogger,
    });

    expect(result).toBe('fallback response');
    expect(mockClaudeGenerate).toHaveBeenCalledTimes(1);

    const { claudeGenerate: orig } = await import('../../../src/claude-cli');
    mock.module('../../../src/claude-cli', () => ({ claudeGenerate: orig }));
  });

  test('falls back to text-only when getLLMClient throws', async () => {
    const mockClaudeGenerate = mock(() => Promise.resolve({ response: 'no-client fallback' }));
    mock.module('../../../src/claude-cli', () => ({
      claudeGenerate: mockClaudeGenerate,
    }));

    const { webGenerate: freshWebGenerate } = await import(
      '../../../src/web/routes/web-tool-helpers'
    );

    const mockBotManager = {
      getLLMClient: () => {
        throw new Error('No LLMClient registered for bot "bot1"');
      },
      getToolRegistry: () => ({}),
    };

    const result = await freshWebGenerate({
      prompt: 'Test',
      systemPrompt: 'Sys',
      botId: 'bot1',
      botManager: mockBotManager as any,
      config: mockConfig,
      logger: noopLogger,
    });

    expect(result).toBe('no-client fallback');
    expect(mockClaudeGenerate).toHaveBeenCalledTimes(1);

    // Restore
    const { claudeGenerate: orig } = await import('../../../src/claude-cli');
    mock.module('../../../src/claude-cli', () => ({ claudeGenerate: orig }));
  });

  test('propagates errors from llmClient.chat', async () => {
    const mockBotManager = {
      getLLMClient: () => ({
        chat: () => Promise.reject(new Error('LLM timeout')),
        backend: 'claude-cli',
      }),
      getActiveModel: () => 'claude-sonnet',
      getToolRegistry: () => ({
        getDefinitionsForBot: () => [
          {
            type: 'function' as const,
            function: {
              name: 'web_search',
              description: 'Search',
              parameters: { type: 'object' as const, properties: {} },
            },
          },
        ],
        createExecutor: () => mock(async () => ({ success: true, content: 'ok' })),
      }),
    };

    await expect(
      webGenerate({
        prompt: 'Test',
        systemPrompt: 'Sys',
        botId: 'bot1',
        botManager: mockBotManager as any,
        config: mockConfig,
        logger: noopLogger,
      })
    ).rejects.toThrow('LLM timeout');
  });

  test('defaults enableTools to true when not specified', async () => {
    const mockChat = mock(() => Promise.resolve({ text: 'default tools response' }));

    const mockBotManager = {
      getLLMClient: () => ({ chat: mockChat, backend: 'claude-cli' }),
      getActiveModel: () => 'claude-sonnet',
      getToolRegistry: () => ({
        getDefinitionsForBot: () => [
          {
            type: 'function' as const,
            function: {
              name: 'web_search',
              description: 'Search',
              parameters: { type: 'object' as const, properties: {} },
            },
          },
        ],
        createExecutor: () => mock(async () => ({ success: true, content: 'ok' })),
      }),
    };

    const result = await webGenerate({
      prompt: 'Test',
      systemPrompt: 'Sys',
      botId: 'bot1',
      botManager: mockBotManager as any,
      config: mockConfig,
      logger: noopLogger,
      // enableTools not specified — should default to true
    });

    expect(result).toBe('default tools response');
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  test('forwards config.webTools.maxToolRounds to llmClient.chat', async () => {
    const mockChat = mock(() => Promise.resolve({ text: 'routed' }));

    const mockBotManager = {
      getLLMClient: () => ({ chat: mockChat, backend: 'claude-cli' }),
      getActiveModel: () => 'claude-sonnet',
      getToolRegistry: () => ({
        getDefinitionsForBot: () => [
          {
            type: 'function' as const,
            function: {
              name: 'web_search',
              description: 'Search',
              parameters: { type: 'object' as const, properties: {} },
            },
          },
        ],
        createExecutor: () => mock(async () => ({ success: true, content: 'ok' })),
      }),
    };

    const configWithGlobal = {
      bots: [{ id: 'bot1', name: 'TestBot' }],
      webTools: { maxToolRounds: 15 },
      improve: { claudePath: 'claude', timeout: 30_000 },
    } as unknown as Config;

    await webGenerate({
      prompt: 'Test',
      systemPrompt: 'Sys',
      botId: 'bot1',
      botManager: mockBotManager as any,
      config: configWithGlobal,
      logger: noopLogger,
    });

    const chatOpts = mockChat.mock.calls[0][1] as any;
    expect(chatOpts.maxToolRounds).toBe(15);
  });

  test('per-bot maxToolRounds overrides the global', async () => {
    const mockChat = mock(() => Promise.resolve({ text: 'routed' }));

    const mockBotManager = {
      getLLMClient: () => ({ chat: mockChat, backend: 'claude-cli' }),
      getActiveModel: () => 'claude-sonnet',
      getToolRegistry: () => ({
        getDefinitionsForBot: () => [
          {
            type: 'function' as const,
            function: {
              name: 'web_search',
              description: 'Search',
              parameters: { type: 'object' as const, properties: {} },
            },
          },
        ],
        createExecutor: () => mock(async () => ({ success: true, content: 'ok' })),
      }),
    };

    const configWithPerBot = {
      bots: [{ id: 'bot1', name: 'TestBot', maxToolRounds: 40 }],
      webTools: { maxToolRounds: 15 },
      improve: { claudePath: 'claude', timeout: 30_000 },
    } as unknown as Config;

    await webGenerate({
      prompt: 'Test',
      systemPrompt: 'Sys',
      botId: 'bot1',
      botManager: mockBotManager as any,
      config: configWithPerBot,
      logger: noopLogger,
    });

    const chatOpts = mockChat.mock.calls[0][1] as any;
    expect(chatOpts.maxToolRounds).toBe(40);
  });

  test('an explicit opts.maxToolRounds beats both config sources', async () => {
    const mockChat = mock(() => Promise.resolve({ text: 'routed' }));

    const mockBotManager = {
      getLLMClient: () => ({ chat: mockChat, backend: 'claude-cli' }),
      getActiveModel: () => 'claude-sonnet',
      getToolRegistry: () => ({
        getDefinitionsForBot: () => [
          {
            type: 'function' as const,
            function: {
              name: 'web_search',
              description: 'Search',
              parameters: { type: 'object' as const, properties: {} },
            },
          },
        ],
        createExecutor: () => mock(async () => ({ success: true, content: 'ok' })),
      }),
    };

    const configWithBoth = {
      bots: [{ id: 'bot1', name: 'TestBot', maxToolRounds: 40 }],
      webTools: { maxToolRounds: 15 },
      improve: { claudePath: 'claude', timeout: 30_000 },
    } as unknown as Config;

    await webGenerate({
      prompt: 'Test',
      systemPrompt: 'Sys',
      botId: 'bot1',
      botManager: mockBotManager as any,
      config: configWithBoth,
      logger: noopLogger,
      maxToolRounds: 3,
    });

    const chatOpts = mockChat.mock.calls[0][1] as any;
    expect(chatOpts.maxToolRounds).toBe(3);
  });

  test('omits maxToolRounds when nothing is configured', async () => {
    const mockChat = mock(() => Promise.resolve({ text: 'routed' }));

    const mockBotManager = {
      getLLMClient: () => ({ chat: mockChat, backend: 'claude-cli' }),
      getActiveModel: () => 'claude-sonnet',
      getToolRegistry: () => ({
        getDefinitionsForBot: () => [
          {
            type: 'function' as const,
            function: {
              name: 'web_search',
              description: 'Search',
              parameters: { type: 'object' as const, properties: {} },
            },
          },
        ],
        createExecutor: () => mock(async () => ({ success: true, content: 'ok' })),
      }),
    };

    await webGenerate({
      prompt: 'Test',
      systemPrompt: 'Sys',
      botId: 'bot1',
      botManager: mockBotManager as any,
      config: mockConfig,
      logger: noopLogger,
    });

    const chatOpts = mockChat.mock.calls[0][1] as any;
    expect('maxToolRounds' in chatOpts).toBe(false);
  });

  test('passes cleanBreak: true to llmClient.chat', async () => {
    const mockChat = mock(() => Promise.resolve({ text: 'routed' }));

    const mockBotManager = {
      getLLMClient: () => ({ chat: mockChat, backend: 'claude-cli' }),
      getActiveModel: () => 'claude-sonnet',
      getToolRegistry: () => ({
        getDefinitionsForBot: () => [
          {
            type: 'function' as const,
            function: {
              name: 'web_search',
              description: 'Search',
              parameters: { type: 'object' as const, properties: {} },
            },
          },
        ],
        createExecutor: () => mock(async () => ({ success: true, content: 'ok' })),
      }),
    };

    await webGenerate({
      prompt: 'Test',
      systemPrompt: 'Sys',
      botId: 'bot1',
      botManager: mockBotManager as any,
      config: mockConfig,
      logger: noopLogger,
    });

    const chatOpts = mockChat.mock.calls[0][1] as any;
    expect(chatOpts.cleanBreak).toBe(true);
  });

  test('passes loopContext { botId, caller } to llmClient.chat', async () => {
    const mockChat = mock(() => Promise.resolve({ text: 'routed' }));

    const mockBotManager = {
      getLLMClient: () => ({ chat: mockChat, backend: 'claude-cli' }),
      getActiveModel: () => 'claude-sonnet',
      getToolRegistry: () => ({
        getDefinitionsForBot: () => [
          {
            type: 'function' as const,
            function: {
              name: 'web_search',
              description: 'Search',
              parameters: { type: 'object' as const, properties: {} },
            },
          },
        ],
        createExecutor: () => mock(async () => ({ success: true, content: 'ok' })),
      }),
    };

    await webGenerate({
      prompt: 'Test',
      systemPrompt: 'Sys',
      botId: 'bot1',
      botManager: mockBotManager as any,
      config: mockConfig,
      logger: noopLogger,
      loopContext: { conversationId: 'conv1', caller: 'web-conversation' },
    });

    const chatOpts = mockChat.mock.calls[0][1] as any;
    expect(chatOpts.loopContext).toEqual({
      botId: 'bot1',
      conversationId: 'conv1',
      caller: 'web-conversation',
    });
  });
});
