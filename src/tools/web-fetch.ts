import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger';
import { TtlCache } from './cache';
import type { Tool, ToolFailureKind, ToolResult } from './types';
import { wrapExternalContent } from './types';

export interface WebFetchConfig {
  maxContentLength?: number;
  timeout?: number;
  cacheTtlMs?: number;
  /** How long a host that answered with a bot challenge / 403 / 429 is skipped. Default 7 days. */
  blockedHostTtlMs?: number;
  /** JSON file the blocked hosts are kept in, so a block survives restarts. Absent → memory only. */
  blockedHostsFile?: string;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** A week: most bots run once a day, so a 1 h memory let every cycle hit the same wall again. */
export const DEFAULT_BLOCKED_HOST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type BlockedHosts = Map<string, { blockedBy: string; until: number }>;

/** Unexpired entries of a saved block list; a missing or unreadable file is an empty list. */
function loadBlockedHosts(file: string | undefined, nowMs: number): BlockedHosts {
  const out: BlockedHosts = new Map();
  if (!file) return out;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [host, v] of Object.entries(raw ?? {})) {
      const e = v as { blockedBy?: unknown; until?: unknown };
      if (typeof e?.blockedBy === 'string' && typeof e.until === 'number' && e.until > nowMs) {
        out.set(host, { blockedBy: e.blockedBy, until: e.until });
      }
    }
  } catch {
    // Missing or corrupt: start empty; the next block rewrites the file.
  }
  return out;
}

/** Write the list atomically (tmp + rename). Best effort: a failed save only loses persistence. */
function saveBlockedHosts(file: string, hosts: BlockedHosts): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(hosts), null, 2));
    renameSync(tmp, file);
  } catch {
    // Read-only or full disk: the in-memory block still applies.
  }
}

export interface FetchFailure {
  kind: ToolFailureKind;
  /** Text returned to the LLM. Names the cause and what to do instead. */
  message: string;
  /** Human label of the wall that refused us (only for `blocked`). */
  blockedBy?: string;
}

const BLOCKED_REMEDY =
  'This site cannot be read by web_fetch; use the search snippet or a different source. Do not retry this URL.';

const NOT_FOUND_REMEDY =
  'Only fetch URLs that appeared in web_search results or in page content you already fetched; never construct or guess a path.';

/**
 * Classify a non-OK HTTP response so the executor can tell a third-party
 * refusal (`blocked`) from a guessed URL (`not-found`) and a real error.
 * Pure: reads only status and headers.
 */
export function classifyHttpFailure(response: {
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
}): FetchFailure {
  const { status, statusText } = response;
  const statusLine = `${status} ${statusText}`.trim();

  if (response.headers.get('cf-mitigated')) {
    return blockedFailure('Cloudflare bot challenge', statusLine);
  }
  if (response.headers.get('x-vercel-mitigated')) {
    return blockedFailure('Vercel security checkpoint', statusLine);
  }
  if (status === 403) {
    return blockedFailure('the site (403 Forbidden)', statusLine);
  }
  if (status === 429) {
    return blockedFailure('the site (429 rate limit or bot check)', statusLine);
  }
  if (status === 404 || status === 410) {
    return {
      kind: 'not-found',
      message: `Page does not exist (${statusLine}). ${NOT_FOUND_REMEDY}`,
    };
  }
  return { kind: 'error', message: `Fetch failed: ${statusLine}` };
}

function blockedFailure(blockedBy: string, statusLine: string): FetchFailure {
  return {
    kind: 'blocked',
    blockedBy,
    message: `Blocked by ${blockedBy} (${statusLine}). ${BLOCKED_REMEDY}`,
  };
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
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const blockedHostTtlMs = config.blockedHostTtlMs ?? DEFAULT_BLOCKED_HOST_TTL_MS;
  /** hostname -> { blockedBy, until } for hosts that refused us recently */
  const blockedHosts = loadBlockedHosts(config.blockedHostsFile, now());

  function rememberBlockedHost(hostname: string, blockedBy: string): void {
    blockedHosts.set(hostname, { blockedBy, until: now() + blockedHostTtlMs });
    if (config.blockedHostsFile) {
      const t = now();
      for (const [h, e] of blockedHosts) if (e.until <= t) blockedHosts.delete(h);
      saveBlockedHosts(config.blockedHostsFile, blockedHosts);
    }
  }

  function recentBlock(hostname: string): { blockedBy: string } | undefined {
    const entry = blockedHosts.get(hostname);
    if (!entry) return undefined;
    if (now() >= entry.until) {
      blockedHosts.delete(hostname);
      return undefined;
    }
    return entry;
  }

  return {
    definition: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description:
          'Fetch and read the contents of a web page. Use this when you need to read a specific URL. ' +
          'Only pass URLs you have seen in a web_search result or in fetched page content; ' +
          'never construct or guess a path. If a site answers with a bot challenge, 403 or 429, ' +
          'do not retry it: use the search snippet or another source instead.',
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

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
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
          content: 'Blocked: only http and https URLs are allowed',
        };
      }

      // SSRF protection
      if (isBlockedHost(parsed.hostname)) {
        return {
          success: false,
          failureKind: 'policy',
          content: 'Blocked: cannot fetch private/local addresses',
        };
      }

      // Check cache
      const cached = cache.get(rawUrl);
      if (cached) {
        logger.debug({ url: rawUrl }, 'web_fetch cache hit');
        return { success: true, content: cached };
      }

      // A host that answered with a bot wall recently will do it again:
      // skip the network round-trip and the tool round.
      const block = recentBlock(parsed.hostname);
      if (block) {
        logger.info({ url: rawUrl, blockedBy: block.blockedBy }, 'web_fetch host blocked recently');
        return {
          success: false,
          failureKind: 'blocked',
          content: `${parsed.hostname} blocked web_fetch recently (${block.blockedBy}). ${BLOCKED_REMEDY}`,
        };
      }

      try {
        logger.info({ url: rawUrl }, 'Executing web_fetch');

        const response = await fetchImpl(rawUrl, {
          headers: {
            'User-Agent': 'AIBot/1.0 (Web Fetch Tool)',
            Accept: 'text/html, application/xhtml+xml, text/plain, */*',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(timeout),
        });

        if (!response.ok) {
          const failure = classifyHttpFailure(response);
          if (failure.kind === 'blocked' && failure.blockedBy) {
            rememberBlockedHost(parsed.hostname, failure.blockedBy);
          }
          logger.warn(
            {
              url: rawUrl,
              status: response.status,
              kind: failure.kind,
              blockedBy: failure.blockedBy,
            },
            'web_fetch non-OK response'
          );
          return { success: false, failureKind: failure.kind, content: failure.message };
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
          text = `${text.slice(0, maxContentLength)}\n\n[Content truncated]`;
        }

        const content = wrapExternalContent(`Content from ${rawUrl}:\n\n${text}`);

        cache.set(rawUrl, content);
        logger.debug({ url: rawUrl, length: text.length }, 'web_fetch completed');

        return { success: true, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message, url: rawUrl }, 'web_fetch failed');
        return { success: false, failureKind: 'error', content: `Fetch failed: ${message}` };
      }
    },
  };
}
