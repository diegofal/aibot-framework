/**
 * Conversation path — backend pinning.
 *
 * `llmBackend` must mean one thing everywhere: a claude-cli bot's
 * *conversations* run on claude-cli, and a Claude hiccup must not silently
 * re-issue the prompt to Ollama (four `All Ollama models failed for chat`
 * errors in production came in through this path).
 *
 * The fix lives in `createLLMClient()` (src/core/llm-client.ts): a claude-cli
 * caller gets a bare client unless cross-backend fallback is explicitly
 * configured. These tests assert the behaviour from the conversation entry
 * point, independently of which layer implements it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ContextCompactor } from '../src/bot/context-compaction';
import { ConversationPipeline } from '../src/bot/conversation-pipeline';
import { createLLMClient } from '../src/core/llm-client';

const realClaudeCli = await import('../src/claude-cli');

/** Claude CLI behaviour for the current test (set per test). */
let claudeBehaviour: () => Promise<{ response: string; usage?: unknown }> = () =>
  Promise.resolve({ response: 'claude says hi' });
let claudeToolBehaviour: () => Promise<{ response: string; usage?: unknown }> = () =>
  Promise.resolve({ response: 'claude used a tool' });
let claudeCalls = 0;
let claudeToolCalls = 0;

mock.module('../src/claude-cli', () => ({
  ...realClaudeCli,
  claudeGenerate: (..._args: unknown[]) => {
    claudeCalls++;
    return claudeBehaviour();
  },
  claudeGenerateWithTools: (..._args: unknown[]) => {
    claudeToolCalls++;
    return claudeToolBehaviour();
  },
}));

function mockLogger(): any {
  const l: any = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    trace: mock(() => {}),
  };
  l.child = () => l;
  return l;
}

/** Minimal OllamaClient stand-in — every call is a cross-backend leak. */
function makeOllamaSpy() {
  return {
    chat: mock(() => Promise.resolve({ text: 'OLLAMA ANSWER' })),
    generate: mock(() => Promise.resolve({ text: 'OLLAMA ANSWER' })),
    chatStream: mock(() => {
      throw new Error('not used');
    }),
  } as any;
}

function makePipeline(llmClient: any, toolDefs: any[] = []) {
  const toolExecutor = mock(() => Promise.resolve({ success: true, content: 'ok' }));
  const ctx: any = {
    config: {
      soul: {
        enabled: false,
        search: { autoRag: { enabled: false, maxResults: 1, minScore: 0.5, maxContentChars: 10 } },
        memoryFlush: { enabled: false, messageThreshold: 10 },
      },
      session: { enabled: true, ttlMinutes: 30 },
      webTools: { maxToolRounds: 3 },
      conversation: {
        systemPrompt: '',
        streaming: { enabled: false, editIntervalMs: 800, minChunkChars: 50 },
        compaction: {
          enabled: false,
          contextWindows: { ollamaTokens: 8192, claudeCliTokens: 180_000 },
          thresholdRatio: 0.75,
          keepRecentMessages: 6,
          maxMessageChars: 15_000,
          maxOverflowRetries: 0,
        },
      },
      ollama: { models: { primary: 'llama3.1' } },
    },
    sessionManager: {
      isExpired: () => false,
      getFullHistory: () => [],
      clearSession: () => {},
      getHistory: () => [],
      getSessionMeta: () => ({ messageCount: 1 }),
      appendMessages: () => {},
      markMemoryFlushed: () => {},
      markActive: () => {},
    },
    memoryManager: undefined,
    searchEnabled: false,
    logger: mockLogger(),
    getLLMClient: () => llmClient,
    getActiveModel: () => 'claude',
    getBotLogger: () => mockLogger(),
  };
  const memoryFlusher: any = {
    flushSessionToMemory: mock(() => Promise.resolve()),
    flushWithScoring: mock(() => Promise.resolve()),
  };
  const pipeline = new ConversationPipeline(
    ctx,
    { build: () => 'system' } as any,
    memoryFlusher,
    {
      getDefinitionsForBot: () => toolDefs,
      createExecutor: () => toolExecutor,
    } as any,
    new ContextCompactor(ctx, memoryFlusher)
  );
  return { pipeline, ctx };
}

const botConfig = (backend: 'ollama' | 'claude-cli') =>
  ({
    id: 'bot1',
    name: 'Bot 1',
    model: 'claude',
    temperature: 0.7,
    maxHistory: 10,
    llmBackend: backend,
    systemPrompt: { text: 'test' },
  }) as any;

const inbound = () => ({
  messageId: 'm-1',
  channelKind: 'rest' as const,
  text: 'Hello',
  chatId: '1',
  chatType: 'private' as const,
  sender: { id: '2', firstName: 'Human' },
  timestamp: Date.now(),
});

function makeChannel() {
  return {
    kind: 'rest' as const,
    sendText: mock(() => Promise.resolve()),
    showTyping: mock(() => Promise.resolve()),
  };
}

beforeEach(() => {
  claudeCalls = 0;
  claudeToolCalls = 0;
  claudeBehaviour = () => Promise.resolve({ response: 'claude says hi' });
  claudeToolBehaviour = () => Promise.resolve({ response: 'claude used a tool' });
});
afterEach(() => {
  mock.restore();
});

describe('claude-cli bot conversations stay on claude-cli', () => {
  test('a healthy claude-cli conversation is answered by claude, never by ollama', async () => {
    const ollama = makeOllamaSpy();
    const client = createLLMClient({ llmBackend: 'claude-cli' }, ollama, mockLogger());
    const { pipeline } = makePipeline(client);
    const channel = makeChannel();

    const reply = await pipeline.handleChannelMessage(
      inbound() as any,
      channel as any,
      botConfig('claude-cli'),
      'user:1'
    );

    expect(claudeCalls).toBeGreaterThan(0);
    expect(ollama.chat).not.toHaveBeenCalled();
    expect(reply).toContain('claude says hi');
  });

  test('a transient Claude failure is NOT silently re-issued to Ollama', async () => {
    claudeBehaviour = () => Promise.reject(new Error('Claude CLI exited with code 1'));
    const ollama = makeOllamaSpy();
    const client = createLLMClient({ llmBackend: 'claude-cli' }, ollama, mockLogger());
    const { pipeline } = makePipeline(client);
    const channel = makeChannel();

    const reply = await pipeline.handleChannelMessage(
      inbound() as any,
      channel as any,
      botConfig('claude-cli'),
      'user:1'
    );

    expect(ollama.chat).not.toHaveBeenCalled();
    expect(reply).not.toContain('OLLAMA ANSWER');
  }, 30_000);

  test('tool-calling conversations still run on claude (MCP bridge path)', async () => {
    const ollama = makeOllamaSpy();
    const client = createLLMClient({ llmBackend: 'claude-cli' }, ollama, mockLogger());
    const { pipeline } = makePipeline(client, [
      { type: 'function', function: { name: 'noop', description: 'x', parameters: {} } },
    ]);
    const channel = makeChannel();

    const reply = await pipeline.handleChannelMessage(
      inbound() as any,
      channel as any,
      botConfig('claude-cli'),
      'user:1'
    );

    expect(claudeToolCalls).toBeGreaterThan(0);
    expect(ollama.chat).not.toHaveBeenCalled();
    expect(reply).toContain('claude used a tool');
  });
});

describe('ollama bots are unchanged', () => {
  test('an ollama conversation goes straight to the ollama client', async () => {
    const ollama = makeOllamaSpy();
    const client = createLLMClient({ llmBackend: 'ollama' }, ollama, mockLogger());
    const { pipeline } = makePipeline(client);
    const channel = makeChannel();

    const reply = await pipeline.handleChannelMessage(
      inbound() as any,
      channel as any,
      botConfig('ollama'),
      'user:1'
    );

    expect(ollama.chat).toHaveBeenCalledTimes(1);
    expect(claudeCalls).toBe(0);
    expect(reply).toContain('OLLAMA ANSWER');
  });
});
