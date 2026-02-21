import { describe, test, expect } from 'bun:test';
import { DynamicToolRegistry } from '../../src/bot/dynamic-tool-registry';
import { ToolRegistry } from '../../src/bot/tool-registry';
import type { BotContext } from '../../src/bot/types';
import type { Tool, ToolDefinition } from '../../src/tools/types';
import type { DynamicToolStore, DynamicToolMeta } from '../../src/tools/dynamic-tool-store';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

function createMockTool(name: string): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name,
        description: `Tool ${name}`,
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: async () => ({ success: true, content: 'ok' }),
  };
}

function createMockStore(entries: Map<string, { meta: DynamicToolMeta; source: string }>): DynamicToolStore {
  return {
    get: (id: string) => entries.get(id) ?? null,
    list: () => [...entries.values()].map((e) => e.meta),
  } as unknown as DynamicToolStore;
}

function createMockMeta(overrides: Partial<DynamicToolMeta> & { id: string; name: string; createdBy: string; scope: string }): DynamicToolMeta {
  return {
    type: 'typescript',
    status: 'approved',
    description: `Dynamic tool ${overrides.name}`,
    parameters: {},
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function createMockContext(tools: Tool[] = [], bots: { id: string; disabledTools?: string[] }[] = []): BotContext {
  return {
    config: {
      bots: bots.length > 0 ? bots : [{ id: 'bot-1' }, { id: 'bot-2' }],
      dynamicTools: { enabled: true, storePath: './data/tools' },
    },
    tools,
    toolDefinitions: tools.map((t) => t.definition),
    logger: noopLogger,
  } as unknown as BotContext;
}

// ─── DynamicToolRegistry.getExcludedNamesForBot ───

describe('DynamicToolRegistry.getExcludedNamesForBot', () => {
  test('tool with scope "all" is never excluded', () => {
    const tool = createMockTool('global_tool');
    const meta = createMockMeta({ id: 'global_tool', name: 'global_tool', createdBy: 'bot-1', scope: 'all' });
    const store = createMockStore(new Map([['global_tool', { meta, source: '' }]]));
    const ctx = createMockContext([tool]);

    const registry = new DynamicToolRegistry(ctx, store, noopLogger);
    // Simulate loadedTools by calling initialize-like setup
    (registry as any).loadedTools.set('global_tool', tool);

    expect(registry.getExcludedNamesForBot('bot-1').size).toBe(0);
    expect(registry.getExcludedNamesForBot('bot-2').size).toBe(0);
    expect(registry.getExcludedNamesForBot('bot-3').size).toBe(0);
  });

  test('tool scoped to bot-1 is excluded for bot-2', () => {
    const tool = createMockTool('scoped_tool');
    const meta = createMockMeta({ id: 'scoped_tool', name: 'scoped_tool', createdBy: 'bot-1', scope: 'bot-1' });
    const store = createMockStore(new Map([['scoped_tool', { meta, source: '' }]]));
    const ctx = createMockContext([tool]);

    const registry = new DynamicToolRegistry(ctx, store, noopLogger);
    (registry as any).loadedTools.set('scoped_tool', tool);

    expect(registry.getExcludedNamesForBot('bot-1').size).toBe(0);
    expect(registry.getExcludedNamesForBot('bot-2').has('scoped_tool')).toBe(true);
  });

  test('tool created by bot-1 is visible to bot-1 regardless of scope', () => {
    const tool = createMockTool('creator_tool');
    const meta = createMockMeta({ id: 'creator_tool', name: 'creator_tool', createdBy: 'bot-1', scope: 'bot-3' });
    const store = createMockStore(new Map([['creator_tool', { meta, source: '' }]]));
    const ctx = createMockContext([tool]);

    const registry = new DynamicToolRegistry(ctx, store, noopLogger);
    (registry as any).loadedTools.set('creator_tool', tool);

    // bot-1 created it — visible
    expect(registry.getExcludedNamesForBot('bot-1').size).toBe(0);
    // bot-3 is the scope target — visible
    expect(registry.getExcludedNamesForBot('bot-3').size).toBe(0);
    // bot-2 is neither creator nor scope target — excluded
    expect(registry.getExcludedNamesForBot('bot-2').has('creator_tool')).toBe(true);
  });

  test('returns empty set when no dynamic tools loaded', () => {
    const store = createMockStore(new Map());
    const ctx = createMockContext([]);

    const registry = new DynamicToolRegistry(ctx, store, noopLogger);

    expect(registry.getExcludedNamesForBot('bot-1').size).toBe(0);
  });
});

// ─── ToolRegistry scope integration ───

describe('ToolRegistry scope filtering', () => {
  function setupRegistry(
    staticTools: Tool[],
    dynamicTools: { tool: Tool; meta: DynamicToolMeta }[],
    bots: { id: string; disabledTools?: string[] }[] = [{ id: 'bot-1' }, { id: 'bot-2' }],
  ) {
    const allTools = [...staticTools, ...dynamicTools.map((d) => d.tool)];
    const ctx = createMockContext(allTools, bots);

    const storeEntries = new Map<string, { meta: DynamicToolMeta; source: string }>();
    for (const dt of dynamicTools) {
      storeEntries.set(dt.meta.id, { meta: dt.meta, source: '' });
    }
    const store = createMockStore(storeEntries);

    const dynamicRegistry = new DynamicToolRegistry(ctx, store, noopLogger);
    for (const dt of dynamicTools) {
      (dynamicRegistry as any).loadedTools.set(dt.meta.id, dt.tool);
    }

    const toolRegistry = new ToolRegistry(ctx);
    // Inject dynamic registry via private field
    (toolRegistry as any).dynamicToolRegistry = dynamicRegistry;

    return { ctx, toolRegistry };
  }

  test('getDefinitionsForBot excludes scoped dynamic tool for wrong bot', () => {
    const staticTool = createMockTool('datetime');
    const dynamicTool = createMockTool('bot1_only');
    const meta = createMockMeta({ id: 'bot1_only', name: 'bot1_only', createdBy: 'bot-1', scope: 'bot-1' });

    const { toolRegistry } = setupRegistry([staticTool], [{ tool: dynamicTool, meta }]);

    const bot1Defs = toolRegistry.getDefinitionsForBot('bot-1');
    const bot2Defs = toolRegistry.getDefinitionsForBot('bot-2');

    expect(bot1Defs.map((d) => d.function.name)).toContain('bot1_only');
    expect(bot2Defs.map((d) => d.function.name)).not.toContain('bot1_only');
    // Both should see the static tool
    expect(bot1Defs.map((d) => d.function.name)).toContain('datetime');
    expect(bot2Defs.map((d) => d.function.name)).toContain('datetime');
  });

  test('getToolsForBot excludes scoped dynamic tool for wrong bot', () => {
    const staticTool = createMockTool('datetime');
    const dynamicTool = createMockTool('bot1_only');
    const meta = createMockMeta({ id: 'bot1_only', name: 'bot1_only', createdBy: 'bot-1', scope: 'bot-1' });

    const { toolRegistry } = setupRegistry([staticTool], [{ tool: dynamicTool, meta }]);

    const bot1Tools = toolRegistry.getToolsForBot('bot-1');
    const bot2Tools = toolRegistry.getToolsForBot('bot-2');

    expect(bot1Tools.map((t) => t.definition.function.name)).toContain('bot1_only');
    expect(bot2Tools.map((t) => t.definition.function.name)).not.toContain('bot1_only');
  });

  test('getCollaborationToolsForBot applies both scope and collaboration exclusions', () => {
    const collaborateTool = createMockTool('collaborate');
    const delegateTool = createMockTool('delegate_to_bot');
    const staticTool = createMockTool('exec');
    const dynamicTool = createMockTool('bot1_only');
    const meta = createMockMeta({ id: 'bot1_only', name: 'bot1_only', createdBy: 'bot-1', scope: 'bot-1' });

    const { toolRegistry } = setupRegistry(
      [collaborateTool, delegateTool, staticTool],
      [{ tool: dynamicTool, meta }],
    );

    const bot1Collab = toolRegistry.getCollaborationToolsForBot('bot-1');
    const bot2Collab = toolRegistry.getCollaborationToolsForBot('bot-2');

    // bot-1: sees exec + bot1_only, no collaborate/delegate
    const bot1Names = bot1Collab.definitions.map((d) => d.function.name);
    expect(bot1Names).toContain('exec');
    expect(bot1Names).toContain('bot1_only');
    expect(bot1Names).not.toContain('collaborate');
    expect(bot1Names).not.toContain('delegate_to_bot');

    // bot-2: sees exec, no bot1_only, no collaborate/delegate
    const bot2Names = bot2Collab.definitions.map((d) => d.function.name);
    expect(bot2Names).toContain('exec');
    expect(bot2Names).not.toContain('bot1_only');
    expect(bot2Names).not.toContain('collaborate');
  });

  test('disabledTools and scope exclusions work together', () => {
    const toolA = createMockTool('tool_a');
    const toolB = createMockTool('tool_b');
    const dynamicTool = createMockTool('dynamic_scoped');
    const meta = createMockMeta({ id: 'dynamic_scoped', name: 'dynamic_scoped', createdBy: 'bot-2', scope: 'bot-2' });

    const { toolRegistry } = setupRegistry(
      [toolA, toolB],
      [{ tool: dynamicTool, meta }],
      [
        { id: 'bot-1', disabledTools: ['tool_a'] },
        { id: 'bot-2' },
      ],
    );

    const bot1Defs = toolRegistry.getDefinitionsForBot('bot-1');
    const bot1Names = bot1Defs.map((d) => d.function.name);

    // bot-1: tool_a disabled via config, dynamic_scoped excluded via scope
    expect(bot1Names).not.toContain('tool_a');
    expect(bot1Names).not.toContain('dynamic_scoped');
    expect(bot1Names).toContain('tool_b');

    // bot-2: sees everything (tool_a not disabled for bot-2, dynamic_scoped is its own scope)
    const bot2Defs = toolRegistry.getDefinitionsForBot('bot-2');
    const bot2Names = bot2Defs.map((d) => d.function.name);
    expect(bot2Names).toContain('tool_a');
    expect(bot2Names).toContain('tool_b');
    expect(bot2Names).toContain('dynamic_scoped');
  });

  test('no dynamic registry means only disabledTools filtering', () => {
    const toolA = createMockTool('tool_a');
    const toolB = createMockTool('tool_b');
    const ctx = createMockContext([toolA, toolB], [{ id: 'bot-1', disabledTools: ['tool_a'] }]);

    // Create ToolRegistry without dynamic tool support
    const toolRegistry = new ToolRegistry(ctx);

    const defs = toolRegistry.getDefinitionsForBot('bot-1');
    const names = defs.map((d) => d.function.name);
    expect(names).not.toContain('tool_a');
    expect(names).toContain('tool_b');
  });
});
