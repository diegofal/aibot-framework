import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationGate } from '../../src/bot/conversation-gate';

function createMockCtx(overrides: Record<string, any> = {}) {
  return {
    config: {
      session: {
        enabled: true,
        llmRelevanceCheck: { enabled: false, broadcastCheck: false },
      },
      collaboration: { enabled: true },
    },
    agentRegistry: {
      getByTelegramUserId: vi.fn().mockReturnValue(undefined),
    },
    collaborationTracker: {
      checkAndRecord: vi.fn().mockReturnValue({ allowed: true }),
    },
    sessionManager: {
      shouldRespondInGroup: vi.fn().mockReturnValue('mention'),
      deriveKey: vi.fn().mockReturnValue({ botId: 'bot1', chatId: 1 }),
      serializeKey: vi.fn().mockReturnValue('bot1:1'),
      stripBotMention: vi.fn((text: string) => text.replace(/@testbot/gi, '').trim()),
    },
    handledMessageIds: new Set<string>(),
    ...overrides,
  } as any;
}

function createMockGroupActivation() {
  return {
    messageTargetsAnotherBot: vi.fn().mockReturnValue(false),
    checkLlmRelevance: vi.fn().mockResolvedValue(true),
    checkBroadcastRelevance: vi.fn().mockResolvedValue(false),
  } as any;
}

function createMockGrammyCtx(overrides: Record<string, any> = {}) {
  return {
    message: {
      text: 'hello',
      message_id: 1,
      reply_to_message: undefined,
      ...overrides.message,
    },
    chat: { id: 100, type: 'private', ...overrides.chat },
    from: { id: 42, username: 'user', first_name: 'Test', ...overrides.from },
    me: { username: 'testbot' },
    ...overrides,
  } as any;
}

function createMockConfig(overrides: Record<string, any> = {}) {
  return {
    id: 'bot1',
    name: 'TestBot',
    authorizedUsers: [],
    mentionPatterns: [],
    ...overrides,
  } as any;
}

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

describe('ConversationGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows a normal private message', async () => {
    const ctx = createMockCtx();
    const gate = new ConversationGate(ctx, createMockGroupActivation());
    const result = await gate.evaluate(createMockGrammyCtx(), createMockConfig(), mockLogger);
    expect(result.allowed).toBe(true);
    expect(result.strippedText).toBe('hello');
  });

  it('blocks command messages', async () => {
    const ctx = createMockCtx();
    const gate = new ConversationGate(ctx, createMockGroupActivation());
    const result = await gate.evaluate(
      createMockGrammyCtx({ message: { text: '/start', message_id: 1 } }),
      createMockConfig(),
      mockLogger,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('command');
  });

  it('blocks messages consumed by skill', async () => {
    const handledIds = new Set(['bot1:1']);
    const ctx = createMockCtx({ handledMessageIds: handledIds });
    const gate = new ConversationGate(ctx, createMockGroupActivation());
    const result = await gate.evaluate(createMockGrammyCtx(), createMockConfig(), mockLogger);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('skill_consumed');
  });

  it('blocks unauthorized users', async () => {
    const ctx = createMockCtx();
    const config = createMockConfig({ authorizedUsers: [999] });
    const gate = new ConversationGate(ctx, createMockGroupActivation());
    const result = await gate.evaluate(createMockGrammyCtx(), config, mockLogger);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unauthorized');
  });

  it('intercepts ask_human replies', async () => {
    const askHumanStore = {
      hasPending: vi.fn().mockReturnValue(true),
      handleReply: vi.fn().mockReturnValue({ matched: true, questionId: 'q1', botId: 'bot1' }),
    };
    const ctx = createMockCtx();
    const gate = new ConversationGate(ctx, createMockGroupActivation(), askHumanStore as any);
    const result = await gate.evaluate(createMockGrammyCtx(), createMockConfig(), mockLogger);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('ask_human_reply');
  });

  it('blocks collaboration messages when collaboration is disabled', async () => {
    const ctx = createMockCtx({
      config: {
        session: { enabled: true, llmRelevanceCheck: { enabled: false } },
        collaboration: { enabled: false },
      },
      agentRegistry: {
        getByTelegramUserId: vi.fn().mockReturnValue({ botId: 'other-bot' }),
      },
    });
    const gate = new ConversationGate(ctx, createMockGroupActivation());
    const result = await gate.evaluate(createMockGrammyCtx(), createMockConfig(), mockLogger);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('collab_disabled');
  });

  it('blocks bot messages without @mention', async () => {
    const ctx = createMockCtx({
      agentRegistry: {
        getByTelegramUserId: vi.fn().mockReturnValue({ botId: 'other-bot' }),
      },
    });
    const gate = new ConversationGate(ctx, createMockGroupActivation());
    const result = await gate.evaluate(
      createMockGrammyCtx({ message: { text: 'hello world', message_id: 1 } }),
      createMockConfig(),
      mockLogger,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('collab_no_mention');
  });

  it('allows bot messages with @mention when collaboration is enabled', async () => {
    const ctx = createMockCtx({
      agentRegistry: {
        getByTelegramUserId: vi.fn().mockReturnValue({ botId: 'other-bot' }),
      },
    });
    const gate = new ConversationGate(ctx, createMockGroupActivation());
    const result = await gate.evaluate(
      createMockGrammyCtx({ message: { text: 'hello @testbot', message_id: 1 } }),
      createMockConfig(),
      mockLogger,
    );
    expect(result.allowed).toBe(true);
    expect(result.isPeerBotMessage).toBe(true);
  });

  it('blocks collaboration limit exceeded', async () => {
    const ctx = createMockCtx({
      agentRegistry: {
        getByTelegramUserId: vi.fn().mockReturnValue({ botId: 'other-bot' }),
      },
      collaborationTracker: {
        checkAndRecord: vi.fn().mockReturnValue({ allowed: false, reason: 'rate_limited' }),
      },
    });
    const gate = new ConversationGate(ctx, createMockGroupActivation());
    const result = await gate.evaluate(
      createMockGrammyCtx({ message: { text: 'hello @testbot', message_id: 1 } }),
      createMockConfig(),
      mockLogger,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('collab_limit');
  });

  it('blocks group messages with no activation reason', async () => {
    const ctx = createMockCtx({
      config: {
        session: { enabled: true, llmRelevanceCheck: { enabled: false, broadcastCheck: false } },
        collaboration: { enabled: true },
      },
      sessionManager: {
        shouldRespondInGroup: vi.fn().mockReturnValue(undefined),
        deriveKey: vi.fn(),
        serializeKey: vi.fn(),
        stripBotMention: vi.fn((t: string) => t),
      },
    });
    const gate = new ConversationGate(ctx, createMockGroupActivation());
    const result = await gate.evaluate(
      createMockGrammyCtx({ chat: { id: 100, type: 'group' } }),
      createMockConfig(),
      mockLogger,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('group_inactive');
  });

  it('strips bot mention in groups when allowed', async () => {
    const ctx = createMockCtx();
    const gate = new ConversationGate(ctx, createMockGroupActivation());
    const result = await gate.evaluate(
      createMockGrammyCtx({
        message: { text: '@testbot hello', message_id: 1 },
        chat: { id: 100, type: 'group' },
      }),
      createMockConfig(),
      mockLogger,
    );
    expect(result.allowed).toBe(true);
    expect(result.strippedText).toBe('hello');
  });
});
