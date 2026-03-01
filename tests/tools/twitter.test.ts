import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { TwitterConfig } from '../../src/config';
import {
  createTwitterPostTool,
  createTwitterReadTool,
  createTwitterSearchTool,
} from '../../src/tools/twitter';

const mockLogger = {
  info: mock(() => {}),
  debug: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  child: () => mockLogger,
} as any;

const baseConfig: TwitterConfig = {
  enabled: true,
  apiKey: 'test-api-key',
  apiSecret: 'test-api-secret',
  bearerToken: 'test-bearer-token',
  accessToken: 'test-access-token',
  accessSecret: 'test-access-secret',
  cacheTtlMs: 120_000,
  timeout: 30_000,
};

const readOnlyConfig: TwitterConfig = {
  ...baseConfig,
  accessToken: undefined,
  accessSecret: undefined,
};

const originalFetch = globalThis.fetch;

function mockTwitterFetch(responseData: unknown, statusCode = 200) {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(responseData), {
        status: statusCode,
        statusText: statusCode === 200 ? 'OK' : 'Error',
        headers: { 'Content-Type': 'application/json' },
      })
    )
  ) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// --- twitter_search ---

describe('twitter_search', () => {
  test('definition has correct name and required params', () => {
    const tool = createTwitterSearchTool(baseConfig);
    expect(tool.definition.function.name).toBe('twitter_search');
    expect(tool.definition.function.parameters.required).toEqual(['query']);
  });

  test('returns error for missing query', async () => {
    const tool = createTwitterSearchTool(baseConfig);
    const result = await tool.execute({}, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing');
  });

  test('sends bearer token in Authorization header', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(
        new Response(JSON.stringify({ data: [], meta: { result_count: 0 } }), { status: 200 })
      );
    }) as typeof fetch;

    const tool = createTwitterSearchTool(baseConfig);
    await tool.execute({ query: 'test' }, mockLogger);
    expect(capturedHeaders.Authorization).toBe('Bearer test-bearer-token');
  });

  test('returns formatted results with metrics', async () => {
    mockTwitterFetch({
      data: [
        {
          id: '123456',
          text: 'Hello world tweet',
          author_id: 'user1',
          created_at: '2026-02-24T10:00:00.000Z',
          public_metrics: { like_count: 42, retweet_count: 10, reply_count: 5, quote_count: 2 },
        },
      ],
      includes: {
        users: [{ id: 'user1', name: 'Test User', username: 'testuser' }],
      },
      meta: { result_count: 1 },
    });

    const tool = createTwitterSearchTool(baseConfig);
    const result = await tool.execute({ query: 'hello' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Hello world tweet');
    expect(result.content).toContain('@testuser');
    expect(result.content).toContain('42 likes');
    expect(result.content).toContain('10 RTs');
    expect(result.content).toContain('EXTERNAL_UNTRUSTED_CONTENT');
  });

  test('returns message for empty results', async () => {
    mockTwitterFetch({ data: [], meta: { result_count: 0 } });

    const tool = createTwitterSearchTool(baseConfig);
    const result = await tool.execute({ query: 'nothing' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('No tweets found');
  });

  test('handles API errors', async () => {
    mockTwitterFetch({ error: 'rate limited' }, 429);

    const tool = createTwitterSearchTool(baseConfig);
    const result = await tool.execute({ query: 'test' }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('429');
  });

  test('caches results', async () => {
    mockTwitterFetch({
      data: [{ id: '1', text: 'cached', author_id: 'u1', created_at: '2026-01-01T00:00:00Z' }],
      includes: { users: [{ id: 'u1', name: 'U', username: 'u' }] },
    });

    const tool = createTwitterSearchTool(baseConfig);
    const r1 = await tool.execute({ query: 'cache-test' }, mockLogger);
    const r2 = await tool.execute({ query: 'cache-test' }, mockLogger);
    expect(r1.content).toBe(r2.content);
  });
});

// --- twitter_read ---

describe('twitter_read', () => {
  test('definition has correct name', () => {
    const tool = createTwitterReadTool(baseConfig);
    expect(tool.definition.function.name).toBe('twitter_read');
  });

  test('returns error when no username or tweet_id', async () => {
    const tool = createTwitterReadTool(baseConfig);
    const result = await tool.execute({}, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Provide either');
  });

  test('reads single tweet by ID', async () => {
    mockTwitterFetch({
      data: {
        id: '789',
        text: 'Single tweet content',
        author_id: 'a1',
        created_at: '2026-02-24T12:00:00Z',
        public_metrics: { like_count: 100, retweet_count: 20, reply_count: 3, quote_count: 1 },
      },
      includes: { users: [{ id: 'a1', name: 'Author', username: 'author' }] },
    });

    const tool = createTwitterReadTool(baseConfig);
    const result = await tool.execute({ tweet_id: '789' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Single tweet content');
    expect(result.content).toContain('@author');
  });

  test('reads user timeline', async () => {
    let callCount = 0;
    globalThis.fetch = mock((url: string) => {
      callCount++;
      if (callCount === 1) {
        // User lookup
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: { id: 'uid1', name: 'Timeline User', username: 'timeline' } }),
            { status: 200 }
          )
        );
      }
      // Tweets
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: 't1', text: 'First tweet', created_at: '2026-02-24T10:00:00Z' },
              { id: 't2', text: 'Second tweet', created_at: '2026-02-24T09:00:00Z' },
            ],
          }),
          { status: 200 }
        )
      );
    }) as typeof fetch;

    const tool = createTwitterReadTool(baseConfig);
    const result = await tool.execute({ username: '@timeline' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('First tweet');
    expect(result.content).toContain('Second tweet');
    expect(result.content).toContain('@timeline');
  });

  test('handles user not found', async () => {
    mockTwitterFetch({ data: null }, 200);

    const tool = createTwitterReadTool(baseConfig);
    const result = await tool.execute({ username: 'nonexistent' }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('not found');
  });
});

// --- twitter_post ---

describe('twitter_post', () => {
  test('definition has correct name and includes ask_permission instruction', () => {
    const tool = createTwitterPostTool(baseConfig);
    expect(tool.definition.function.name).toBe('twitter_post');
    expect(tool.definition.function.description).toContain('ask_permission');
  });

  test('returns error for missing text', async () => {
    const tool = createTwitterPostTool(baseConfig);
    const result = await tool.execute({}, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing');
  });

  test('rejects tweets over 280 characters', async () => {
    const tool = createTwitterPostTool(baseConfig);
    const result = await tool.execute({ text: 'x'.repeat(281) }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('281/280');
  });

  test('rejects when write credentials are missing', async () => {
    const tool = createTwitterPostTool(readOnlyConfig);
    const result = await tool.execute({ text: 'test tweet' }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('not configured');
  });

  test('posts tweet successfully', async () => {
    mockTwitterFetch({ data: { id: 'new-tweet-123', text: 'Posted!' } });

    const tool = createTwitterPostTool(baseConfig);
    const result = await tool.execute({ text: 'Posted!' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('new-tweet-123');
    expect(result.content).toContain('successfully');
  });

  test('sends OAuth 1.0a Authorization header', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(
        new Response(JSON.stringify({ data: { id: '1', text: 'test' } }), { status: 200 })
      );
    }) as typeof fetch;

    const tool = createTwitterPostTool(baseConfig);
    await tool.execute({ text: 'auth test' }, mockLogger);
    expect(capturedHeaders.Authorization).toMatch(/^OAuth /);
    expect(capturedHeaders.Authorization).toContain('oauth_consumer_key');
    expect(capturedHeaders.Authorization).toContain('oauth_signature');
  });

  test('handles API errors on post', async () => {
    mockTwitterFetch({ error: 'forbidden' }, 403);

    const tool = createTwitterPostTool(baseConfig);
    const result = await tool.execute({ text: 'test' }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('403');
  });
});
