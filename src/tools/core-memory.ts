import type { CoreMemoryManager, CoreMemoryEntry } from '../memory/core-memory';
import type { Tool, ToolResult } from './types';

type ToolLogger = { info: (msg: Record<string, unknown>) => void; error: (msg: Record<string, unknown>) => void };

export function createCoreMemoryTools(coreMemory: CoreMemoryManager): Tool[] {
  return [
    createCoreMemoryAppendTool(coreMemory),
    createCoreMemoryReplaceTool(coreMemory),
    createCoreMemorySearchTool(coreMemory),
  ];
}

function createCoreMemoryAppendTool(coreMemory: CoreMemoryManager): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'core_memory_append',
        description:
          'Add or update a structured memory fact about identity, relationships, preferences, goals, or constraints. ' +
          'Use this to remember important things that should persist across conversations. ' +
          'Categories: identity (who you are), relationships (info about users), preferences (your own preferences), ' +
          'goals (long-term objectives), constraints (self-imposed limits). ' +
          'Importance: 1-10 scale (10 = critical, 1 = minor).',
        parameters: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              description: 'Memory category: identity, relationships, preferences, goals, or constraints',
              enum: ['identity', 'relationships', 'preferences', 'goals', 'constraints'],
            },
            key: {
              type: 'string',
              description: 'Short identifier for this fact (e.g., "user_diego_work", "personal_style")',
            },
            value: {
              type: 'string',
              description: 'The actual content to remember (max 2000 chars)',
            },
            importance: {
              type: 'number',
              description: 'Importance score 1-10 (default: 5)',
              minimum: 1,
              maximum: 10,
            },
          },
          required: ['category', 'key', 'value'],
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const category = String(args.category);
      const key = String(args.key);
      const value = String(args.value);
      const importance = typeof args.importance === 'number' ? args.importance : 5;

      try {
        await coreMemory.set(category, key, value, importance);
        return {
          success: true,
          content: `Memory saved: [${category}] ${key} = "${value}" (importance: ${importance})`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          content: `Failed to save memory: ${message}`,
        };
      }
    },
  };
}

function createCoreMemoryReplaceTool(coreMemory: CoreMemoryManager): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'core_memory_replace',
        description:
          'Replace an existing memory fact with a new value. ' +
          'Use this to update or correct information you previously saved. ' +
          'The old_value must match exactly for safety.',
        parameters: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              description: 'Memory category',
              enum: ['identity', 'relationships', 'preferences', 'goals', 'constraints'],
            },
            key: {
              type: 'string',
              description: 'Identifier of the fact to replace',
            },
            old_value: {
              type: 'string',
              description: 'Current value (must match exactly for safety)',
            },
            new_value: {
              type: 'string',
              description: 'New value to replace with',
            },
            importance: {
              type: 'number',
              description: 'Optional new importance score 1-10',
              minimum: 1,
              maximum: 10,
            },
          },
          required: ['category', 'key', 'old_value', 'new_value'],
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const category = String(args.category);
      const key = String(args.key);
      const oldValue = String(args.old_value);
      const newValue = String(args.new_value);
      const newImportance = typeof args.importance === 'number' ? args.importance : undefined;

      try {
        const existing = await coreMemory.get(category, key);

        if (!existing) {
          return {
            success: false,
            content: `No memory found for [${category}] ${key}`,
          };
        }

        if (existing.value !== oldValue) {
          return {
            success: false,
            content:
              `Value mismatch. Expected: "${oldValue}" but found: "${existing.value}". ` +
              `Use core_memory_search to verify current value.`,
          };
        }

        const importance = newImportance ?? existing.importance;
        await coreMemory.set(category, key, newValue, importance);

        return {
          success: true,
          content: `Memory updated: [${category}] ${key} = "${newValue}" (importance: ${importance})`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          content: `Failed to replace memory: ${message}`,
        };
      }
    },
  };
}

function createCoreMemorySearchTool(coreMemory: CoreMemoryManager): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'core_memory_search',
        description:
          'Search your structured core memory for facts about identity, relationships, preferences, goals, or constraints. ' +
          'Use this before claiming you know something about a person or yourself. ' +
          'Returns facts ordered by importance.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query (matches against keys and values)',
            },
            category: {
              type: 'string',
              description: 'Optional: filter to specific category',
              enum: ['identity', 'relationships', 'preferences', 'goals', 'constraints'],
            },
            limit: {
              type: 'number',
              description: 'Maximum results (default: 10)',
              minimum: 1,
              maximum: 50,
            },
          },
          required: ['query'],
        },
      },
    },
    async execute(args: Record<string, unknown>, _logger?: ToolLogger): Promise<ToolResult> {
      const query = String(args.query);
      const category = args.category ? String(args.category) : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : 10;

      try {
        const results = await coreMemory.search(query, category, limit);

        if (results.length === 0) {
          return {
            success: true,
            content: `No core memory found for query: "${query}"`,
          };
        }

        const formatted = formatCoreMemoryResults(results);
        return {
          success: true,
          content: `Found ${results.length} core memory entries:\n\n${formatted}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          content: `Search failed: ${message}`,
        };
      }
    },
  };
}

function formatCoreMemoryResults(results: CoreMemoryEntry[]): string {
  const lines: string[] = [];

  // Group by category for readability
  const byCategory = new Map<string, CoreMemoryEntry[]>();
  for (const r of results) {
    const list = byCategory.get(r.category) ?? [];
    list.push(r);
    byCategory.set(r.category, list);
  }

  for (const [category, entries] of byCategory) {
    lines.push(`**${category.charAt(0).toUpperCase() + category.slice(1)}**:`);
    for (const e of entries) {
      lines.push(`  - ${e.key} [${e.importance}/10]: ${e.value}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
