/**
 * Operator turns get what the fleet knows (the watcher's graph) prefetched
 * into the conversation prompt, the same way RAG prefetches the bot's own
 * memory. Live, 2026-10-24: a canary fact planted with one bot was in the
 * graph, but another bot asked about it never called `fleet_memory_search`.
 * Non-operator turns get nothing (the graph holds operator material).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextCompactor } from '../../src/bot/context-compaction';
import { ConversationPipeline } from '../../src/bot/conversation-pipeline';
import type { SystemPromptOptions } from '../../src/bot/system-prompt-builder';
import { Graph } from '../../src/watcher/graph';

let dir: string;
let graph: Graph;
const t = Date.parse('2026-10-24T10:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-prefetch-'));
  graph = new Graph(dir, { now: () => t });
  graph.load();
  graph.addNeuron({
    kind: 'entity',
    text: 'Finny',
    support: { bots: ['finny'] },
    createdBy: 'bot:finny',
    meta: { key: 'bot:finny', name: 'Finny' },
  });
  graph.addNeuron({
    kind: 'fact',
    text: 'The canary codeword for the heron project is heliotrope',
    support: { bots: ['finny'] },
    createdBy: 'watcher',
    meta: { operatorSourced: 'true' },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function logger(): any {
  const l: any = { info: () => {}, warn: mock(() => {}), error: () => {}, debug: () => {} };
  l.child = () => l;
  return l;
}

function makePipeline(
  opts: {
    watcherEnabled?: boolean;
    source?: () => unknown;
    bots?: Array<Record<string, unknown>>;
    multiTenant?: boolean;
  } = {}
) {
  const built: SystemPromptOptions[] = [];
  const botLogger = logger();
  const ctx: any = {
    config: {
      watcher: { enabled: opts.watcherEnabled ?? true },
      soul: {
        enabled: false,
        search: { autoRag: { enabled: false, maxResults: 1, minScore: 0.5, maxContentChars: 10 } },
        memoryFlush: { enabled: false, messageThreshold: 10 },
      },
      session: { enabled: false, ttlMinutes: 30 },
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
      bots: opts.bots ?? [],
      ...(opts.multiTenant ? { multiTenant: { enabled: true } } : {}),
    },
    sessionManager: {
      isExpired: () => false,
      expiryReason: () => null,
      getEndedSession: () => undefined,
      getFullHistory: () => [],
      clearSession: () => {},
      getHistory: () => [],
      getSessionMeta: () => ({ messageCount: 1 }),
      appendMessages: () => {},
      markMemoryFlushed: () => {},
      markActive: () => {},
    },
    fleetMemory: opts.source ?? (() => ({ graph })),
    memoryManager: undefined,
    searchEnabled: false,
    logger: logger(),
    getLLMClient: () => ({ chat: async () => ({ text: 'ok', usage: undefined }) }),
    getActiveModel: () => 'llama3.1',
    getBotLogger: () => botLogger,
  };
  const memoryFlusher: any = {
    flushSessionToMemory: mock(() => Promise.resolve()),
    flushWithScoring: mock(() => Promise.resolve()),
  };
  const pipeline = new ConversationPipeline(
    ctx,
    {
      build: (o: SystemPromptOptions) => {
        built.push(o);
        return 'system';
      },
    } as any,
    memoryFlusher,
    { getDefinitionsForBot: () => [], createExecutor: () => mock(() => ({})) } as any,
    new ContextCompactor(ctx, memoryFlusher)
  );
  return { pipeline, built, botLogger };
}

const bot = {
  id: 'ai-perfectionist',
  name: 'AI Perfectionist',
  model: 'llama3.1',
  temperature: 0.7,
  maxHistory: 10,
  llmBackend: 'ollama',
  systemPrompt: { text: 'test' },
} as any;

const question = (sender = '7') => ({
  messageId: 'm-1',
  channelKind: 'web' as const,
  text: 'What is the canary codeword for the heron project?',
  chatId: '1',
  chatType: 'private' as const,
  sender: { id: sender, firstName: 'Someone' },
  timestamp: t,
});

const channel = () => ({
  kind: 'web' as const,
  sendText: mock(() => Promise.resolve()),
  showTyping: mock(() => Promise.resolve()),
});

describe('fleet memory prefetch in conversations', () => {
  test('an operator turn (dashboard thread) gets "What the fleet knows" with the canary fact', async () => {
    const { pipeline, built } = makePipeline();
    await pipeline.handleChannelMessage(question() as any, channel() as any, bot, 'k', {
      actor: 'operator',
    });
    expect(built).toHaveLength(1);
    expect(built[0].operatorTurn).toBe(true);
    expect(built[0].fleetMemoryContext).toContain('## What the fleet knows');
    expect(built[0].fleetMemoryContext).toContain('heliotrope');
    expect(built[0].fleetMemoryContext).toContain('known by Finny');
  });

  // Live, 2026-10-24: ai-perfectionist and jarvis-factory carry the admin
  // tenant's id and never got the prefetch.
  test('a bot of the admin tenant (__admin__) gets the prefetch in multi-tenant mode', async () => {
    const { pipeline, built } = makePipeline({
      bots: [{ id: bot.id, tenantId: '__admin__' }],
      multiTenant: true,
    });
    await pipeline.handleChannelMessage(question() as any, channel() as any, bot, 'k', {
      actor: 'operator',
    });
    expect(built[0].fleetMemoryContext).toContain('heliotrope');
  });

  test('a bot of a customer tenant gets no prefetch; multi-tenant off it does', async () => {
    const tenant = makePipeline({ bots: [{ id: bot.id, tenantId: 't1' }], multiTenant: true });
    await tenant.pipeline.handleChannelMessage(question() as any, channel() as any, bot, 'k', {
      actor: 'operator',
    });
    expect(tenant.built[0].fleetMemoryContext ?? null).toBeNull();

    const single = makePipeline({ bots: [{ id: bot.id, tenantId: 't1' }] });
    await single.pipeline.handleChannelMessage(question() as any, channel() as any, bot, 'k', {
      actor: 'operator',
    });
    expect(single.built[0].fleetMemoryContext).toContain('heliotrope');
  });

  test('a public turn gets nothing, and the graph is not even read', async () => {
    const read = mock(() => ({ graph }));
    const { pipeline, built } = makePipeline({ source: read });
    await pipeline.handleChannelMessage(question() as any, channel() as any, bot, 'k');
    expect(built[0].operatorTurn).toBe(false);
    expect(built[0].fleetMemoryContext ?? null).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  test('watcher off (config) or not running (no source): no section', async () => {
    const off = makePipeline({ watcherEnabled: false });
    await off.pipeline.handleChannelMessage(question() as any, channel() as any, bot, 'k', {
      actor: 'operator',
    });
    expect(off.built[0].fleetMemoryContext ?? null).toBeNull();

    const asleep = makePipeline({ source: () => undefined });
    await asleep.pipeline.handleChannelMessage(question() as any, channel() as any, bot, 'k', {
      actor: 'operator',
    });
    expect(asleep.built[0].fleetMemoryContext ?? null).toBeNull();
  });

  test('a prefetch that throws never breaks the turn', async () => {
    const broken = {
      graph: {
        list: () => {
          throw new Error('graph unreadable');
        },
        findByKey: () => undefined,
        getEmbedding: () => undefined,
      },
    };
    const { pipeline, built, botLogger } = makePipeline({ source: () => broken });
    const ch = channel();
    const reply = await pipeline.handleChannelMessage(question() as any, ch as any, bot, 'k', {
      actor: 'operator',
    });
    expect(reply).toContain('ok');
    expect(built[0].fleetMemoryContext ?? null).toBeNull();
    expect(botLogger.warn).toHaveBeenCalled();
  });
});
