import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { ToolExecutor } from '../../src/bot/tool-executor';
import type { BotContext } from '../../src/bot/types';
import type { Tool, ToolResult } from '../../src/tools/types';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

function createMockContext(tools: Tool[] = []): BotContext {
  return {
    config: {
      bots: [{ id: 'test-bot', disabledTools: [] }],
    },
    tools,
    toolDefinitions: tools.map(t => t.definition),
    logger: noopLogger,
  } as unknown as BotContext;
}

function createMockTool(
  name: string,
  executeResult: ToolResult,
  outputSchema?: z.ZodType<unknown>
): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `Tool ${name}`,
        parameters: { type: 'object', properties: {} },
      },
      outputSchema,
    },
    execute: async () => executeResult,
  };
}

describe('ToolExecutor', () => {
  describe('basic execution', () => {
    test('executes tool and returns result', async () => {
      const tool = createMockTool('test_tool', { success: true, content: 'hello' });
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('test_tool', {});

      expect(result.success).toBe(true);
      expect(result.content).toBe('hello');
      expect(result.toolName).toBe('test_tool');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('returns error for unknown tool', async () => {
      const ctx = createMockContext([]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('unknown_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('Unknown tool');
    });

    test('returns error for disabled tool', async () => {
      const tool = createMockTool('disabled_tool', { success: true, content: 'ok' });
      const ctx = createMockContext([tool]);
      ctx.config.bots[0].disabledTools = ['disabled_tool'];
      
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });
      const result = await executor.execute('disabled_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('not available');
    });

    test('injects _botId and _chatId into args', async () => {
      let capturedArgs: Record<string, unknown> = {};
      const tool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'capture_tool',
            description: 'Captures args',
            parameters: { type: 'object', properties: {} },
          },
        },
        execute: async (args) => {
          capturedArgs = args;
          return { success: true, content: 'captured' };
        },
      };

      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'my-bot', chatId: 456 });
      
      await executor.execute('capture_tool', { foo: 'bar' });

      expect(capturedArgs._botId).toBe('my-bot');
      expect(capturedArgs._chatId).toBe(456);
      expect(capturedArgs.foo).toBe('bar');
    });
  });

  describe('output schema validation', () => {
    test('passes through result when no schema defined', async () => {
      const tool = createMockTool('no_schema', { success: true, content: 'raw text' });
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('no_schema', {});

      expect(result.success).toBe(true);
      expect(result.content).toBe('raw text');
    });

    test('passes through error results without validation', async () => {
      const schema = z.object({ success: z.boolean() });
      const tool = createMockTool(
        'error_tool',
        { success: false, content: 'Something went wrong' },
        schema
      );
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('error_tool', {});

      // Error results pass through without validation
      expect(result.success).toBe(false);
      expect(result.content).toBe('Something went wrong');
    });

    test('validates successful JSON string output against schema', async () => {
      const schema = z.object({
        name: z.string(),
        count: z.number(),
      });
      const tool = createMockTool(
        'json_tool',
        { success: true, content: '{"name": "test", "count": 42}' },
        schema
      );
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('json_tool', {});

      expect(result.success).toBe(true);
      expect(result.content).toBe('{"name": "test", "count": 42}');
    });

    test('validates successful object output against schema', async () => {
      const schema = z.object({
        items: z.array(z.string()),
        total: z.number(),
      });
      const tool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'object_tool',
            description: 'Returns object',
            parameters: { type: 'object', properties: {} },
          },
          outputSchema: schema,
        },
        execute: async () => ({ success: true, content: { items: ['a', 'b'], total: 2 } }),
      };
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('object_tool', {});

      expect(result.success).toBe(true);
    });

    test('fails validation when JSON content does not match schema', async () => {
      const schema = z.object({
        required_field: z.string(),
      });
      const tool = createMockTool(
        'invalid_tool',
        { success: true, content: '{"wrong_field": "value"}' },
        schema
      );
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('invalid_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('Output validation failed');
      expect(result.content).toContain('required_field');
    });

    test('fails validation when JSON is malformed', async () => {
      const schema = z.object({ field: z.string() });
      const tool = createMockTool(
        'malformed_tool',
        { success: true, content: '{invalid json}' },
        schema
      );
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('malformed_tool', {});

      // Malformed JSON falls back to treating as raw string, which fails schema
      expect(result.success).toBe(false);
      expect(result.content).toContain('Output validation failed');
    });

    test('treats non-JSON string as raw content', async () => {
      const schema = z.string();
      const tool = createMockTool(
        'text_tool',
        { success: true, content: 'plain text output' },
        schema
      );
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('text_tool', {});

      expect(result.success).toBe(true);
      expect(result.content).toBe('plain text output');
    });

    test('validates complex nested schema', async () => {
      const schema = z.object({
        users: z.array(z.object({
          id: z.number(),
          name: z.string(),
          active: z.boolean(),
        })),
        metadata: z.object({
          total: z.number(),
          page: z.number(),
        }),
      });
      const tool = createMockTool(
        'complex_tool',
        {
          success: true,
          content: JSON.stringify({
            users: [{ id: 1, name: 'Alice', active: true }],
            metadata: { total: 1, page: 1 },
          }),
        },
        schema
      );
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('complex_tool', {});

      expect(result.success).toBe(true);
    });

    test('provides detailed validation errors for complex failures', async () => {
      const schema = z.object({
        email: z.string().email(),
        age: z.number().min(0).max(150),
      });
      const tool = createMockTool(
        'validation_tool',
        { success: true, content: '{"email": "not-an-email", "age": -5}' },
        schema
      );
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('validation_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('email');
      expect(result.content).toContain('age');
    });
  });

  describe('execution logging', () => {
    test('logs executions when enabled', async () => {
      const tool = createMockTool('log_tool', { success: true, content: 'output' });
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { 
        botId: 'test-bot', 
        chatId: 123,
        enableLogging: true,
      });

      await executor.execute('log_tool', { arg: 'value' });
      await executor.execute('log_tool', { arg: 'other' });

      const logs = executor.getExecutionLog();
      expect(logs).toHaveLength(2);
      expect(logs[0].name).toBe('log_tool');
      expect(logs[0].args.arg).toBe('value');
      expect(logs[0].success).toBe(true);
      expect(logs[0].result).toBe('output');
    });

    test('does not log when disabled', async () => {
      const tool = createMockTool('no_log_tool', { success: true, content: 'output' });
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { 
        botId: 'test-bot', 
        chatId: 123,
        enableLogging: false,
      });

      await executor.execute('no_log_tool', {});

      expect(executor.getExecutionLog()).toHaveLength(0);
    });

    test('clears execution log', async () => {
      const tool = createMockTool('clear_tool', { success: true, content: 'output' });
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { 
        botId: 'test-bot', 
        chatId: 123,
        enableLogging: true,
      });

      await executor.execute('clear_tool', {});
      expect(executor.getExecutionLog()).toHaveLength(1);

      executor.clearExecutionLog();
      expect(executor.getExecutionLog()).toHaveLength(0);
    });

    test('truncates long results in logs', async () => {
      const longContent = 'x'.repeat(3000);
      const tool = createMockTool('long_tool', { success: true, content: longContent });
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { 
        botId: 'test-bot', 
        chatId: 123,
        enableLogging: true,
      });

      await executor.execute('long_tool', {});

      const log = executor.getExecutionLog()[0];
      expect(log.result.length).toBeLessThan(longContent.length);
      expect(log.result.length).toBeLessThanOrEqual(2000);
    });
  });

  describe('tool filtering', () => {
    test('applies tool filter when provided', async () => {
      const tool = createMockTool('filtered_tool', { success: true, content: 'ok' });
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { 
        botId: 'test-bot', 
        chatId: 123,
        toolFilter: () => false, // Filter out all tools
      });

      const result = await executor.execute('filtered_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('not available in this context');
    });

    test('getDefinitions respects tool filter', async () => {
      const tool1 = createMockTool('tool_a', { success: true, content: 'a' });
      const tool2 = createMockTool('tool_b', { success: true, content: 'b' });
      const ctx = createMockContext([tool1, tool2]);
      const executor = new ToolExecutor(ctx, { 
        botId: 'test-bot', 
        chatId: 123,
        toolFilter: (t) => t.definition.function.name === 'tool_a',
      });

      const defs = executor.getDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].function.name).toBe('tool_a');
    });

    test('isToolAvailable checks filter and disabled status', async () => {
      const tool = createMockTool('check_tool', { success: true, content: 'ok' });
      const ctx = createMockContext([tool]);
      ctx.config.bots[0].disabledTools = ['check_tool'];
      
      const executor = new ToolExecutor(ctx, { 
        botId: 'test-bot', 
        chatId: 123,
      });

      expect(executor.isToolAvailable('check_tool')).toBe(false);
      expect(executor.isToolAvailable('nonexistent')).toBe(false);
    });
  });

  describe('createCallback', () => {
    test('returns ToolResult without metadata', async () => {
      const tool = createMockTool('callback_tool', { success: true, content: 'result' });
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const callback = executor.createCallback();
      const result = await callback('callback_tool', {});

      // Callback returns ToolResult, not ToolExecutionResult
      expect(result.success).toBe(true);
      expect(result.content).toBe('result');
      expect(result).not.toHaveProperty('toolName');
      expect(result).not.toHaveProperty('durationMs');
      expect(result).not.toHaveProperty('args');
    });
  });

  describe('error handling', () => {
    test('handles tool execution exceptions', async () => {
      const tool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'error_tool',
            description: 'Throws error',
            parameters: { type: 'object', properties: {} },
          },
        },
        execute: async () => {
          throw new Error('Tool crashed!');
        },
      };
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('error_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('Tool execution failed');
      expect(result.content).toContain('Tool crashed!');
    });

    test('handles non-Error exceptions', async () => {
      const tool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'string_error_tool',
            description: 'Throws string',
            parameters: { type: 'object', properties: {} },
          },
        },
        execute: async () => {
          throw 'String error';
        },
      };
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('string_error_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('String error');
    });
  });

  describe('retry logic', () => {
    test('succeeds on first attempt without retries', async () => {
      const tool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'simple_tool',
            description: 'Simple tool',
            parameters: { type: 'object', properties: {} },
          },
        },
        execute: async () => ({ success: true, content: 'ok' }),
      };
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('simple_tool', {});

      expect(result.success).toBe(true);
      expect(result.content).toBe('ok');
      expect(result.retryAttempts).toBe(0);
    });

    test('succeeds on second attempt after execution error', async () => {
      let attemptCount = 0;
      const tool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'retry_tool',
            description: 'Tool that fails once',
            parameters: { type: 'object', properties: {} },
          },
          maxRetries: 2,
        },
        execute: async (args) => {
          attemptCount++;
          if (attemptCount === 1) {
            throw new Error('Transient failure');
          }
          // Verify retry context is provided
          if (args._retryAttempt !== 1 || args._previousError !== 'Transient failure') {
            throw new Error('Retry context not provided correctly');
          }
          return { success: true, content: 'recovered' };
        },
      };
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('retry_tool', {});

      expect(result.success).toBe(true);
      expect(result.content).toBe('recovered');
      expect(result.retryAttempts).toBe(1);
      expect(attemptCount).toBe(2);
    });

    test('succeeds on third attempt after multiple failures', async () => {
      let attemptCount = 0;
      const tool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'multi_retry_tool',
            description: 'Tool that fails twice',
            parameters: { type: 'object', properties: {} },
          },
          maxRetries: 3,
        },
        execute: async () => {
          attemptCount++;
          if (attemptCount < 3) {
            throw new Error(`Failure ${attemptCount}`);
          }
          return { success: true, content: 'finally worked' };
        },
      };
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('multi_retry_tool', {});

      expect(result.success).toBe(true);
      expect(result.content).toBe('finally worked');
      expect(result.retryAttempts).toBe(2);
      expect(attemptCount).toBe(3);
    });

    test('fails after max retries exceeded', async () => {
      let attemptCount = 0;
      const tool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'always_fail_tool',
            description: 'Tool that always fails',
            parameters: { type: 'object', properties: {} },
          },
          maxRetries: 2,
        },
        execute: async () => {
          attemptCount++;
          throw new Error(`Persistent error ${attemptCount}`);
        },
      };
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('always_fail_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('after 3 attempt(s)');
      expect(result.content).toContain('Persistent error 3');
      expect(result.retryAttempts).toBe(2);
      expect(attemptCount).toBe(3); // Initial + 2 retries
    });

    test('retries on validation failure and succeeds', async () => {
      let attemptCount = 0;
      const schema = z.object({ status: z.literal('success') });
      const tool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'validation_retry_tool',
            description: 'Tool with validation retries',
            parameters: { type: 'object', properties: {} },
          },
          outputSchema: schema,
          maxRetries: 2,
        },
        execute: async () => {
          attemptCount++;
          if (attemptCount === 1) {
            // Return invalid response first time
            return { success: true, content: '{"status": "invalid"}' };
          }
          // Return valid response on retry
          return { success: true, content: '{"status": "success"}' };
        },
      };
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('validation_retry_tool', {});

      expect(result.success).toBe(true);
      expect(result.retryAttempts).toBe(1);
      expect(attemptCount).toBe(2);
    });

    test('fails after max retries on persistent validation failure', async () => {
      const schema = z.object({ required: z.boolean() });
      const tool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'always_invalid_tool',
            description: 'Tool that always returns invalid data',
            parameters: { type: 'object', properties: {} },
          },
          outputSchema: schema,
          maxRetries: 2,
        },
        execute: async () => {
          return { success: true, content: '{"wrong": "data"}' };
        },
      };
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('always_invalid_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('Validation failed after 3 attempt(s)');
      expect(result.content).toContain('required');
      expect(result.retryAttempts).toBe(2);
    });

    test('no retries when maxRetries=0 (default)', async () => {
      let attemptCount = 0;
      const tool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'no_retry_tool',
            description: 'Tool with no retries configured',
            parameters: { type: 'object', properties: {} },
          },
          maxRetries: 0,
        },
        execute: async () => {
          attemptCount++;
          throw new Error('Failed once');
        },
      };
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('no_retry_tool', {});

      expect(result.success).toBe(false);
      expect(result.content).toContain('after 1 attempt(s)');
      expect(attemptCount).toBe(1);
    });

    test('no retries when maxRetries is undefined (default)', async () => {
      let attemptCount = 0;
      const tool: Tool = {
        definition: {
          type: 'function',
          function: {
            name: 'default_no_retry_tool',
            description: 'Tool with no retries specified',
            parameters: { type: 'object', properties: {} },
          },
          // maxRetries not defined - defaults to 0
        },
        execute: async () => {
          attemptCount++;
          throw new Error('Failed');
        },
      };
      const ctx = createMockContext([tool]);
      const executor = new ToolExecutor(ctx, { botId: 'test-bot', chatId: 123 });

      const result = await executor.execute('default_no_retry_tool', {});

      expect(result.success).toBe(false);
      expect(attemptCount).toBe(1);
    });
  });
});
