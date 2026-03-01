import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '../src/bot/tool-registry';
import type { BotContext } from '../src/bot/types';
import type { LoadedExternalSkill } from '../src/core/external-skill-loader';
import type { Logger } from '../src/logger';
import type { Tool, ToolDefinition } from '../src/tools/types';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

function makeTool(name: string): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `Tool ${name}`,
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: async () => ({ success: true, content: 'ok' }),
  };
}

function makeSkill(id: string, toolNames: string[], botName?: string): LoadedExternalSkill {
  return {
    manifest: {
      id,
      name: id,
      tools: toolNames.map((n) => ({
        name: n,
        description: `${n} desc`,
        parameters: { type: 'object', properties: {} },
      })),
    },
    handlers: {},
    dir: `/fake/${id}`,
    warnings: [],
    botName,
  };
}

function createCtxAndRegistry(): {
  ctx: BotContext;
  registry: ToolRegistry;
  tools: Tool[];
  toolDefinitions: ToolDefinition[];
} {
  const tools: Tool[] = [];
  const toolDefinitions: ToolDefinition[] = [];
  const ctx = {
    tools,
    toolDefinitions,
    logger: noopLogger,
    config: { bots: [] },
  } as unknown as BotContext;

  const registry = new ToolRegistry(ctx);
  return { ctx, registry, tools, toolDefinitions };
}

/**
 * Manually inject external skills into the registry (simulates what initializeExternalSkills does).
 */
function injectSkills(
  registry: ToolRegistry,
  ctx: BotContext,
  skills: Array<{ skill: LoadedExternalSkill; toolNames: string[] }>
): void {
  for (const { skill, toolNames } of skills) {
    // Add skill to externalSkills
    (registry as any).externalSkills.push(skill);
    // Add tools and map them
    for (const toolName of toolNames) {
      const namespacedName = `${skill.manifest.id}_${toolName}`;
      const tool = makeTool(namespacedName);
      ctx.tools.push(tool);
      (registry as any).externalToolToSkill.set(namespacedName, skill.manifest.id);
    }
  }
  // Sync definitions
  ctx.toolDefinitions.length = 0;
  ctx.toolDefinitions.push(...ctx.tools.map((t) => t.definition));
}

describe('ToolRegistry.clearExternalSkillsForBot', () => {
  test('removes tools belonging to the target bot', () => {
    const { ctx, registry } = createCtxAndRegistry();

    injectSkills(registry, ctx, [
      { skill: makeSkill('gcal-sync', ['list', 'create'], 'finny'), toolNames: ['list', 'create'] },
      { skill: makeSkill('bookmarks', ['save', 'search'], 'finny'), toolNames: ['save', 'search'] },
    ]);

    expect(ctx.tools).toHaveLength(4);
    expect(ctx.toolDefinitions).toHaveLength(4);

    const removed = registry.clearExternalSkillsForBot('finny');

    expect(removed).toEqual(['gcal-sync', 'bookmarks']);
    expect(ctx.tools).toHaveLength(0);
    expect(ctx.toolDefinitions).toHaveLength(0);
    expect(registry.getExternalSkills()).toHaveLength(0);
  });

  test('does not touch skills from other bots', () => {
    const { ctx, registry } = createCtxAndRegistry();

    injectSkills(registry, ctx, [
      { skill: makeSkill('gcal-sync', ['list'], 'finny'), toolNames: ['list'] },
      { skill: makeSkill('weather', ['forecast'], 'tsc'), toolNames: ['forecast'] },
    ]);

    expect(ctx.tools).toHaveLength(2);

    const removed = registry.clearExternalSkillsForBot('finny');

    expect(removed).toEqual(['gcal-sync']);
    expect(ctx.tools).toHaveLength(1);
    expect(ctx.tools[0].definition.function.name).toBe('weather_forecast');
    expect(registry.getExternalSkills()).toHaveLength(1);
    expect(registry.getExternalSkills()[0].manifest.id).toBe('weather');
  });

  test('does not touch core tools (no botName)', () => {
    const { ctx, registry } = createCtxAndRegistry();

    // Add a core tool manually (not from external skills)
    const coreTool = makeTool('get_datetime');
    ctx.tools.push(coreTool);

    injectSkills(registry, ctx, [
      { skill: makeSkill('gcal-sync', ['list'], 'finny'), toolNames: ['list'] },
      { skill: makeSkill('bundled', ['do_thing'], undefined), toolNames: ['do_thing'] },
    ]);

    expect(ctx.tools).toHaveLength(3); // core + 2 external

    const removed = registry.clearExternalSkillsForBot('finny');

    expect(removed).toEqual(['gcal-sync']);
    expect(ctx.tools).toHaveLength(2); // core + bundled
    expect(ctx.tools.map((t) => t.definition.function.name).sort()).toEqual([
      'bundled_do_thing',
      'get_datetime',
    ]);
  });

  test('re-syncs toolDefinitions after clearing', () => {
    const { ctx, registry } = createCtxAndRegistry();

    const coreTool = makeTool('web_search');
    ctx.tools.push(coreTool);

    injectSkills(registry, ctx, [
      { skill: makeSkill('streak', ['check', 'update'], 'finny'), toolNames: ['check', 'update'] },
    ]);

    expect(ctx.toolDefinitions).toHaveLength(3);

    registry.clearExternalSkillsForBot('finny');

    expect(ctx.toolDefinitions).toHaveLength(1);
    expect(ctx.toolDefinitions[0].function.name).toBe('web_search');
    // Verify it's the same reference array (mutated in place)
    expect(ctx.tools.length).toBe(ctx.toolDefinitions.length);
  });

  test('is idempotent — second call returns empty', () => {
    const { ctx, registry } = createCtxAndRegistry();

    injectSkills(registry, ctx, [
      { skill: makeSkill('gcal-sync', ['list'], 'finny'), toolNames: ['list'] },
    ]);

    const first = registry.clearExternalSkillsForBot('finny');
    expect(first).toEqual(['gcal-sync']);

    const second = registry.clearExternalSkillsForBot('finny');
    expect(second).toEqual([]);
    expect(ctx.tools).toHaveLength(0);
  });

  test('returns empty array when bot has no skills', () => {
    const { registry } = createCtxAndRegistry();

    const removed = registry.clearExternalSkillsForBot('nonexistent');
    expect(removed).toEqual([]);
  });

  test('cleans externalToolToSkill map entries', () => {
    const { ctx, registry } = createCtxAndRegistry();

    injectSkills(registry, ctx, [
      { skill: makeSkill('gcal-sync', ['list', 'create'], 'finny'), toolNames: ['list', 'create'] },
      { skill: makeSkill('weather', ['forecast'], 'tsc'), toolNames: ['forecast'] },
    ]);

    registry.clearExternalSkillsForBot('finny');

    // Internal map should only have weather's tool
    const map = (registry as any).externalToolToSkill as Map<string, string>;
    expect(map.size).toBe(1);
    expect(map.has('weather_forecast')).toBe(true);
    expect(map.has('gcal-sync_list')).toBe(false);
    expect(map.has('gcal-sync_create')).toBe(false);
  });
});
