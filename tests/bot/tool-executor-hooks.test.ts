import { describe, it, expect, beforeEach } from 'bun:test';
import { ToolExecutor, ToolStartEvent, ToolEndEvent, ToolErrorEvent } from '../../src/bot/tool-executor';
import { Tool, ToolResult } from '../../src/tools/types';
import { BotContext } from '../../src/bot/types';
import { z } from 'zod';
import { EventEmitter } from 'events';

// Helper to create a mock BotContext
function createMockContext(tools: Tool[] = []): BotContext {
  return {
    config: {
      bots: [{ id: 'test-bot', name: 'Test Bot', model: 'test', disabledTools: ['disabled_tool'] }],
    } as any,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} } as any),
    },
    tools,
    toolDefinitions: tools.map((t) => t.definition),
  } as BotContext;
}

// Helper to create a simple test tool
function createTestTool(name: string, executeResult: ToolResult, maxRetries = 0): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `Test tool ${name}`,
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      maxRetries,
    },
    execute: async () => executeResult,
  };
}

// Helper to create a tool that throws
function createThrowingTool(name: string, errorMessage: string, maxRetries = 0): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `Throwing tool ${name}`,
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      maxRetries,
    },
    execute: async () => {
      throw new Error(errorMessage);
    },
  };
}

// Helper to create a tool with validation schema
function createSchemaTool(name: string, outputSchema: z.ZodType<unknown>, executeResult: unknown): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `Schema validation tool ${name}`,
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      maxRetries: 2,
      outputSchema,
    },
    execute: async () => ({
      success: true,
      content: JSON.stringify(executeResult),
    }),
  };
}

describe('ToolExecutor Observability Hooks', () => {
  describe('tool:start event', () => {
    it('should emit tool:start for disabled tool', async () => {
      const ctx = createMockContext([]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolStartEvent[] = [];
      executor.on('tool:start', (e) => events.push(e));

      await executor.execute('disabled_tool', { foo: 'bar' });

      expect(events.length).toBe(1);
      expect(events[0].toolName).toBe('disabled_tool');
      expect(events[0].args).toEqual({ foo: 'bar' });
      expect(events[0].botId).toBe('test-bot');
      expect(events[0].chatId).toBe(123);
      expect(events[0].timestamp).toBeGreaterThan(0);
    });

    it('should emit tool:start for unknown tool', async () => {
      const ctx = createMockContext([]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolStartEvent[] = [];
      executor.on('tool:start', (e) => events.push(e));

      await executor.execute('nonexistent_tool', {});

      expect(events.length).toBe(1);
      expect(events[0].toolName).toBe('nonexistent_tool');
    });

    it('should emit tool:start for successful execution', async () => {
      const successTool = createTestTool('success_tool', { success: true, content: 'ok' });
      const ctx = createMockContext([successTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolStartEvent[] = [];
      executor.on('tool:start', (e) => events.push(e));

      await executor.execute('success_tool', { input: 'test' });

      expect(events.length).toBe(1);
      expect(events[0].toolName).toBe('success_tool');
      expect(events[0].args).toEqual({ input: 'test' });
    });
  });

  describe('tool:end event', () => {
    it('should emit tool:end for disabled tool with success=false', async () => {
      const ctx = createMockContext([]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolEndEvent[] = [];
      executor.on('tool:end', (e) => events.push(e));

      await executor.execute('disabled_tool', {});

      expect(events.length).toBe(1);
      expect(events[0].toolName).toBe('disabled_tool');
      expect(events[0].success).toBe(false);
      expect(events[0].result).toContain('not available');
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(events[0].retryAttempts).toBe(0);
      expect(events[0].botId).toBe('test-bot');
      expect(events[0].chatId).toBe(123);
      expect(events[0].timestamp).toBeGreaterThan(0);
    });

    it('should emit tool:end for unknown tool with success=false', async () => {
      const ctx = createMockContext([]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolEndEvent[] = [];
      executor.on('tool:end', (e) => events.push(e));

      await executor.execute('unknown', {});

      expect(events.length).toBe(1);
      expect(events[0].success).toBe(false);
      expect(events[0].result).toContain('Unknown tool');
    });

    it('should emit tool:end for filtered tool with success=false', async () => {
      const successTool = createTestTool('filtered_tool', { success: true, content: 'ok' });
      const ctx = createMockContext([successTool]);
      const executor = new ToolExecutor(ctx, {
        botId: 'test-bot',
        chatId: 123,
        toolFilter: () => false, // Filter everything
      });

      const events: ToolEndEvent[] = [];
      executor.on('tool:end', (e) => events.push(e));

      await executor.execute('filtered_tool', {});

      expect(events.length).toBe(1);
      expect(events[0].success).toBe(false);
      expect(events[0].result).toContain('not available');
    });

    it('should emit tool:end for successful execution with success=true', async () => {
      const successTool = createTestTool('success_tool', { success: true, content: 'great success' });
      const ctx = createMockContext([successTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolEndEvent[] = [];
      executor.on('tool:end', (e) => events.push(e));

      await executor.execute('success_tool', {});

      expect(events.length).toBe(1);
      expect(events[0].toolName).toBe('success_tool');
      expect(events[0].success).toBe(true);
      expect(events[0].result).toBe('great success');
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(events[0].retryAttempts).toBe(0);
    });

    it('should emit tool:end with correct retryAttempts after retries', async () => {
      // Tool that fails validation twice then succeeds on third attempt
      let attempt = 0;
      const retryTool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'retry_tool',
            description: 'Retry test',
            parameters: { type: 'object', properties: {} },
          },
          maxRetries: 3,
          outputSchema: z.object({ value: z.number() }),
        },
        execute: async () => {
          attempt++;
          if (attempt < 3) {
            return { success: true, content: JSON.stringify({ wrong: 'schema' }) };
          }
          return { success: true, content: JSON.stringify({ value: 42 }) };
        },
      };

      const ctx = createMockContext([retryTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolEndEvent[] = [];
      executor.on('tool:end', (e) => events.push(e));

      await executor.execute('retry_tool', {});

      expect(events.length).toBe(1);
      expect(events[0].success).toBe(true);
      expect(events[0].retryAttempts).toBe(2); // 2 retries before success
    });

    it('should emit tool:end after exhausting all retries', async () => {
      const alwaysFailTool = createSchemaTool(
        'always_fail',
        z.object({ value: z.number() }),
        { wrong: 'always' }
      );

      const ctx = createMockContext([alwaysFailTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolEndEvent[] = [];
      executor.on('tool:end', (e) => events.push(e));

      await executor.execute('always_fail', {});

      expect(events.length).toBe(1);
      expect(events[0].success).toBe(false);
      expect(events[0].retryAttempts).toBe(2); // maxRetries = 2
      expect(events[0].result).toContain('Validation failed');
    });

    it('should emit tool:end after throwing tool exhausts retries', async () => {
      const throwingTool = createThrowingTool('throws', 'Boom!', 2);
      const ctx = createMockContext([throwingTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolEndEvent[] = [];
      executor.on('tool:end', (e) => events.push(e));

      await executor.execute('throws', {});

      expect(events.length).toBe(1);
      expect(events[0].success).toBe(false);
      expect(events[0].retryAttempts).toBe(2);
      expect(events[0].result).toContain('Boom!');
    });
  });

  describe('tool:error event', () => {
    it('should emit tool:error for disabled tool with phase=lookup', async () => {
      const ctx = createMockContext([]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolErrorEvent[] = [];
      executor.on('tool:error', (e) => events.push(e));

      await executor.execute('disabled_tool', { arg: 123 });

      expect(events.length).toBe(1);
      expect(events[0].toolName).toBe('disabled_tool');
      expect(events[0].args).toEqual({ arg: 123 });
      expect(events[0].error).toContain('not available');
      expect(events[0].phase).toBe('lookup');
      expect(events[0].botId).toBe('test-bot');
      expect(events[0].chatId).toBe(123);
    });

    it('should emit tool:error for unknown tool with phase=lookup', async () => {
      const ctx = createMockContext([]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolErrorEvent[] = [];
      executor.on('tool:error', (e) => events.push(e));

      await executor.execute('unknown_tool', {});

      expect(events.length).toBe(1);
      expect(events[0].phase).toBe('lookup');
      expect(events[0].error).toContain('Unknown tool');
    });

    it('should emit tool:error for filtered tool with phase=lookup', async () => {
      const tool = createTestTool('test', { success: true, content: 'ok' });
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, {
        botId: 'test-bot',
        chatId: 123,
        toolFilter: () => false,
      });

      const events: ToolErrorEvent[] = [];
      executor.on('tool:error', (e) => events.push(e));

      await executor.execute('test', {});

      expect(events.length).toBe(1);
      expect(events[0].phase).toBe('lookup');
    });

    it('should emit tool:error for tool that returns success=false with phase=execution', async () => {
      const failingTool = createTestTool('fails', { success: false, content: 'Tool failed internally' });
      const ctx = createMockContext([failingTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolErrorEvent[] = [];
      executor.on('tool:error', (e) => events.push(e));

      await executor.execute('fails', {});

      expect(events.length).toBe(1);
      expect(events[0].phase).toBe('execution');
      expect(events[0].error).toBe('Tool failed internally');
    });

    it('should emit tool:error for validation failures with phase=validation', async () => {
      const invalidTool = createSchemaTool('invalid', z.object({ count: z.number() }), { count: 'not a number' });
      const ctx = createMockContext([invalidTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolErrorEvent[] = [];
      executor.on('tool:error', (e) => events.push(e));

      await executor.execute('invalid', {});

      // Should emit error for each failed attempt + final
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].phase).toBe('validation');
      expect(events[0].error).toContain('validation');
    });

    it('should emit tool:error for thrown errors with phase=execution', async () => {
      const throwingTool = createThrowingTool('throws', 'Kaboom!', 0);
      const ctx = createMockContext([throwingTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolErrorEvent[] = [];
      executor.on('tool:error', (e) => events.push(e));

      await executor.execute('throws', {});

      // Emits 1 error for the final failure (no retries, so only the final error)
      expect(events.length).toBe(1);
      expect(events[0].phase).toBe('execution');
      // Error message includes the "failed after X attempts" wrapper
      expect(events[0].error).toContain('Kaboom!');
    });

    it('should emit multiple tool:error events during retry loop', async () => {
      let attempt = 0;
      const retryFailingTool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'retry_fails',
            description: 'Always fails',
            parameters: { type: 'object', properties: {} },
          },
          maxRetries: 2,
        },
        execute: async () => {
          attempt++;
          throw new Error(`Attempt ${attempt} failed`);
        },
      };

      const ctx = createMockContext([retryFailingTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const events: ToolErrorEvent[] = [];
      executor.on('tool:error', (e) => events.push(e));

      await executor.execute('retry_fails', {});

      // Should emit for each attempt (initial + 2 retries = 3 total)
      expect(events.length).toBe(3);
      expect(events[0].error).toBe('Attempt 1 failed');
      expect(events[1].error).toBe('Attempt 2 failed');
      expect(events[2].error).toBe('Attempt 3 failed');
      expect(events.every(e => e.phase === 'execution')).toBe(true);
    });
  });

  describe('event ordering', () => {
    it('should emit tool:start before tool:end for successful execution', async () => {
      const successTool = createTestTool('success', { success: true, content: 'ok' });
      const ctx = createMockContext([successTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const order: string[] = [];
      executor.on('tool:start', () => order.push('start'));
      executor.on('tool:end', () => order.push('end'));

      await executor.execute('success', {});

      expect(order).toEqual(['start', 'end']);
    });

    it('should emit tool:start, tool:error, then tool:end for lookup failure', async () => {
      const ctx = createMockContext([]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const order: string[] = [];
      executor.on('tool:start', () => order.push('start'));
      executor.on('tool:error', () => order.push('error'));
      executor.on('tool:end', () => order.push('end'));

      await executor.execute('disabled_tool', {});

      expect(order).toEqual(['start', 'error', 'end']);
    });
  });

  describe('typed events interface', () => {
    it('should support typed event listeners via ToolExecutorEvents interface', async () => {
      const successTool = createTestTool('typed', { success: true, content: 'ok' });
      const ctx = createMockContext([successTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      // Test that typed listeners compile and work
      const startListener = (e: ToolStartEvent) => {
        expect(e.toolName).toBe('typed');
      };
      const endListener = (e: ToolEndEvent) => {
        expect(e.success).toBe(true);
        expect(e.durationMs).toBeGreaterThanOrEqual(0);
      };

      executor.on('tool:start', startListener);
      executor.on('tool:end', endListener);

      await executor.execute('typed', {});
    });
  });

  describe('once listeners', () => {
    it('should support once() for one-time listeners', async () => {
      const successTool = createTestTool('once', { success: true, content: 'ok' });
      const ctx = createMockContext([successTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      let count = 0;
      executor.once('tool:start', () => count++);

      await executor.execute('once', {});
      await executor.execute('once', {});

      expect(count).toBe(1); // Only fired once
    });
  });

  describe('removeListener', () => {
    it('should support removeListener to unsubscribe', async () => {
      const successTool = createTestTool('remove', { success: true, content: 'ok' });
      const ctx = createMockContext([successTool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      let count = 0;
      const listener = () => count++;

      executor.on('tool:start', listener);
      await executor.execute('remove', {});
      expect(count).toBe(1);

      executor.removeListener('tool:start', listener);
      await executor.execute('remove', {});
      expect(count).toBe(1); // Did not increment
    });
  });
});
