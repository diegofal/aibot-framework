/**
 * Phase 2b (C15): asks and approvals per worker run.
 *
 * A worker run asks through the same ask_human / ask_permission tools as the
 * cycle. The answer must reach the asker: the cycle consumes its own through
 * `consume*ForBot`, a run gets its own through `WorkerPoolApi.onAnswer` — and
 * never both, or an approved action would be executed twice.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { AskHumanStore } from '../../src/bot/ask-human-store';
import { AskPermissionStore } from '../../src/bot/ask-permission-store';
import { autoAttachFiles } from '../../src/bot/executor-turn';
import type { ToolExecutionRecord } from '../../src/bot/tool-executor';
import type { BotContext } from '../../src/bot/types';
import { ConversationsService } from '../../src/conversations/service';
import type { Logger } from '../../src/logger';
import {
  type AskHumanDeps,
  createAskHumanTool,
  reconcileAskHumanInbox,
  sweepStaleAskHumanQuestions,
} from '../../src/tools/ask-human';
import { createAskPermissionTool } from '../../src/tools/ask-permission';
import type { WorkerAnswer } from '../../src/workers/types';
import { createTempDir } from '../helpers/temp-dir';

const HOUR = 3_600_000;

function makeLogger(): Logger {
  const logger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

const logger = makeLogger();

/** A fake pool sink: records what reached each run. */
function makeRouter(delivered = true) {
  const calls: Array<{ runId: string; answer: WorkerAnswer }> = [];
  const router = (runId: string, answer: WorkerAnswer) => {
    calls.push({ runId, answer });
    return delivered;
  };
  return { calls, router };
}

describe('ask_human per run', () => {
  let dir: string;
  let store: AskHumanStore;
  let conversations: ConversationsService;

  function deps(overrides: Partial<AskHumanDeps> = {}): AskHumanDeps {
    return {
      store,
      getBotInstance: () => undefined,
      getBotName: (id) => id,
      conversationsService: conversations,
      ...overrides,
    };
  }

  /** store.ask with the waiter's rejection swallowed (nobody awaits it here). */
  function ask(...args: Parameters<AskHumanStore['ask']>) {
    const r = store.ask(...args);
    r.promise.catch(() => {});
    return r;
  }

  beforeEach(() => {
    dir = createTempDir('asks-per-run');
    store = new AskHumanStore(logger, `${dir}/ask-human`);
    conversations = new ConversationsService(`${dir}/conversations`);
  });

  test('the cycle and two runs each keep one pending question', async () => {
    const tool = createAskHumanTool(deps());
    const cycle = await tool.execute({ question: 'Cycle question?', _botId: 'b' }, logger);
    const r1 = await tool.execute(
      { question: 'Run one question?', _botId: 'b', _runId: 'run-1', _taskId: 't-1' },
      logger
    );
    const r2 = await tool.execute(
      { question: 'Run two question?', _botId: 'b', _runId: 'run-2', _taskId: 't-2' },
      logger
    );
    expect(store.getPendingForBot('b')).toHaveLength(3);
    expect(cycle.content).toContain('queued to the human inbox');
    expect(r1.content).toContain('the run will pause until the operator answers');
    expect(r2.content).toContain('the run will pause until the operator answers');

    // A second ask from the same scope is still refused.
    const again = await tool.execute(
      { question: 'Run one again?', _botId: 'b', _runId: 'run-1' },
      logger
    );
    expect(again.content).toContain('already have a pending question');
    const cycleAgain = await tool.execute({ question: 'Cycle again?', _botId: 'b' }, logger);
    expect(cycleAgain.content).toContain('already have a pending question');
    expect(store.getPendingForBot('b')).toHaveLength(3);
  });

  test('pending questions and inbox threads carry runId and taskId', async () => {
    const tool = createAskHumanTool(deps());
    await tool.execute(
      { question: 'Run question?', _botId: 'b', _runId: 'run-1', _taskId: 't-1' },
      logger
    );
    const [q] = store.getPendingForBot('b');
    expect(q.runId).toBe('run-1');
    expect(q.taskId).toBe('t-1');
    const conv = conversations.findByQuestionId('b', q.id);
    expect(conv?.runId).toBe('run-1');
    expect(conv?.taskId).toBe('t-1');
  });

  test('each answer reaches its asker: cycle via consume, runs via onAnswer', () => {
    const { calls, router } = makeRouter();
    store.setRunRouter(router);
    const cycle = ask('b', 0, 'Cycle?');
    const r1 = ask('b', 0, 'Run 1?', undefined, Date.now(), { runId: 'run-1' });
    const r2 = ask('b', 0, 'Run 2?', undefined, Date.now(), { runId: 'run-2' });

    store.answerById(r2.id, 'two');
    store.answerById(cycle.id, 'zero');
    store.answerById(r1.id, 'one');

    expect(calls).toEqual([
      { runId: 'run-2', answer: { kind: 'ask', id: r2.id, answer: 'two' } },
      { runId: 'run-1', answer: { kind: 'ask', id: r1.id, answer: 'one' } },
    ]);
    const consumed = store.consumeAnswersForBot('b');
    expect(consumed.map((a) => a.id)).toEqual([cycle.id]);
  });

  test('an answer the pool could not take waits for the run, never for the cycle', () => {
    const { router } = makeRouter(false);
    store.setRunRouter(router);
    const r1 = ask('b', 0, 'Run 1?', undefined, Date.now(), { runId: 'run-1' });
    store.answerById(r1.id, 'one');
    expect(store.consumeAnswersForBot('b')).toEqual([]);
    const forRun = store.consumeAnswersForRun('run-1');
    expect(forRun.map((a) => a.answer)).toEqual(['one']);
    expect(store.consumeAnswersForRun('run-1')).toEqual([]);
  });

  test('without a router a run answer is kept for the run too', () => {
    const r1 = ask('b', 0, 'Run 1?', undefined, Date.now(), { runId: 'run-1' });
    store.answerById(r1.id, 'one');
    expect(store.consumeAnswersForBot('b')).toEqual([]);
    expect(store.consumeAnswersForRun('run-1')).toHaveLength(1);
  });

  test('dismiss, close-stale and clear route a run question as dismissed', () => {
    const { calls, router } = makeRouter();
    store.setRunRouter(router);
    const now = Date.now();
    const d = ask('b', 0, 'Dismiss me?', undefined, now, { runId: 'run-d' });
    const s = ask('b', 0, 'Stale?', undefined, now - 100 * HOUR, { runId: 'run-s' });
    const cycleStale = ask('b', 0, 'Cycle stale?', undefined, now - 100 * HOUR);
    store.dismissById(d.id);
    store.closeStale(72 * HOUR, now, 'b');
    const c = ask('b', 0, 'Cleared?', undefined, now, { runId: 'run-c' });
    store.clearForBot('b');

    expect(calls).toEqual([
      { runId: 'run-d', answer: { kind: 'ask', id: d.id, dismissed: true } },
      { runId: 'run-s', answer: { kind: 'ask', id: s.id, dismissed: true } },
      { runId: 'run-c', answer: { kind: 'ask', id: c.id, dismissed: true } },
    ]);
    expect(calls.some((x) => x.answer.id === cycleStale.id)).toBe(false);
  });

  test('the ask tool sweep routes a stale run question as dismissed', () => {
    const { calls, router } = makeRouter();
    store.setRunRouter(router);
    const now = Date.now();
    const s = ask('b', 0, 'Stale?', undefined, now - 100 * HOUR, { runId: 'run-s' });
    sweepStaleAskHumanQuestions(deps({ now: () => now }), logger, 'b');
    expect(calls).toEqual([{ runId: 'run-s', answer: { kind: 'ask', id: s.id, dismissed: true } }]);
  });

  test('runId and taskId survive a restart', () => {
    ask('b', 0, 'Run 1?', undefined, Date.now(), { runId: 'run-1', taskId: 't-1' });
    const reloaded = new AskHumanStore(logger, `${dir}/ask-human`);
    const [q] = reloaded.getPendingForBot('b');
    expect(q.runId).toBe('run-1');
    expect(q.taskId).toBe('t-1');
  });

  test('a run question restored from its inbox thread keeps routing to the run', async () => {
    const tool = createAskHumanTool(deps());
    await tool.execute({ question: 'Run?', _botId: 'b', _runId: 'run-1', _taskId: 't-1' }, logger);
    const [q] = store.getPendingForBot('b');
    // Store file lost: only the inbox thread survives.
    const fresh = new AskHumanStore(logger);
    reconcileAskHumanInbox({ ...deps(), store: fresh }, logger);
    const [restored] = fresh.getPendingForBot('b');
    expect(restored.id).toBe(q.id);
    expect(restored.runId).toBe('run-1');
    expect(restored.taskId).toBe('t-1');
  });

  describe('Telegram reply matching', () => {
    test('several pending for the bot: only a reply-to matches', () => {
      const { calls, router } = makeRouter();
      store.setRunRouter(router);
      const a = ask('b', 42, 'A?');
      store.setMessageId(a.id, 100);
      const r = ask('b', 7, 'R?', undefined, Date.now(), { runId: 'run-1' });
      store.setMessageId(r.id, 200);

      // Plain message in chat 42: exactly one pending in that chat, but two for the bot.
      expect(store.handleReply('b', 42, 'hello').matched).toBe(false);
      expect(store.getPendingForBot('b')).toHaveLength(2);

      // Two in the same chat: reply-to picks the right one.
      const r2 = ask('b', 42, 'R2?', undefined, Date.now(), { runId: 'run-2' });
      store.setMessageId(r2.id, 300);
      const res = store.handleReply('b', 42, 'answer for run 2', 300);
      expect(res).toMatchObject({ matched: true, questionId: r2.id });
      expect(calls).toEqual([
        { runId: 'run-2', answer: { kind: 'ask', id: r2.id, answer: 'answer for run 2' } },
      ]);
      expect(store.consumeAnswersForBot('b')).toEqual([]);
    });

    test('exactly one pending for the bot: a plain message still answers it', () => {
      const { calls, router } = makeRouter();
      store.setRunRouter(router);
      const r = ask('b', 42, 'R?', undefined, Date.now(), { runId: 'run-1' });
      store.setMessageId(r.id, 100);
      expect(store.handleReply('b', 42, 'yes').matched).toBe(true);
      expect(calls).toEqual([{ runId: 'run-1', answer: { kind: 'ask', id: r.id, answer: 'yes' } }]);
    });
  });

  describe('autoAttachFiles', () => {
    function ctxFor(): BotContext {
      return { askHumanStore: store, conversationsService: conversations } as unknown as BotContext;
    }
    function filesOf(questionId: string): string[] {
      const conv = conversations.findByQuestionId('b', questionId);
      if (!conv) return [];
      const botMsg = conversations.getMessages('b', conv.id).find((m) => m.role === 'bot');
      return (botMsg?.files ?? []).map((f) => f.path);
    }

    test('attaches to the question this turn asked, not the last pending', async () => {
      const tool = createAskHumanTool(deps());
      const cycleRes = await tool.execute({ question: 'Cycle?', _botId: 'b' }, logger);
      // A run asks later: it is now "the last pending".
      await tool.execute({ question: 'Run?', _botId: 'b', _runId: 'run-1' }, logger);
      const [cycleQ, runQ] = store.getPendingForBot('b');

      const log: ToolExecutionRecord[] = [
        { name: 'file_write', args: {}, success: true, result: 'ok' },
        { name: 'ask_human', args: {}, success: true, result: cycleRes.content },
      ];
      autoAttachFiles(
        ctxFor(),
        'b',
        { getFileOperations: () => [{ path: 'report.md', size: 3 }] },
        log,
        logger
      );
      expect(filesOf(cycleQ.id)).toEqual(['report.md']);
      expect(filesOf(runQ.id)).toEqual([]);
    });

    test('a refused ask (already pending) attaches nothing', async () => {
      const tool = createAskHumanTool(deps());
      await tool.execute({ question: 'Run?', _botId: 'b', _runId: 'run-1' }, logger);
      const refused = await tool.execute(
        { question: 'Run 2?', _botId: 'b', _runId: 'run-1' },
        logger
      );
      const [runQ] = store.getPendingForBot('b');
      autoAttachFiles(
        ctxFor(),
        'b',
        { getFileOperations: () => [{ path: 'x.md' }] },
        [{ name: 'ask_human', args: {}, success: true, result: refused.content }],
        logger
      );
      expect(filesOf(runQ.id)).toEqual([]);
    });
  });
});

describe('ask_permission per run', () => {
  let store: AskPermissionStore;

  beforeEach(() => {
    store = new AskPermissionStore(logger, `${createTempDir('perm-per-run')}/ask-permission`);
  });

  test("a worker's approved permission goes to the run, not to consumeDecisionsForBot", () => {
    const { calls, router } = makeRouter();
    store.setRunRouter(router);
    const cycle = store.request('b', 'exec', 'ls', 'list');
    const run = store.request('b', 'exec', 'rm tmp', 'clean', 'normal', { runId: 'run-1' });
    const denied = store.request('b', 'api_call', 'x', 'call', 'normal', { runId: 'run-2' });
    store.approveById(run.id);
    store.denyById(denied.id);
    store.approveById(cycle.id);

    expect(calls).toEqual([
      { runId: 'run-1', answer: { kind: 'approval', id: run.id, decision: 'approved' } },
      { runId: 'run-2', answer: { kind: 'approval', id: denied.id, decision: 'denied' } },
    ]);
    expect(store.consumeDecisionsForBot('b').map((d) => d.id)).toEqual([cycle.id]);
    // The decision is still in the history for "Why this?".
    expect(store.getHistoryById(run.id)?.runId).toBe('run-1');
  });

  test('an undelivered run decision waits for the run, never for the cycle', () => {
    const { router } = makeRouter(false);
    store.setRunRouter(router);
    const run = store.request('b', 'exec', 'rm tmp', 'clean', 'normal', { runId: 'run-1' });
    store.approveById(run.id);
    expect(store.consumeDecisionsForBot('b')).toEqual([]);
    expect(store.consumeDecisionsForRun('run-1').map((d) => d.id)).toEqual([run.id]);
    expect(store.consumeDecisionsForRun('run-1')).toEqual([]);
  });

  test('a requeued run approval goes back to the run', () => {
    const { calls, router } = makeRouter();
    store.setRunRouter(router);
    const run = store.request('b', 'exec', 'rm tmp', 'clean', 'normal', { runId: 'run-1' });
    store.approveById(run.id);
    // Requeue only applies to consumed/failed decisions; a run decision is consumed by the pool.
    expect(store.getHistoryById(run.id)?.executionStatus).toBe('consumed');
    expect(store.requeueById(run.id)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(store.consumeDecisionsForBot('b')).toEqual([]);
  });

  test('the tool carries runId and dedups per scope', async () => {
    const tool = createAskPermissionTool({
      store,
      getBotInstance: () => undefined,
      getBotName: (id) => id,
    });
    const args = { action: 'exec', resource: 'ls', description: 'list', _botId: 'b' };
    await tool.execute(args, logger);
    const res = await tool.execute({ ...args, _runId: 'run-1', _taskId: 't-1' }, logger);
    expect(res.content).toContain('the run will pause until the operator decides');
    const pending = store.getPendingForBot('b');
    expect(pending).toHaveLength(2);
    expect(pending.find((p) => p.runId === 'run-1')).toBeDefined();
    const dup = await tool.execute({ ...args, _runId: 'run-1' }, logger);
    expect(dup.content).toContain('already have a pending permission request');
    expect(store.getPendingForBot('b')).toHaveLength(2);
  });
});
