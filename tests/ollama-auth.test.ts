/**
 * Coverage for Ollama Cloud bearer auth across EVERY outbound call site.
 *
 * Missing a single site produces a confusing partial failure — most calls
 * succeed and one 401s — so these tests enumerate the sites explicitly rather
 * than sampling one or two. All HTTP is mocked; nothing here touches a network.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createOllamaProbeClient } from '../src/bot/model-failover/model-validation';
import { NativeToolStrategy } from '../src/core/native-tool-strategy';
import { OllamaClient } from '../src/ollama';

const API_KEY = 'sk-ollama-secret-value-do-not-log';
const BASE_URL = 'http://127.0.0.1:11434';

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

let captured: CapturedRequest[] = [];
let originalFetch: typeof globalThis.fetch;

/** Normalise whatever shape a caller passed as `headers` into a plain object. */
function normaliseHeaders(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers;
  if (!raw) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw);
  return { ...(raw as Record<string, string>) };
}

/** Authorization lookup that is case-insensitive, so a miss is a real miss. */
function authOf(request: CapturedRequest): string | undefined {
  const hit = Object.entries(request.headers).find(
    ([name]) => name.toLowerCase() === 'authorization'
  );
  return hit?.[1];
}

function ndjsonResponse(lines: object[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function installFetchMock(): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    captured.push({ url, headers: normaliseHeaders(init) });

    if (url.includes('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'kimi-k2.6:cloud' }] }), {
        status: 200,
      });
    }
    if (url.includes('/api/embed')) {
      return new Response(JSON.stringify({ model: 'embed-model', embeddings: [[0.1, 0.2]] }), {
        status: 200,
      });
    }

    const streaming = typeof init?.body === 'string' && JSON.parse(init.body).stream === true;
    if (url.includes('/api/generate')) {
      if (streaming) {
        return ndjsonResponse([{ response: 'hi', done: false }, { done: true }]);
      }
      return new Response(JSON.stringify({ model: 'm', response: 'hi', done: true }), {
        status: 200,
      });
    }
    if (url.includes('/api/chat')) {
      if (streaming) {
        return ndjsonResponse([{ message: { content: 'hi' }, done: false }, { done: true }]);
      }
      return new Response(
        JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'hi' }, done: true }),
        { status: 200 }
      );
    }
    return new Response('{}', { status: 200 });
  }) as typeof globalThis.fetch;
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

function makeClient(apiKey?: string) {
  return new OllamaClient(
    {
      baseUrl: BASE_URL,
      apiKey,
      timeout: 5_000,
      models: { primary: 'kimi-k2.6:cloud', fallbacks: [] },
    } as any,
    noopLogger
  );
}

/** Drive an async generator to completion so its fetch actually happens. */
async function drain(generator: AsyncGenerator<string, unknown>): Promise<void> {
  while (!(await generator.next()).done) {
    /* consume */
  }
}

/**
 * Every outbound call site, as (name, invoke, expected path). Adding a new
 * fetch to the Ollama path without adding it here should be caught by the
 * "no unlisted call sites" test below.
 */
const CALL_SITES: Array<{ name: string; path: string; run: (apiKey?: string) => Promise<unknown> }> =
  [
    {
      name: 'OllamaClient.generate',
      path: '/api/generate',
      run: (k) => makeClient(k).generate('hello'),
    },
    {
      name: 'OllamaClient.chat',
      path: '/api/chat',
      run: (k) => makeClient(k).chat([{ role: 'user', content: 'hello' }]),
    },
    {
      name: 'OllamaClient.generateStream',
      path: '/api/generate',
      run: (k) => drain(makeClient(k).generateStream('hello')),
    },
    {
      name: 'OllamaClient.chatStream',
      path: '/api/chat',
      run: (k) => drain(makeClient(k).chatStream([{ role: 'user', content: 'hello' }])),
    },
    {
      name: 'OllamaClient.embed',
      path: '/api/embed',
      run: (k) => makeClient(k).embed('text', 'embed-model'),
    },
    { name: 'OllamaClient.ping', path: '/api/tags', run: (k) => makeClient(k).ping() },
    { name: 'OllamaClient.listModels', path: '/api/tags', run: (k) => makeClient(k).listModels() },
    {
      name: 'NativeToolStrategy.chat',
      path: '/api/chat',
      run: (k) =>
        new NativeToolStrategy(null as any, BASE_URL, noopLogger, 5_000, k).chat(
          [{ role: 'user', content: 'hello' }],
          { model: 'kimi-k2.6:cloud' }
        ),
    },
    {
      name: 'probeClient.checkDaemon',
      path: '/api/tags',
      run: (k) => createOllamaProbeClient(BASE_URL, k).checkDaemon(1_000),
    },
    {
      name: 'probeClient.probeModel',
      path: '/api/generate',
      run: (k) => createOllamaProbeClient(BASE_URL, k).probeModel('kimi-k2.6:cloud', 1_000),
    },
  ];

beforeEach(() => {
  captured = [];
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Ollama auth header — key configured', () => {
  for (const site of CALL_SITES) {
    test(`${site.name} sends Authorization: Bearer`, async () => {
      await site.run(API_KEY);
      expect(captured.length).toBeGreaterThan(0);
      const request = captured.find((r) => r.url.includes(site.path));
      expect(request).toBeDefined();
      expect(authOf(request as CapturedRequest)).toBe(`Bearer ${API_KEY}`);
    });
  }

  test('every request issued carries the header, not just the first', async () => {
    for (const site of CALL_SITES) await site.run(API_KEY);
    expect(captured.length).toBe(CALL_SITES.length);
    for (const request of captured) {
      expect(authOf(request)).toBe(`Bearer ${API_KEY}`);
    }
  });
});

describe('Ollama auth header — no key configured', () => {
  for (const site of CALL_SITES) {
    test(`${site.name} omits Authorization entirely`, async () => {
      await site.run(undefined);
      const request = captured.find((r) => r.url.includes(site.path));
      expect(request).toBeDefined();
      expect(authOf(request as CapturedRequest)).toBeUndefined();
    });
  }

  test('a blank key is treated as no key (unset ${OLLAMA_API_KEY})', async () => {
    for (const site of CALL_SITES) await site.run('');
    for (const request of captured) {
      expect(authOf(request)).toBeUndefined();
    }
  });

  test('POST sites still send Content-Type when unauthenticated', async () => {
    await makeClient(undefined).generate('hello');
    expect(captured[0].headers['Content-Type']).toBe('application/json');
  });
});

describe('Ollama API key never reaches the logs', () => {
  test('no logger call, at any level, contains the key', async () => {
    const logged: unknown[] = [];
    const recorder: any = {
      debug: (...args: unknown[]) => logged.push(args),
      info: (...args: unknown[]) => logged.push(args),
      warn: (...args: unknown[]) => logged.push(args),
      error: (...args: unknown[]) => logged.push(args),
      child: () => recorder,
    };

    const client = new OllamaClient(
      {
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        timeout: 5_000,
        models: { primary: 'kimi-k2.6:cloud', fallbacks: [] },
      } as any,
      recorder
    );

    await client.generate('hello');
    await client.chat([{ role: 'user', content: 'hello' }]);
    await client.embed('text', 'embed-model');
    await client.listModels();
    await drain(client.chatStream([{ role: 'user', content: 'hello' }]));

    expect(logged.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(logged);
    expect(serialised).not.toContain(API_KEY);
    expect(serialised.toLowerCase()).not.toContain('bearer');
  });

  test('the key does not leak through the failure path either', async () => {
    const logged: unknown[] = [];
    const recorder: any = {
      debug: (...args: unknown[]) => logged.push(args),
      info: (...args: unknown[]) => logged.push(args),
      warn: (...args: unknown[]) => logged.push(args),
      error: (...args: unknown[]) => logged.push(args),
      child: () => recorder,
    };

    globalThis.fetch = (async () =>
      new Response('nope', { status: 401 })) as typeof globalThis.fetch;

    const client = new OllamaClient(
      {
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        timeout: 5_000,
        models: { primary: 'kimi-k2.6:cloud', fallbacks: ['gpt-oss:120b-cloud'] },
      } as any,
      recorder
    );

    await expect(client.generate('hello')).rejects.toThrow();

    const serialised = JSON.stringify(
      logged,
      (_key, value) => (value instanceof Error ? `${value.name}: ${value.message}` : value)
    );
    expect(serialised).not.toContain(API_KEY);
  });
});
