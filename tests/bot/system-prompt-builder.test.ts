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
  bots: Array<{ id: string; name: string; enabled?: boolean; tenantId?: string }> = [],
  agentRegistryOverride?: { listOtherAgents: (...args: any[]) => any[] }
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
    agentRegistry: agentRegistryOverride ?? {
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

  describe('cross-tenant bot visibility isolation', () => {
    const tenantABot = { id: 'bot-a', name: 'BotA', tenantId: 'tenant-a' } as any;
    const tenantBBot = { id: 'bot-b', name: 'BotB', tenantId: 'tenant-b' } as any;

    test('delegationInstructions filters bots by tenantId', () => {
      const bots = [
        { id: 'bot-a', name: 'BotA', tenantId: 'tenant-a' },
        { id: 'bot-a2', name: 'BotA2', tenantId: 'tenant-a' },
        { id: 'bot-b', name: 'BotB', tenantId: 'tenant-b' },
      ];
      const ctx = createMockCtx(bots);
      const defs = [makeDef('delegate_to_bot')];
      const registry = createMockToolRegistry(defs);
      const builder = new SystemPromptBuilder(ctx, registry);

      const prompt = builder.build({
        mode: 'conversation',
        botId: 'bot-a',
        botConfig: tenantABot,
        isGroup: false,
      });

      expect(prompt).toContain('bot-a2 (BotA2)');
      expect(prompt).not.toContain('bot-b');
      expect(prompt).not.toContain('BotB');
    });

    test('createAgentInstructions filters bots by tenantId', () => {
      const bots = [
        { id: 'bot-a', name: 'BotA', tenantId: 'tenant-a' },
        { id: 'bot-b', name: 'BotB', tenantId: 'tenant-b' },
        { id: 'bot-b2', name: 'BotB2', tenantId: 'tenant-b' },
      ];
      const ctx = createMockCtx(bots);
      const defs = [makeDef('create_agent')];
      const registry = createMockToolRegistry(defs);
      const builder = new SystemPromptBuilder(ctx, registry);

      const prompt = builder.build({
        mode: 'conversation',
        botId: 'bot-b',
        botConfig: tenantBBot,
        isGroup: false,
      });

      expect(prompt).toContain('bot-b (BotB)');
      expect(prompt).toContain('bot-b2 (BotB2)');
      expect(prompt).not.toContain('bot-a');
      expect(prompt).not.toContain('BotA');
    });

    test('collaborationInstructions passes tenantId to listOtherAgents', () => {
      let capturedTenantId: string | undefined;
      const bots = [
        { id: 'bot-a', name: 'BotA', tenantId: 'tenant-a' },
        { id: 'bot-b', name: 'BotB', tenantId: 'tenant-b' },
      ];
      const ctx = createMockCtx(bots, {
        listOtherAgents: (_botId: string, tenantId?: string) => {
          capturedTenantId = tenantId;
          return [];
        },
      });
      const defs = [makeDef('collaborate')];
      const registry = createMockToolRegistry(defs);
      const builder = new SystemPromptBuilder(ctx, registry);

      builder.build({
        mode: 'conversation',
        botId: 'bot-a',
        botConfig: tenantABot,
        isGroup: false,
      });

      expect(capturedTenantId).toBe('tenant-a');
    });

    test('bots without tenantId see all bots (single-tenant mode)', () => {
      const bots = [
        { id: 'bot-x', name: 'BotX' },
        { id: 'bot-y', name: 'BotY' },
        { id: 'bot-z', name: 'BotZ' },
      ];
      const noTenantConfig = {
        id: 'bot-x',
        name: 'BotX',
        token: 'x',
        enabled: true,
        skills: [],
      } as any;
      const ctx = createMockCtx(bots);
      const defs = [makeDef('delegate_to_bot'), makeDef('create_agent')];
      const registry = createMockToolRegistry(defs);
      const builder = new SystemPromptBuilder(ctx, registry);

      const prompt = builder.build({
        mode: 'conversation',
        botId: 'bot-x',
        botConfig: noTenantConfig,
        isGroup: false,
      });

      expect(prompt).toContain('bot-y (BotY)');
      expect(prompt).toContain('bot-z (BotZ)');
    });
  });
});
