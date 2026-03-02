import { describe, expect, it } from 'bun:test';
import { CollaborationManager } from '../../src/bot/collaboration';
import type { SystemPromptBuilder } from '../../src/bot/system-prompt-builder';
import type { ToolRegistry } from '../../src/bot/tool-registry';
import type { BotContext } from '../../src/bot/types';
import type { McpAgentBridge } from '../../src/mcp/agent-bridge';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

function createMockCtx(overrides?: Partial<BotContext>): BotContext {
  return {
    config: {
      bots: [],
      collaboration: {
        maxRounds: 5,
        cooldownMs: 10_000,
        sessionTtlMs: 300_000,
        visibleMaxTurns: 3,
        enableTargetTools: false,
        internalQueryTimeout: 30_000,
        maxConverseTurns: 5,
      },
    },
    logger: noopLogger,
    bots: new Map(),
    runningBots: new Set(),
    activeModels: new Map(),
    agentRegistry: {
      getByBotId: () => undefined,
    },
    collaborationTracker: {
      checkAndRecord: () => ({ allowed: true }),
    },
    collaborationSessions: {
      get: () => undefined,
      create: (src: string, tgt: string) => ({
        id: 'test-session',
        sourceBotId: src,
        targetBotId: tgt,
        messages: [],
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      }),
      appendMessages: () => {},
    },
    activityStream: { publish: () => {} },
    getBotLogger: () => noopLogger,
    resolveBotId: () => undefined,
    mcpAgentBridge: undefined,
    ...overrides,
  } as unknown as BotContext;
}

function createMockSystemPromptBuilder(): SystemPromptBuilder {
  return { build: () => 'system prompt' } as unknown as SystemPromptBuilder;
}

function createMockToolRegistry(): ToolRegistry {
  return {
    getCollaborationToolsForBot: () => ({ tools: [], definitions: [] }),
  } as unknown as ToolRegistry;
}

describe('CollaborationManager MCP collaboration', () => {
  it('routes to MCP when agent has mcp-external skill', async () => {
    const callToolCalls: Array<{ agentId: string; tool: string; args: Record<string, unknown> }> =
      [];

    const mockBridge: McpAgentBridge = {
      callTool: async (agentId, toolName, args) => {
        callToolCalls.push({ agentId, tool: toolName, args });
        return {
          content: [{ type: 'text', text: 'MCP response' }],
          isError: false,
        };
      },
    } as unknown as McpAgentBridge;

    const ctx = createMockCtx({
      agentRegistry: {
        getByBotId: (botId: string) => {
          if (botId === 'ext-agent') {
            return {
              botId: 'ext-agent',
              name: 'External Agent',
              skills: ['mcp-external'],
              tools: ['collaborate', 'search'],
            };
          }
          return undefined;
        },
      } as any,
      mcpAgentBridge: mockBridge,
    });

    const cm = new CollaborationManager(
      ctx,
      createMockSystemPromptBuilder(),
      createMockToolRegistry()
    );
    const result = await cm.collaborationStep(undefined, 'ext-agent', 'Hello MCP', 'bot1');

    expect(result.sessionId).toBe('test-session');
    expect(result.response).toBe('MCP response');
    expect(callToolCalls).toHaveLength(1);
    expect(callToolCalls[0].agentId).toBe('ext-agent');
    expect(callToolCalls[0].tool).toBe('collaborate');
    expect(callToolCalls[0].args.message).toBe('Hello MCP');
  });

  it('still throws for truly unknown bots', async () => {
    const ctx = createMockCtx({
      resolveBotId: () => undefined,
      agentRegistry: {
        getByBotId: () => undefined,
      } as any,
    });

    const cm = new CollaborationManager(
      ctx,
      createMockSystemPromptBuilder(),
      createMockToolRegistry()
    );
    await expect(cm.collaborationStep(undefined, 'unknown-bot', 'Hi', 'bot1')).rejects.toThrow(
      'Target bot not running: unknown-bot'
    );
  });

  it('does not route to MCP if agent lacks mcp-external skill', async () => {
    const ctx = createMockCtx({
      resolveBotId: () => undefined,
      agentRegistry: {
        getByBotId: (botId: string) => {
          if (botId === 'internal-bot') {
            return {
              botId: 'internal-bot',
              name: 'Internal Bot',
              skills: ['web-search'],
              tools: ['search'],
            };
          }
          return undefined;
        },
      } as any,
    });

    const cm = new CollaborationManager(
      ctx,
      createMockSystemPromptBuilder(),
      createMockToolRegistry()
    );
    await expect(cm.collaborationStep(undefined, 'internal-bot', 'Hi', 'bot1')).rejects.toThrow(
      'Target bot not running: internal-bot'
    );
  });

  it('rate limiting applies to MCP collaboration', async () => {
    const mockBridge: McpAgentBridge = {
      callTool: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    } as unknown as McpAgentBridge;

    const ctx = createMockCtx({
      agentRegistry: {
        getByBotId: (botId: string) => {
          if (botId === 'ext-agent') {
            return {
              botId: 'ext-agent',
              name: 'External Agent',
              skills: ['mcp-external'],
              tools: ['collaborate'],
            };
          }
          return undefined;
        },
      } as any,
      collaborationTracker: {
        checkAndRecord: () => ({ allowed: false, reason: 'Rate limit exceeded' }),
      } as any,
      mcpAgentBridge: mockBridge,
    });

    const cm = new CollaborationManager(
      ctx,
      createMockSystemPromptBuilder(),
      createMockToolRegistry()
    );
    await expect(cm.collaborationStep(undefined, 'ext-agent', 'Hi', 'bot1')).rejects.toThrow(
      'Collaboration blocked: Rate limit exceeded'
    );
  });

  it('returns descriptive message when no chat tool available', async () => {
    const mockBridge: McpAgentBridge = {
      callTool: async () => ({
        content: [{ type: 'text', text: 'should not be called' }],
        isError: false,
      }),
    } as unknown as McpAgentBridge;

    const ctx = createMockCtx({
      agentRegistry: {
        getByBotId: (botId: string) => {
          if (botId === 'ext-agent') {
            return {
              botId: 'ext-agent',
              name: 'External Agent',
              skills: ['mcp-external'],
              tools: ['file_read', 'file_write'], // no collaborate/chat/message/ask
            };
          }
          return undefined;
        },
      } as any,
      mcpAgentBridge: mockBridge,
    });

    const cm = new CollaborationManager(
      ctx,
      createMockSystemPromptBuilder(),
      createMockToolRegistry()
    );
    const result = await cm.collaborationStep(undefined, 'ext-agent', 'Hello', 'bot1');

    expect(result.response).toContain('does not expose a collaborate, chat, message, or ask tool');
    expect(result.response).toContain('file_read, file_write');
  });

  it('handles MCP error responses', async () => {
    const mockBridge: McpAgentBridge = {
      callTool: async () => ({
        content: [{ type: 'text', text: 'Connection refused' }],
        isError: true,
      }),
    } as unknown as McpAgentBridge;

    const ctx = createMockCtx({
      agentRegistry: {
        getByBotId: (botId: string) => {
          if (botId === 'ext-agent') {
            return {
              botId: 'ext-agent',
              name: 'External Agent',
              skills: ['mcp-external'],
              tools: ['chat'],
            };
          }
          return undefined;
        },
      } as any,
      mcpAgentBridge: mockBridge,
    });

    const cm = new CollaborationManager(
      ctx,
      createMockSystemPromptBuilder(),
      createMockToolRegistry()
    );
    const result = await cm.collaborationStep(undefined, 'ext-agent', 'Hello', 'bot1');

    expect(result.response).toContain('MCP error:');
    expect(result.response).toContain('Connection refused');
  });
});

describe('collaborate tool discover display', () => {
  it('handles missing telegramUsername without @undefined', async () => {
    const { createCollaborateTool } = await import('../../src/tools/collaborate');

    const tool = createCollaborateTool(() => ({
      discoverAgents: () => [
        {
          botId: 'ext-agent',
          name: 'External Agent',
          skills: ['mcp-external'],
          description: 'An MCP agent',
          tools: ['chat'],
          // no telegramUsername
        },
        {
          botId: 'tg-bot',
          name: 'Telegram Bot',
          telegramUsername: 'tgbot',
          skills: ['web-search'],
          tools: ['search'],
        },
      ],
      collaborationStep: async () => ({ sessionId: 's1', response: 'ok' }),
      endSession: () => {},
      sendVisibleMessage: async () => {},
    }));

    const result = await tool.execute({ action: 'discover', _botId: 'my-bot' }, noopLogger as any);

    expect(result.success).toBe(true);
    // MCP agent should show name without @undefined
    expect(result.content).toContain('**ext-agent** (External Agent)');
    expect(result.content).not.toContain('@undefined');
    // Telegram bot should still show @username
    expect(result.content).toContain('**tg-bot** (Telegram Bot, @tgbot)');
  });
});
