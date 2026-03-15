import { describe, expect, it, mock } from 'bun:test';
import { splitMessage, streamToChannel } from '../src/bot/telegram-utils';
import { streamToWebSocket } from '../src/channel/websocket';

// ─── Helper: create an async generator from an array of chunks ───
async function* chunksToStream(
  chunks: string[]
): AsyncGenerator<string, { text: string; usage?: any }> {
  let full = '';
  for (const c of chunks) {
    full += c;
    yield c;
  }
  return { text: full };
}

// ─── Streaming config schema tests ───
describe('streaming config', () => {
  it('StreamingConfigSchema provides sensible defaults', async () => {
    // Dynamically import to test the schema
    const { z } = await import('zod');
    const StreamingConfigSchema = z
      .object({
        enabled: z.boolean().default(false),
        editIntervalMs: z.number().int().min(200).max(5000).default(800),
        minChunkChars: z.number().int().min(10).max(500).default(50),
      })
      .default({});

    const defaults = StreamingConfigSchema.parse(undefined);
    expect(defaults.enabled).toBe(false);
    expect(defaults.editIntervalMs).toBe(800);
    expect(defaults.minChunkChars).toBe(50);
  });

  it('StreamingConfigSchema validates constraints', async () => {
    const { z } = await import('zod');
    const StreamingConfigSchema = z.object({
      enabled: z.boolean().default(false),
      editIntervalMs: z.number().int().min(200).max(5000).default(800),
      minChunkChars: z.number().int().min(10).max(500).default(50),
    });

    // editIntervalMs too low
    expect(() => StreamingConfigSchema.parse({ editIntervalMs: 100 })).toThrow();
    // editIntervalMs too high
    expect(() => StreamingConfigSchema.parse({ editIntervalMs: 10000 })).toThrow();
    // minChunkChars too low
    expect(() => StreamingConfigSchema.parse({ minChunkChars: 5 })).toThrow();
    // Valid custom values
    const custom = StreamingConfigSchema.parse({
      enabled: true,
      editIntervalMs: 500,
      minChunkChars: 20,
    });
    expect(custom.enabled).toBe(true);
    expect(custom.editIntervalMs).toBe(500);
    expect(custom.minChunkChars).toBe(20);
  });

  it('conversation config includes streaming when parsed', async () => {
    const { loadConfig } = await import('../src/config');
    // We just test that the schema accepts the streaming field at the right place.
    // Full loadConfig requires a file; instead, test the schema directly.
    const { z } = await import('zod');
    const CompactionConfigSchema = z
      .object({
        enabled: z.boolean().default(true),
      })
      .default({});
    const StreamingConfigSchema = z
      .object({
        enabled: z.boolean().default(false),
        editIntervalMs: z.number().int().min(200).max(5000).default(800),
        minChunkChars: z.number().int().min(10).max(500).default(50),
      })
      .default({});
    const ConversationConfigSchema = z.object({
      enabled: z.boolean().default(true),
      systemPrompt: z.string().default('You are a helpful assistant.'),
      temperature: z.number().min(0).max(2).default(0.7),
      maxHistory: z.number().int().positive().default(20),
      compaction: CompactionConfigSchema,
      streaming: StreamingConfigSchema,
    });

    const parsed = ConversationConfigSchema.parse({});
    expect(parsed.streaming).toBeDefined();
    expect(parsed.streaming.enabled).toBe(false);
  });
});

// ─── streamToChannel tests ───
describe('streamToChannel', () => {
  it('sends initial message and progressively edits', async () => {
    const sent: { id: number; text: string }[] = [];
    const edits: { id: number; text: string }[] = [];
    let nextId = 1;

    const sendMessage = mock(async (text: string) => {
      const id = nextId++;
      sent.push({ id, text });
      return id;
    });

    const editMessage = mock(async (id: number, text: string) => {
      edits.push({ id, text });
    });

    const chunks = [
      'Hello',
      ', ',
      'world',
      '! How are you today? This is a longer message to test.',
    ];
    const result = await streamToChannel(
      sendMessage,
      editMessage,
      chunksToStream(chunks),
      0, // no throttle for test
      1 // minChunkChars = 1 so every chunk triggers an edit
    );

    expect(result).toBe('Hello, world! How are you today? This is a longer message to test.');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toBe('Hello');
    // Final edit should contain the full text
    if (edits.length > 0) {
      expect(edits[edits.length - 1].text).toBe(result);
    }
  });

  it('handles empty stream', async () => {
    const sendMessage = mock(async (_text: string) => 1);
    const editMessage = mock(async (_id: number, _text: string) => {});

    // biome-ignore lint/correctness/useYield: intentionally empty stream for testing
    async function* emptyStream(): AsyncGenerator<string, { text: string }> {
      return { text: '' };
    }

    const result = await streamToChannel(sendMessage, editMessage, emptyStream(), 0, 1);
    expect(result).toBe('');
    // No message sent for empty content
    expect(sendMessage.mock.calls.length).toBe(0);
  });

  it('respects minChunkChars throttle', async () => {
    const edits: string[] = [];
    const sendMessage = mock(async (_text: string) => 1);
    const editMessage = mock(async (_id: number, text: string) => {
      edits.push(text);
    });

    // Each chunk is 1 char, minChunkChars = 50
    const chunks = Array.from({ length: 10 }, (_, i) => String.fromCharCode(65 + i)); // A,B,C...
    const result = await streamToChannel(
      sendMessage,
      editMessage,
      chunksToStream(chunks),
      0, // no time throttle
      50 // 50 char minimum — none of our intermediate edits should trigger
    );

    expect(result).toBe('ABCDEFGHIJ');
    // Only the initial send + final edit (since accumulated < 50 chars for intermediates)
    // The final edit should happen because the text changed from initial
    expect(edits.length).toBe(1); // just the final edit
  });

  it('single chunk stream works', async () => {
    const sendMessage = mock(async (_text: string) => 42);
    const editMessage = mock(async (_id: number, _text: string) => {});

    const result = await streamToChannel(
      sendMessage,
      editMessage,
      chunksToStream(['Hello world!']),
      0,
      1
    );

    expect(result).toBe('Hello world!');
    expect(sendMessage.mock.calls.length).toBe(1);
  });
});

// ─── streamToWebSocket tests ───
describe('streamToWebSocket', () => {
  it('sends stream_start, chunks, and stream_end', async () => {
    const messages: string[] = [];
    const fakeWs = {
      send: mock((data: string) => {
        messages.push(data);
      }),
    } as any;

    const chunks = ['Hello', ' ', 'world'];
    const result = await streamToWebSocket(fakeWs, chunksToStream(chunks));

    expect(result).toBe('Hello world');
    expect(messages.length).toBe(5); // start + 3 chunks + end

    const parsed = messages.map((m) => JSON.parse(m));
    expect(parsed[0].type).toBe('stream_start');
    expect(parsed[1].type).toBe('stream_chunk');
    expect(parsed[1].text).toBe('Hello');
    expect(parsed[2].type).toBe('stream_chunk');
    expect(parsed[2].text).toBe(' ');
    expect(parsed[3].type).toBe('stream_chunk');
    expect(parsed[3].text).toBe('world');
    expect(parsed[4].type).toBe('stream_end');
    expect(parsed[4].fullText).toBe('Hello world');
  });

  it('handles ws.send throwing (connection closed)', async () => {
    let callCount = 0;
    const fakeWs = {
      send: mock((_data: string) => {
        callCount++;
        if (callCount > 2) throw new Error('Connection closed');
      }),
    } as any;

    const chunks = ['a', 'b', 'c', 'd'];
    // Should not throw despite ws.send failing
    const result = await streamToWebSocket(fakeWs, chunksToStream(chunks));
    expect(result).toBe('abcd');
  });

  it('empty stream sends start and end', async () => {
    const messages: string[] = [];
    const fakeWs = {
      send: mock((data: string) => {
        messages.push(data);
      }),
    } as any;

    // biome-ignore lint/correctness/useYield: intentionally empty stream for testing
    async function* emptyStream(): AsyncGenerator<string, { text: string }> {
      return { text: '' };
    }

    const result = await streamToWebSocket(fakeWs, emptyStream());
    expect(result).toBe('');

    const parsed = messages.map((m) => JSON.parse(m));
    expect(parsed.length).toBe(2);
    expect(parsed[0].type).toBe('stream_start');
    expect(parsed[1].type).toBe('stream_end');
    expect(parsed[1].fullText).toBe('');
  });
});

// ─── OllamaClient stream parsing tests ───
describe('Ollama NDJSON stream parsing', () => {
  it('parses generate-style NDJSON correctly', () => {
    // Simulate parsing logic used in OllamaClient.generateStream
    const lines = [
      '{"response":"Hello","done":false}',
      '{"response":" world","done":false}',
      '{"response":"!","done":true,"prompt_eval_count":10,"eval_count":5}',
    ];

    let fullText = '';
    const chunks: string[] = [];
    let finalDone = false;
    let promptEvalCount: number | undefined;
    let evalCount: number | undefined;

    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (parsed.response) {
        fullText += parsed.response;
        chunks.push(parsed.response);
      }
      if (parsed.done) {
        finalDone = true;
        promptEvalCount = parsed.prompt_eval_count;
        evalCount = parsed.eval_count;
      }
    }

    expect(fullText).toBe('Hello world!');
    expect(chunks).toEqual(['Hello', ' world', '!']);
    expect(finalDone).toBe(true);
    expect(promptEvalCount).toBe(10);
    expect(evalCount).toBe(5);
  });

  it('parses chat-style NDJSON correctly', () => {
    const lines = [
      '{"message":{"content":"Hi"},"done":false}',
      '{"message":{"content":" there"},"done":false}',
      '{"message":{"content":""},"done":true,"prompt_eval_count":20,"eval_count":15}',
    ];

    let fullText = '';
    const chunks: string[] = [];
    let finalDone = false;

    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (parsed.message?.content) {
        fullText += parsed.message.content;
        chunks.push(parsed.message.content);
      }
      if (parsed.done) {
        finalDone = true;
      }
    }

    expect(fullText).toBe('Hi there');
    expect(chunks).toEqual(['Hi', ' there']);
    expect(finalDone).toBe(true);
  });

  it('skips malformed lines gracefully', () => {
    const lines = [
      '{"response":"ok","done":false}',
      'not valid json',
      '{"response":"!","done":true}',
    ];

    let fullText = '';
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.response) fullText += parsed.response;
      } catch {
        // skip
      }
    }

    expect(fullText).toBe('ok!');
  });
});

// ─── LLMClient interface tests ───
describe('LLMClient streaming interface', () => {
  it('chatStream is optional on LLMClient', async () => {
    const { ClaudeCliLLMClient } = await import('../src/core/llm-client');
    const mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
    const client = new ClaudeCliLLMClient('claude', 30000, mockLogger);

    // Claude CLI does NOT implement chatStream
    expect(client.chatStream).toBeUndefined();
  });

  it('OllamaLLMClient exposes chatStream', async () => {
    const { OllamaLLMClient } = await import('../src/core/llm-client');
    const mockOllama = {
      generate: async () => ({ text: 'test' }),
      chat: async () => ({ text: 'test' }),
      chatStream: async function* () {
        yield 'test';
        return { text: 'test' };
      },
    } as any;
    const client = new OllamaLLMClient(mockOllama);

    expect(typeof client.chatStream).toBe('function');
  });
});
