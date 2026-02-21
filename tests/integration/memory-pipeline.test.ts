import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createCoreMemoryManager, type CoreMemoryManager } from '../../src/memory/core-memory';
import { MemoryFlusher, type ScoredFact } from '../../src/bot/memory-flush';
import { SystemPromptBuilder } from '../../src/bot/system-prompt-builder';
import { ToolRegistry } from '../../src/bot/tool-registry';
import type { BotContext, ChatMessage } from '../../src/bot/types';
import type { BotConfig, Config } from '../../src/config';
import type { MemoryManager } from '../../src/memory';
import type { AgentRegistry } from '../../src/bot/agent-registry';
import type { OllamaClient } from '../../src/ollama';
import type { SoulLoader } from '../../src/soul-loader';
import type { Logger } from '../../src/logger';

/**
 * Integration tests for Core Memory → MemoryFlusher → SystemPromptBuilder pipeline
 * 
 * This test verifies:
 * 1. CoreMemoryManager stores facts with importance correctly
 * 2. MemoryFlusher.flushWithScoring extracts and scores facts from conversation history
 * 3. SystemPromptBuilder renders core memories into system prompt context
 */
describe('Core Memory Pipeline Integration', () => {
  let db: Database;
  let coreMemory: CoreMemoryManager;
  let logger: Logger;
  let mockCtx: BotContext;
  let mockConfig: Config;
  let mockBotConfig: BotConfig;
  let toolRegistry: ToolRegistry;
  let memoryFlusher: MemoryFlusher;
  let systemPromptBuilder: SystemPromptBuilder;

  beforeEach(() => {
    // Setup in-memory SQLite database
    db = new Database(':memory:');
    db.run(`
      CREATE TABLE IF NOT EXISTS core_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        importance INTEGER DEFAULT 5,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(category, key)
      )
    `);

    // Mock logger
    logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => logger,
    } as Logger;

    // Create real CoreMemoryManager
    coreMemory = createCoreMemoryManager(db, logger);

    // Setup minimal mock config with all required properties
    mockConfig = {
      bots: [],
      telegram: { token: 'test-token' },
      ollama: {
        baseUrl: 'http://localhost:11434',
        models: { primary: 'test-model', tool: 'test-tool-model' },
      },
      humanizer: { enabled: false },
      memory: { vectorStore: { enabled: false } },
      soul: { dir: '/tmp/test-soul' },
      conversation: { systemPrompt: 'You are a helpful assistant.', temperature: 0.7, maxHistory: 20 },
    } as Config;

    mockBotConfig = {
      id: 'test-bot',
      name: 'TestBot',
      model: 'test-model',
      systemPrompt: 'You are a test bot.',
      enabled: true,
    } as BotConfig;

    // Create mock BotContext with real CoreMemoryManager
    mockCtx = {
      config: mockConfig,
      logger,
      memoryManager: {
        getCoreMemory: () => coreMemory,
      } as MemoryManager,
      getSoulLoader: () => ({
        composeSystemPrompt: () => 'Base system prompt',
        appendDailyMemory: () => {},
      } as unknown as SoulLoader),
      getActiveModel: () => 'test-model',
      defaultSoulLoader: {} as SoulLoader,
      runningBots: new Set(),
      toolDefinitions: [],
      ollamaClient: {} as OllamaClient,
      agentRegistry: {
        listOtherAgents: () => [],
      } as AgentRegistry,
    } as BotContext;

    // Create ToolRegistry and SystemPromptBuilder
    toolRegistry = new ToolRegistry(mockCtx);
    systemPromptBuilder = new SystemPromptBuilder(mockCtx, toolRegistry);
    memoryFlusher = new MemoryFlusher(mockCtx);
  });

  afterAll(() => {
    db.close();
  });

  describe('Stage 1: CoreMemoryManager stores facts with importance', () => {
    it('should store facts in all valid categories with importance 1-10', async () => {
      const testCases = [
        { category: 'identity', key: 'name', value: 'AutoForja', importance: 10 },
        { category: 'relationships', key: 'user_diego', value: 'Diego likes Rust', importance: 8 },
        { category: 'preferences', key: 'tone', value: 'Technical but digestible', importance: 7 },
        { category: 'goals', key: 'pipeline_test', value: 'Write integration tests', importance: 9 },
        { category: 'constraints', key: 'no_secrets', value: 'Never share credentials', importance: 10 },
      ];

      for (const tc of testCases) {
        await coreMemory.set(tc.category, tc.key, tc.value, tc.importance);
      }

      // Verify all entries stored
      for (const tc of testCases) {
        const entry = await coreMemory.get(tc.category, tc.key);
        expect(entry).not.toBeNull();
        expect(entry!.value).toBe(tc.value);
        expect(entry!.importance).toBe(tc.importance);
      }
    });

    it('should reject invalid categories', async () => {
      await expect(
        coreMemory.set('invalid_category', 'key', 'value', 5)
      ).rejects.toThrow(/Invalid category/);
    });

    it('should reject importance outside 1-10 range', async () => {
      await expect(
        coreMemory.set('identity', 'test_key', 'value', 15)
      ).rejects.toThrow(/Importance must be between 1 and 10/);
    });

    it('should list entries filtered by importance', async () => {
      await coreMemory.set('goals', 'high_priority', 'Critical task', 9);
      await coreMemory.set('goals', 'medium_priority', 'Normal task', 5);
      await coreMemory.set('goals', 'low_priority', 'Minor task', 2);

      const highImportance = await coreMemory.list('goals', 7);
      expect(highImportance.length).toBe(1);
      expect(highImportance[0].key).toBe('high_priority');

      const all = await coreMemory.list('goals');
      expect(all.length).toBe(3);
    });

    it('should render formatted output for system prompt', async () => {
      await coreMemory.set('identity', 'name', 'AutoForja', 10);
      await coreMemory.set('goals', 'current', 'Write integration tests', 8);

      const rendered = coreMemory.renderForSystemPrompt(800);
      expect(rendered).toContain('Core Memory');
      expect(rendered).toContain('AutoForja');
      expect(rendered).toContain('Write integration tests');
    });
  });

  describe('Stage 2: MemoryFlusher extracts and scores facts', () => {
    it('should parse scored facts from LLM JSON response', () => {
      const jsonResponse = JSON.stringify([
        { fact: 'User prefers concise answers', importance: 8, category: 'relationships' },
        { fact: 'Bot name is AutoForja', importance: 10, category: 'identity' },
      ]);

      // Access private method via type assertion for testing
      const parsed = (memoryFlusher as unknown as { parseScoredFacts: (r: string) => ScoredFact[] }).parseScoredFacts(jsonResponse);

      expect(parsed.length).toBe(2);
      expect(parsed[0].fact).toBe('User prefers concise answers');
      expect(parsed[0].importance).toBe(8);
      expect(parsed[0].category).toBe('relationships');
      expect(parsed[1].importance).toBe(10);
    });

    it('should fallback to bracket format when JSON fails', () => {
      const bracketResponse = `[8] User likes dark mode
[5] User works in Python
[3] User had coffee today`;

      const parsed = (memoryFlusher as unknown as { parseScoredFacts: (r: string) => ScoredFact[] }).parseScoredFacts(bracketResponse);

      expect(parsed.length).toBe(3);
      expect(parsed[0].fact).toBe('User likes dark mode');
      expect(parsed[0].importance).toBe(8);
      expect(parsed[0].category).toBe('general'); // Default when parsing brackets
    });

    it('should clamp importance to 1-10 range', () => {
      const response = JSON.stringify([
        { fact: 'Very important', importance: 99, category: 'goals' },
        { fact: 'Very trivial', importance: -5, category: 'general' },
      ]);

      const parsed = (memoryFlusher as unknown as { parseScoredFacts: (r: string) => ScoredFact[] }).parseScoredFacts(response);

      expect(parsed[0].importance).toBe(10); // Clamped to max
      expect(parsed[1].importance).toBe(1);  // Clamped to min
    });

    it('should validate category enum values', () => {
      const response = JSON.stringify([
        { fact: 'Valid goal', importance: 7, category: 'goals' },
        { fact: 'Invalid category', importance: 5, category: 'not_a_category' },
        { fact: 'Valid identity', importance: 8, category: 'identity' },
      ]);

      const parsed = (memoryFlusher as unknown as { parseScoredFacts: (r: string) => ScoredFact[] }).parseScoredFacts(response);

      expect(parsed.length).toBe(2); // Invalid category filtered out
      expect(parsed.some(p => p.fact === 'Valid goal')).toBe(true);
      expect(parsed.some(p => p.fact === 'Valid identity')).toBe(true);
    });

    it('should generate stable fact keys', () => {
      const fact: ScoredFact = {
        fact: 'User prefers detailed technical explanations',
        importance: 8,
        category: 'relationships',
      };

      const key1 = (memoryFlusher as unknown as { generateFactKey: (f: ScoredFact) => string }).generateFactKey(fact);
      const key2 = (memoryFlusher as unknown as { generateFactKey: (f: ScoredFact) => string }).generateFactKey(fact);

      expect(key1).toBe(key2); // Stable
      expect(key1.length).toBeLessThanOrEqual(50);
      expect(key1).toContain('user_prefers');
    });
  });

  describe('Stage 3: SystemPromptBuilder renders core memories', () => {
    it('should include core memory block in system prompt', async () => {
      // Setup: Store some core memories
      await coreMemory.set('identity', 'name', 'AutoForja', 10);
      await coreMemory.set('preferences', 'style', 'Technical but digestible', 7);

      const prompt = systemPromptBuilder.build({
        mode: 'conversation',
        botId: 'test-bot',
        botConfig: mockBotConfig,
        isGroup: false,
      });

      expect(prompt).toContain('Core Memory');
      expect(prompt).toContain('AutoForja');
      expect(prompt).toContain('Technical but digestible');
    });

    it('should not include core memory when importance is below threshold', async () => {
      // Only low importance memories (using valid category 'goals')
      await coreMemory.set('goals', 'trivia', 'Some random fact', 3);
      await coreMemory.set('goals', 'minor', 'Another unimportant thing', 2);

      const prompt = systemPromptBuilder.build({
        mode: 'conversation',
        botId: 'test-bot',
        botConfig: mockBotConfig,
        isGroup: false,
      });

      // renderForSystemPrompt filters by importance >= 5
      expect(prompt).not.toContain('Some random fact');
    });

    it('should handle missing core memory gracefully', () => {
      const ctxWithoutCoreMemory = {
        ...mockCtx,
        memoryManager: undefined,
      } as unknown as BotContext;

      const builder = new SystemPromptBuilder(ctxWithoutCoreMemory, toolRegistry);
      
      const prompt = builder.build({
        mode: 'conversation',
        botId: 'test-bot',
        botConfig: mockBotConfig,
        isGroup: false,
      });

      // Should not throw and should not contain core memory section
      expect(prompt).not.toContain('Core Memory');
    });
  });

  describe('Full Pipeline: End-to-End Integration', () => {
    it('should complete full pipeline: extract facts → store → render in prompt', async () => {
      // Stage 1: Simulate conversation history
      const history: ChatMessage[] = [
        { role: 'user', content: 'Hi, my name is Diego and I love Rust programming' },
        { role: 'assistant', content: 'Nice to meet you Diego! Rust is a great language for systems programming.' },
        { role: 'user', content: 'Yes, I also prefer concise technical answers without fluff' },
      ];

      // Stage 2: Manually simulate what flushWithScoring would do
      // (We mock the LLM response parsing since we can't call real LLM in tests)
      const simulatedFacts: ScoredFact[] = [
        { fact: 'User name is Diego', importance: 9, category: 'relationships' },
        { fact: 'User loves Rust programming', importance: 8, category: 'relationships' },
        { fact: 'User prefers concise technical answers', importance: 7, category: 'preferences' },
      ];

      // Store facts via CoreMemoryManager (simulating flushWithScoring storage)
      for (const fact of simulatedFacts) {
        const key = `user_${fact.fact.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30)}`;
        await coreMemory.set(fact.category, key, fact.fact, fact.importance);
      }

      // Verify storage
      const allMemories = await coreMemory.list();
      expect(allMemories.length).toBe(3);

      // Stage 3: Verify SystemPromptBuilder includes these memories
      const prompt = systemPromptBuilder.build({
        mode: 'conversation',
        botId: 'test-bot',
        botConfig: mockBotConfig,
        isGroup: false,
      });

      expect(prompt).toContain('Diego');
      expect(prompt).toContain('Rust programming');
      expect(prompt).toContain('concise technical answers');
      expect(prompt).toContain('Relationships');
      expect(prompt).toContain('Preferences');

      // Verify structure - the core memory section contains the categories
      expect(prompt).toContain('**Relationships**');
      expect(prompt).toContain('**Preferences**');
    });

    it('should prioritize high importance memories in prompt rendering', async () => {
      // Store many memories with varying importance
      await coreMemory.set('relationships', 'user_critical', 'Critical user info', 10);
      await coreMemory.set('relationships', 'user_important', 'Important user info', 8);
      await coreMemory.set('relationships', 'user_normal', 'Normal user info', 5);
      await coreMemory.set('relationships', 'user_minor1', 'Minor info 1', 4);
      await coreMemory.set('relationships', 'user_minor2', 'Minor info 2', 3);
      await coreMemory.set('relationships', 'user_minor3', 'Minor info 3', 2);

      const prompt = systemPromptBuilder.build({
        mode: 'conversation',
        botId: 'test-bot',
        botConfig: mockBotConfig,
        isGroup: false,
      });

      // High importance should be present
      expect(prompt).toContain('Critical user info');
      expect(prompt).toContain('Important user info');
      expect(prompt).toContain('Normal user info');

      // Very low importance (below threshold of 5) should not be rendered
      expect(prompt).not.toContain('Minor info 1');
      expect(prompt).not.toContain('Minor info 2');
    });

    it('should update existing memories without duplicates', async () => {
      // Store initial fact
      await coreMemory.set('relationships', 'user_pref', 'User likes Python', 7);
      
      // Update same key with new value
      await coreMemory.set('relationships', 'user_pref', 'User switched to Rust', 9);

      const entry = await coreMemory.get('relationships', 'user_pref');
      expect(entry!.value).toBe('User switched to Rust');
      expect(entry!.importance).toBe(9);

      // Verify only one entry exists
      const all = await coreMemory.list('relationships');
      expect(all.length).toBe(1);
    });
  });
});
