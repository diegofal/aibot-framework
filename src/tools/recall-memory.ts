import type { CoreMemoryEntry, CoreMemoryManager } from '../memory/core-memory';
import type { Tool, ToolResult } from './types';

type ToolLogger = {
  info: (msg: Record<string, unknown>) => void;
  error: (msg: Record<string, unknown>) => void;
};

/**
 * Create the recall_memory tool for self-directed memory retrieval.
 *
 * This tool allows the agent to actively search and retrieve relevant memories
 * from its structured core memory without relying on automatic prefetch.
 * Use cases: remembering user preferences, recalling goals, retrieving constraints.
 */
export function createRecallMemoryTool(coreMemory: CoreMemoryManager): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'recall_memory',
        description:
          'Recupera recuerdos relevantes de tu memoria estructurada sobre un tema específico. ' +
          'Úsalo cuando necesites recordar información sobre personas, preferencias, objetivos ' +
          'o restricciones sin depender de la carga automática de memoria. ' +
          'El tool busca en keys y values, filtra por categoría e importancia, ' +
          'y retorna resultados ordenados por relevancia.',
        parameters: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description:
                'Tema, concepto o palabra clave a recordar (ej: "Diego", "preferencias de trabajo", "objetivos Q1")',
            },
            context: {
              type: 'string',
              description: 'Contexto adicional para refinar la búsqueda (opcional)',
            },
            category: {
              type: 'string',
              description: 'Filtrar por categoría específica',
              enum: ['identity', 'relationships', 'preferences', 'goals', 'constraints'],
            },
            min_importance: {
              type: 'number',
              description:
                'Importancia mínima (1-10). Solo retorna hechos con importance >= este valor',
              minimum: 1,
              maximum: 10,
            },
            max_results: {
              type: 'number',
              description: 'Máximo de resultados a retornar (default: 5)',
              minimum: 1,
              maximum: 20,
            },
          },
          required: ['topic'],
        },
      },
    },
    async execute(args: Record<string, unknown>, logger?: ToolLogger): Promise<ToolResult> {
      const topic = String(args.topic);
      const context = args.context ? String(args.context) : undefined;
      const category = args.category ? String(args.category) : undefined;
      const minImportance =
        typeof args.min_importance === 'number' ? args.min_importance : undefined;
      const maxResults = typeof args.max_results === 'number' ? args.max_results : 5;

      try {
        // Build search query: combine topic + context if provided
        const searchQuery = context ? `${topic} ${context}` : topic;
        const botId = typeof args._botId === 'string' ? args._botId : undefined;
        const userId = typeof args._userId === 'string' ? args._userId : undefined;
        if (!botId) {
          return { success: false, content: 'Internal error: missing _botId context' };
        }

        // Search core memory (includes user-specific + shared entries)
        let results = await coreMemory.search(searchQuery, category, maxResults * 2, botId, userId);

        // Filter by minimum importance if specified
        if (minImportance !== undefined) {
          results = results.filter((r) => r.importance >= minImportance);
        }

        // Limit to max_results
        results = results.slice(0, maxResults);

        logger?.info({
          topic,
          category,
          minImportance,
          found: results.length,
          query: searchQuery,
        });

        if (results.length === 0) {
          return {
            success: true,
            content: `No recuerdo nada sobre "${topic}"${category ? ` en la categoría ${category}` : ''}${minImportance ? ` con importancia >= ${minImportance}` : ''}.`,
          };
        }

        const formatted = formatRecallResults(results, topic);
        return {
          success: true,
          content: formatted,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.error({ topic, error: message });
        return {
          success: false,
          content: `Error al recuperar recuerdos: ${message}`,
        };
      }
    },
  };
}

function formatRecallResults(results: CoreMemoryEntry[], topic: string): string {
  const lines: string[] = [];
  lines.push(`Recuerdos sobre "${topic}":`);
  lines.push('');

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
      const importanceBadge = e.importance >= 8 ? '🔴' : e.importance >= 5 ? '🟡' : '🟢';
      lines.push(`  ${importanceBadge} ${e.key}: ${e.value}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
