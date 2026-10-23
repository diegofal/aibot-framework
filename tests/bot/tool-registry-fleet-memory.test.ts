import { describe, expect, test } from 'bun:test';
import { DEFAULT_PERMISSIONS } from '../../src/bot/tool-permissions';
import { TOOL_CATEGORIES, TOOL_TO_CATEGORY, ToolRegistry } from '../../src/bot/tool-registry';
import type { BotContext } from '../../src/bot/types';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

function ctxWith(watcherEnabled: boolean): BotContext {
  return {
    config: { bots: [{ id: 'b1' }], watcher: { enabled: watcherEnabled } },
    tools: [],
    toolDefinitions: [],
    logger: noopLogger,
  } as unknown as BotContext;
}

const source = () => ({
  graph: { list: () => [], findByKey: () => undefined, getEmbedding: () => undefined },
});

const names = (defs: { function: { name: string } }[]) => defs.map((d) => d.function.name);

describe('ToolRegistry.setFleetMemory', () => {
  test('registers fleet_memory_search when the watcher is enabled', () => {
    const ctx = ctxWith(true);
    const reg = new ToolRegistry(ctx);
    reg.setFleetMemory(source);
    expect(names(ctx.toolDefinitions)).toContain('fleet_memory_search');
    expect(names(reg.getDefinitionsForBot('b1'))).toContain('fleet_memory_search');
  });

  test('registers nothing when the watcher is off', () => {
    const ctx = ctxWith(false);
    const reg = new ToolRegistry(ctx);
    reg.setFleetMemory(source);
    expect(ctx.tools).toHaveLength(0);
    expect(ctx.toolDefinitions).toHaveLength(0);
  });

  test('is idempotent', () => {
    const ctx = ctxWith(true);
    const reg = new ToolRegistry(ctx);
    reg.setFleetMemory(source);
    reg.setFleetMemory(source);
    expect(names(ctx.toolDefinitions).filter((n) => n === 'fleet_memory_search')).toHaveLength(1);
    expect(ctx.tools).toHaveLength(1);
  });

  test('is in the memory category, free in both modes and not sensitive', () => {
    const ctx = ctxWith(true);
    const reg = new ToolRegistry(ctx);
    reg.setFleetMemory(source);
    expect(TOOL_CATEGORIES.memory).toContain('fleet_memory_search');
    expect(TOOL_TO_CATEGORY.get('fleet_memory_search')).toBe('memory');
    expect(DEFAULT_PERMISSIONS.fleet_memory_search).toEqual({
      agentLoop: 'free',
      conversation: 'free',
    });
    expect(ctx.tools[0].definition.sensitive).toBeFalsy();
    expect(names(reg.getCollaborationToolsForBot('b1').definitions)).toContain(
      'fleet_memory_search'
    );
  });
});
