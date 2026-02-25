import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { apiRequest, RateLimiter } from '../../src/tools/api-client';

describe('apiRequest', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns parsed JSON on success', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ id: 1, name: 'test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    ) as typeof fetch;

    const result = await apiRequest<{ id: number; name: string }>('https://api.example.com/data');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ id: 1, name: 'test' });
    }
  });

  test('sends correct method and headers', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as typeof fetch;

    await apiRequest('https://api.example.com/data', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer token123' },
      body: { text: 'hello' },
    });

    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['Authorization']).toBe('Bearer token123');
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(capturedInit?.body).toBe(JSON.stringify({ text: 'hello' }));
  });

  test('returns error on HTTP error status', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Not Found', { status: 404, statusText: 'Not Found' })),
    ) as typeof fetch;

    const result = await apiRequest('https://api.example.com/missing');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.message).toBe('Not Found');
    }
  });

  test('returns error on HTTP 500 with body', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('{"error":"internal"}', { status: 500, statusText: 'Internal Server Error' })),
    ) as typeof fetch;

    const result = await apiRequest('https://api.example.com/fail');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toContain('internal');
    }
  });

  test('throws on timeout', async () => {
    globalThis.fetch = mock((_url: string, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('ok')), 10_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal!.reason);
        });
      }),
    ) as typeof fetch;

    await expect(
      apiRequest('https://api.example.com/slow', { timeout: 50 }),
    ).rejects.toThrow();
  });

  test('throws on invalid JSON response', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('not json at all', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    ) as typeof fetch;

    await expect(
      apiRequest('https://api.example.com/bad-json'),
    ).rejects.toThrow();
  });

  test('truncates long error bodies to 500 chars', async () => {
    const longBody = 'x'.repeat(1000);
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(longBody, { status: 400 })),
    ) as typeof fetch;

    const result = await apiRequest('https://api.example.com/err');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBe(500);
    }
  });

  test('defaults to GET method', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as typeof fetch;

    await apiRequest('https://api.example.com/data');
    expect(capturedInit?.method).toBe('GET');
  });
});

describe('RateLimiter', () => {
  test('allows requests within limit', async () => {
    const limiter = new RateLimiter(3, 60_000);

    await limiter.acquire(); // 1
    await limiter.acquire(); // 2
    await limiter.acquire(); // 3
    // All three should resolve immediately
  });

  test('blocks when tokens exhausted then refills', async () => {
    const limiter = new RateLimiter(1, 50); // 1 request per 50ms

    await limiter.acquire(); // Consumes the one token

    const start = Date.now();
    await limiter.acquire(); // Should block until refill (~50ms)
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(30); // Allow some timing slack
  });

  test('refills to full capacity after window', async () => {
    const limiter = new RateLimiter(2, 50);

    await limiter.acquire();
    await limiter.acquire();

    // Wait for full refill
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Should have 2 tokens again
    await limiter.acquire();
    await limiter.acquire();
  });
});
