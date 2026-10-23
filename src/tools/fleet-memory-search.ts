import { textSimilarity, titleTokens } from '../hygiene/text-utils';
import type { Logger } from '../logger';
/**
 * `fleet_memory_search`: a bot asks what the whole fleet knows (the watcher's
 * graph, docs/plans/watcher-implementation-plan.md phase 2). Bots never get
 * the graph in a prompt; this tool is the one way in. Ranked by embedding
 * similarity when the watcher can embed, else by text (Jaccard, or the share
 * of the query's words a neuron contains, whichever is higher). Archived
 * neurons are left out. Results are wrapped as external content: the graph
 * holds what other bots and the watcher's model wrote. Not sensitive: tier 0
 * reduces every non-operator message to topic words before it reaches the
 * graph, so no private conversation is in it.
 */
import { cosineSimilarity } from '../memory/search';
import type { Neuron } from '../watcher/types';
import { type Tool, type ToolResult, wrapExternalContent } from './types';

export const FLEET_MEMORY_MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const MIN_TEXT_SCORE = 0.15;
const MIN_EMBED_SCORE = 0.5;

/** What the tool reads: the watcher's graph and, when it has one, its embedder. */
export interface FleetMemorySource {
  graph: {
    list(): Neuron[];
    findByKey(key: string): Neuron | undefined;
    getEmbedding(id: string): number[] | undefined;
  };
  embed?: (text: string) => Promise<number[]>;
}

function coverage(query: string[], text: string): number {
  if (query.length === 0) return 0;
  const words = new Set(titleTokens(text));
  return query.filter((w) => words.has(w)).length / query.length;
}

function botLabel(source: FleetMemorySource, botId: string): string {
  return source.graph.findByKey(`bot:${botId}`)?.meta?.name ?? botId;
}

export function createFleetMemorySearchTool(getSource: () => FleetMemorySource | undefined): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fleet_memory_search',
        description:
          'Search what the whole fleet of agents knows: facts, topics, people and surprises other agents learned, ' +
          'kept by the fleet watcher. Use it when the answer may be known to another agent, or before saying you do not know.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you are looking for, in a few words' },
            limit: {
              type: 'number',
              description: `Maximum results (default ${DEFAULT_RESULTS}, at most ${FLEET_MEMORY_MAX_RESULTS})`,
            },
          },
          required: ['query'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const query = String(args.query ?? '').trim();
      if (!query) return { success: false, content: 'Missing required parameter: query' };
      const source = getSource();
      if (!source) {
        return { success: false, content: 'The fleet memory is not available right now.' };
      }
      const raw =
        typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? args.limit
          : DEFAULT_RESULTS;
      const limit = Math.max(1, Math.min(FLEET_MEMORY_MAX_RESULTS, Math.floor(raw)));

      let queryVec: number[] | undefined;
      if (source.embed) {
        try {
          queryVec = await source.embed(query);
        } catch (err) {
          logger.warn?.({ err }, 'fleet_memory_search: embedding failed, ranking by text');
        }
      }
      const qWords = titleTokens(query);
      const scored: Array<{ n: Neuron; score: number }> = [];
      for (const n of source.graph.list()) {
        if (n.archivedAt) continue;
        const text = Math.max(textSimilarity(query, n.text), coverage(qWords, n.text));
        let score = text >= MIN_TEXT_SCORE ? text : 0;
        const vec = queryVec ? source.graph.getEmbedding(n.id) : undefined;
        if (queryVec && vec && vec.length === queryVec.length) {
          const cos = cosineSimilarity(queryVec, vec);
          if (cos >= MIN_EMBED_SCORE) score = Math.max(score, cos);
        }
        if (score > 0) scored.push({ n, score });
      }
      scored.sort((a, b) => b.score - a.score || b.n.activations - a.n.activations);
      const top = scored.slice(0, limit);
      if (top.length === 0) {
        return {
          success: true,
          content: wrapExternalContent('Nothing in the fleet memory matches.'),
        };
      }
      const lines = top.map(({ n }, i) => {
        const bots = n.support.bots.map((b) => botLabel(source, b)).join(', ');
        const when = n.lastActivatedAt.slice(0, 10);
        const known = bots ? `known by ${bots}` : 'known by the watcher';
        return `${i + 1}. [${n.kind}] ${n.text} (${known}; last seen ${when})`;
      });
      logger.info?.({ query, results: top.length }, 'fleet_memory_search executed');
      return { success: true, content: wrapExternalContent(lines.join('\n')) };
    },
  };
}
