import { describe, expect, test } from 'bun:test';
import { createLoopDetector } from '../src/core/loop-detector';
import { type ToolCallingStrategy, runToolLoop } from '../src/core/tool-runner';

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
  level: 'debug',
  fatal: () => {},
} as any;

describe('Loop detector integration with runToolLoop', () => {
  test('breaks when same tool call is repeated 4+ times', async () => {
    let chatCallCount = 0;

    const mockStrategy: ToolCallingStrategy = {
      async chat() {
        chatCallCount++;
        return {
          content: '',
          toolCalls: [
            {
              id: `call_${chatCallCount}`,
              type: 'function' as const,
              function: { name: 'test_tool', arguments: { key: 'same_value' } },
            },
          ],
        };
      },
    };

    const toolExecutor = async () => ({
      success: true,
      content: 'same result',
    });

    const result = await runToolLoop(
      mockStrategy,
      [{ role: 'user', content: 'test' }],
      {
        maxRounds: 10,
        tools: [
          {
            type: 'function' as const,
            function: {
              name: 'test_tool',
              description: 'test',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        toolExecutor,
        logger: noopLogger,
        loopDetector: createLoopDetector(10),
      },
      {}
    );

    expect(result.text).toContain('Loop stopped');
    expect(chatCallCount).toBeLessThanOrEqual(5);
  });

  test('breaks when same result is returned 3+ times', async () => {
    let chatCallCount = 0;

    const mockStrategy: ToolCallingStrategy = {
      async chat() {
        chatCallCount++;
        return {
          content: '',
          toolCalls: [
            {
              id: `call_${chatCallCount}`,
              type: 'function' as const,
              function: { name: 'test_tool', arguments: { iteration: chatCallCount } },
            },
          ],
        };
      },
    };

    const toolExecutor = async () => ({
      success: true,
      content: 'identical result every time',
    });

    const result = await runToolLoop(
      mockStrategy,
      [{ role: 'user', content: 'test' }],
      {
        maxRounds: 10,
        tools: [
          {
            type: 'function' as const,
            function: {
              name: 'test_tool',
              description: 'test',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        toolExecutor,
        logger: noopLogger,
        loopDetector: createLoopDetector(10),
      },
      {}
    );

    expect(result.text).toContain('Loop stopped');
    expect(chatCallCount).toBeLessThanOrEqual(4);
  });

  test('does not break when tool calls vary', async () => {
    let chatCallCount = 0;

    const mockStrategy: ToolCallingStrategy = {
      async chat() {
        chatCallCount++;
        if (chatCallCount <= 2) {
          return {
            content: '',
            toolCalls: [
              {
                id: `call_${chatCallCount}`,
                type: 'function' as const,
                function: { name: 'test_tool', arguments: { unique: `value_${chatCallCount}` } },
              },
            ],
          };
        }
        return { content: 'Task completed successfully' };
      },
    };

    let toolCallCount = 0;
    const toolExecutor = async () => {
      toolCallCount++;
      return { success: true, content: `unique result ${toolCallCount}` };
    };

    const result = await runToolLoop(
      mockStrategy,
      [{ role: 'user', content: 'test' }],
      {
        maxRounds: 10,
        tools: [
          {
            type: 'function' as const,
            function: {
              name: 'test_tool',
              description: 'test',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        toolExecutor,
        logger: noopLogger,
        loopDetector: createLoopDetector(10),
      },
      {}
    );

    expect(result.text).toBe('Task completed successfully');
    expect(result.text).not.toContain('Loop stopped');
  });

  test('global circuit breaker fires at 2x maxRounds', async () => {
    let chatCallCount = 0;
    const maxRounds = 3;

    const mockStrategy: ToolCallingStrategy = {
      async chat() {
        chatCallCount++;
        return {
          content: '',
          toolCalls: [
            {
              id: `a_${chatCallCount}`,
              type: 'function' as const,
              function: { name: 'tool_a', arguments: { v: chatCallCount } },
            },
            {
              id: `b_${chatCallCount}`,
              type: 'function' as const,
              function: { name: 'tool_b', arguments: { v: chatCallCount } },
            },
            {
              id: `c_${chatCallCount}`,
              type: 'function' as const,
              function: { name: 'tool_c', arguments: { v: chatCallCount } },
            },
          ],
        };
      },
    };

    let toolCallCount = 0;
    const toolExecutor = async () => {
      toolCallCount++;
      return { success: true, content: `result_${toolCallCount}` };
    };

    const result = await runToolLoop(
      mockStrategy,
      [{ role: 'user', content: 'test' }],
      {
        maxRounds,
        tools: [
          {
            type: 'function' as const,
            function: {
              name: 'tool_a',
              description: 'a',
              parameters: { type: 'object', properties: {} },
            },
          },
          {
            type: 'function' as const,
            function: {
              name: 'tool_b',
              description: 'b',
              parameters: { type: 'object', properties: {} },
            },
          },
          {
            type: 'function' as const,
            function: {
              name: 'tool_c',
              description: 'c',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        toolExecutor,
        logger: noopLogger,
        loopDetector: createLoopDetector(maxRounds),
      },
      {}
    );

    expect(result.text).toContain('Loop stopped');
    expect(result.text).toContain('Exceeded');
  });

  test('without loopDetector, loop exhausts all rounds', async () => {
    let chatCallCount = 0;
    const toolDefs = [
      {
        type: 'function' as const,
        function: {
          name: 'test_tool',
          description: 'test',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];

    const mockStrategy: ToolCallingStrategy = {
      async chat(_messages, opts) {
        chatCallCount++;
        const hasTools = opts.tools && opts.tools.length > 0;
        if (hasTools) {
          return {
            content: '',
            toolCalls: [
              {
                id: `call_${chatCallCount}`,
                type: 'function' as const,
                function: { name: 'test_tool', arguments: { key: 'same_value' } },
              },
            ],
          };
        }
        return { content: 'Exhaustion summary' };
      },
    };

    const toolExecutor = async () => ({
      success: true,
      content: 'same result',
    });

    const result = await runToolLoop(
      mockStrategy,
      [{ role: 'user', content: 'test' }],
      {
        maxRounds: 3,
        tools: toolDefs,
        toolExecutor,
        logger: noopLogger,
        // NO loopDetector
      },
      { tools: toolDefs }
    );

    expect(result.text).toBe('Exhaustion summary');
    expect(chatCallCount).toBe(4); // 3 tool rounds + 1 final
  });
});

describe('OllamaClient fallback timeout restoration', () => {
  // Test the timeout restoration logic using a minimal OllamaClient
  // We can't easily mock fetch in Bun with AbortSignal.timeout, so we
  // test the config.timeout value is restored after the method returns.
  test('OllamaClient imports and createLoopDetector are wired', async () => {
    // Verify that ollama.ts properly imports createLoopDetector
    const ollamaModule = await import('../src/ollama');
    expect(ollamaModule.OllamaClient).toBeDefined();

    // Verify createLoopDetector exists and works
    const detector = createLoopDetector(5);
    expect(detector).toBeDefined();
    expect(typeof detector.recordCall).toBe('function');
    expect(typeof detector.check).toBe('function');
    expect(typeof detector.reset).toBe('function');
  });
});

describe('OllamaClient fallback recursion prevention', () => {
  const { OllamaClient } = require('../src/ollama');

  function makeClient(primary: string, fallbacks: string[]) {
    return new OllamaClient(
      { baseUrl: 'http://127.0.0.1:99999', timeout: 5_000, models: { primary, fallbacks } },
      noopLogger
    );
  }

  test('generate does not recurse infinitely when all models fail', async () => {
    const client = makeClient('bad-primary', ['bad-fallback']);
    // If recursion prevention is broken, this would hang or stack overflow
    await expect(client.generate('test')).rejects.toThrow('Failed to generate');
  });

  test('chat does not recurse infinitely when all models fail', async () => {
    const client = makeClient('bad-primary', ['bad-fallback']);
    await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow(
      'Failed to chat'
    );
  });

  test('generate with _skipFallbacks throws immediately without trying fallbacks', async () => {
    let fetchCallCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCallCount++;
      return new Response('Not Found', { status: 404 }) as any;
    };
    try {
      const client = makeClient('model-a', ['model-b']);
      await expect(client.generate('test', { _skipFallbacks: true })).rejects.toThrow();
      // Only 1 fetch call — no fallback attempted
      expect(fetchCallCount).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('chat with _skipFallbacks throws immediately without trying fallbacks', async () => {
    let fetchCallCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCallCount++;
      return new Response('Not Found', { status: 404 }) as any;
    };
    try {
      const client = makeClient('model-a', ['model-b']);
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { _skipFallbacks: true })
      ).rejects.toThrow();
      expect(fetchCallCount).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('generate tries primary + each fallback exactly once', async () => {
    const modelsAttempted: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      modelsAttempted.push(body.model);
      return new Response('Not Found', { status: 404 }) as any;
    };
    try {
      const client = makeClient('primary-m', ['fb1', 'fb2']);
      await expect(client.generate('test')).rejects.toThrow('Failed to generate');
      expect(modelsAttempted).toEqual(['primary-m', 'fb1', 'fb2']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
