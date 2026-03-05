import { describe, expect, test } from 'bun:test';
import { SystemPromptBuilder } from '../../src/bot/system-prompt-builder';
import type { ToolRegistry } from '../../src/bot/tool-registry';
import type { BotContext } from '../../src/bot/types';
import type { ToolDefinition } from '../../src/tools/types';

function makeDef(name: string): ToolDefinition {
  return {
    type: 'function',
    function: { name, description: '', parameters: {} },
  } as ToolDefinition;
}

function createMockCtx(
  bots: Array<{ id: string; name: string; enabled?: boolean }> = []
): BotContext {
  return {
    config: {
      bots: bots.map((b) => ({ ...b, enabled: b.enabled ?? true, token: 'x', skills: [] })),
      humanizer: { enabled: false },
      soul: { enabled: false, dir: './soul' },
      ollama: { models: { primary: 'test-model' } },
      conversation: { systemPrompt: 'Base prompt.', temperature: 0.7, maxHistory: 20 },
      karma: { enabled: false },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    },
    memoryManager: undefined,
    getSoulLoader: () => ({
      composeSystemPrompt: () => 'You are TestBot.',
    }),
    runningBots: new Set(bots.map((b) => b.id)),
    agentRegistry: {
      listOtherAgents: () => [],
    },
  } as unknown as BotContext;
}

function createMockToolRegistry(defs: ToolDefinition[]): ToolRegistry {
  return {
    getDefinitionsForBot: () => defs,
  } as unknown as ToolRegistry;
}

const botConfig = { id: 'testbot', name: 'TestBot', token: 'x', enabled: true, skills: [] } as any;

describe('SystemPromptBuilder', () => {
  describe('create_agent instructions', () => {
    test('includes agent creation section when create_agent tool is present', () => {
      const bots = [
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: 'Beta' },
      ];
      const ctx = createMockCtx(bots);
      const defs = [makeDef('create_agent'), makeDef('get_datetime')];
      const registry = createMockToolRegistry(defs);
      const builder = new SystemPromptBuilder(ctx, registry);

      const prompt = builder.build({
        mode: 'conversation',
        botId: 'testbot',
        botConfig,
        isGroup: false,
      });

      expect(prompt).toContain('## Agent Creation');
      expect(prompt).toContain('create_agent');
      expect(prompt).toContain('gap in the ecosystem');
      expect(prompt).toContain('human approval');
    });

    test('lists existing agents from the ecosystem', () => {
      const bots = [
        { id: 'alpha', name: 'AlphaBot' },
        { id: 'beta', name: 'BetaBot' },
        { id: 'gamma', name: 'GammaBot' },
      ];
      const ctx = createMockCtx(bots);
      const defs = [makeDef('create_agent')];
      const registry = createMockToolRegistry(defs);
      const builder = new SystemPromptBuilder(ctx, registry);

      const prompt = builder.build({
        mode: 'conversation',
        botId: 'testbot',
        botConfig,
        isGroup: false,
      });

      expect(prompt).toContain('- alpha (AlphaBot)');
      expect(prompt).toContain('- beta (BetaBot)');
      expect(prompt).toContain('- gamma (GammaBot)');
    });

    test('excludes disabled agents from the listing', () => {
      const bots = [
        { id: 'active', name: 'ActiveBot', enabled: true },
        { id: 'disabled', name: 'DisabledBot', enabled: false },
      ];
      const ctx = createMockCtx(bots);
      const defs = [makeDef('create_agent')];
      const registry = createMockToolRegistry(defs);
      const builder = new SystemPromptBuilder(ctx, registry);

      const prompt = builder.build({
        mode: 'conversation',
        botId: 'testbot',
        botConfig,
        isGroup: false,
      });

      expect(prompt).toContain('- active (ActiveBot)');
      expect(prompt).not.toContain('DisabledBot');
    });

    test('does NOT include agent creation section when create_agent tool is absent', () => {
      const ctx = createMockCtx([{ id: 'alpha', name: 'Alpha' }]);
      const defs = [makeDef('get_datetime'), makeDef('exec')];
      const registry = createMockToolRegistry(defs);
      const builder = new SystemPromptBuilder(ctx, registry);

      const prompt = builder.build({
        mode: 'conversation',
        botId: 'testbot',
        botConfig,
        isGroup: false,
      });

      expect(prompt).not.toContain('## Agent Creation');
      expect(prompt).not.toContain('create_agent');
    });

    test('includes agent creation section in autonomous mode', () => {
      const bots = [{ id: 'alpha', name: 'Alpha' }];
      const ctx = createMockCtx(bots);
      const defs = [makeDef('create_agent')];
      const registry = createMockToolRegistry(defs);
      const builder = new SystemPromptBuilder(ctx, registry);

      const prompt = builder.build({
        mode: 'autonomous',
        botId: 'testbot',
        botConfig,
        isGroup: false,
      });

      expect(prompt).toContain('## Agent Creation');
      expect(prompt).toContain('- alpha (Alpha)');
    });
  });
});
