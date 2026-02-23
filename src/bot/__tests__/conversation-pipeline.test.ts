/**
 * Integration tests for ConversationPipeline
 * Tests the full flow: message in → response out with mocked LLM
 */
import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import type { Context } from 'grammy';
import { ConversationPipeline } from '../conversation-pipeline';
import type { BotContext } from '../types';
import type { SystemPromptBuilder } from '../system-prompt-builder';
import type { MemoryFlusher } from '../memory-flush';
import type { ToolRegistry } from '../tool-registry';
import type { BotConfig } from '../../config';
import type { LLMClient, ChatMessage } from '../../ollama';
import type { SessionManager } from '../session-manager';
import type { MemoryManager } from '../../memory/memory-manager';
import type { Logger } from '../../logger';
import type { CoreMemoryManager } from '../../memory/core-memory';

describe('ConversationPipeline', () => {
  // Mock factories
  const createMockLogger = (): Logger => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn().mockReturnThis(),
    bindings: () => ({}),
    flush: jest.fn(),
    level: 'info',
  }) as unknown as Logger;

  const createMockContext = (overrides?: Partial<Context>): Context => {
    const chat = { id: 123456, type: 'private' as const };
    const from = { id: 789, first_name: 'TestUser', username: 'testuser' };
    
    return {
      chat,
      from,
      reply: jest.fn().mockResolvedValue(undefined),
      replyWithChatAction: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as Context;
  };

  const createMockBotConfig = (overrides?: Partial<BotConfig>): BotConfig => ({
    id: 'test-bot',
    name: 'TestBot',
    model: 'llama3.1',
    temperature: 0.7,
    maxHistory: 10,
    systemPrompt: { text: 'You are a test bot' },
    ...overrides,
  }) as BotConfig;

  // Test fixtures
  let mockBotContext: BotContext;
  let mockSystemPromptBuilder: SystemPromptBuilder;
  let mockMemoryFlusher: MemoryFlusher;
  let mockToolRegistry: ToolRegistry;
  let mockLLMClient: LLMClient;
  let mockSessionManager: SessionManager;
  let mockMemoryManager: MemoryManager;
  let mockCoreMemoryManager: CoreMemoryManager;
  let mockLogger: Logger;
  let pipeline: ConversationPipeline;

  beforeEach(() => {
    mockLogger = createMockLogger();
    
    mockLLMClient = {
      chat: jest.fn().mockResolvedValue('Mocked LLM response'),
      stream: jest.fn(),
    } as unknown as LLMClient;

    mockSessionManager = {
      isExpired: jest.fn().mockReturnValue(false),
      getFullHistory: jest.fn().mockReturnValue([]),
      clearSession: jest.fn(),
      getHistory: jest.fn().mockReturnValue([]),
      getSessionMeta: jest.fn().mockReturnValue({ messageCount: 5 }),
      appendMessages: jest.fn(),
      markMemoryFlushed: jest.fn(),
      markActive: jest.fn(),
    } as unknown as SessionManager;

    mockMemoryManager = {
      search: jest.fn().mockResolvedValue([]),
    } as unknown as MemoryManager;

    mockCoreMemoryManager = {
      renderForSystemPrompt: jest.fn().mockReturnValue(''),
    } as unknown as CoreMemoryManager;

    mockBotContext = {
      config: {
        soul: {
          enabled: true,
          search: {
            autoRag: {
              enabled: false,
              maxResults: 5,
              minScore: 0.5,
              maxContentChars: 2000,
            },
          },
          memoryFlush: {
            enabled: false,
            messageThreshold: 10,
          },
        },
        session: {
          enabled: true,
          ttlMinutes: 30,
        },
        webTools: {
          maxToolRounds: 3,
        },
        conversation: {
          systemPrompt: 'Test system prompt',
        },
        ollama: {
          models: {
            primary: 'llama3.1',
          },
        },
      },
      sessionManager: mockSessionManager,
      memoryManager: mockMemoryManager,
      coreMemoryManager: mockCoreMemoryManager,
      searchEnabled: true,
      getLLMClient: jest.fn().mockReturnValue(mockLLMClient),
      getActiveModel: jest.fn().mockReturnValue('llama3.1'),
      getBotLogger: jest.fn().mockReturnValue(mockLogger),
    } as unknown as BotContext;

    mockSystemPromptBuilder = {
      build: jest.fn().mockReturnValue('System prompt content'),
    } as unknown as SystemPromptBuilder;

    mockMemoryFlusher = {
      flushSessionToMemory: jest.fn().mockResolvedValue(undefined),
      flushWithScoring: jest.fn().mockResolvedValue(undefined),
    } as unknown as MemoryFlusher;

    mockToolRegistry = {
      getDefinitionsForBot: jest.fn().mockReturnValue([]),
      createExecutor: jest.fn().mockReturnValue({ execute: jest.fn() }),
    } as unknown as ToolRegistry;

    pipeline = new ConversationPipeline(
      mockBotContext,
      mockSystemPromptBuilder,
      mockMemoryFlusher,
      mockToolRegistry
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('basic message flow', () => {
    it('should process message and return LLM response', async () => {
      const ctx = createMockContext();
      const config = createMockBotConfig();
      const userText = 'Hello bot';

      await pipeline.handleConversation(ctx, config, 'user:123', userText);

      // Verify LLM was called with correct messages
      expect(mockLLMClient.chat).toHaveBeenCalledTimes(1);
      const callArgs = (mockLLMClient.chat as jest.Mock).mock.calls[0];
      expect(callArgs[0]).toHaveLength(2); // system + user message
      expect(callArgs[0][0].role).toBe('system');
      expect(callArgs[0][1].role).toBe('user');
      expect(callArgs[0][1].content).toBe(userText);

      // Verify response was sent to user
      expect(ctx.reply).toHaveBeenCalledWith('Mocked LLM response');
    });

    it('should prefix group messages with sender name', async () => {
      const ctx = createMockContext({
        chat: { id: 123456, type: 'supergroup' },
        from: { id: 789, first_name: 'Alice' },
      });
      const config = createMockBotConfig();
      const userText = 'Hello everyone';

      await pipeline.handleConversation(ctx, config, 'group:123', userText);

      // Verify message was prefixed
      const callArgs = (mockLLMClient.chat as jest.Mock).mock.calls[0];
      expect(callArgs[0][1].content).toBe('[Alice]: Hello everyone');
    });

    it('should handle empty LLM response with checkmark', async () => {
      (mockLLMClient.chat as jest.Mock).mockResolvedValue('   ');
      
      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'Test');

      expect(ctx.reply).toHaveBeenCalledWith('✅');
    });

    it('should include images in user message when provided', async () => {
      const ctx = createMockContext();
      const config = createMockBotConfig();
      const images = ['base64image1', 'base64image2'];

      await pipeline.handleConversation(ctx, config, 'user:123', 'Look at this', images);

      const callArgs = (mockLLMClient.chat as jest.Mock).mock.calls[0];
      expect(callArgs[0][1].images).toEqual(images);
    });
  });

  describe('session management', () => {
    it('should flush and clear expired sessions', async () => {
      const expiredHistory = [
        { role: 'user', content: 'Old message' },
        { role: 'assistant', content: 'Old response' },
      ] as ChatMessage[];
      
      (mockSessionManager.isExpired as jest.Mock).mockReturnValue(true);
      (mockSessionManager.getFullHistory as jest.Mock).mockReturnValue(expiredHistory);

      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'New message');

      expect(mockSessionManager.isExpired).toHaveBeenCalledWith('user:123');
      expect(mockMemoryFlusher.flushSessionToMemory).toHaveBeenCalledWith(expiredHistory, 'test-bot');
      expect(mockSessionManager.clearSession).toHaveBeenCalledWith('user:123');
    });

    it('should not flush when session is not expired', async () => {
      (mockSessionManager.isExpired as jest.Mock).mockReturnValue(false);

      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'Message');

      expect(mockMemoryFlusher.flushSessionToMemory).not.toHaveBeenCalled();
      expect(mockSessionManager.clearSession).not.toHaveBeenCalled();
    });

    it('should persist conversation to session after response', async () => {
      const ctx = createMockContext();
      const config = createMockBotConfig({ conversation: { maxHistory: 10 } } as any);

      await pipeline.handleConversation(ctx, config, 'user:123', 'Hello');

      expect(mockSessionManager.appendMessages).toHaveBeenCalledTimes(1);
      const [, messages, maxHistory] = (mockSessionManager.appendMessages as jest.Mock).mock.calls[0];
      
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
      expect(maxHistory).toBe(10);
    });

    it('should mark user active in groups', async () => {
      const ctx = createMockContext({
        chat: { id: 123456, type: 'supergroup' },
        from: { id: 789, first_name: 'Bob' },
      });
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'group:123', 'Hello');

      expect(mockSessionManager.markActive).toHaveBeenCalledWith('test-bot', 123456, 789);
    });
  });

  describe('RAG pre-fetch', () => {
    it('should skip RAG when disabled in config', async () => {
      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'Hello');

      expect(mockMemoryManager.search).not.toHaveBeenCalled();
    });

    it('should skip RAG for short queries', async () => {
      // Enable RAG
      (mockBotContext.config.soul.search.autoRag as any).enabled = true;

      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'Hi'); // < 8 chars

      expect(mockMemoryManager.search).not.toHaveBeenCalled();
    });

    it('should inject RAG context when results found', async () => {
      // Enable RAG
      (mockBotContext.config.soul.search.autoRag as any).enabled = true;
      
      (mockMemoryManager.search as jest.Mock).mockResolvedValue([
        {
          content: 'Relevant memory content',
          filePath: 'memory/2024-01-15.md',
          score: 0.85,
          sourceType: 'rag',
        },
      ]);

      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'Tell me about my preferences');

      expect(mockMemoryManager.search).toHaveBeenCalledWith(
        'Tell me about my preferences',
        5, // maxResults
        0.5 // minScore
      );
      expect(mockSystemPromptBuilder.build).toHaveBeenCalledWith(
        expect.objectContaining({
          ragContext: expect.stringContaining('Relevant Memory Context'),
        })
      );
    });

    it('should filter out recent daily logs from RAG results', async () => {
      // Enable RAG
      (mockBotContext.config.soul.search.autoRag as any).enabled = true;
      
      const today = new Date().toLocaleDateString('sv-SE');
      
      (mockMemoryManager.search as jest.Mock).mockResolvedValue([
        {
          content: 'Today log content',
          filePath: `memory/${today}.md`,
          score: 0.9,
          sourceType: 'rag',
        },
        {
          content: 'Old memory content',
          filePath: 'memory/2024-01-01.md',
          score: 0.8,
          sourceType: 'rag',
        },
      ]);

      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'What do you know');

      // Should only inject the old memory, not today's log
      const buildCall = (mockSystemPromptBuilder.build as jest.Mock).mock.calls[0][0];
      expect(buildCall.ragContext).toContain('Old memory content');
      expect(buildCall.ragContext).not.toContain('Today log content');
    });

    it('should handle RAG errors gracefully', async () => {
      // Enable RAG
      (mockBotContext.config.soul.search.autoRag as any).enabled = true;

      (mockMemoryManager.search as jest.Mock).mockRejectedValue(new Error('Search failed'));

      const ctx = createMockContext();
      const config = createMockBotConfig();

      // Should not throw — RAG error is caught inside prefetchMemoryContext
      await pipeline.handleConversation(ctx, config, 'user:123', 'Tell me everything');

      // Should log warning
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'RAG pre-fetch failed (non-fatal)'
      );
    });
  });

  describe('proactive memory flush', () => {
    it('should trigger proactive flush when threshold reached', async () => {
      // Enable proactive flush
      (mockBotContext.config.soul.memoryFlush as any).enabled = true;
      (mockBotContext.config.soul.memoryFlush as any).messageThreshold = 5;
      
      (mockSessionManager.getSessionMeta as jest.Mock).mockReturnValue({
        messageCount: 10,
        lastFlushCompactionIndex: 0,
        compactionCount: 1,
      });

      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'Hello');

      expect(mockMemoryFlusher.flushWithScoring).toHaveBeenCalled();
      expect(mockSessionManager.markMemoryFlushed).toHaveBeenCalledWith('user:123');
    });

    it('should not flush if already flushed for current compaction', async () => {
      // Enable proactive flush
      (mockBotContext.config.soul.memoryFlush as any).enabled = true;
      (mockBotContext.config.soul.memoryFlush as any).messageThreshold = 5;
      
      (mockSessionManager.getSessionMeta as jest.Mock).mockReturnValue({
        messageCount: 10,
        lastFlushCompactionIndex: 1,
        compactionCount: 1, // Same as lastFlushCompactionIndex
      });

      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'Hello');

      expect(mockMemoryFlusher.flushWithScoring).not.toHaveBeenCalled();
    });

    it('should handle flush errors without failing the conversation', async () => {
      // Enable proactive flush
      (mockBotContext.config.soul.memoryFlush as any).enabled = true;
      (mockBotContext.config.soul.memoryFlush as any).messageThreshold = 5;

      (mockSessionManager.getSessionMeta as jest.Mock).mockReturnValue({
        messageCount: 10,
        lastFlushCompactionIndex: 0,
        compactionCount: 1,
      });

      // Make flush fail but not throw immediately (it's fire-and-forget)
      const flushError = new Error('Flush failed');
      (mockMemoryFlusher.flushWithScoring as jest.Mock).mockRejectedValue(flushError);

      const ctx = createMockContext();
      const config = createMockBotConfig();

      // Should not throw — flush rejection is caught via .catch() callback
      await pipeline.handleConversation(ctx, config, 'user:123', 'Hello');
    });
  });

  describe('error handling', () => {
    it('should handle LLM errors gracefully', async () => {
      (mockLLMClient.chat as jest.Mock).mockRejectedValue(new Error('LLM timeout'));

      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'Hello');

      expect(ctx.reply).toHaveBeenCalledWith('❌ Failed to generate response. Please try again later.');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'Conversation handler failed'
      );
    });

    it('should handle reply errors after successful LLM call', async () => {
      const ctx = createMockContext();
      (ctx.reply as jest.Mock).mockRejectedValue(new Error('Network error'));

      const config = createMockBotConfig();

      // Should not throw — error reply is wrapped in its own try/catch
      await pipeline.handleConversation(ctx, config, 'user:123', 'Hello');
    });

    it('should handle session persistence errors gracefully', async () => {
      (mockSessionManager.appendMessages as jest.Mock).mockImplementation(() => {
        throw new Error('Persistence failed');
      });

      const ctx = createMockContext();
      const config = createMockBotConfig();

      // appendMessages throws → caught by outer catch → error reply sent
      await pipeline.handleConversation(ctx, config, 'user:123', 'Hello');

      expect(ctx.reply).toHaveBeenCalledWith('❌ Failed to generate response. Please try again later.');
    });
  });

  describe('tools integration', () => {
    it('should pass tools to LLM when bot has tools', async () => {
      const toolDefs = [
        { name: 'web_search', description: 'Search the web' },
      ];
      
      (mockToolRegistry.getDefinitionsForBot as jest.Mock).mockReturnValue(toolDefs as any);

      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'Search for something');

      const callArgs = (mockLLMClient.chat as jest.Mock).mock.calls[0];
      expect(callArgs[1].tools).toEqual(toolDefs);
      expect(callArgs[1].toolExecutor).toBeDefined();
      expect(callArgs[1].maxToolRounds).toBe(3);
    });

    it('should not pass tools when bot has no tools', async () => {
      (mockToolRegistry.getDefinitionsForBot as jest.Mock).mockReturnValue([]);

      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'Hello');

      const callArgs = (mockLLMClient.chat as jest.Mock).mock.calls[0];
      expect(callArgs[1].tools).toBeUndefined();
      expect(callArgs[1].toolExecutor).toBeUndefined();
    });
  });

  describe('session disabled', () => {
    it('should not use session when disabled', async () => {
      (mockBotContext.config.session as any).enabled = false;

      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'Hello');

      expect(mockSessionManager.getHistory).not.toHaveBeenCalled();
      expect(mockSessionManager.appendMessages).not.toHaveBeenCalled();
    });

    it('should not check expiry when session disabled', async () => {
      (mockBotContext.config.session as any).enabled = false;

      const ctx = createMockContext();
      const config = createMockBotConfig();

      await pipeline.handleConversation(ctx, config, 'user:123', 'Hello');

      expect(mockSessionManager.isExpired).not.toHaveBeenCalled();
    });
  });

  describe('prefetchMemoryContext standalone', () => {
    it('should return null when RAG is disabled', async () => {
      const result = await pipeline.prefetchMemoryContext('Hello', false, mockLogger);
      expect(result).toBeNull();
    });

    it('should return null for short queries', async () => {
      (mockBotContext.config.soul.search.autoRag as any).enabled = true;
      
      const result = await pipeline.prefetchMemoryContext('Hi', false, mockLogger);
      expect(result).toBeNull();
    });

    it('should return formatted context when results found', async () => {
      (mockBotContext.config.soul.search.autoRag as any).enabled = true;
      
      (mockMemoryManager.search as jest.Mock).mockResolvedValue([
        {
          content: 'Memory about user preferences',
          filePath: 'memory/preferences.md',
          score: 0.9,
          sourceType: 'rag',
        },
      ]);

      const result = await pipeline.prefetchMemoryContext(
        'What are my preferences',
        false,
        mockLogger
      );

      expect(result).toContain('Relevant Memory Context');
      expect(result).toContain('Memory about user preferences');
      expect(result).toContain('preferences.md');
      expect(result).toContain('score: 0.90');
    });

    it('should strip name prefix from group messages', async () => {
      (mockBotContext.config.soul.search.autoRag as any).enabled = true;
      
      (mockMemoryManager.search as jest.Mock).mockResolvedValue([]);

      await pipeline.prefetchMemoryContext('[Alice]: Hello everyone', true, mockLogger);

      // Should search with stripped query
      expect(mockMemoryManager.search).toHaveBeenCalledWith(
        'Hello everyone',
        expect.any(Number),
        expect.any(Number)
      );
    });
  });
});
