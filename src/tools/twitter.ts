import crypto from 'node:crypto';
import type { Tool, ToolResult } from './types';
import { wrapExternalContent } from './types';
import { TtlCache } from './cache';
import { apiRequest, RateLimiter } from './api-client';
import type { Logger } from '../logger';
import type { TwitterConfig } from '../config';

// --- OAuth 1.0a signature ---

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function generateOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys.map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join('&');

  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const hmac = crypto.createHmac('sha1', signingKey);
  hmac.update(baseString);
  return hmac.digest('base64');
}

function buildOAuthHeader(
  method: string,
  url: string,
  config: TwitterConfig,
  extraParams?: Record<string, string>,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: config.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.accessToken!,
    oauth_version: '1.0',
  };

  const allParams = { ...oauthParams, ...(extraParams ?? {}) };
  const signature = generateOAuthSignature(method, url, allParams, config.apiSecret, config.accessSecret!);
  oauthParams['oauth_signature'] = signature;

  const header = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ');

  return `OAuth ${header}`;
}

// --- Response formatting ---

interface Tweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
  };
}

interface TwitterUser {
  id: string;
  name: string;
  username: string;
}

function formatTweet(tweet: Tweet, users: Map<string, TwitterUser>, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const user = tweet.author_id ? users.get(tweet.author_id) : undefined;
  const author = user ? `@${user.username} (${user.name})` : 'unknown';
  const metrics = tweet.public_metrics;
  const stats = metrics
    ? `${metrics.like_count} likes | ${metrics.retweet_count} RTs | ${metrics.reply_count} replies`
    : '';
  const date = tweet.created_at ? tweet.created_at.split('T')[0] : '';

  const lines = [`${prefix}${author} ${date}`, `   ${tweet.text}`];
  if (stats) lines.push(`   ${stats}`);
  lines.push(`   https://x.com/i/status/${tweet.id}`);
  return lines.join('\n');
}

// --- Shared state ---

const searchLimiter = new RateLimiter(300, 900_000);
const tweetLimiter = new RateLimiter(200, 900_000);

const TWITTER_API_BASE = 'https://api.twitter.com';

// --- Tool factories ---

export function createTwitterSearchTool(config: TwitterConfig): Tool {
  const cache = new TtlCache<string>(config.cacheTtlMs);

  return {
    definition: {
      type: 'function',
      function: {
        name: 'twitter_search',
        description: 'Search recent tweets on Twitter/X. Returns tweet text, author, metrics, and links.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (supports Twitter search operators)' },
            max_results: {
              type: 'number',
              description: 'Number of results (10-100, default 10)',
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

      const maxResults = Math.min(Math.max(Number(args.max_results) || 10, 10), 100);

      const cacheKey = `search:${query}:${maxResults}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        logger.debug({ query }, 'twitter_search cache hit');
        return { success: true, content: cached };
      }

      try {
        await searchLimiter.acquire();

        const url = new URL(`${TWITTER_API_BASE}/2/tweets/search/recent`);
        url.searchParams.set('query', query);
        url.searchParams.set('max_results', String(maxResults));
        url.searchParams.set('tweet.fields', 'author_id,created_at,public_metrics');
        url.searchParams.set('expansions', 'author_id');
        url.searchParams.set('user.fields', 'name,username');

        logger.info({ query, maxResults }, 'Executing twitter_search');

        const result = await apiRequest<{
          data?: Tweet[];
          includes?: { users?: TwitterUser[] };
          meta?: { result_count: number };
        }>(url.toString(), {
          headers: { 'Authorization': `Bearer ${config.bearerToken}` },
          timeout: config.timeout,
        });

        if (!result.ok) {
          return { success: false, content: `Twitter API error: ${result.status} ${result.message}` };
        }

        const tweets = result.data.data ?? [];
        const users = new Map<string, TwitterUser>();
        for (const u of result.data.includes?.users ?? []) {
          users.set(u.id, u);
        }

        if (tweets.length === 0) {
          const content = wrapExternalContent(`No tweets found for: "${query}"`);
          return { success: true, content };
        }

        const formatted = tweets.map((t, i) => formatTweet(t, users, i)).join('\n\n');
        const content = wrapExternalContent(`Twitter search results for "${query}":\n\n${formatted}`);

        cache.set(cacheKey, content);
        logger.debug({ query, resultCount: tweets.length }, 'twitter_search completed');
        return { success: true, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message, query }, 'twitter_search failed');
        return { success: false, content: `Twitter search failed: ${message}` };
      }
    },
  };
}

export function createTwitterReadTool(config: TwitterConfig): Tool {
  const cache = new TtlCache<string>(config.cacheTtlMs);

  return {
    definition: {
      type: 'function',
      function: {
        name: 'twitter_read',
        description: 'Read a specific tweet by ID, or recent tweets from a user by username.',
        parameters: {
          type: 'object',
          properties: {
            username: { type: 'string', description: 'Twitter username (without @) to read recent tweets' },
            tweet_id: { type: 'string', description: 'Specific tweet ID to read' },
          },
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const username = args.username ? String(args.username).replace(/^@/, '').trim() : undefined;
      const tweetId = args.tweet_id ? String(args.tweet_id).trim() : undefined;

      if (!username && !tweetId) {
        return { success: false, content: 'Provide either username or tweet_id' };
      }

      const cacheKey = `read:${username || ''}:${tweetId || ''}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        logger.debug({ username, tweetId }, 'twitter_read cache hit');
        return { success: true, content: cached };
      }

      try {
        await searchLimiter.acquire();

        if (tweetId) {
          // Read single tweet
          const url = new URL(`${TWITTER_API_BASE}/2/tweets/${tweetId}`);
          url.searchParams.set('tweet.fields', 'author_id,created_at,public_metrics');
          url.searchParams.set('expansions', 'author_id');
          url.searchParams.set('user.fields', 'name,username');

          logger.info({ tweetId }, 'Executing twitter_read (single tweet)');

          const result = await apiRequest<{
            data?: Tweet;
            includes?: { users?: TwitterUser[] };
          }>(url.toString(), {
            headers: { 'Authorization': `Bearer ${config.bearerToken}` },
            timeout: config.timeout,
          });

          if (!result.ok) {
            return { success: false, content: `Twitter API error: ${result.status} ${result.message}` };
          }

          if (!result.data.data) {
            return { success: false, content: 'Tweet not found' };
          }

          const users = new Map<string, TwitterUser>();
          for (const u of result.data.includes?.users ?? []) {
            users.set(u.id, u);
          }

          const content = wrapExternalContent(formatTweet(result.data.data, users));
          cache.set(cacheKey, content);
          return { success: true, content };
        }

        // Read user timeline
        // First resolve username → user ID
        const userUrl = `${TWITTER_API_BASE}/2/users/by/username/${encodeURIComponent(username!)}`;
        logger.info({ username }, 'Executing twitter_read (user timeline)');

        const userResult = await apiRequest<{ data?: { id: string; name: string; username: string } }>(
          userUrl,
          {
            headers: { 'Authorization': `Bearer ${config.bearerToken}` },
            timeout: config.timeout,
          },
        );

        if (!userResult.ok || !userResult.data.data) {
          return { success: false, content: `User @${username} not found` };
        }

        const userId = userResult.data.data.id;
        const tweetsUrl = new URL(`${TWITTER_API_BASE}/2/users/${userId}/tweets`);
        tweetsUrl.searchParams.set('max_results', '10');
        tweetsUrl.searchParams.set('tweet.fields', 'created_at,public_metrics');

        await searchLimiter.acquire();

        const tweetsResult = await apiRequest<{ data?: Tweet[] }>(tweetsUrl.toString(), {
          headers: { 'Authorization': `Bearer ${config.bearerToken}` },
          timeout: config.timeout,
        });

        if (!tweetsResult.ok) {
          return { success: false, content: `Twitter API error: ${tweetsResult.status} ${tweetsResult.message}` };
        }

        const tweets = tweetsResult.data.data ?? [];
        if (tweets.length === 0) {
          const content = wrapExternalContent(`No recent tweets from @${username}`);
          return { success: true, content };
        }

        const userInfo = userResult.data.data;
        const users = new Map<string, TwitterUser>();
        users.set(userId, { id: userId, name: userInfo.name, username: userInfo.username });

        const tweetsWithAuthor = tweets.map((t) => ({ ...t, author_id: userId }));
        const formatted = tweetsWithAuthor.map((t, i) => formatTweet(t, users, i)).join('\n\n');
        const content = wrapExternalContent(`Recent tweets from @${username}:\n\n${formatted}`);

        cache.set(cacheKey, content);
        logger.debug({ username, resultCount: tweets.length }, 'twitter_read completed');
        return { success: true, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message, username, tweetId }, 'twitter_read failed');
        return { success: false, content: `Twitter read failed: ${message}` };
      }
    },
  };
}

export function createTwitterPostTool(config: TwitterConfig): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'twitter_post',
        description:
          'Post a tweet on Twitter/X. IMPORTANT: Before posting, use ask_permission to get operator approval. Max 280 characters.',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'Tweet text (max 280 characters)',
            },
          },
          required: ['text'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const text = String(args.text ?? '').trim();
      if (!text) {
        return { success: false, content: 'Missing required parameter: text' };
      }
      if (text.length > 280) {
        return { success: false, content: `Tweet too long: ${text.length}/280 characters` };
      }
      if (!config.accessToken || !config.accessSecret) {
        return { success: false, content: 'Twitter write credentials not configured (accessToken, accessSecret)' };
      }

      try {
        await tweetLimiter.acquire();

        const postUrl = `${TWITTER_API_BASE}/2/tweets`;
        const authHeader = buildOAuthHeader('POST', postUrl, config);

        logger.info({ textLength: text.length }, 'Executing twitter_post');

        const response = await fetch(postUrl, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(config.timeout),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          logger.error({ status: response.status, body: body.slice(0, 200) }, 'twitter_post API error');
          return { success: false, content: `Twitter API error: ${response.status} ${body.slice(0, 200)}` };
        }

        const data = (await response.json()) as { data?: { id: string; text: string } };
        if (!data.data) {
          return { success: false, content: 'Unexpected response from Twitter API' };
        }

        const content = `Tweet posted successfully!\nID: ${data.data.id}\nURL: https://x.com/i/status/${data.data.id}\nText: ${data.data.text}`;
        logger.info({ tweetId: data.data.id }, 'twitter_post completed');
        return { success: true, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'twitter_post failed');
        return { success: false, content: `Twitter post failed: ${message}` };
      }
    },
  };
}
