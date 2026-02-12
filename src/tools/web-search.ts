import type { Tool, ToolResult } from './types';
import { wrapExternalContent } from './types';
import { TtlCache } from './cache';
import type { Logger } from '../logger';

export interface WebSearchConfig {
  apiKey: string;
  maxResults?: number;
  timeout?: number;
  cacheTtlMs?: number;
}

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: {
    results: BraveSearchResult[];
  };
}

export function createWebSearchTool(config: WebSearchConfig): Tool {
  const maxResults = config.maxResults ?? 5;
  const timeout = config.timeout ?? 30_000;
  const cache = new TtlCache<string>(config.cacheTtlMs);

  return {
    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Search the web for current information. Use this when you need up-to-date facts, news, or information you don\'t have.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query',
            },
          },
          required: ['query'],
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      logger: Logger
    ): Promise<ToolResult> {
      const query = String(args.query ?? '').trim();
      if (!query) {
        return { success: false, content: 'Missing required parameter: query' };
      }

      // Check cache
      const cached = cache.get(query);
      if (cached) {
        logger.debug({ query }, 'web_search cache hit');
        return { success: true, content: cached };
      }

      try {
        logger.info({ query, maxResults }, 'Executing web_search');

        const url = new URL('https://api.search.brave.com/res/v1/web/search');
        url.searchParams.set('q', query);
        url.searchParams.set('count', String(maxResults));

        const response = await fetch(url.toString(), {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': config.apiKey,
          },
          signal: AbortSignal.timeout(timeout),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          logger.error(
            { status: response.status, body: body.slice(0, 200) },
            'Brave Search API error'
          );
          return {
            success: false,
            content: `Search API error: ${response.status} ${response.statusText}`,
          };
        }

        const data: BraveSearchResponse = await response.json();
        const results = data.web?.results ?? [];

        if (results.length === 0) {
          const content = wrapExternalContent(
            `No results found for: "${query}"`
          );
          return { success: true, content };
        }

        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.description}`
          )
          .join('\n\n');

        const content = wrapExternalContent(
          `Search results for "${query}":\n\n${formatted}`
        );

        cache.set(query, content);
        logger.debug(
          { query, resultCount: results.length },
          'web_search completed'
        );

        return { success: true, content };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error({ error: message, query }, 'web_search failed');
        return { success: false, content: `Search failed: ${message}` };
      }
    },
  };
}
