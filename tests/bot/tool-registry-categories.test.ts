import { describe, test, expect } from 'bun:test';
import {
  TOOL_CATEGORIES,
  TOOL_CATEGORY_NAMES,
  TOOL_TO_CATEGORY,
  ALWAYS_INCLUDED_TOOLS,
  ToolRegistry,
  type ToolCategory,
} from '../../src/bot/tool-registry';
import type { BotContext } from '../../src/bot/types';
import type { Tool, ToolDefinition } from '../../src/tools/types';

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

function createMockContext(tools: Tool[], bots: { id: string; disabledTools?: string[] }[] = [{ id: 'bot-1' }]): BotContext {
  return {
    config: {
      bots,
      dynamicTools: { enabled: false },
    },
    tools,
    toolDefinitions: tools.map((t) => t.definition),
    logger: noopLogger,
  } as unknown as BotContext;
}

// ─── Category Constants ───

describe('Tool category constants', () => {
  test('TOOL_CATEGORY_NAMES has 10 categories', () => {
    expect(TOOL_CATEGORY_NAMES).toHaveLength(10);
  });

  test('no tool appears in multiple categories', () => {
    const seen = new Map<string, string>();
    for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
      for (const tool of tools) {
        expect(seen.has(tool)).toBe(false);
        seen.set(tool, category);
      }
    }
  });

  test('TOOL_TO_CATEGORY is consistent with TOOL_CATEGORIES', () => {
    for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
      for (const tool of tools) {
        expect(TOOL_TO_CATEGORY.get(tool)).toBe(category);
      }
    }
  });

  test('TOOL_TO_CATEGORY has exactly as many entries as all tools in TOOL_CATEGORIES', () => {
    const totalTools = Object.values(TOOL_CATEGORIES).reduce((sum, tools) => sum + tools.length, 0);
    expect(TOOL_TO_CATEGORY.size).toBe(totalTools);
  });

  test('ALWAYS_INCLUDED_TOOLS are all categorized', () => {
    for (const tool of ALWAYS_INCLUDED_TOOLS) {
      expect(TOOL_TO_CATEGORY.has(tool)).toBe(true);
    }
  });

  test('each category in TOOL_CATEGORY_NAMES exists in TOOL_CATEGORIES', () => {
    for (const name of TOOL_CATEGORY_NAMES) {
      expect(TOOL_CATEGORIES[name]).toBeDefined();
      expect(TOOL_CATEGORIES[name].length).toBeGreaterThan(0);
    }
  });
});

// ─── getDefinitionsByCategories ───

describe('ToolRegistry.getDefinitionsByCategories', () => {
  function setupRegistry(toolNames: string[], bots: { id: string; disabledTools?: string[] }[] = [{ id: 'bot-1' }]) {
    const tools = toolNames.map(createMockTool);
    const ctx = createMockContext(tools, bots);
    const registry = new ToolRegistry(ctx);
    return { ctx, registry };
  }

  test('undefined categories returns all tools (fallback)', () => {
    const { registry } = setupRegistry(['web_search', 'exec', 'file_read', 'ask_human']);
    const defs = registry.getDefinitionsByCategories(undefined, 'bot-1');
    expect(defs.map((d) => d.function.name).sort()).toEqual(['ask_human', 'exec', 'file_read', 'web_search']);
  });

  test('empty categories array returns all tools (fallback)', () => {
    const { registry } = setupRegistry(['web_search', 'exec', 'file_read']);
    const defs = registry.getDefinitionsByCategories([], 'bot-1');
    expect(defs).toHaveLength(3);
  });

  test('selecting ["web"] returns only web tools + always-included', () => {
    const { registry } = setupRegistry(['web_search', 'web_fetch', 'exec', 'file_read', 'get_datetime', 'ask_human', 'ask_permission']);
    const defs = registry.getDefinitionsByCategories(['web'], 'bot-1');
    const names = defs.map((d) => d.function.name).sort();
    // web_search, web_fetch (web category) + get_datetime, ask_human, ask_permission (always-included)
    expect(names).toEqual(['ask_human', 'ask_permission', 'get_datetime', 'web_fetch', 'web_search']);
  });

  test('selecting ["files", "system"] returns files + system tools + always-included', () => {
    const { registry } = setupRegistry(['file_read', 'file_write', 'exec', 'get_datetime', 'web_search', 'ask_human']);
    const defs = registry.getDefinitionsByCategories(['files', 'system'], 'bot-1');
    const names = defs.map((d) => d.function.name).sort();
    // file_read, file_write (files), exec, get_datetime (system), ask_human (always-included)
    expect(names).toEqual(['ask_human', 'exec', 'file_read', 'file_write', 'get_datetime']);
  });

  test('ALWAYS_INCLUDED_TOOLS are present even when their category is not selected', () => {
    // get_datetime is in "system", ask_human & ask_permission are in "communication"
    // Select only "web" — always-included should still appear
    const { registry } = setupRegistry(['web_search', 'get_datetime', 'ask_human', 'ask_permission', 'exec']);
    const defs = registry.getDefinitionsByCategories(['web'], 'bot-1');
    const names = new Set(defs.map((d) => d.function.name));
    expect(names.has('get_datetime')).toBe(true);
    expect(names.has('ask_human')).toBe(true);
    expect(names.has('ask_permission')).toBe(true);
    expect(names.has('web_search')).toBe(true);
    // exec is in system, not selected
    expect(names.has('exec')).toBe(false);
  });

  test('uncategorized tools (external/dynamic) always pass through', () => {
    const { registry } = setupRegistry(['web_search', 'custom_skill_tool', 'another_external']);
    const defs = registry.getDefinitionsByCategories(['web'], 'bot-1');
    const names = new Set(defs.map((d) => d.function.name));
    // custom_skill_tool and another_external are not in any category → pass through
    expect(names.has('web_search')).toBe(true);
    expect(names.has('custom_skill_tool')).toBe(true);
    expect(names.has('another_external')).toBe(true);
  });

  test('respects disabledTools on top of category filtering', () => {
    const { registry } = setupRegistry(
      ['web_search', 'web_fetch', 'get_datetime', 'ask_human'],
      [{ id: 'bot-1', disabledTools: ['web_fetch'] }],
    );
    const defs = registry.getDefinitionsByCategories(['web'], 'bot-1');
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('web_search');
    expect(names).not.toContain('web_fetch'); // disabled
    expect(names).toContain('get_datetime'); // always-included
    expect(names).toContain('ask_human'); // always-included
  });
});

// ─── parsePlannerResult toolCategories ───

describe('parsePlannerResult toolCategories', () => {
  // Import the parser
  const { parsePlannerResult } = require('../../src/bot/agent-planner');

  test('extracts valid toolCategories', () => {
    const raw = JSON.stringify({
      reasoning: 'Need to search and save',
      plan: ['Search the web', 'Save to memory'],
      priority: 'medium',
      toolCategories: ['web', 'memory'],
    });
    const result = parsePlannerResult(raw, noopLogger);
    expect(result).not.toBeNull();
    expect(result!.toolCategories).toEqual(['web', 'memory']);
  });

  test('filters out invalid category names', () => {
    const raw = JSON.stringify({
      reasoning: 'Do stuff',
      plan: ['Step 1'],
      priority: 'medium',
      toolCategories: ['web', 'invalid_cat', 'soul', 'nonsense'],
    });
    const result = parsePlannerResult(raw, noopLogger);
    expect(result).not.toBeNull();
    expect(result!.toolCategories).toEqual(['web', 'soul']);
  });

  test('returns undefined when toolCategories is absent', () => {
    const raw = JSON.stringify({
      reasoning: 'Plan something',
      plan: ['Step 1'],
      priority: 'medium',
    });
    const result = parsePlannerResult(raw, noopLogger);
    expect(result).not.toBeNull();
    expect(result!.toolCategories).toBeUndefined();
  });

  test('returns undefined when toolCategories is empty array', () => {
    const raw = JSON.stringify({
      reasoning: 'Plan something',
      plan: ['Step 1'],
      priority: 'medium',
      toolCategories: [],
    });
    const result = parsePlannerResult(raw, noopLogger);
    expect(result).not.toBeNull();
    expect(result!.toolCategories).toBeUndefined();
  });

  test('returns undefined when all categories are invalid', () => {
    const raw = JSON.stringify({
      reasoning: 'Plan something',
      plan: ['Step 1'],
      priority: 'medium',
      toolCategories: ['fake', 'bogus'],
    });
    const result = parsePlannerResult(raw, noopLogger);
    expect(result).not.toBeNull();
    expect(result!.toolCategories).toBeUndefined();
  });

  test('handles non-array toolCategories gracefully', () => {
    const raw = JSON.stringify({
      reasoning: 'Plan something',
      plan: ['Step 1'],
      priority: 'medium',
      toolCategories: 'web',
    });
    const result = parsePlannerResult(raw, noopLogger);
    expect(result).not.toBeNull();
    expect(result!.toolCategories).toBeUndefined();
  });
});

// ─── Planner prompt tool category section ───

describe('buildPlannerPrompt toolCategoryList', () => {
  const { buildPlannerPrompt, buildContinuousPlannerPrompt } = require('../../src/bot/agent-loop-prompts');

  const baseInput = {
    identity: 'Test bot',
    soul: 'Test soul',
    motivations: 'Test motivations',
    goals: 'Test goals',
    recentMemory: '',
    datetime: '2026-01-01T00:00:00Z',
    availableTools: ['web_search', 'file_read'],
    hasCreateTool: false,
  };

  test('includes category section when toolCategoryList is provided', () => {
    const { system } = buildPlannerPrompt({ ...baseInput, toolCategoryList: ['web', 'memory', 'files'] });
    expect(system).toContain('## Tool Categories');
    expect(system).toContain('**web**');
    expect(system).toContain('**memory**');
    expect(system).toContain('**files**');
    expect(system).toContain('"toolCategories"');
  });

  test('omits category section when toolCategoryList is undefined', () => {
    const { system } = buildPlannerPrompt({ ...baseInput });
    expect(system).not.toContain('## Tool Categories');
  });

  test('omits category section when toolCategoryList is empty', () => {
    const { system } = buildPlannerPrompt({ ...baseInput, toolCategoryList: [] });
    expect(system).not.toContain('## Tool Categories');
  });

  test('includes toolCategories in JSON schema when enabled', () => {
    const { system } = buildPlannerPrompt({ ...baseInput, toolCategoryList: ['web'] });
    expect(system).toContain('toolCategories: array of strings');
  });

  test('omits toolCategories from JSON schema when disabled', () => {
    const { system } = buildPlannerPrompt({ ...baseInput });
    expect(system).not.toContain('toolCategories: array of strings');
  });

  test('continuous planner also includes category section', () => {
    const { system } = buildContinuousPlannerPrompt({ ...baseInput, toolCategoryList: ['soul', 'communication'] });
    expect(system).toContain('## Tool Categories');
    expect(system).toContain('**soul**');
    expect(system).toContain('**communication**');
  });

  test('continuous planner omits category section when not provided', () => {
    const { system } = buildContinuousPlannerPrompt({ ...baseInput });
    expect(system).not.toContain('## Tool Categories');
  });
});
