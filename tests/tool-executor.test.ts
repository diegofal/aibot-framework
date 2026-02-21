import { describe, it, expect, beforeEach, spyOn, mock } from 'bun:test';
import { z } from 'zod';
import { ToolExecutor, createToolExecutor, createCollaborationToolExecutor } from '../src/bot/tool-executor';
import type { BotContext } from '../src/bot/types';
import type { Tool, ToolDefinition, ToolResult } from '../src/tools/types';
import type { Logger } from '../src/logger';

describe('ToolExecutor', () => {
  let mockCtx: BotContext;
  let mockTool: Tool;
  let executor: ToolExecutor;

  beforeEach(() => {
    mockTool = {
      definition: {
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'A test tool',
          parameters: {
            type: 'object',
            properties: {
              input: { type: 'string' }
            },
            required: ['input']
          }
        },
        maxRetries: 2
      },
      execute: mock(async (args: Record<string, unknown>): Promise<ToolResult> => {
        return { success: true, content: `Result: ${args.input}` };
      })
    };

    mockCtx = {
      config: {
        bots: [{
          id: 'test_bot',
          disabledTools: [],
          workDir: '/tmp/test'
        }]
      },
      tools: [mockTool],
      logger: {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {})
      }
    } as unknown as BotContext;

    executor = createToolExecutor(mockCtx, {
      botId: 'test_bot',
      chatId: 123,
      enableLogging: true
    });
  });

  describe('basic execution', () => {
    it('should execute a tool successfully', async () => {
      const result = await executor.execute('test_tool', { input: 'hello' });
      
      expect(result.success).toBe(true);
      expect(result.content).toBe('Result: hello');
      expect(result.toolName).toBe('test_tool');
      expect(result.args).toEqual({ input: 'hello' });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.retryAttempts).toBe(0);
    });

    it('should inject _chatId and _botId into args', async () => {
      const executeSpy = spyOn(mockTool, 'execute');
      
      await executor.execute('test_tool', { input: 'test' });
      
      const callArgs = executeSpy.mock.calls[0][0];
      expect(callArgs._chatId).toBe(123);
      expect(callArgs._botId).toBe('test_bot');
    });

    it('should return error for disabled tool', async () => {
      const disabledExecutor = createToolExecutor(mockCtx, {
        botId: 'test_bot',
        chatId: 123,
        disabledTools: new Set(['test_tool'])
      });

      const result = await disabledExecutor.execute('test_tool', { input: 'test' });
      
      expect(result.success).toBe(false);
      expect(result.content).toContain('not available');
    });

    it('should return error for unknown tool', async () => {
      const result = await executor.execute('unknown_tool', { input: 'test' });
      
      expect(result.success).toBe(false);
      expect(result.content).toContain('Unknown tool');
    });
  });

  describe('event emission', () => {
    it('should emit tool:start event', async () => {
      const startHandler = mock(() => {});
      executor.on('tool:start', startHandler);

      await executor.execute('test_tool', { input: 'test' });

      expect(startHandler).toHaveBeenCalled();
      const event = startHandler.mock.calls[0][0];
      expect(event.toolName).toBe('test_tool');
      expect(event.args).toEqual({ input: 'test' });
      expect(event.botId).toBe('test_bot');
      expect(event.chatId).toBe(123);
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('should emit tool:end event on success', async () => {
      const endHandler = mock(() => {});
      executor.on('tool:end', endHandler);

      await executor.execute('test_tool', { input: 'test' });

      expect(endHandler).toHaveBeenCalled();
      const event = endHandler.mock.calls[0][0];
      expect(event.success).toBe(true);
      expect(event.result).toBe('Result: test');
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.retryAttempts).toBe(0);
    });

    it('should emit tool:end event on failure', async () => {
      mockTool.execute = mock(async () => ({ success: false, content: 'Tool failed' }));
      
      const endHandler = mock(() => {});
      executor.on('tool:end', endHandler);

      await executor.execute('test_tool', { input: 'test' });

      expect(endHandler).toHaveBeenCalled();
      const event = endHandler.mock.calls[0][0];
      expect(event.success).toBe(false);
      expect(event.result).toContain('Tool failed');
    });

    it('should emit tool:error on execution error', async () => {
      mockTool.execute = mock(async () => { throw new Error('Boom'); });
      
      const errorHandler = mock(() => {});
      executor.on('tool:error', errorHandler);

      await executor.execute('test_tool', { input: 'test' });

      expect(errorHandler).toHaveBeenCalled();
      const event = errorHandler.mock.calls[0][0];
      expect(event.phase).toBe('execution');
      expect(event.error).toContain('Boom');
    });

    it('should emit tool:error on disabled tool', async () => {
      const disabledExecutor = createToolExecutor(mockCtx, {
        botId: 'test_bot',
        chatId: 123,
        disabledTools: new Set(['test_tool'])
      });

      const errorHandler = mock(() => {});
      disabledExecutor.on('tool:error', errorHandler);

      await disabledExecutor.execute('test_tool', { input: 'test' });

      expect(errorHandler).toHaveBeenCalled();
      const event = errorHandler.mock.calls[0][0];
      expect(event.phase).toBe('lookup');
    });
  });

  describe('retry logic', () => {
    beforeEach(() => {
      mockTool.definition.maxRetries = 2;
    });

    it('should retry on execution error', async () => {
      let callCount = 0;
      mockTool.execute = mock(async (args: Record<string, unknown>) => {
        callCount++;
        if (callCount < 3) {
          throw new Error(`Attempt ${callCount} failed`);
        }
        return { success: true, content: 'Success!' };
      });

      const result = await executor.execute('test_tool', { input: 'test' });
      
      expect(result.success).toBe(true);
      expect(result.content).toBe('Success!');
      expect(result.retryAttempts).toBe(2);
      expect(callCount).toBe(3);
    });

    it('should include _retryAttempt and _previousError on retries', async () => {
      mockTool.execute = mock(async (args: Record<string, unknown>) => {
        if (!args._retryAttempt) {
          throw new Error('First attempt failed');
        }
        return { success: true, content: `Retry ${args._retryAttempt}` };
      });

      await executor.execute('test_tool', { input: 'test' });
      
      const secondCall = mockTool.execute.mock.calls[1][0];
      expect(secondCall._retryAttempt).toBe(1);
      expect(secondCall._previousError).toContain('First attempt failed');
    });

    it('should not retry tool failures (success: false)', async () => {
      let callCount = 0;
      mockTool.execute = mock(async () => {
        callCount++;
        return { success: false, content: 'Tool logic error' };
      });

      const result = await executor.execute('test_tool', { input: 'test' });
      
      expect(result.success).toBe(false);
      expect(callCount).toBe(1);
      expect(result.retryAttempts).toBe(0);
    });

    it('should return error after max retries exceeded', async () => {
      mockTool.execute = mock(async () => {
        throw new Error('Always fails');
      });

      const result = await executor.execute('test_tool', { input: 'test' });
      
      expect(result.success).toBe(false);
      expect(result.content).toContain('Always fails');
      expect(result.content).toContain('3 attempt(s)');
      expect(result.retryAttempts).toBe(2);
    });

    it('should emit tool:error for each retry attempt', async () => {
      mockTool.execute = mock(async () => {
        throw new Error('Retry me');
      });

      const errorHandler = mock(() => {});
      executor.on('tool:error', errorHandler);

      await executor.execute('test_tool', { input: 'test' });

      // Should emit error for initial attempt + 2 retries
      expect(errorHandler.mock.calls.length).toBe(3);
    });
  });

  describe('output validation', () => {
    beforeEach(() => {
      mockTool.definition.outputSchema = z.object({
        status: z.string(),
        data: z.any()
      });
    });

    it('should validate JSON output against schema', async () => {
      mockTool.execute = mock(async () => ({
        success: true,
        content: JSON.stringify({ status: 'ok', data: [1, 2, 3] })
      }));

      const result = await executor.execute('test_tool', { input: 'test' });
      
      expect(result.success).toBe(true);
    });

    it('should fail validation for invalid JSON output', async () => {
      mockTool.execute = mock(async () => ({
        success: true,
        content: JSON.stringify({ wrongField: 'value' })
      }));

      const result = await executor.execute('test_tool', { input: 'test' });
      
      expect(result.success).toBe(false);
      expect(result.content).toContain('Output validation failed');
    });

    it('should retry on validation failure', async () => {
      let callCount = 0;
      mockTool.execute = mock(async () => {
        callCount++;
        if (callCount === 1) {
          return { success: true, content: JSON.stringify({ wrong: 'data' }) };
        }
        return { success: true, content: JSON.stringify({ status: 'ok', data: null }) };
      });

      const result = await executor.execute('test_tool', { input: 'test' });
      
      expect(result.success).toBe(true);
      expect(callCount).toBe(2);
    });

    it('should pass through tool errors without validation', async () => {
      mockTool.execute = mock(async () => ({
        success: false,
        content: 'Something went wrong'
      }));

      const result = await executor.execute('test_tool', { input: 'test' });
      
      expect(result.success).toBe(false);
      expect(result.content).toBe('Something went wrong');
    });

    it('should handle non-JSON string content', async () => {
      mockTool.execute = mock(async () => ({
        success: true,
        content: 'Plain text response'
      }));

      const result = await executor.execute('test_tool', { input: 'test' });
      
      // Plain text doesn't match object schema
      expect(result.success).toBe(false);
      expect(result.content).toContain('Output validation failed');
    });
  });

  describe('execution logging', () => {
    it('should log executions when enabled', async () => {
      await executor.execute('test_tool', { input: 'test' });

      const log = executor.getExecutionLog();
      expect(log.length).toBe(1);
      expect(log[0].name).toBe('test_tool');
      expect(log[0].success).toBe(true);
      expect(log[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should not log when disabled', async () => {
      const noLogExecutor = createToolExecutor(mockCtx, {
        botId: 'test_bot',
        chatId: 123,
        enableLogging: false
      });

      await noLogExecutor.execute('test_tool', { input: 'test' });

      expect(noLogExecutor.getExecutionLog().length).toBe(0);
    });

    it('should truncate long results in logs', async () => {
      mockTool.execute = mock(async () => ({
        success: true,
        content: 'x'.repeat(5000)
      }));

      await executor.execute('test_tool', { input: 'test' });

      const log = executor.getExecutionLog();
      expect(log[0].result.length).toBeLessThan(3000);
    });

    it('should clear execution log', async () => {
      await executor.execute('test_tool', { input: 'test1' });
      await executor.execute('test_tool', { input: 'test2' });
      
      expect(executor.getExecutionLog().length).toBe(2);
      
      executor.clearExecutionLog();
      
      expect(executor.getExecutionLog().length).toBe(0);
    });
  });

  describe('tool filtering', () => {
    it('should filter tools with custom filter', async () => {
      const filteredExecutor = createToolExecutor(mockCtx, {
        botId: 'test_bot',
        chatId: 123,
        toolFilter: (tool) => tool.definition.function.name !== 'test_tool'
      });

      const result = await filteredExecutor.execute('test_tool', { input: 'test' });
      
      expect(result.success).toBe(false);
      expect(result.content).toContain('not available in this context');
    });

    it('should emit tool:error for filtered tools', async () => {
      const filteredExecutor = createToolExecutor(mockCtx, {
        botId: 'test_bot',
        chatId: 123,
        toolFilter: (tool) => tool.definition.function.name !== 'test_tool'
      });

      const errorHandler = mock(() => {});
      filteredExecutor.on('tool:error', errorHandler);

      await filteredExecutor.execute('test_tool', { input: 'test' });

      expect(errorHandler).toHaveBeenCalled();
      expect(errorHandler.mock.calls[0][0].phase).toBe('lookup');
    });
  });

  describe('utility methods', () => {
    it('should return filtered definitions', () => {
      const defs = executor.getDefinitions();
      expect(defs.length).toBe(1);
      expect(defs[0].function.name).toBe('test_tool');
    });

    it('should return empty definitions when all filtered', () => {
      const filteredExecutor = createToolExecutor(mockCtx, {
        botId: 'test_bot',
        chatId: 123,
        disabledTools: new Set(['test_tool'])
      });

      const defs = filteredExecutor.getDefinitions();
      expect(defs.length).toBe(0);
    });

    it('should check tool availability', () => {
      expect(executor.isToolAvailable('test_tool')).toBe(true);
      expect(executor.isToolAvailable('unknown_tool')).toBe(false);
    });

    it('should report unavailable for disabled tools', () => {
      const disabledExecutor = createToolExecutor(mockCtx, {
        botId: 'test_bot',
        chatId: 123,
        disabledTools: new Set(['test_tool'])
      });

      expect(disabledExecutor.isToolAvailable('test_tool')).toBe(false);
    });
  });

  describe('createCallback', () => {
    it('should create callback returning ToolResult shape', async () => {
      const callback = executor.createCallback();
      
      const result = await callback('test_tool', { input: 'test' });
      
      expect(result.success).toBe(true);
      expect(result.content).toBe('Result: test');
      // Should not have toolName, args, durationMs
      expect('toolName' in result).toBe(false);
      expect('args' in result).toBe(false);
      expect('durationMs' in result).toBe(false);
    });
  });

  describe('createCollaborationToolExecutor', () => {
    it('should exclude delegate_to_bot and collaborate tools', () => {
      const collabExecutor = createCollaborationToolExecutor(mockCtx, 'test_bot', 123);
      
      // Should have our test tool
      expect(collabExecutor.isToolAvailable('test_tool')).toBe(true);
      
      // These would be filtered if they existed
      expect(collabExecutor.getDefinitions().some(
        d => d.function.name === 'delegate_to_bot' || d.function.name === 'collaborate'
      )).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle tools with no maxRetries', async () => {
      const noRetryTool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'no_retry_tool',
            description: 'No retries',
            parameters: { type: 'object', properties: {} }
          }
          // No maxRetries defined
        },
        execute: mock(async () => { throw new Error('Fail'); })
      };

      const ctxWithNoRetry = {
        ...mockCtx,
        tools: [noRetryTool]
      } as unknown as BotContext;

      const noRetryExecutor = createToolExecutor(ctxWithNoRetry, {
        botId: 'test_bot',
        chatId: 123
      });

      const result = await noRetryExecutor.execute('no_retry_tool', {});
      
      expect(result.success).toBe(false);
      expect(result.retryAttempts).toBe(0);
    });

    it('should handle tools with 0 maxRetries', async () => {
      mockTool.definition.maxRetries = 0;
      mockTool.execute = mock(async () => { throw new Error('Fail'); });

      const result = await executor.execute('test_tool', { input: 'test' });
      
      expect(result.success).toBe(false);
      expect(result.retryAttempts).toBe(0);
    });

    it('should handle custom logger', async () => {
      const customLogger = {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {})
      };

      const customExecutor = createToolExecutor(mockCtx, {
        botId: 'test_bot',
        chatId: 123,
        logger: customLogger as unknown as Logger
      });

      await customExecutor.execute('unknown_tool', { input: 'test' });
      
      expect(customLogger.warn).toHaveBeenCalled();
    });
  });
});
