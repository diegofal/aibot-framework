import type { Tool, ToolResult } from './types';
import type { MemoryManager } from '../memory/manager';
import type { Logger } from '../logger';

export function createMemoryGetTool(memoryManager: MemoryManager): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_get',
        description:
          'Retrieve the contents of a specific memory file with line numbers. ' +
          'Use this to read more context around a search result.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path to the memory file (e.g. "MEMORY.md")',
            },
            from: {
              type: 'number',
              description: 'Starting line number (1-indexed, default: 1)',
            },
            lines: {
              type: 'number',
              description: 'Number of lines to read (default: entire file)',
            },
          },
          required: ['path'],
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      logger: Logger,
    ): Promise<ToolResult> {
      const path = String(args.path ?? '').trim();
      if (!path) {
        return { success: false, content: 'Missing required parameter: path' };
      }

      // Security: reject absolute paths and directory traversal
      if (path.startsWith('/') || path.includes('..')) {
        return { success: false, content: 'Invalid path: absolute paths and ".." are not allowed' };
      }

      const from = typeof args.from === 'number' ? args.from : undefined;
      const lines = typeof args.lines === 'number' ? args.lines : undefined;

      try {
        const content = memoryManager.getFileLines(path, from, lines);

        if (content === null) {
          return { success: true, content: `File not found: ${path}` };
        }

        logger.info({ path, from, lines }, 'memory_get executed');
        return { success: true, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'memory_get failed');
        return { success: false, content: `Failed to read memory file: ${message}` };
      }
    },
  };
}
