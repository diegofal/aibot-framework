import { describe, expect, it } from 'bun:test';
import { CollaborationManager } from '../../src/bot/collaboration';
import type { SystemPromptBuilder } from '../../src/bot/system-prompt-builder';
import type { ToolRegistry } from '../../src/bot/tool-registry';
import type { BotContext } from '../../src/bot/types';

function createMockCtx(overrides?: Partial<BotContext>): BotContext {
  return {
    config: {
      bots: [],
      collaboration: {
        maxRounds: 5,
        cooldownMs: 10_000,
        sessionTtlMs: 300_000,
        visibleMaxTurns: 3,
        enableTargetTools: false,
        internalQueryTimeout: 30_000,
        maxConverseTurns: 5,
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    },
    bots: new Map(),
    runningBots: new Set(),
    activeModels: new Map(),
    agentRegistry: {
      getByBotId: () => ({ telegramUsername: 'testbot' }),
    },
    activityStream: { publish: () => {} },
    getBotLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
    resolveBotId: (id: string) => id,
    ...overrides,
  } as unknown as BotContext;
}

function createMockSystemPromptBuilder(): SystemPromptBuilder {
  return { build: () => 'system prompt' } as unknown as SystemPromptBuilder;
}

function createMockToolRegistry(): ToolRegistry {
  return {
    getCollaborationToolsForBot: () => ({ tools: [], definitions: [] }),
  } as unknown as ToolRegistry;
}

describe('CollaborationManager.drainPending', () => {
  it('resolves immediately when no pending tasks', async () => {
    const cm = new CollaborationManager(
      createMockCtx(),
      createMockSystemPromptBuilder(),
      createMockToolRegistry()
    );
    await cm.drainPending('bot1'); // should not throw
  });

  it('drainPending awaits pending tasks', async () => {
    const cm = new CollaborationManager(
      createMockCtx(),
      createMockSystemPromptBuilder(),
      createMockToolRegistry()
    );

    // Access private pendingTasks to inject a tracked promise
    const pendingTasks = (cm as any).pendingTasks as Map<string, Set<Promise<void>>>;
    let resolved = false;

    const taskSet = new Set<Promise<void>>();
    const task = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 50);
    }).finally(() => {
      taskSet.delete(task);
    });
    taskSet.add(task);
    pendingTasks.set('bot1', taskSet);

    expect(resolved).toBe(false);
    await cm.drainPending('bot1');
    expect(resolved).toBe(true);
  });

  it('completed tasks are cleaned from the set', async () => {
    const cm = new CollaborationManager(
      createMockCtx(),
      createMockSystemPromptBuilder(),
      createMockToolRegistry()
    );

    const pendingTasks = (cm as any).pendingTasks as Map<string, Set<Promise<void>>>;
    const taskSet = new Set<Promise<void>>();
    pendingTasks.set('bot1', taskSet);

    // Create a task that self-removes via .finally()
    const task = Promise.resolve().finally(() => {
      taskSet.delete(task);
    });
    taskSet.add(task);

    // Wait for the task to complete and clean up
    await new Promise((r) => setTimeout(r, 10));
    expect(taskSet.size).toBe(0);
  });

  it('drainPending handles task errors gracefully', async () => {
    const cm = new CollaborationManager(
      createMockCtx(),
      createMockSystemPromptBuilder(),
      createMockToolRegistry()
    );

    const pendingTasks = (cm as any).pendingTasks as Map<string, Set<Promise<void>>>;
    const taskSet = new Set<Promise<void>>();

    const failingTask = Promise.reject(new Error('test error'))
      .catch(() => {}) // suppress unhandled rejection
      .finally(() => {
        taskSet.delete(failingTask);
      });
    taskSet.add(failingTask);
    pendingTasks.set('bot1', taskSet);

    // Should not throw
    await cm.drainPending('bot1');
  });
});
