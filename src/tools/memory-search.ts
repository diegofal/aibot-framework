import type { Tool, ToolResult } from './types';
import type { MemoryManager } from '../memory/manager';
import type { Logger } from '../logger';

export function createMemorySearchTool(memoryManager: MemoryManager): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_search',
        description:
          'Search your persistent memory for relevant facts, preferences, conversation history, and context. ' +
          'Use this BEFORE answering questions about people, past conversations, preferences, or decisions.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query — describe what you are looking for',
            },
            maxResults: {
              type: 'number',
              description: 'Maximum number of results to return (default: 5)',
            },
            minScore: {
              type: 'number',
              description: 'Minimum relevance score 0-1 (default: 0.1)',
            },
          },
          required: ['query'],
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      logger: Logger,
    ): Promise<ToolResult> {
      const query = String(args.query ?? '').trim();
      if (!query) {
        return { success: false, content: 'Missing required parameter: query' };
      }

      const maxResults = typeof args.maxResults === 'number' ? args.maxResults : undefined;
      const minScore = typeof args.minScore === 'number' ? args.minScore : undefined;

      try {
        const results = await memoryManager.search(query, maxResults, minScore);

        if (results.length === 0) {
          return { success: true, content: 'No relevant memories found.' };
        }

        const formatted = results.map((r, i) => {
          const typeLabel = r.sourceType ?? 'memory';
          const header = `[${i + 1}] ${r.filePath} (${typeLabel}, lines ${r.startLine}-${r.endLine}, score: ${r.score}, via: ${r.source})`;
          return `${header}\n${r.content}`;
        }).join('\n\n---\n\n');

        logger.info({ query, results: results.length }, 'memory_search executed');
        return { success: true, content: formatted };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'memory_search failed');
        return { success: false, content: `Memory search failed: ${message}` };
      }
    },
  };
}
