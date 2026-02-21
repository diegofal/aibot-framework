import { describe, test, expect, mock } from 'bun:test';
import { LLMClientWithFallback } from '../src/core/llm-client';
import type { LLMClient, LLMGenerateOptions, LLMChatOptions } from '../src/core/llm-client';
import type { ChatMessage } from '../src/ollama';

function mockLogger() {
  return { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) } as any;
}

function mockClient(backend: 'ollama' | 'claude-cli', response = 'ok'): LLMClient & { generate: ReturnType<typeof mock>; chat: ReturnType<typeof mock> } {
  return {
    backend,
    generate: mock(() => Promise.resolve(response)),
    chat: mock(() => Promise.resolve(response)),
  };
}

const dummyMessages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

const toolOpts: LLMChatOptions = {
  tools: [{ type: 'function', function: { name: 'test_tool', description: 'a tool', parameters: {} } }],
  toolExecutor: mock(() => Promise.resolve('result')),
};

describe('LLMClientWithFallback', () => {
  describe('tool-based chat bypass', () => {
    test('bypasses claude-cli primary when tools are present', async () => {
      const primary = mockClient('claude-cli', 'primary-response');
      const fallback = mockClient('ollama', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.chat(dummyMessages, toolOpts);

      expect(result).toBe('fallback-response');
      expect(primary.chat).not.toHaveBeenCalled();
      expect(fallback.chat).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledTimes(1);
    });

    test('does not bypass when no tools are provided', async () => {
      const primary = mockClient('claude-cli', 'primary-response');
      const fallback = mockClient('ollama', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.chat(dummyMessages);

      expect(result).toBe('primary-response');
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(fallback.chat).not.toHaveBeenCalled();
    });

    test('does not bypass when tools array is empty', async () => {
      const primary = mockClient('claude-cli', 'primary-response');
      const fallback = mockClient('ollama', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.chat(dummyMessages, { tools: [], toolExecutor: toolOpts.toolExecutor });

      expect(result).toBe('primary-response');
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(fallback.chat).not.toHaveBeenCalled();
    });

    test('does not bypass when primary is not claude-cli', async () => {
      const primary = mockClient('ollama', 'primary-response');
      const fallback = mockClient('claude-cli', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.chat(dummyMessages, toolOpts);

      expect(result).toBe('primary-response');
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(fallback.chat).not.toHaveBeenCalled();
    });

    test('does not bypass when toolExecutor is missing', async () => {
      const primary = mockClient('claude-cli', 'primary-response');
      const fallback = mockClient('ollama', 'fallback-response');
      const logger = mockLogger();
      const client = new LLMClientWithFallback(primary, fallback, logger);

      const result = await client.chat(dummyMessages, { tools: toolOpts.tools });

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
});
