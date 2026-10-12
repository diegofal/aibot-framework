import { describe, expect, mock, test } from 'bun:test';
import { CollaborationManager } from '../src/bot/collaboration';
import type { SystemPromptBuilder } from '../src/bot/system-prompt-builder';
import type { ToolRegistry } from '../src/bot/tool-registry';
import type { BotContext } from '../src/bot/types';
import type { KarmaService } from '../src/karma/service';

// Row 17 of docs/plans/why-everywhere-plan.md: collab:start / collab:end and
// the collaborateCompleted karma outcome carry the cycle that started the
// collaboration and its opening message, plus a `why` the fleet feed renders.

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

interface CtxOpts {
  chat?: () => Promise<{ text: string }>;
  internalQueryTimeout?: number;
  publish?: (ev: unknown) => void;
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
    activityStream: { publish: opts.publish ?? (() => {}) },
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
      create: (sourceBotId: string, targetBotId: string, meta?: object) => {
        const s = { id: `s${++seq}`, sourceBotId, targetBotId, messages: [], ...meta };
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

interface Ev {
  type: string;
  botId: string;
  data: Record<string, unknown> & { why?: Record<string, unknown> };
}

function collect() {
  const events: Ev[] = [];
  return { events, publish: (ev: unknown) => events.push(ev as Ev) };
}

describe('CollaborationManager: why on collab events', () => {
  test('a step in a cycle: start and end carry the cycle, the opening and a why', async () => {
    const { events, publish } = collect();
    const { cm } = createManager(createMockCtx({ publish }));
    cm.setCycleLookup((botId) =>
      botId === 'source' ? { cycleId: 'c1', plan: 'Research X', goalTitle: 'Know X' } : undefined
    );
    await cm.collaborationStep(undefined, 'target', 'What do you know about X?', 'source', {
      cycleId: 'c1',
      goalId: 'g1',
    });
    const start = events.find((e) => e.type === 'collab:start');
    const end = events.find((e) => e.type === 'collab:end');
    expect(start?.data).toMatchObject({
      targetBotId: 'target',
      mode: 'internal',
      cycleId: 'c1',
      goalId: 'g1',
      opening: 'What do you know about X?',
    });
    expect(start?.data.why).toMatchObject({
      what: 'Asked Target for help',
      cycle: { id: 'c1', botId: 'source', plan: 'Research X' },
      goal: { id: 'g1', title: 'Know X' },
      outcome: "Waiting for Target's answer.",
    });
    expect(end?.data).toMatchObject({ cycleId: 'c1', opening: 'What do you know about X?' });
    expect(end?.data.why?.outcome).toBe('Target answered (21 characters).');
  });

  test('a resumed session keeps the initiating cycle and opening message', async () => {
    const { events, publish } = collect();
    const { cm } = createManager(createMockCtx({ publish }));
    const first = await cm.collaborationStep(undefined, 'target', 'Opening question', 'source', {
      cycleId: 'c1',
    });
    await cm.collaborationStep(first.sessionId, 'target', 'Follow-up', 'source', {
      cycleId: 'c2',
    });
    const starts = events.filter((e) => e.type === 'collab:start');
    expect(starts[1].data).toMatchObject({
      cycleId: 'c1',
      opening: 'Opening question',
      resumed: true,
    });
  });

  test('outside a cycle the why says so', async () => {
    const { events, publish } = collect();
    const { cm } = createManager(createMockCtx({ publish }));
    await cm.collaborationStep(undefined, 'target', 'hi', 'source');
    const start = events.find((e) => e.type === 'collab:start');
    expect(start?.data.cycleId).toBeUndefined();
    expect(String(start?.data.why?.missing)).toContain('Not asked during a work cycle');
  });

  test('the karma outcome carries the cycle and the opening message', async () => {
    const { cm, recordOutcome } = createManager(createMockCtx());
    await cm.initiateCollaboration('source', 'target', 'A topic to discuss', 1, {
      cycleId: 'c1',
      goalId: 'g1',
    });
    const metadata = (recordOutcome.mock.calls[0] as unknown as unknown[])[3];
    expect(metadata).toMatchObject({ cycleId: 'c1', goalId: 'g1', opening: 'A topic to discuss' });
  });
});
