import { describe, test, expect, mock, afterEach } from 'bun:test';
import { createRedditSearchTool, createRedditHotTool, createRedditReadTool } from '../../src/tools/reddit';
import type { RedditConfig } from '../../src/config';

const mockLogger = {
  info: mock(() => {}),
  debug: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  child: () => mockLogger,
} as any;

const baseConfig: RedditConfig = {
  enabled: true,
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  username: 'testuser',
  password: 'testpass',
  userAgent: 'AIBot:test:1.0 (by /u/test)',
  cacheTtlMs: 300_000,
  timeout: 30_000,
};

const originalFetch = globalThis.fetch;

function mockRedditFetch(responseData: unknown, statusCode = 200) {
  let callCount = 0;
  globalThis.fetch = mock((url: string, _init?: RequestInit) => {
    callCount++;
    // First call is always the OAuth token request
    if (callCount === 1 || url.includes('access_token')) {
      return Promise.resolve(new Response(
        JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    }
    return Promise.resolve(new Response(
      JSON.stringify(responseData),
      { status: statusCode, statusText: statusCode === 200 ? 'OK' : 'Error', headers: { 'Content-Type': 'application/json' } },
    ));
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// --- reddit_search ---

describe('reddit_search', () => {
  test('definition has correct name and required params', () => {
    const tool = createRedditSearchTool(baseConfig);
    expect(tool.definition.function.name).toBe('reddit_search');
    expect(tool.definition.function.parameters.required).toEqual(['query']);
  });

  test('returns error for missing query', async () => {
    const tool = createRedditSearchTool(baseConfig);
    const result = await tool.execute({}, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing');
  });

  test('returns formatted results', async () => {
    mockRedditFetch({
      data: {
        children: [
          {
            data: {
              title: 'Test Post',
              author: 'user1',
              subreddit: 'test',
              score: 42,
              num_comments: 5,
              url: 'https://example.com',
              permalink: '/r/test/comments/abc123/test_post',
              created_utc: 1700000000,
            },
          },
        ],
      },
    });

    const tool = createRedditSearchTool(baseConfig);
    const result = await tool.execute({ query: 'test' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Test Post');
    expect(result.content).toContain('u/user1');
    expect(result.content).toContain('42 pts');
    expect(result.content).toContain('EXTERNAL_UNTRUSTED_CONTENT');
  });

  test('returns message for empty results', async () => {
    mockRedditFetch({ data: { children: [] } });

    const tool = createRedditSearchTool(baseConfig);
    const result = await tool.execute({ query: 'nothing' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('No Reddit results');
  });

  test('handles API errors', async () => {
    mockRedditFetch({ error: 'forbidden' }, 403);

    const tool = createRedditSearchTool(baseConfig);
    const result = await tool.execute({ query: 'test' }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('403');
  });

  test('caches results', async () => {
    mockRedditFetch({
      data: {
        children: [
          {
            data: {
              title: 'Cached Post',
              author: 'user1',
              subreddit: 'test',
              score: 10,
              num_comments: 1,
              url: 'https://example.com',
              permalink: '/r/test/comments/def456/cached',
              created_utc: 1700000000,
            },
          },
        ],
      },
    });

    const tool = createRedditSearchTool(baseConfig);
    const r1 = await tool.execute({ query: 'cache-test' }, mockLogger);
    const r2 = await tool.execute({ query: 'cache-test' }, mockLogger);
    expect(r1.content).toBe(r2.content);
  });
});

// --- reddit_hot ---

describe('reddit_hot', () => {
  test('definition has correct name and required params', () => {
    const tool = createRedditHotTool(baseConfig);
    expect(tool.definition.function.name).toBe('reddit_hot');
    expect(tool.definition.function.parameters.required).toEqual(['subreddit']);
  });

  test('returns error for missing subreddit', async () => {
    const tool = createRedditHotTool(baseConfig);
    const result = await tool.execute({}, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing');
  });

  test('strips r/ prefix from subreddit', async () => {
    let capturedUrl = '';
    let callCount = 0;
    globalThis.fetch = mock((url: string) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response(
          JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
          { status: 200 },
        ));
      }
      capturedUrl = url.toString();
      return Promise.resolve(new Response(
        JSON.stringify({ data: { children: [] } }),
        { status: 200 },
      ));
    }) as typeof fetch;

    const tool = createRedditHotTool(baseConfig);
    await tool.execute({ subreddit: 'r/programming' }, mockLogger);
    expect(capturedUrl).toContain('/r/programming/hot');
    expect(capturedUrl).not.toContain('/r/r%2F');
  });

  test('returns formatted hot posts', async () => {
    mockRedditFetch({
      data: {
        children: [
          {
            data: {
              title: 'Hot Post',
              author: 'hotuser',
              subreddit: 'programming',
              score: 1234,
              num_comments: 200,
              url: 'https://example.com',
              permalink: '/r/programming/comments/xyz/hot_post',
              created_utc: 1700000000,
            },
          },
        ],
      },
    });

    const tool = createRedditHotTool(baseConfig);
    const result = await tool.execute({ subreddit: 'programming' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Hot Post');
    expect(result.content).toContain('1234 pts');
  });
});

// --- reddit_read ---

describe('reddit_read', () => {
  test('definition has correct name and required params', () => {
    const tool = createRedditReadTool(baseConfig);
    expect(tool.definition.function.name).toBe('reddit_read');
    expect(tool.definition.function.parameters.required).toEqual(['url']);
  });

  test('returns error for missing url', async () => {
    const tool = createRedditReadTool(baseConfig);
    const result = await tool.execute({}, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing');
  });

  test('extracts post ID from full URL', async () => {
    let capturedUrl = '';
    let callCount = 0;
    globalThis.fetch = mock((url: string) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response(
          JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
          { status: 200 },
        ));
      }
      capturedUrl = url.toString();
      return Promise.resolve(new Response(
        JSON.stringify([
          { data: { children: [{ data: { title: 'Test', author: 'u', subreddit: 's', score: 1, num_comments: 0, url: '', permalink: '/r/s/comments/abc123/test', created_utc: 1700000000 } }] } },
          { data: { children: [] } },
        ]),
        { status: 200 },
      ));
    }) as typeof fetch;

    const tool = createRedditReadTool(baseConfig);
    await tool.execute({ url: 'https://reddit.com/r/test/comments/abc123/some_title' }, mockLogger);
    expect(capturedUrl).toContain('/comments/abc123');
  });

  test('returns post with comments', async () => {
    mockRedditFetch([
      {
        data: {
          children: [{
            data: {
              title: 'Read Test',
              author: 'poster',
              subreddit: 'test',
              score: 100,
              num_comments: 2,
              url: 'https://example.com',
              permalink: '/r/test/comments/abc/read_test',
              selftext: 'Post body here',
              created_utc: 1700000000,
            },
          }],
        },
      },
      {
        data: {
          children: [
            { kind: 't1', data: { author: 'commenter1', body: 'Great post!', score: 10 } },
            { kind: 't1', data: { author: 'commenter2', body: 'Thanks', score: 5 } },
          ],
        },
      },
    ]);

    const tool = createRedditReadTool(baseConfig);
    const result = await tool.execute({ url: 'abc' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Read Test');
    expect(result.content).toContain('Post body here');
    expect(result.content).toContain('commenter1');
    expect(result.content).toContain('Great post!');
    expect(result.content).toContain('Top Comments');
  });

  test('handles post not found', async () => {
    mockRedditFetch([{ data: { children: [] } }]);

    const tool = createRedditReadTool(baseConfig);
    const result = await tool.execute({ url: 'nonexistent' }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('not found');
  });
});

// --- Token refresh ---

describe('Reddit auth', () => {
  test('sends correct OAuth credentials', async () => {
    let authHeader = '';
    let callCount = 0;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        authHeader = (init?.headers as Record<string, string>)?.['Authorization'] || '';
        return Promise.resolve(new Response(
          JSON.stringify({ access_token: 'new-token', expires_in: 3600 }),
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response(
        JSON.stringify({ data: { children: [] } }),
        { status: 200 },
      ));
    }) as typeof fetch;

    const tool = createRedditSearchTool(baseConfig);
    await tool.execute({ query: 'test' }, mockLogger);

    const expected = Buffer.from(`${baseConfig.clientId}:${baseConfig.clientSecret}`).toString('base64');
    expect(authHeader).toBe(`Basic ${expected}`);
  });
});
