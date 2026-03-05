import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPACTION_SUMMARY_PREFIX,
  ContextCompactor,
  estimateMessagesTokens,
  estimateTokens,
  isCompactionSummary,
  resolveContextWindow,
  truncateOversizedMessages,
} from '../../src/bot/context-compaction';
import { MemoryFlusher } from '../../src/bot/memory-flush';
import type { BotContext } from '../../src/bot/types';
import type { CompactionConfig } from '../../src/config';
import type { LLMClient } from '../../src/core/llm-client';
import type { Logger } from '../../src/logger';
import type { ChatMessage } from '../../src/ollama';
import type { SessionManager } from '../../src/session';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

// --- Pure function tests ---

describe('estimateTokens', () => {
  test('empty string returns 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('short text', () => {
    expect(estimateTokens('hello')).toBe(2); // ceil(5/4) = 2
  });

  test('long text', () => {
    const text = 'a'.repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });

  test('unicode text', () => {
    const text = '你好世界'; // 4 chars × 3 bytes but .length = 4
    expect(estimateTokens(text)).toBe(1); // ceil(4/4) = 1
  });

  test('emoji text', () => {
    const text = '👋🌍'; // .length = 4 (surrogate pairs)
    expect(estimateTokens(text)).toBe(1);
  });
});

describe('estimateMessagesTokens', () => {
  test('empty array returns 0', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  test('single message includes overhead', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    // ceil(5/4) = 2, + 4 overhead = 6
    expect(estimateMessagesTokens(messages)).toBe(6);
  });

  test('multiple messages accumulate correctly', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'a'.repeat(100) }, // 25 + 4 = 29
      { role: 'user', content: 'b'.repeat(200) }, // 50 + 4 = 54
      { role: 'assistant', content: 'c'.repeat(400) }, // 100 + 4 = 104
    ];
    expect(estimateMessagesTokens(messages)).toBe(187);
  });
});

describe('resolveContextWindow', () => {
  const config: CompactionConfig = {
    enabled: true,
    contextWindows: { ollamaTokens: 8192, claudeCliTokens: 180_000 },
    thresholdRatio: 0.75,
    keepRecentMessages: 6,
    maxMessageChars: 15_000,
    maxOverflowRetries: 2,
  };

  test('ollama backend returns ollamaTokens', () => {
    expect(resolveContextWindow('ollama', config)).toBe(8192);
  });

  test('claude-cli backend returns claudeCliTokens', () => {
    expect(resolveContextWindow('claude-cli', config)).toBe(180_000);
  });

  test('custom values', () => {
    const custom = { ...config, contextWindows: { ollamaTokens: 4096, claudeCliTokens: 100_000 } };
    expect(resolveContextWindow('ollama', custom)).toBe(4096);
    expect(resolveContextWindow('claude-cli', custom)).toBe(100_000);
  });
});

describe('isCompactionSummary', () => {
  test('positive: system role with prefix', () => {
    expect(
      isCompactionSummary({ role: 'system', content: '[CONTEXT_SUMMARY] Some summary here' })
    ).toBe(true);
  });

  test('negative: wrong role', () => {
    expect(
      isCompactionSummary({ role: 'user', content: '[CONTEXT_SUMMARY] Some summary here' })
    ).toBe(false);
  });

  test('negative: no prefix', () => {
    expect(isCompactionSummary({ role: 'system', content: 'Regular system prompt' })).toBe(false);
  });

  test('negative: prefix in middle of content', () => {
    expect(
      isCompactionSummary({
        role: 'system',
        content: 'Something [CONTEXT_SUMMARY] in middle',
      })
    ).toBe(false);
  });
});

describe('truncateOversizedMessages', () => {
  test('passthrough short messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'also short' },
    ];
    const result = truncateOversizedMessages(messages, 1000);
    expect(result.messages).toEqual(messages);
    expect(result.truncatedCount).toBe(0);
  });

  test('truncates long messages', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'a'.repeat(200) }];
    const result = truncateOversizedMessages(messages, 50);
    expect(result.truncatedCount).toBe(1);
    expect(result.messages[0].content.length).toBeLessThan(200);
    expect(result.messages[0].content).toContain('[...truncated]');
  });

  test('counts correctly with mixed lengths', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'x'.repeat(500) },
      { role: 'user', content: 'also short' },
      { role: 'assistant', content: 'y'.repeat(500) },
    ];
    const result = truncateOversizedMessages(messages, 100);
    expect(result.truncatedCount).toBe(2);
    expect(result.messages[0].content).toBe('short');
    expect(result.messages[2].content).toBe('also short');
  });

  test('breaks at newline when possible', () => {
    const content = `${'a'.repeat(40)}\n${'b'.repeat(40)}\n${'c'.repeat(40)}`;
    const messages: ChatMessage[] = [{ role: 'user', content }];
    const result = truncateOversizedMessages(messages, 60);
    expect(result.truncatedCount).toBe(1);
    // Should break at the first newline (position 40) since it's > 50% of maxChars (30)
    expect(result.messages[0].content).toContain('[...truncated]');
  });
});

// --- ContextCompactor tests ---

describe('ContextCompactor', () => {
  const defaultConfig: CompactionConfig = {
    enabled: true,
    contextWindows: { ollamaTokens: 200, claudeCliTokens: 180_000 },
    thresholdRatio: 0.75,
    keepRecentMessages: 2,
    maxMessageChars: 15_000,
    maxOverflowRetries: 2,
  };

  function makeMessages(count: number, contentSize = 100): ChatMessage[] {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'System prompt here' }];
    for (let i = 0; i < count; i++) {
      msgs.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}: ${'x'.repeat(contentSize)}`,
      });
    }
    msgs.push({ role: 'user', content: 'Latest user message' });
    return msgs;
  }

  let mockLLMClient: LLMClient;
  let mockSessionManager: SessionManager;
  let mockCtx: BotContext;
  let flusher: MemoryFlusher;
  let compactor: ContextCompactor;

  beforeEach(() => {
    mockLLMClient = {
      backend: 'ollama' as const,
      generate: mock(() => Promise.resolve('')),
      chat: mock(() => Promise.resolve('Summary of the conversation with key facts.')),
    };

    mockSessionManager = {
      rewriteWithSummary: mock(() => {}),
    } as unknown as SessionManager;

    mockCtx = {
      config: {
        ollama: { models: { primary: 'test-model' } },
        improve: undefined,
        conversation: { compaction: defaultConfig },
      },
      logger: noopLogger,
      ollamaClient: {} as any,
      sessionManager: mockSessionManager,
      getLLMClient: () => mockLLMClient,
      getActiveModel: () => 'test-model',
      getBotLogger: () => noopLogger,
      getSoulLoader: () => ({ appendDailyMemory: () => {} }) as any,
      activityStream: { publish: mock(() => {}) },
      memoryManager: undefined,
    } as unknown as BotContext;

    flusher = new MemoryFlusher(mockCtx);
    compactor = new ContextCompactor(mockCtx, flusher);
  });

  test('disabled config returns no-op', async () => {
    const messages = makeMessages(20);
    const result = await compactor.maybeCompact(messages, 'test-key', 'bot1', {
      ...defaultConfig,
      enabled: false,
    });
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  test('below threshold returns no-op', async () => {
    // Small messages, big context window
    const messages: ChatMessage[] = [
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'hi' },
    ];
    const bigWindowConfig = {
      ...defaultConfig,
      contextWindows: { ollamaTokens: 100_000, claudeCliTokens: 180_000 },
    };
    const result = await compactor.maybeCompact(messages, 'test-key', 'bot1', bigWindowConfig);
    expect(result.compacted).toBe(false);
  });

  test('above threshold compacts and returns fewer messages with summary', async () => {
    // 10 messages × ~104 chars each = ~260 tokens + overhead > 200 * 0.75 threshold
    const messages = makeMessages(10, 100);
    const result = await compactor.maybeCompact(messages, 'test-key', 'bot1', defaultConfig);

    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.summaryTokens).toBeGreaterThan(0);

    // Should have: system + summary + keepRecentMessages(2) + userMsg
    expect(result.messages.length).toBeLessThan(messages.length);

    // First message should be system prompt
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toBe('System prompt here');

    // Second should be the summary
    expect(result.messages[1].content).toContain(COMPACTION_SUMMARY_PREFIX);

    // Last should be the user message
    expect(result.messages[result.messages.length - 1].content).toBe('Latest user message');
  });

  test('keeps system prompt and recent messages intact', async () => {
    const messages = makeMessages(10, 100);
    const result = await compactor.maybeCompact(messages, 'test-key', 'bot1', defaultConfig);

    if (result.compacted) {
      // System prompt preserved
      expect(result.messages[0].content).toBe('System prompt here');

      // User message preserved
      expect(result.messages[result.messages.length - 1].role).toBe('user');
    }
  });

  test('LLM failure falls back to mechanical summary', async () => {
    // Make LLM fail
    (mockLLMClient.chat as any) = mock(() => Promise.reject(new Error('LLM failed')));

    const messages = makeMessages(10, 100);
    const result = await compactor.maybeCompact(messages, 'test-key', 'bot1', defaultConfig);

    expect(result.compacted).toBe(true);
    // Mechanical summary should contain "Previous conversation"
    const summaryMsg = result.messages.find((m) => m.content.startsWith(COMPACTION_SUMMARY_PREFIX));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg?.content).toContain('Previous conversation');
  });

  test('existing summary in history is replaced', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      {
        role: 'system',
        content: '[CONTEXT_SUMMARY] Old summary from previous compaction',
      },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as ChatMessage['role'],
        content: `Msg ${i}: ${'z'.repeat(100)}`,
      })),
      { role: 'user', content: 'Latest question' },
    ];

    const result = await compactor.maybeCompact(messages, 'test-key', 'bot1', defaultConfig);

    if (result.compacted) {
      // Should have exactly one summary (the new one), not two
      const summaries = result.messages.filter((m) =>
        m.content.startsWith(COMPACTION_SUMMARY_PREFIX)
      );
      expect(summaries.length).toBe(1);
      // The old summary should not be present
      expect(summaries[0].content).not.toContain('Old summary');
    }
  });

  test('too few older messages skips compaction', async () => {
    // Only 1 message to compact — not enough
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'x'.repeat(500) },
      { role: 'assistant', content: 'y'.repeat(500) },
      { role: 'user', content: 'Latest' },
    ];
    // With keepRecentMessages=2, there's only 1 older message (not enough)
    const result = await compactor.maybeCompact(messages, 'test-key', 'bot1', {
      ...defaultConfig,
      contextWindows: { ollamaTokens: 50, claudeCliTokens: 50 },
    });
    expect(result.compacted).toBe(false);
  });

  test('persists summary via sessionManager.rewriteWithSummary', async () => {
    const messages = makeMessages(10, 100);
    await compactor.maybeCompact(messages, 'test-key', 'bot1', defaultConfig);

    expect(mockSessionManager.rewriteWithSummary).toHaveBeenCalled();
    const calls = (mockSessionManager.rewriteWithSummary as any).mock.calls;
    expect(calls[0][0]).toBe('test-key');
    // Summary message
    expect(calls[0][1].content).toContain(COMPACTION_SUMMARY_PREFIX);
  });
});
