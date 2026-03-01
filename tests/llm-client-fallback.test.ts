import { describe, expect, mock, test } from 'bun:test';
import { LLMClientWithFallback } from '../src/core/llm-client';
import type { LLMChatOptions, LLMClient, LLMGenerateOptions } from '../src/core/llm-client';
import type { ChatMessage } from '../src/ollama';

function mockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  } as any;
}

function mockClient(
  backend: 'ollama' | 'claude-cli',
  response = 'ok'
): LLMClient & { generate: ReturnType<typeof mock>; chat: ReturnType<typeof mock> } {
  return {
    backend,
    generate: mock(() => Promise.resolve(response)),
    chat: mock(() => Promise.resolve(response)),
  };
}

const dummyMessages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

const toolOpts: LLMChatOptions = {
  tools: [
    {
      type: 'function',
      function: {
        name: 'test_tool',
        description: 'a tool',
        parameters: { type: 'object', properties: {} },
      },
    },
  ],
  toolExecutor: mock(() => Promise.resolve({ success: true, content: 'result' })),
};

describe('LLMClientWithFallback', () => {
  describe('tool-based chat — no bypass (MCP bridge)', () => {
    test('routes tool chat to primary (claude-cli) — no longer bypassed', async () => {
      const primary = mockClient('claude-cli', 'primary-response');
      const fallback = mockClient('ollama', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.chat(dummyMessages, toolOpts);

      expect(result).toBe('primary-response');
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(fallback.chat).not.toHaveBeenCalled();
    });

    test('falls back to ollama when claude-cli tool chat fails', async () => {
      const primary = mockClient('claude-cli');
      primary.chat = mock(() => Promise.reject(new Error('MCP bridge timeout')));
      const fallback = mockClient('ollama', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.chat(dummyMessages, toolOpts);

      expect(result).toBe('fallback-response');
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(fallback.chat).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    test('routes chat without tools to primary normally', async () => {
      const primary = mockClient('claude-cli', 'primary-response');
      const fallback = mockClient('ollama', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.chat(dummyMessages);

      expect(result).toBe('primary-response');
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(fallback.chat).not.toHaveBeenCalled();
    });

    test('routes tool chat with empty tools array to primary', async () => {
      const primary = mockClient('claude-cli', 'primary-response');
      const fallback = mockClient('ollama', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.chat(dummyMessages, {
        tools: [],
        toolExecutor: toolOpts.toolExecutor,
      });

      expect(result).toBe('primary-response');
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(fallback.chat).not.toHaveBeenCalled();
    });

    test('ollama primary with tools works normally', async () => {
      const primary = mockClient('ollama', 'primary-response');
      const fallback = mockClient('claude-cli', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.chat(dummyMessages, toolOpts);

      expect(result).toBe('primary-response');
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(fallback.chat).not.toHaveBeenCalled();
    });
  });

  describe('generate', () => {
    test('uses primary for generate even with claude-cli backend', async () => {
      const primary = mockClient('claude-cli', 'primary-response');
      const fallback = mockClient('ollama', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.generate('test prompt');

      expect(result).toBe('primary-response');
      expect(primary.generate).toHaveBeenCalledTimes(1);
      expect(fallback.generate).not.toHaveBeenCalled();
    });

    test('falls back on generate error', async () => {
      const primary = mockClient('claude-cli');
      primary.generate = mock(() => Promise.reject(new Error('timeout')));
      const fallback = mockClient('ollama', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.generate('test prompt');

      expect(result).toBe('fallback-response');
      expect(primary.generate).toHaveBeenCalledTimes(1);
      expect(fallback.generate).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('chat fallback on error', () => {
    test('falls back when primary chat throws', async () => {
      const primary = mockClient('ollama');
      primary.chat = mock(() => Promise.reject(new Error('connection refused')));
      const fallback = mockClient('claude-cli', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.chat(dummyMessages);

      expect(result).toBe('fallback-response');
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(fallback.chat).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('onFallback callback', () => {
    test('fires on generate fallback', async () => {
      const primary = mockClient('claude-cli');
      primary.generate = mock(() => Promise.reject(new Error('timeout')));
      const fallback = mockClient('ollama', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const cb = mock(() => {});
      client.onFallback = cb;

      await client.generate('test');

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({
        primaryBackend: 'claude-cli',
        fallbackBackend: 'ollama',
        error: 'timeout',
        method: 'generate',
      });
    });

    test('fires on chat fallback', async () => {
      const primary = mockClient('claude-cli');
      primary.chat = mock(() => Promise.reject(new Error('connection refused')));
      const fallback = mockClient('ollama', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const cb = mock(() => {});
      client.onFallback = cb;

      await client.chat(dummyMessages);

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({
        primaryBackend: 'claude-cli',
        fallbackBackend: 'ollama',
        error: 'connection refused',
        method: 'chat',
      });
    });

    test('does not fire when primary succeeds', async () => {
      const primary = mockClient('claude-cli', 'ok');
      const fallback = mockClient('ollama', 'fallback');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const cb = mock(() => {});
      client.onFallback = cb;

      await client.generate('test');
      await client.chat(dummyMessages);

      expect(cb).not.toHaveBeenCalled();
    });
  });
});
