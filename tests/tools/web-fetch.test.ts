import { describe, expect, test } from 'bun:test';
import { classifyHttpFailure, createWebFetchTool } from '../../src/tools/web-fetch';

function createMockLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createMockLogger(),
    fatal: () => {},
    trace: () => {},
    level: 'info',
    silent: () => {},
  } as any;
}

const logger = createMockLogger();

describe('web_fetch tool', () => {
  const tool = createWebFetchTool({
    maxContentLength: 1000,
    timeout: 5000,
    cacheTtlMs: 100,
  });

  test('has correct definition', () => {
    expect(tool.definition.function.name).toBe('web_fetch');
    expect(tool.definition.type).toBe('function');
  });

  describe('input validation', () => {
    test('rejects missing url', async () => {
      const result = await tool.execute({}, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Missing required parameter');
    });

    test('rejects empty url', async () => {
      const result = await tool.execute({ url: '' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Missing required parameter');
    });

    test('rejects invalid url', async () => {
      const result = await tool.execute({ url: 'not-a-url' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Invalid URL');
    });

    test('rejects non-http(s) schemes', async () => {
      const result = await tool.execute({ url: 'ftp://example.com/file' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('only http and https');
    });

    test('rejects file:// scheme', async () => {
      const result = await tool.execute({ url: 'file:///etc/passwd' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('only http and https');
    });
  });

  describe('SSRF protection', () => {
    test('blocks localhost', async () => {
      const result = await tool.execute({ url: 'http://localhost/admin' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('tags the SSRF refusal as a policy failure', async () => {
      const result = await tool.execute({ url: 'http://127.0.0.1:3000/' }, logger);
      expect(result.failureKind).toBe('policy');
    });

    test('blocks 127.0.0.1', async () => {
      const result = await tool.execute({ url: 'http://127.0.0.1:8080/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks 10.x.x.x', async () => {
      const result = await tool.execute({ url: 'http://10.0.0.1/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks 172.16-31.x.x', async () => {
      const result = await tool.execute({ url: 'http://172.16.0.1/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks 192.168.x.x', async () => {
      const result = await tool.execute({ url: 'http://192.168.1.1/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks 169.254.x.x (link-local)', async () => {
      const result = await tool.execute({ url: 'http://169.254.169.254/metadata' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks 0.x.x.x', async () => {
      const result = await tool.execute({ url: 'http://0.0.0.0/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks IPv6 loopback', async () => {
      const result = await tool.execute({ url: 'http://[::1]/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks IPv6 unique-local (fc00::)', async () => {
      const result = await tool.execute({ url: 'http://[fc00::1]/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks IPv6 link-local (fe80::)', async () => {
      const result = await tool.execute({ url: 'http://[fe80::1]/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('does not block public addresses (connection may fail but not SSRF)', async () => {
      // Use a non-routable TEST-NET address (RFC 5737) with very short timeout
      const shortTimeoutTool = createWebFetchTool({
        maxContentLength: 1000,
        timeout: 500,
        cacheTtlMs: 100,
      });
      const result = await shortTimeoutTool.execute({ url: 'http://203.0.113.1/' }, logger);
      // Should fail with connection/timeout error, NOT SSRF block
      expect(result.success).toBe(false);
      expect(result.content).not.toContain('private/local');
      expect(result.content).not.toContain('Blocked');
    });
  });
});

function mockResponse(status: number, headers: Record<string, string> = {}, body = ''): Response {
  const statusText: Record<number, string> = {
    200: 'OK',
    403: 'Forbidden',
    404: 'Not Found',
    410: 'Gone',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
  };
  return new Response(body, { status, statusText: statusText[status] ?? '', headers });
}

describe('classifyHttpFailure', () => {
  test('cf-mitigated header is a Cloudflare bot challenge', () => {
    const f = classifyHttpFailure(mockResponse(403, { 'cf-mitigated': 'challenge' }));
    expect(f.kind).toBe('blocked');
    expect(f.blockedBy).toBe('Cloudflare bot challenge');
    expect(f.message).toContain('cannot be read by web_fetch');
  });

  test('x-vercel-mitigated header is a Vercel security checkpoint even on 429', () => {
    const f = classifyHttpFailure(mockResponse(429, { 'x-vercel-mitigated': 'challenge' }));
    expect(f.kind).toBe('blocked');
    expect(f.blockedBy).toBe('Vercel security checkpoint');
  });

  test('bare 403 is blocked by the site', () => {
    const f = classifyHttpFailure(mockResponse(403));
    expect(f.kind).toBe('blocked');
    expect(f.message).toContain('403');
  });

  test('bare 429 is blocked (rate limit)', () => {
    const f = classifyHttpFailure(mockResponse(429));
    expect(f.kind).toBe('blocked');
    expect(f.message).toContain('429');
  });

  test('404 and 410 are not-found with guidance against guessing URLs', () => {
    for (const status of [404, 410]) {
      const f = classifyHttpFailure(mockResponse(status));
      expect(f.kind).toBe('not-found');
      expect(f.message).toContain('does not exist');
      expect(f.message).toContain('Only fetch URLs');
    }
  });

  test('5xx and other statuses stay plain errors', () => {
    const f = classifyHttpFailure(mockResponse(500));
    expect(f.kind).toBe('error');
    expect(f.message).toContain('Fetch failed: 500');
  });
});

describe('web_fetch failure classification', () => {
  function toolWith(
    responses: Array<Response | Error>,
    opts: { now?: () => number; blockedHostTtlMs?: number } = {}
  ) {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      const next = responses.shift();
      if (!next) throw new Error('no more mocked responses');
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch;
    const tool = createWebFetchTool({ cacheTtlMs: 100, fetchImpl, ...opts });
    return { tool, calls };
  }

  test('description tells the model not to guess URLs', () => {
    const desc = createWebFetchTool().definition.function.description;
    expect(desc).toMatch(/never (construct|guess)/i);
    expect(desc).toContain('web_search');
  });

  test('Cloudflare challenge -> failureKind blocked, message names the wall', async () => {
    const { tool } = toolWith([mockResponse(403, { 'cf-mitigated': 'challenge' })]);
    const r = await tool.execute({ url: 'https://openai.com/index/x/' }, logger);
    expect(r.success).toBe(false);
    expect(r.failureKind).toBe('blocked');
    expect(r.content).toContain('Cloudflare bot challenge');
    expect(r.content).toContain('use the search snippet or a different source');
  });

  test('404 -> failureKind not-found', async () => {
    const { tool } = toolWith([mockResponse(404)]);
    const r = await tool.execute({ url: 'https://cognition.com/blog/made-up' }, logger);
    expect(r.success).toBe(false);
    expect(r.failureKind).toBe('not-found');
    expect(r.content).toContain('does not exist');
  });

  test('500 -> failureKind error', async () => {
    const { tool } = toolWith([mockResponse(500)]);
    const r = await tool.execute({ url: 'https://example.com/' }, logger);
    expect(r.failureKind).toBe('error');
  });

  test('network exception -> failureKind error', async () => {
    const { tool } = toolWith([new Error('ECONNRESET')]);
    const r = await tool.execute({ url: 'https://example.com/' }, logger);
    expect(r.success).toBe(false);
    expect(r.failureKind).toBe('error');
    expect(r.content).toContain('ECONNRESET');
  });

  test('successful fetch has no failureKind', async () => {
    const { tool } = toolWith([mockResponse(200, { 'content-type': 'text/plain' }, 'hello')]);
    const r = await tool.execute({ url: 'https://example.com/' }, logger);
    expect(r.success).toBe(true);
    expect(r.failureKind).toBeUndefined();
  });

  describe('blocked host memory', () => {
    test('a second fetch to a blocked host is short-circuited without a network call', async () => {
      const { tool, calls } = toolWith([mockResponse(429, { 'x-vercel-mitigated': 'challenge' })]);
      const first = await tool.execute({ url: 'https://devin.ai/pricing' }, logger);
      expect(first.failureKind).toBe('blocked');
      const second = await tool.execute({ url: 'https://devin.ai/' }, logger);
      expect(second.success).toBe(false);
      expect(second.failureKind).toBe('blocked');
      expect(second.content).toContain('devin.ai');
      expect(second.content).toContain('Vercel security checkpoint');
      expect(second.content).toMatch(/recently|earlier/i);
      expect(calls).toHaveLength(1);
    });

    test('other hosts are unaffected', async () => {
      const { tool, calls } = toolWith([
        mockResponse(403, { 'cf-mitigated': 'challenge' }),
        mockResponse(200, { 'content-type': 'text/plain' }, 'ok'),
      ]);
      await tool.execute({ url: 'https://openai.com/a' }, logger);
      const r = await tool.execute({ url: 'https://example.org/b' }, logger);
      expect(r.success).toBe(true);
      expect(calls).toHaveLength(2);
    });

    test('not-found and plain errors do not mark the host as blocked', async () => {
      const { tool, calls } = toolWith([
        mockResponse(404),
        mockResponse(500),
        mockResponse(200, { 'content-type': 'text/plain' }, 'ok'),
      ]);
      await tool.execute({ url: 'https://example.com/a' }, logger);
      await tool.execute({ url: 'https://example.com/b' }, logger);
      const r = await tool.execute({ url: 'https://example.com/c' }, logger);
      expect(r.success).toBe(true);
      expect(calls).toHaveLength(3);
    });

    test('the block expires after blockedHostTtlMs', async () => {
      let t = 1_000_000;
      const { tool, calls } = toolWith(
        [
          mockResponse(403, { 'cf-mitigated': 'challenge' }),
          mockResponse(200, { 'content-type': 'text/plain' }, 'ok'),
        ],
        { now: () => t, blockedHostTtlMs: 60_000 }
      );
      await tool.execute({ url: 'https://openai.com/a' }, logger);
      t += 59_000;
      const still = await tool.execute({ url: 'https://openai.com/b' }, logger);
      expect(still.failureKind).toBe('blocked');
      expect(calls).toHaveLength(1);
      t += 2_000;
      const again = await tool.execute({ url: 'https://openai.com/c' }, logger);
      expect(again.success).toBe(true);
      expect(calls).toHaveLength(2);
    });
  });
});
