import { describe, expect, test } from 'bun:test';
import { DynamicToolRegistry } from '../../src/bot/dynamic-tool-registry';
import type { BotContext } from '../../src/bot/types';
import type { DynamicToolStore } from '../../src/tools/dynamic-tool-store';
import type { Tool } from '../../src/tools/types';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

function tool(name: string): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    execute: async () => ({ success: true, content: 'ok' }),
  };
}

function setup(onDisk: Set<string>) {
  const t = tool('my_tool');
  const ctx = { tools: [t], toolDefinitions: [t.definition] } as unknown as BotContext;
  const store = {
    delete: (id: string) => onDisk.delete(id),
  } as unknown as DynamicToolStore;
  const registry = new DynamicToolRegistry(ctx, store, noopLogger);
  (registry as any).loadedTools.set('t1', t);
  return { ctx, registry };
}

describe('DynamicToolRegistry.delete', () => {
  test('unloads the tool from the runtime and removes it from disk', () => {
    const onDisk = new Set(['t1']);
    const { ctx, registry } = setup(onDisk);
    expect(registry.delete('t1')).toBe(true);
    expect(onDisk.has('t1')).toBe(false);
    expect(ctx.tools).toHaveLength(0);
    expect(ctx.toolDefinitions).toHaveLength(0);
  });

  test('returns false for a tool that is not on disk', () => {
    const { registry } = setup(new Set());
    expect(registry.delete('missing')).toBe(false);
  });
});
