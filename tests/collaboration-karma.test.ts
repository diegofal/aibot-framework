import { describe, expect, mock, test } from 'bun:test';
import { CollaborationManager } from '../src/bot/collaboration';
import type { SystemPromptBuilder } from '../src/bot/system-prompt-builder';
import type { ToolRegistry } from '../src/bot/tool-registry';
import type { BotContext } from '../src/bot/types';
import type { KarmaService } from '../src/karma/service';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

interface CtxOpts {
  chat?: () => Promise<{ text: string }>;
  internalQueryTimeout?: number;
}

function createMockCtx(opts: CtxOpts = {}): BotContext {
  const sessions = new Map<string, { id: string; messages: unknown[] }>();
  let seq = 0;
  return {
    config: {
      bots: [
        { id: 'source', name: 'Source' },
        { id: 'target', name: 'Target' },
      ],
      ollama: { models: { primary: 'qwen3:8b' } },
      conversation: { systemPrompt: 'sys', temperature: 0.7, maxHistory: 10 },
      session: { enabled: false },
      collaboration: {
        maxRounds: 5,
        cooldownMs: 10_000,
        sessionTtlMs: 300_000,
        visibleMaxTurns: 3,
        enableTargetTools: false,
        internalQueryTimeout: opts.internalQueryTimeout ?? 30_000,
        maxConverseTurns: 5,
      },
    },
    logger: { ...noopLogger, child: () => noopLogger },
    bots: new Map(),
    runningBots: new Set(['source', 'target']),
    activeModels: new Map(),
    agentRegistry: { getByBotId: () => undefined },
    activityStream: { publish: () => {} },
    getBotLogger: () => noopLogger,
    resolveBotId: (id: string) => id,
    getActiveModel: () => 'qwen3:8b',
    getSoulLoader: () => ({ composeSystemPrompt: () => 'soul prompt' }),
    getLLMClient: () => ({
      chat: opts.chat ?? (() => Promise.resolve({ text: 'target replies [DONE]' })),
    }),
    collaborationTracker: { checkAndRecord: () => ({ allowed: true }) },
    collaborationSessions: {
      get: (id: string) => sessions.get(id),
      create: (sourceBotId: string, targetBotId: string) => {
        const s = { id: `s${++seq}`, sourceBotId, targetBotId, messages: [] };
        sessions.set(s.id, s);
        return s;
      },
      appendMessages: () => {},
      end: () => {},
    },
  } as unknown as BotContext;
}

function createManager(ctx: BotContext) {
  const recordOutcome = mock(() => null);
  const karma = { recordOutcome } as unknown as KarmaService;
  const cm = new CollaborationManager(
    ctx,
    { build: () => 'system prompt' } as unknown as SystemPromptBuilder,
    {
      getCollaborationToolsForBot: () => ({ tools: [], definitions: [] }),
    } as unknown as ToolRegistry
  );
  cm.setKarmaService(karma);
  return { cm, recordOutcome };
}

describe('CollaborationManager karma: collaborateCompleted', () => {
  test('records the outcome when a collaboration session completes', async () => {
    const { cm, recordOutcome } = createManager(createMockCtx());

    const result = await cm.initiateCollaboration('source', 'target', 'topic', 1);

    expect(result.turns).toBe(1);
    expect(recordOutcome).toHaveBeenCalledTimes(1);
    const [botId, kind, reason, metadata] = recordOutcome.mock.calls[0] as unknown as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(botId).toBe('source');
    expect(kind).toBe('collaborateCompleted');
    expect(typeof reason).toBe('string');
    expect(metadata).toMatchObject({ targetBotId: 'target', turns: 1 });
  });

  test('credits the source bot, not the target', async () => {
    const { cm, recordOutcome } = createManager(createMockCtx());
    await cm.initiateCollaboration('source', 'target', 'topic', 1);
    expect((recordOutcome.mock.calls[0] as unknown as string[])[0]).toBe('source');
  });

  test('does NOT record the outcome when the collaboration times out', async () => {
    const ctx = createMockCtx({
      internalQueryTimeout: 20,
      chat: () => new Promise(() => {}), // never settles
    });
    const { cm, recordOutcome } = createManager(ctx);

    await expect(cm.initiateCollaboration('source', 'target', 'topic', 1)).rejects.toThrow(
      /timeout/i
    );
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  test('does NOT record the outcome when the collaboration step fails', async () => {
    const ctx = createMockCtx({ chat: () => Promise.reject(new Error('backend exploded')) });
    const { cm, recordOutcome } = createManager(ctx);

    await expect(cm.initiateCollaboration('source', 'target', 'topic', 1)).rejects.toThrow(
      'backend exploded'
    );
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  test('works with no karma service wired (no throw)', async () => {
    const cm = new CollaborationManager(
      createMockCtx(),
      { build: () => 'system prompt' } as unknown as SystemPromptBuilder,
      {
        getCollaborationToolsForBot: () => ({ tools: [], definitions: [] }),
      } as unknown as ToolRegistry
    );
    await expect(cm.initiateCollaboration('source', 'target', 'topic', 1)).resolves.toBeDefined();
  });
});
