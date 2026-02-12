import type { Tool, ToolResult } from './types';
import { wrapExternalContent } from './types';
import { TtlCache } from './cache';
import type { Logger } from '../logger';

export interface WebFetchConfig {
  maxContentLength?: number;
  timeout?: number;
  cacheTtlMs?: number;
}

/**
 * Regex patterns for SSRF-dangerous hostnames / IPs
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/,
  /^\[fc/i, // fc00::/7 unique-local
  /^\[fd/i,
  /^\[fe80/i, // link-local
];

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname));
}

/**
 * Strip HTML to plain text (regex-based, no dependencies)
 */
function htmlToText(html: string): string {
  let text = html;
  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Replace <br>, <p>, <div>, <li> with newlines
  text = text.replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, '\n');
  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#039;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function createWebFetchTool(config: WebFetchConfig = {}): Tool {
  const maxContentLength = config.maxContentLength ?? 50_000;
  const timeout = config.timeout ?? 30_000;
  const cache = new TtlCache<string>(config.cacheTtlMs);

  return {
    definition: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description:
          'Fetch and read the contents of a web page. Use this when you need to read a specific URL.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to fetch',
            },
          },
          required: ['url'],
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      logger: Logger
    ): Promise<ToolResult> {
      const rawUrl = String(args.url ?? '').trim();
      if (!rawUrl) {
        return { success: false, content: 'Missing required parameter: url' };
      }

      // Validate URL
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return { success: false, content: `Invalid URL: ${rawUrl}` };
      }

      // Scheme check
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return {
          success: false,
          content: `Blocked: only http and https URLs are allowed`,
        };
      }

      // SSRF protection
      if (isBlockedHost(parsed.hostname)) {
        return {
          success: false,
          content: `Blocked: cannot fetch private/local addresses`,
        };
      }

      // Check cache
      const cached = cache.get(rawUrl);
      if (cached) {
        logger.debug({ url: rawUrl }, 'web_fetch cache hit');
        return { success: true, content: cached };
      }

      try {
        logger.info({ url: rawUrl }, 'Executing web_fetch');

        const response = await fetch(rawUrl, {
          headers: {
            'User-Agent': 'AIBot/1.0 (Web Fetch Tool)',
            Accept: 'text/html, application/xhtml+xml, text/plain, */*',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(timeout),
        });

        if (!response.ok) {
          return {
            success: false,
            content: `Fetch failed: ${response.status} ${response.statusText}`,
          };
        }

        const contentType = response.headers.get('content-type') ?? '';
        const body = await response.text();

        let text: string;
        if (contentType.includes('text/html') || contentType.includes('xhtml')) {
          text = htmlToText(body);
        } else {
          text = body;
        }

        // Truncate if needed
        if (text.length > maxContentLength) {
          text = text.slice(0, maxContentLength) + '\n\n[Content truncated]';
        }

        const content = wrapExternalContent(
          `Content from ${rawUrl}:\n\n${text}`
        );

        cache.set(rawUrl, content);
        logger.debug(
          { url: rawUrl, length: text.length },
          'web_fetch completed'
        );

        return { success: true, content };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error({ error: message, url: rawUrl }, 'web_fetch failed');
        return { success: false, content: `Fetch failed: ${message}` };
      }
    },
  };
}
