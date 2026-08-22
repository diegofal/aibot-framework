import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IntelCollector } from '../src/skills/intel-gatherer/collector';
import type { RedditSource } from '../src/skills/intel-gatherer/types';

// The daily intel cron reported "Reddit posts: 0" as a success every day while
// every subreddit fetch was being rejected. Zero posts because nothing matched
// and zero posts because every source was blocked must not look the same.

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as import('../src/logger').Logger;

const source: RedditSource = {
  type: 'reddit',
  name: 'LocalLLaMA',
  url: 'https://www.reddit.com/r/LocalLLaMA/hot.json?limit=10',
  min_score: 50,
  min_comments: 20,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: () => Promise<unknown>): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}

describe('IntelCollector.blockedSources', () => {
  test('starts empty', () => {
    expect(new IntelCollector(logger).blockedSources).toEqual([]);
  });

  test('records a source rejected with 403 and still returns no posts', async () => {
    stubFetch(async () => ({ ok: false, status: 403 }));
    const c = new IntelCollector(logger);
    await expect(c.fetchReddit(source)).resolves.toEqual([]);
    expect(c.blockedSources).toEqual([{ name: 'LocalLLaMA', reason: 'HTTP 403' }]);
  });

  test('records a source that threw', async () => {
    stubFetch(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const c = new IntelCollector(logger);
    await expect(c.fetchReddit(source)).resolves.toEqual([]);
    expect(c.blockedSources[0].name).toBe('LocalLLaMA');
    expect(c.blockedSources[0].reason).toContain('ENOTFOUND');
  });

  test('records a non-403 HTTP failure', async () => {
    stubFetch(async () => ({ ok: false, status: 429 }));
    const c = new IntelCollector(logger);
    await expect(c.fetchReddit(source)).resolves.toEqual([]);
    expect(c.blockedSources[0].reason).toContain('429');
  });

  test('does not record a source that answered with zero matching posts', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { children: [] } }),
    }));
    const c = new IntelCollector(logger);
    await expect(c.fetchReddit(source)).resolves.toEqual([]);
    expect(c.blockedSources).toEqual([]);
  });

  test('does not double-record the same source name', async () => {
    stubFetch(async () => ({ ok: false, status: 403 }));
    const c = new IntelCollector(logger);
    await c.fetchReddit(source);
    await c.fetchReddit(source);
    expect(c.blockedSources).toHaveLength(1);
  });
});
