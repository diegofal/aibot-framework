import type { Tool, ToolResult } from './types';
import type { DynamicToolStore } from './dynamic-tool-store';
import type { Logger } from '../logger';

// Patterns that indicate dangerous code in TypeScript tools
const DANGEROUS_PATTERNS = [
  /process\.exit/i,
  /child_process/i,
  /require\s*\(\s*['"](?:fs|path|os|child_process|net|http|https|dgram|cluster|worker_threads|vm)\s*['"]\s*\)/,
  /import\s+.*from\s+['"](?:fs|path|os|child_process|net|http|https|dgram|cluster|worker_threads|vm)['"]/,
  /Bun\.spawn|Bun\.spawnSync/,
  /eval\s*\(/,
  /Function\s*\(/,
  /rm\s+-rf/,
  /sudo\s+/,
  /chmod\s+/,
];

// Existing tool names that can't be used
const RESERVED_NAMES = new Set([
  'web_search', 'web_fetch', 'save_memory', 'update_soul', 'update_identity',
  'memory_search', 'memory_get', 'exec', 'file_read', 'file_write', 'file_edit',
  'process', 'get_datetime', 'phone_call', 'cron', 'delegate_to_bot', 'collaborate',
  'improve', 'manage_goals', 'create_tool',
]);

export function createCreateToolTool(store: DynamicToolStore, maxToolsPerBot: number): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'create_tool',
        description:
          'Create a new custom tool that will be available after human approval. ' +
          'Use this when you need a capability that your existing tools don\'t provide. ' +
          'The tool will be in "pending" status until a human reviews and approves it.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Tool name in snake_case (e.g., search_remote_jobs). Must be unique.',
            },
            description: {
              type: 'string',
              description: 'What the tool does. This description is shown to the LLM.',
            },
            type: {
              type: 'string',
              description: 'Tool type: "typescript" (Bun script that reads JSON args from argv[2]) or "command" (shell command with {{param}} placeholders)',
            },
            source: {
              type: 'string',
              description: 'The source code for the tool.',
            },
            parameters: {
              type: 'object',
              description: 'Parameter definitions as { paramName: { type, description, required } }',
            },
            scope: {
              type: 'string',
              description: 'Who can use this tool: "all" (default) or a specific bot ID',
            },
          },
          required: ['name', 'description', 'type', 'source'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const name = String(args.name ?? '').trim();
      const description = String(args.description ?? '').trim();
      const type = String(args.type ?? '').trim() as 'typescript' | 'command';
      const source = String(args.source ?? '').trim();
      const scope = String(args.scope ?? 'all').trim();
      const botId = String(args._botId ?? '');
      const params = (args.parameters ?? {}) as Record<string, { type: string; description: string; required?: boolean }>;

      // Validation
      if (!name || !description || !source) {
        return { success: false, content: 'Missing required parameters: name, description, source' };
      }

      if (type !== 'typescript' && type !== 'command') {
        return { success: false, content: 'Type must be "typescript" or "command"' };
      }

      if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        return { success: false, content: 'Name must be snake_case (lowercase letters, numbers, underscores)' };
      }

      if (RESERVED_NAMES.has(name)) {
        return { success: false, content: `Name "${name}" conflicts with a built-in tool` };
      }

      // Check per-bot limit
      const existing = store.list().filter((m) => m.createdBy === botId);
      if (existing.length >= maxToolsPerBot) {
        return { success: false, content: `Tool limit reached (${maxToolsPerBot} per bot)` };
      }

      // Static analysis for TypeScript tools
      if (type === 'typescript') {
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(source)) {
            return {
              success: false,
              content: `Source code contains a restricted pattern: ${pattern.source}. Tool creation rejected for safety.`,
            };
          }
        }
      }

      try {
        const meta = store.create(
          { name, description, type, createdBy: botId, scope, parameters: params },
          source,
        );

        logger.info({ toolId: meta.id, name, type, createdBy: botId }, 'Dynamic tool created (pending approval)');

        return {
          success: true,
          content:
            `Tool "${name}" created successfully and is now pending human approval. ` +
            `It will become available once approved in the web UI. ` +
            `Tool ID: ${meta.id}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, content: `Failed to create tool: ${msg}` };
      }
    },
  };
}
