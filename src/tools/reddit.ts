import type { Tool, ToolResult } from './types';
import { wrapExternalContent } from './types';
import { TtlCache } from './cache';
import { apiRequest, RateLimiter } from './api-client';
import type { Logger } from '../logger';
import type { RedditConfig } from '../config';

// --- Reddit OAuth2 token management ---

class RedditAuth {
  private token: string | null = null;
  private expiresAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(private config: RedditConfig) {}

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) {
      return this.token;
    }

    // Mutex: if a refresh is already in flight, wait for it
    if (this.refreshPromise) {
      await this.refreshPromise;
      return this.token!;
    }

    this.refreshPromise = this.refresh();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
    return this.token!;
  }

  private async refresh(): Promise<void> {
    const credentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString('base64');

    const body = new URLSearchParams({
      grant_type: 'password',
      username: this.config.username,
      password: this.config.password,
    });

    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.config.userAgent,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(this.config.timeout),
    });

    if (!response.ok) {
      throw new Error(`Reddit auth failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.token = data.access_token;
    // Refresh 60s before actual expiry
    this.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  }
}

// --- Response formatting ---

interface RedditPost {
  title: string;
  author: string;
  subreddit: string;
  score: number;
  num_comments: number;
  url: string;
  selftext?: string;
  permalink: string;
  created_utc: number;
}

interface RedditComment {
  author: string;
  body: string;
  score: number;
}

function formatPost(post: RedditPost, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const date = new Date(post.created_utc * 1000).toISOString().split('T')[0];
  const lines = [
    `${prefix}${post.title}`,
    `   r/${post.subreddit} | u/${post.author} | ${post.score} pts | ${post.num_comments} comments | ${date}`,
    `   https://reddit.com${post.permalink}`,
  ];
  if (post.selftext) {
    const text = post.selftext.length > 300
      ? post.selftext.slice(0, 300) + '...'
      : post.selftext;
    lines.push(`   ${text}`);
  }
  return lines.join('\n');
}

function formatComment(comment: RedditComment, index: number): string {
  const body = comment.body.length > 200
    ? comment.body.slice(0, 200) + '...'
    : comment.body;
  return `${index + 1}. u/${comment.author} (${comment.score} pts)\n   ${body}`;
}

// --- Shared state ---

const rateLimiter = new RateLimiter(100, 60_000);

// --- Tool factories ---

export function createRedditSearchTool(config: RedditConfig): Tool {
  const cache = new TtlCache<string>(config.cacheTtlMs);
  const auth = new RedditAuth(config);

  return {
    definition: {
      type: 'function',
      function: {
        name: 'reddit_search',
        description: 'Search Reddit for posts matching a query. Returns titles, scores, and links.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            subreddit: { type: 'string', description: 'Limit search to a specific subreddit (optional)' },
            sort: {
              type: 'string',
              enum: ['hot', 'new', 'top', 'relevance'],
              description: 'Sort order (default: relevance)',
            },
            limit: {
              type: 'number',
              description: 'Number of results (1-25, default 10)',
            },
          },
          required: ['query'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const query = String(args.query ?? '').trim();
      if (!query) {
        return { success: false, content: 'Missing required parameter: query' };
      }

      const sort = String(args.sort ?? 'relevance');
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
      const subreddit = args.subreddit ? String(args.subreddit).replace(/^r\//, '') : undefined;

      const cacheKey = `search:${subreddit || '*'}:${query}:${sort}:${limit}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        logger.debug({ query }, 'reddit_search cache hit');
        return { success: true, content: cached };
      }

      try {
        await rateLimiter.acquire();
        const token = await auth.getToken();

        const url = new URL('https://oauth.reddit.com/search.json');
        url.searchParams.set('q', subreddit ? `subreddit:${subreddit} ${query}` : query);
        url.searchParams.set('sort', sort);
        url.searchParams.set('limit', String(limit));
        url.searchParams.set('restrict_sr', subreddit ? 'true' : 'false');

        logger.info({ query, subreddit, sort, limit }, 'Executing reddit_search');

        const result = await apiRequest<{ data: { children: Array<{ data: RedditPost }> } }>(url.toString(), {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': config.userAgent,
          },
          timeout: config.timeout,
        });

        if (!result.ok) {
          return { success: false, content: `Reddit API error: ${result.status} ${result.message}` };
        }

        const posts = result.data.data.children.map((c) => c.data);
        if (posts.length === 0) {
          const content = wrapExternalContent(`No Reddit results found for: "${query}"`);
          return { success: true, content };
        }

        const formatted = posts.map((p, i) => formatPost(p, i)).join('\n\n');
        const content = wrapExternalContent(`Reddit search results for "${query}":\n\n${formatted}`);

        cache.set(cacheKey, content);
        logger.debug({ query, resultCount: posts.length }, 'reddit_search completed');
        return { success: true, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message, query }, 'reddit_search failed');
        return { success: false, content: `Reddit search failed: ${message}` };
      }
    },
  };
}

export function createRedditHotTool(config: RedditConfig): Tool {
  const cache = new TtlCache<string>(config.cacheTtlMs);
  const auth = new RedditAuth(config);

  return {
    definition: {
      type: 'function',
      function: {
        name: 'reddit_hot',
        description: 'Get hot or top posts from a subreddit.',
        parameters: {
          type: 'object',
          properties: {
            subreddit: { type: 'string', description: 'Subreddit name (without r/ prefix)' },
            limit: {
              type: 'number',
              description: 'Number of posts (1-25, default 10)',
            },
            time: {
              type: 'string',
              enum: ['hour', 'day', 'week', 'month', 'year', 'all'],
              description: 'Time filter for top posts (default: day)',
            },
          },
          required: ['subreddit'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const subreddit = String(args.subreddit ?? '').replace(/^r\//, '').trim();
      if (!subreddit) {
        return { success: false, content: 'Missing required parameter: subreddit' };
      }

      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
      const time = String(args.time ?? 'day');

      const cacheKey = `hot:${subreddit}:${limit}:${time}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        logger.debug({ subreddit }, 'reddit_hot cache hit');
        return { success: true, content: cached };
      }

      try {
        await rateLimiter.acquire();
        const token = await auth.getToken();

        const url = new URL(`https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/hot.json`);
        url.searchParams.set('limit', String(limit));
        url.searchParams.set('t', time);

        logger.info({ subreddit, limit, time }, 'Executing reddit_hot');

        const result = await apiRequest<{ data: { children: Array<{ data: RedditPost }> } }>(url.toString(), {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': config.userAgent,
          },
          timeout: config.timeout,
        });

        if (!result.ok) {
          return { success: false, content: `Reddit API error: ${result.status} ${result.message}` };
        }

        const posts = result.data.data.children.map((c) => c.data);
        if (posts.length === 0) {
          const content = wrapExternalContent(`No posts found in r/${subreddit}`);
          return { success: true, content };
        }

        const formatted = posts.map((p, i) => formatPost(p, i)).join('\n\n');
        const content = wrapExternalContent(`Hot posts in r/${subreddit}:\n\n${formatted}`);

        cache.set(cacheKey, content);
        logger.debug({ subreddit, resultCount: posts.length }, 'reddit_hot completed');
        return { success: true, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message, subreddit }, 'reddit_hot failed');
        return { success: false, content: `Reddit hot failed: ${message}` };
      }
    },
  };
}

export function createRedditReadTool(config: RedditConfig): Tool {
  const cache = new TtlCache<string>(config.cacheTtlMs);
  const auth = new RedditAuth(config);

  return {
    definition: {
      type: 'function',
      function: {
        name: 'reddit_read',
        description: 'Read a Reddit post and its top comments. Accepts a post URL or post ID.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'Reddit post URL (e.g. https://reddit.com/r/sub/comments/abc123/title) or just the post ID (e.g. abc123)',
            },
          },
          required: ['url'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const input = String(args.url ?? '').trim();
      if (!input) {
        return { success: false, content: 'Missing required parameter: url' };
      }

      // Extract post ID from URL or use directly
      let postId = input;
      const urlMatch = input.match(/\/comments\/([a-z0-9]+)/i);
      if (urlMatch) {
        postId = urlMatch[1];
      }

      const cacheKey = `read:${postId}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        logger.debug({ postId }, 'reddit_read cache hit');
        return { success: true, content: cached };
      }

      try {
        await rateLimiter.acquire();
        const token = await auth.getToken();

        const url = `https://oauth.reddit.com/comments/${encodeURIComponent(postId)}.json?limit=10&depth=1`;

        logger.info({ postId }, 'Executing reddit_read');

        const result = await apiRequest<Array<{ data: { children: Array<{ data: RedditPost | RedditComment; kind: string }> } }>>(
          url,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'User-Agent': config.userAgent,
            },
            timeout: config.timeout,
          },
        );

        if (!result.ok) {
          return { success: false, content: `Reddit API error: ${result.status} ${result.message}` };
        }

        const data = result.data;
        if (!Array.isArray(data) || data.length === 0) {
          return { success: false, content: 'Post not found' };
        }

        // First listing = post, second listing = comments
        const post = data[0]?.data?.children?.[0]?.data as RedditPost | undefined;
        if (!post) {
          return { success: false, content: 'Post not found' };
        }

        const lines = [formatPost(post)];

        if (data.length > 1) {
          const comments = data[1].data.children
            .filter((c) => c.kind === 't1')
            .map((c) => c.data as RedditComment);

          if (comments.length > 0) {
            lines.push('\n--- Top Comments ---\n');
            lines.push(...comments.map((c, i) => formatComment(c, i)));
          }
        }

        const content = wrapExternalContent(lines.join('\n'));
        cache.set(cacheKey, content);
        logger.debug({ postId }, 'reddit_read completed');
        return { success: true, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message, postId }, 'reddit_read failed');
        return { success: false, content: `Reddit read failed: ${message}` };
      }
    },
  };
}
