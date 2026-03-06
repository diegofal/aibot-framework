import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { integrationsRoutes } from '../../../src/web/routes/integrations';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const fakeTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'get_datetime',
      description: 'Get the current date and time',
      parameters: { type: 'object' as const, properties: {} },
    },
  },
  execute: async () => ({ success: true, content: '2026-02-24T12:00:00Z' }),
};

const fakeTool2 = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: 'Search the web',
      parameters: {
        type: 'object' as const,
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  execute: async () => ({ success: true, content: 'search results' }),
};

const mockToolRegistry = {
  getDefinitions: () => [fakeTool.definition, fakeTool2.definition],
  getTools: () => [fakeTool, fakeTool2],
};

const mockBotManager = {
  getOllamaClient: () => ({
    chat: async (_msgs: any, opts: any) => {
      // If tools are provided, simulate tool execution via executor then return
      if (opts?.tools && opts?.toolExecutor) {
        await opts.toolExecutor('get_datetime', {});
        return { text: 'The time is 2026-02-24T12:00:00Z' };
      }
      return { text: 'test response' };
    },
  }),
  getToolRegistry: () => mockToolRegistry,
} as any;

function makeApp(config: Partial<Config>, botManager = mockBotManager) {
  const app = new Hono();
  app.route(
    '/api/integrations',
    integrationsRoutes({
      config: config as Config,
      botManager,
      logger: noopLogger,
    })
  );
  return app;
}

const baseConfig = {
  ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'llama3' }, timeout: 30000 },
} as Partial<Config>;

describe('integrations routes - GET /ollama/tools', () => {
  test('returns list of tool names', async () => {
    const app = makeApp(baseConfig);
    const res = await app.request('http://localhost/api/integrations/ollama/tools');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tools).toEqual(['get_datetime', 'web_search']);
  });

  test('returns empty list when no tools registered', async () => {
    const emptyBm = {
      ...mockBotManager,
      getToolRegistry: () => ({ getDefinitions: () => [], getTools: () => [] }),
    } as any;
    const app = makeApp(baseConfig, emptyBm);
    const res = await app.request('http://localhost/api/integrations/ollama/tools');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tools).toEqual([]);
  });
});

describe('integrations routes - POST /ollama/chat-with-tools', () => {
  test('returns 400 when message is missing', async () => {
    const app = makeApp(baseConfig);
    const res = await app.request('http://localhost/api/integrations/ollama/chat-with-tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('message is required');
  });

  test('returns 400 when selected tools match nothing', async () => {
    const app = makeApp(baseConfig);
    const res = await app.request('http://localhost/api/integrations/ollama/chat-with-tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', tools: ['nonexistent_tool'] }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('No matching tools found');
  });

  test('sends all tools when tools array is omitted', async () => {
    let capturedTools: any[] = [];
    const bm = {
      ...mockBotManager,
      getOllamaClient: () => ({
        chat: async (_msgs: any, opts: any) => {
          capturedTools = opts.tools;
          return { text: 'ok' };
        },
      }),
    } as any;
    const app = makeApp(baseConfig, bm);
    const res = await app.request('http://localhost/api/integrations/ollama/chat-with-tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(200);
    expect(capturedTools).toHaveLength(2);
  });

  test('filters tools when tools array is provided', async () => {
    let capturedTools: any[] = [];
    const bm = {
      ...mockBotManager,
      getOllamaClient: () => ({
        chat: async (_msgs: any, opts: any) => {
          capturedTools = opts.tools;
          return { text: 'ok' };
        },
      }),
    } as any;
    const app = makeApp(baseConfig, bm);
    const res = await app.request('http://localhost/api/integrations/ollama/chat-with-tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', tools: ['get_datetime'] }),
    });
    expect(res.status).toBe(200);
    expect(capturedTools).toHaveLength(1);
    expect(capturedTools[0].function.name).toBe('get_datetime');
  });

  test('success response includes toolCalls and response', async () => {
    const app = makeApp(baseConfig);
    const res = await app.request('http://localhost/api/integrations/ollama/chat-with-tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What time is it?', tools: ['get_datetime'] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.response).toBe('The time is 2026-02-24T12:00:00Z');
    expect(data.model).toBe('llama3');
    expect(typeof data.durationMs).toBe('number');
    expect(data.toolCalls).toHaveLength(1);
    expect(data.toolCalls[0].name).toBe('get_datetime');
    expect(data.toolCalls[0].success).toBe(true);
    expect(data.toolCalls[0].result).toBe('2026-02-24T12:00:00Z');
  });

  test('uses specified model', async () => {
    let capturedModel = '';
    const bm = {
      ...mockBotManager,
      getOllamaClient: () => ({
        chat: async (_msgs: any, opts: any) => {
          capturedModel = opts.model;
          return { text: 'ok' };
        },
      }),
    } as any;
    const app = makeApp(baseConfig, bm);
    await app.request('http://localhost/api/integrations/ollama/chat-with-tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', model: 'kimi-k2.5:cloud' }),
    });
    expect(capturedModel).toBe('kimi-k2.5:cloud');
  });

  test('returns 500 on chat error with toolCalls collected so far', async () => {
    const bm = {
      ...mockBotManager,
      getOllamaClient: () => ({
        chat: async () => {
          throw new Error('503 Service Unavailable');
        },
      }),
    } as any;
    const app = makeApp(baseConfig, bm);
    const res = await app.request('http://localhost/api/integrations/ollama/chat-with-tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', tools: ['get_datetime'] }),
    });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('503');
    expect(data.model).toBe('llama3');
    expect(Array.isArray(data.toolCalls)).toBe(true);
  });

  test('executor handles unknown tool gracefully', async () => {
    // Simulate the LLM calling a tool not in the selected set
    const bm = {
      ...mockBotManager,
      getOllamaClient: () => ({
        chat: async (_msgs: any, opts: any) => {
          // The LLM tries to call a tool that doesn't exist in our map
          const result = await opts.toolExecutor('nonexistent', { a: 1 });
          return { text: `got: ${result.content}` };
        },
      }),
    } as any;
    const app = makeApp(baseConfig, bm);
    const res = await app.request('http://localhost/api/integrations/ollama/chat-with-tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.toolCalls).toHaveLength(1);
    expect(data.toolCalls[0].name).toBe('nonexistent');
    expect(data.toolCalls[0].success).toBe(false);
    expect(data.toolCalls[0].result).toContain('Unknown tool');
  });
});

describe('integrations routes - ElevenLabs voices', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns 400 when TTS is not configured', async () => {
    const app = makeApp({ media: { enabled: true, maxFileSizeMb: 10 } } as any);
    const res = await app.request('http://localhost/api/integrations/elevenlabs/voices');
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('TTS not configured');
  });

  test('returns 400 when media.tts has no apiKey', async () => {
    const app = makeApp({
      media: { enabled: true, maxFileSizeMb: 10, tts: { provider: 'elevenlabs' } as any },
    } as any);
    const res = await app.request('http://localhost/api/integrations/elevenlabs/voices');
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('TTS not configured');
  });

  test('returns simplified voice list on success', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('elevenlabs.io')) {
        return new Response(
          JSON.stringify({
            voices: [
              {
                voice_id: 'abc123',
                name: 'Rachel',
                labels: { gender: 'female', accent: 'american', age: 'young' },
                preview_url: 'https://example.com/preview.mp3',
                extra_field: 'should be stripped',
              },
              {
                voice_id: 'def456',
                name: 'Adam',
                labels: { gender: 'male', accent: 'british' },
                preview_url: 'https://example.com/adam.mp3',
              },
            ],
          }),
          { status: 200 }
        );
      }
      return originalFetch(url);
    }) as any;

    const app = makeApp({
      media: {
        enabled: true,
        maxFileSizeMb: 10,
        tts: { provider: 'elevenlabs', apiKey: 'test-key' } as any,
      },
    } as any);

    const res = await app.request('http://localhost/api/integrations/elevenlabs/voices');
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.voices).toHaveLength(2);
    expect(data.voices[0]).toEqual({
      voice_id: 'abc123',
      name: 'Rachel',
      labels: { gender: 'female', accent: 'american', age: 'young' },
      preview_url: 'https://example.com/preview.mp3',
    });
    expect(data.voices[1].voice_id).toBe('def456');
    expect(data.voices[0].extra_field).toBeUndefined();
    expect(typeof data.latencyMs).toBe('number');
  });

  test('returns 500 on ElevenLabs API error', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('elevenlabs.io')) {
        return new Response('Unauthorized', { status: 401 });
      }
      return originalFetch(url);
    }) as any;

    const app = makeApp({
      media: {
        enabled: true,
        maxFileSizeMb: 10,
        tts: { provider: 'elevenlabs', apiKey: 'bad-key' } as any,
      },
    } as any);

    const res = await app.request('http://localhost/api/integrations/elevenlabs/voices');
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('401');
  });

  test('returns 500 on network error', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('elevenlabs.io')) {
        throw new Error('Network failure');
      }
      return originalFetch(url);
    }) as any;

    const app = makeApp({
      media: {
        enabled: true,
        maxFileSizeMb: 10,
        tts: { provider: 'elevenlabs', apiKey: 'test-key' } as any,
      },
    } as any);

    const res = await app.request('http://localhost/api/integrations/elevenlabs/voices');
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Network failure');
  });
});
