import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { z } from 'zod';
import type { Logger } from '../../logger';
import {
  ToolExecutor,
  createCollaborationToolExecutor,
  createToolExecutor,
} from '../tool-executor';
import type { BotContext, Tool } from '../types';

// Mock logger factory
const createMockLogger = (): Logger => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  } as unknown as Logger;
  (logger.child as jest.Mock).mockReturnValue(logger);
  return logger;
};

// Mock tool factory
const createMockTool = (overrides: Partial<Tool> = {}): Tool => ({
  definition: {
    type: 'function',
    function: {
      name: 'test_tool',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    maxRetries: 0,
    ...overrides.definition,
  },
  execute: jest.fn(() => Promise.resolve({ success: true, content: 'success' })),
  ...overrides,
});

// Mock context factory
const createMockContext = (overrides: Partial<BotContext> = {}): BotContext =>
  ({
    config: {
      bots: [{ id: 'test-bot', disabledTools: [] }],
    },
    tools: [],
    logger: createMockLogger(),
    ...overrides,
  }) as unknown as BotContext;

describe('ToolExecutor', () => {
  let ctx: BotContext;
  let logger: Logger;

  beforeEach(() => {
    logger = createMockLogger();
    ctx = createMockContext({ logger });
  });

  describe('basic execution', () => {
    it('should execute a tool successfully', async () => {
      const tool = createMockTool();
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('test_tool', { foo: 'bar' });

      expect(result.success).toBe(true);
      expect(result.content).toBe('success');
      expect(result.toolName).toBe('test_tool');
      expect(result.args).toEqual({ foo: 'bar' });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(tool.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          foo: 'bar',
          _chatId: 123,
          _botId: 'test-bot',
        }),
        logger
      );
    });

    it('should return error for disabled tool', async () => {
      const tool = createMockTool();
      (ctx as { tools: Tool[] }).tools = [tool];
      ctx.config.bots[0].disabledTools = ['test_tool'];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('test_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('not available');
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it('should return error for unknown tool', async () => {
      (ctx as { tools: Tool[] }).tools = [];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('unknown_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('Unknown tool');
    });

    it('should filter tools via toolFilter option', async () => {
      const tool = createMockTool();
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, {
        botId: 'test-bot',
        chatId: 123,
        toolFilter: () => false,
      });
      const result = await executor.execute('test_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('not available');
    });
  });

  describe('EventEmitter hooks', () => {
    it('should emit tool:start event', async () => {
      const tool = createMockTool();
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const startHandler = jest.fn();
      executor.on('tool:start', startHandler);

      await executor.execute('test_tool', { foo: 'bar' });

      expect(startHandler).toHaveBeenCalledWith({
        toolName: 'test_tool',
        args: { foo: 'bar' },
        botId: 'test-bot',
        chatId: 123,
        timestamp: expect.any(Number),
      });
    });

    it('should emit tool:end event on success', async () => {
      const tool = createMockTool();
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const endHandler = jest.fn();
      executor.on('tool:end', endHandler);

      await executor.execute('test_tool', { foo: 'bar' });

      expect(endHandler).toHaveBeenCalledWith({
        toolName: 'test_tool',
        args: { foo: 'bar' },
        success: true,
        result: 'success',
        durationMs: expect.any(Number),
        retryAttempts: 0,
        botId: 'test-bot',
        chatId: 123,
        timestamp: expect.any(Number),
      });
    });

    it('should emit tool:end event on failure', async () => {
      const tool = createMockTool({
        execute: jest.fn(() => Promise.reject(new Error('execution failed'))),
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const endHandler = jest.fn();
      executor.on('tool:end', endHandler);

      await executor.execute('test_tool', {});

      expect(endHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'test_tool',
          success: false,
          retryAttempts: 0,
        })
      );
    });

    it('should emit tool:error for disabled tool', async () => {
      ctx.config.bots[0].disabledTools = ['test_tool'];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const errorHandler = jest.fn();
      executor.on('tool:error', errorHandler);

      await executor.execute('test_tool', { foo: 'bar' });

      expect(errorHandler).toHaveBeenCalledWith({
        toolName: 'test_tool',
        args: { foo: 'bar' },
        error: expect.stringContaining('not available'),
        phase: 'lookup',
        botId: 'test-bot',
        chatId: 123,
        timestamp: expect.any(Number),
      });
    });

    it('should emit tool:error for unknown tool', async () => {
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const errorHandler = jest.fn();
      executor.on('tool:error', errorHandler);

      await executor.execute('unknown', {});

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'lookup',
        })
      );
    });

    it('should emit tool:error for execution error', async () => {
      const tool = createMockTool({
        execute: jest.fn(() => Promise.reject(new Error('boom'))),
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const errorHandler = jest.fn();
      executor.on('tool:error', errorHandler);

      await executor.execute('test_tool', {});

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'execution',
          error: 'boom',
        })
      );
    });
  });

  describe('Zod output validation', () => {
    it('should pass validation with valid output schema', async () => {
      const tool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
          outputSchema: z.object({ name: z.string(), age: z.number() }),
        },
        execute: jest.fn(() =>
          Promise.resolve({
            success: true,
            content: '{"name": "John", "age": 30}',
          })
        ),
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('test_tool', {});

      expect(result.success).toBe(true);
    });

    it('should fail validation with invalid output schema', async () => {
      const tool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
          outputSchema: z.object({ name: z.string(), age: z.number() }),
        },
        execute: jest.fn(() =>
          Promise.resolve({
            success: true,
            content: '{"name": "John", "age": "not a number"}',
          })
        ),
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('test_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('Output validation failed');
    });

    it('should emit tool:error for validation failure', async () => {
      const tool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
          outputSchema: z.object({ name: z.string() }),
        },
        execute: jest.fn(() =>
          Promise.resolve({
            success: true,
            content: '{"invalid": true}',
          })
        ),
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const errorHandler = jest.fn();
      executor.on('tool:error', errorHandler);

      await executor.execute('test_tool', {});

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'validation',
        })
      );
    });

    it('should skip validation for failed tool results', async () => {
      const tool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
          outputSchema: z.object({ name: z.string() }),
        },
        execute: jest.fn(() =>
          Promise.resolve({
            success: false,
            content: 'some error',
          })
        ),
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('test_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toBe('some error');
    });

    it('should skip validation when no schema defined', async () => {
      const tool = createMockTool({
        execute: jest.fn(() =>
          Promise.resolve({
            success: true,
            content: 'any content',
          })
        ),
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('test_tool', {});

      expect(result.success).toBe(true);
    });

    it('should handle non-JSON content as raw string', async () => {
      const tool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
          outputSchema: z.string(),
        },
        execute: jest.fn(() =>
          Promise.resolve({
            success: true,
            content: 'plain text response',
          })
        ),
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('test_tool', {});

      expect(result.success).toBe(true);
    });
  });

  describe('retry logic', () => {
    it('should retry on validation failure with maxRetries > 0', async () => {
      let callCount = 0;
      const execute = jest.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ success: true, content: '{"invalid": true}' });
        }
        return Promise.resolve({ success: true, content: '{"name": "valid"}' });
      });

      const tool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
          maxRetries: 2,
          outputSchema: z.object({ name: z.string() }),
        },
        execute,
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('test_tool', {});

      expect(execute).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.retryAttempts).toBe(1);
    });

    it('should include _retryAttempt and _previousError on retries', async () => {
      let callCount = 0;
      const execute = jest.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ success: true, content: 'invalid' });
        }
        return Promise.resolve({ success: true, content: 'valid' });
      });

      const tool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
          maxRetries: 2,
          outputSchema: z.string().refine((v) => v === 'valid'),
        },
        execute,
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      await executor.execute('test_tool', {});

      expect(execute).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          _retryAttempt: 1,
          _previousError: expect.any(String),
        }),
        expect.anything()
      );
    });

    it('should return error after exhausting retries', async () => {
      const execute = jest.fn(() =>
        Promise.resolve({
          success: true,
          content: '{"invalid": true}',
        })
      );

      const tool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
          maxRetries: 2,
          outputSchema: z.object({ name: z.string() }),
        },
        execute,
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('test_tool', {});

      expect(execute).toHaveBeenCalledTimes(3); // initial + 2 retries
      expect(result.success).toBe(false);
      expect(result.content).toContain('Validation failed after 3 attempt(s)');
      expect(result.retryAttempts).toBe(2);
    });

    it('should retry on execution errors', async () => {
      let callCount = 0;
      const execute = jest.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('network error'));
        }
        return Promise.resolve({ success: true, content: 'success' });
      });

      const tool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
          maxRetries: 2,
        },
        execute,
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('test_tool', {});

      expect(execute).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });

    it('should not retry when maxRetries is 0', async () => {
      const execute = jest.fn(() => Promise.reject(new Error('fail')));

      const tool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
          maxRetries: 0,
        },
        execute,
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('test_tool', {});

      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
    });

    it('should not retry tool execution failures (only validation failures)', async () => {
      const execute = jest.fn(() =>
        Promise.resolve({
          success: false,
          content: 'tool returned error',
        })
      );

      const tool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
          maxRetries: 3,
        },
        execute,
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('test_tool', {});

      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.content).toBe('tool returned error');
    });
  });

  describe('execution logging', () => {
    it('should log executions when enableLogging is true', async () => {
      const tool = createMockTool();
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, {
        botId: 'test-bot',
        chatId: 123,
        enableLogging: true,
      });

      await executor.execute('test_tool', { foo: 'bar' });

      const log = executor.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        name: 'test_tool',
        args: { foo: 'bar' },
        success: true,
        result: 'success',
      });
    });

    it('should not log when enableLogging is false', async () => {
      const tool = createMockTool();
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, {
        botId: 'test-bot',
        chatId: 123,
        enableLogging: false,
      });

      await executor.execute('test_tool', {});

      expect(executor.getExecutionLog()).toHaveLength(0);
    });

    it('should clear execution log', async () => {
      const tool = createMockTool();
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, {
        botId: 'test-bot',
        chatId: 123,
        enableLogging: true,
      });

      await executor.execute('test_tool', {});
      expect(executor.getExecutionLog()).toHaveLength(1);

      executor.clearExecutionLog();
      expect(executor.getExecutionLog()).toHaveLength(0);
    });

    it('should truncate long results in logs', async () => {
      const tool = createMockTool({
        execute: jest.fn(() =>
          Promise.resolve({
            success: true,
            content: 'x'.repeat(3000),
          })
        ),
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, {
        botId: 'test-bot',
        chatId: 123,
        enableLogging: true,
      });

      await executor.execute('test_tool', {});

      const log = executor.getExecutionLog();
      expect(log[0].result.length).toBe(2000);
    });
  });

  describe('createCallback', () => {
    it('should return ToolResult without metadata', async () => {
      const tool = createMockTool();
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const callback = executor.createCallback();

      const result = await callback('test_tool', {});

      expect(result).toEqual({
        success: true,
        content: 'success',
      });
      expect(result).not.toHaveProperty('toolName');
      expect(result).not.toHaveProperty('durationMs');
    });
  });

  describe('getDefinitions', () => {
    it('should return filtered tool definitions', async () => {
      const tool1 = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'tool1',
            description: 'Tool 1',
            parameters: { type: 'object', properties: {} },
          },
        },
      });
      const tool2 = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'tool2',
            description: 'Tool 2',
            parameters: { type: 'object', properties: {} },
          },
        },
      });
      (ctx as { tools: Tool[] }).tools = [tool1, tool2];
      ctx.config.bots[0].disabledTools = ['tool1'];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const definitions = executor.getDefinitions();

      expect(definitions).toHaveLength(1);
      expect(definitions[0].function.name).toBe('tool2');
    });
  });

  describe('isToolAvailable', () => {
    it('should return true for available tools', () => {
      const tool = createMockTool();
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      expect(executor.isToolAvailable('test_tool')).toBe(true);
    });

    it('should return false for disabled tools', () => {
      const tool = createMockTool();
      (ctx as { tools: Tool[] }).tools = [tool];
      ctx.config.bots[0].disabledTools = ['test_tool'];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      expect(executor.isToolAvailable('test_tool')).toBe(false);
    });

    it('should return false for unknown tools', () => {
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      expect(executor.isToolAvailable('unknown')).toBe(false);
    });

    it('should respect toolFilter', () => {
      const tool = createMockTool();
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, {
        botId: 'test-bot',
        chatId: 123,
        toolFilter: () => false,
      });
      expect(executor.isToolAvailable('test_tool')).toBe(false);
    });
  });

  describe('factory functions', () => {
    it('createToolExecutor should create ToolExecutor instance', () => {
      const executor = createToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      expect(executor).toBeInstanceOf(ToolExecutor);
    });

    it('createCollaborationToolExecutor should exclude delegate and collaborate tools', async () => {
      const delegateTool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'delegate_to_bot',
            description: 'Delegate',
            parameters: { type: 'object', properties: {} },
          },
        },
      });
      const collaborateTool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'collaborate',
            description: 'Collaborate',
            parameters: { type: 'object', properties: {} },
          },
        },
      });
      const normalTool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'normal_tool',
            description: 'Normal',
            parameters: { type: 'object', properties: {} },
          },
        },
      });
      (ctx as { tools: Tool[] }).tools = [delegateTool, collaborateTool, normalTool];

      const executor = createCollaborationToolExecutor(ctx, 'test-bot', 123);

      expect(executor.isToolAvailable('delegate_to_bot')).toBe(false);
      expect(executor.isToolAvailable('collaborate')).toBe(false);
      expect(executor.isToolAvailable('normal_tool')).toBe(true);
    });
  });

  describe('error classification', () => {
    it('should classify disabled tool as lookup phase', async () => {
      ctx.config.bots[0].disabledTools = ['test_tool'];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const errorHandler = jest.fn();
      executor.on('tool:error', errorHandler);

      await executor.execute('test_tool', {});

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ phase: 'lookup' }));
    });

    it('should classify validation failure as validation phase', async () => {
      const tool = createMockTool({
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
          outputSchema: z.object({ name: z.string() }),
        },
        execute: jest.fn(() =>
          Promise.resolve({
            success: true,
            content: '{"invalid": true}',
          })
        ),
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const errorHandler = jest.fn();
      executor.on('tool:error', errorHandler);

      await executor.execute('test_tool', {});

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ phase: 'validation' }));
    });

    it('should classify execution error as execution phase', async () => {
      const tool = createMockTool({
        execute: jest.fn(() => Promise.reject(new Error('runtime error'))),
      });
      (ctx as { tools: Tool[] }).tools = [tool];

      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const errorHandler = jest.fn();
      executor.on('tool:error', errorHandler);

      await executor.execute('test_tool', {});

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ phase: 'execution' }));
    });
  });
});
