/**
 * The worker step on the real `runExecutorTurn`, with a claude-cli-like fake
 * client that ignores `maxToolRounds` and keeps calling tools: the worker's
 * callback counter is what stops it. Also: worker priority on the semaphore,
 * denied + confirm-level tools refused, and audit rows with the run's ids.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolAuditEntry } from '../../src/bot/tool-audit-log';
import { GlobalAgentLoopConfigSchema } from '../../src/config';
import type { Tool } from '../../src/tools/types';
import { WORKERS_DEFAULTS, type WorkerRun } from '../../src/workers/types';
import { drainAnswersFrom } from '../../src/workers/wiring';
import {
  type WorkerEnv,
  createExecutorTurnRunner,
  runWorker,
  workerDeniedTools,
} from '../../src/workers/worker';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-turn-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const quiet: any = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
};
quiet.child = () => quiet;

function tool(name: string, ran: string[]): Tool {
  return {
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    execute: async () => {
      ran.push(name);
      return { success: true, content: 'ok' };
    },
  };
}

function setup(calls: string[], agentLoop: Record<string, unknown> = {}) {
  const ran: string[] = [];
  const audit: ToolAuditEntry[] = [];
  const chatOpts: any[] = [];
  const tools = [tool('web_search', ran), tool('send_message', ran), tool('file_edit', ran)];
  const llm: any = {
    backend: 'claude-cli',
    chat: async (_messages: any[], opts: any) => {
      chatOpts.push(opts);
      // claude-cli: maxToolRounds is not honoured; the model calls on.
      for (const name of calls) await opts.toolExecutor(name, { q: 'x' });
      await opts.toolExecutor('task_progress', { note: 'searched' });
      return { text: 'ok', stopReason: 'completed' };
    },
  };
  const botConfig = { id: 'b1', name: 'B1', workDir: join(dir, 'prod', 'b1'), agentLoop };
  const ctx: any = {
    config: {
      bots: [botConfig],
      agentLoop: GlobalAgentLoopConfigSchema.parse({}),
      ollama: { models: { primary: 'm' } },
    },
    logger: quiet,
    tools,
    toolDefinitions: tools.map((t) => t.definition),
    toolAuditLog: { append: (e: ToolAuditEntry) => audit.push(e) },
    askHumanStore: { getPendingForBot: () => [] },
    getLLMClient: () => llm,
    getActiveModel: () => 'claude',
    getBotLogger: () => quiet,
  };
  const runner = createExecutorTurnRunner({
    ctx,
    botId: 'b1',
    toolRegistry: { getDefinitionsForBot: () => tools.map((t) => t.definition) },
  });
  return { ran, audit, chatOpts, runner, ctx };
}

function env(runTurn: WorkerEnv['runTurn'], budget: Partial<WorkerRun['budget']> = {}): WorkerEnv {
  const run: WorkerRun = {
    runId: 'wr-1',
    botId: 'b1',
    taskId: 't-1',
    goalId: 'g-1',
    dispatchCycleId: 'c-1',
    taskText: 'task',
    goalTitle: 'goal',
    status: 'queued',
    attempt: 1,
    step: 0,
    budget: { steps: 1, toolCalls: 40, wallMs: 3_600_000, ...budget },
    used: { steps: 0, toolCalls: 0, wallMs: 0 },
    createdAt: new Date().toISOString(),
    claimToken: 'tok',
  };
  return {
    run,
    config: WORKERS_DEFAULTS,
    signal: new AbortController().signal,
    now: () => Date.now(),
    context: () => ({
      goalTitle: 'goal',
      taskText: 'task',
      workDir: join(dir, 'prod', 'b1', 'tasks', 't-1'),
    }),
    runTurn,
    journal: () => {},
    readJournal: () => [],
    save: () => {},
    publish: () => {},
    renewClaim: () => true,
    releaseTask: () => true,
    dailyStepsLeft: () => 100,
  };
}

describe('worker step on runExecutorTurn', () => {
  test('the tool-call budget cuts a claude-cli turn that ignores maxToolRounds', async () => {
    const s = setup(Array(10).fill('web_search'));
    const e = env(s.runner, { toolCalls: 3 });
    await runWorker(e);
    expect(s.ran.filter((n) => n === 'web_search')).toHaveLength(3);
    expect(e.run.used.toolCalls).toBe(3);
    expect(e.run.lastReport?.note).toBe('searched');
  });

  test('worker priority, denied and confirm tools refused, audit rows carry the run', async () => {
    const s = setup(['send_message', 'file_edit', 'web_search']);
    await runWorker(env(s.runner));
    expect(s.chatOpts[0].priority).toBe('worker');
    const offered = s.chatOpts[0].tools.map((d: any) => d.function.name);
    expect(offered).toContain('web_search');
    expect(offered).toContain('task_done');
    expect(offered).not.toContain('send_message');
    expect(offered).not.toContain('file_edit');
    expect(s.ran).toEqual(['web_search']);
    const row = s.audit.find((a) => a.toolName === 'web_search');
    expect(row).toMatchObject({ runId: 'wr-1', taskId: 't-1', dispatchCycleId: 'c-1' });
    expect(row?.cycleId).toBeUndefined();
  });
});

describe('integration re-review: scope refusals are audited (N9)', () => {
  test('a write outside the task folder never runs, but has an audit row and a tool:end', async () => {
    const s = setup([]);
    const ran: string[] = [];
    s.ctx.tools.push(tool('file_write', ran));
    const ends: any[] = [];
    const llm: any = {
      backend: 'ollama',
      chat: async (_messages: any[], opts: any) => {
        const r = await opts.toolExecutor('file_write', { path: '/elsewhere/x.md', content: 'x' });
        ends.push(r);
        await opts.toolExecutor('task_progress', { note: 'tried' });
        return { text: 'ok', stopReason: 'completed' };
      },
    };
    const runner = createExecutorTurnRunner({
      ctx: { ...s.ctx, getLLMClient: () => llm },
      botId: 'b1',
      toolRegistry: { getDefinitionsForBot: () => s.ctx.tools.map((t: Tool) => t.definition) },
    });
    const e = env(runner);
    const journal: any[] = [];
    e.journal = (j) => journal.push(j);
    await runWorker(e);
    expect(ran).toEqual([]);
    expect(ends[0].success).toBe(false);
    expect(ends[0].content).toContain('workers write only inside their task directory');
    const row = s.audit.find((a) => a.toolName === 'file_write');
    expect(row).toMatchObject({ success: false, failureKind: 'scope', runId: 'wr-1' });
    expect(journal.find((j) => j.kind === 'tool' && j.name === 'file_write')).toMatchObject({
      failureKind: 'scope',
    });
  });

  test('N3: a denied tool is refused as disabled, so a resume knows it never ran', async () => {
    const s = setup(['send_message']);
    const e = env(s.runner);
    const journal: any[] = [];
    e.journal = (j) => journal.push(j);
    await runWorker(e);
    expect(s.ran).toEqual([]);
    expect(journal.find((j) => j.kind === 'tool' && j.name === 'send_message')).toMatchObject({
      ok: false,
      failureKind: 'disabled',
    });
  });
});

describe('worker tools after phase 2b', () => {
  test('workers may ask: ask_human and ask_permission are not denied', () => {
    expect(workerDeniedTools()).not.toContain('ask_human');
    expect(workerDeniedTools()).not.toContain('ask_permission');
    expect(workerDeniedTools()).toContain('send_message');
  });

  test('with enforceToolPermissions on, confirm tools are offered (they go through approval)', async () => {
    const flagged = setup(['web_search'], { enforceToolPermissions: true });
    await runWorker(env(flagged.runner));
    const offered = flagged.chatOpts[0].tools.map((d: any) => d.function.name);
    expect(offered).toContain('file_edit');
  });
});

describe('drainAnswersFrom', () => {
  test('maps stored answers and decisions for a run to WorkerAnswer', () => {
    const ctx: any = {
      askHumanStore: {
        consumeAnswersForRun: (r: string) =>
          r === 'wr-1' ? [{ id: 'q-1', answer: 'use EU only', runId: 'wr-1' }] : [],
      },
      askPermissionStore: {
        consumeDecisionsForRun: (r: string) =>
          r === 'wr-1' ? [{ id: 'p-1', status: 'approved', runId: 'wr-1' }] : [],
      },
    };
    expect(drainAnswersFrom(ctx)('wr-1')).toEqual([
      { kind: 'ask', id: 'q-1', answer: 'use EU only' },
      { kind: 'approval', id: 'p-1', decision: 'approved' },
    ]);
    expect(drainAnswersFrom(ctx)('wr-2')).toEqual([]);
    expect(drainAnswersFrom({} as any)('wr-1')).toEqual([]);
  });
});

describe('LLM queue time on the real runner (review M4)', () => {
  test('claude-cli: a slow semaphore queue does not time the step out', async () => {
    const s = setup([]);
    const llm: any = {
      backend: 'claude-cli',
      chat: async (_messages: any[], opts: any) => {
        s.chatOpts.push(opts);
        await new Promise((r) => setTimeout(r, 120)); // waiting for a CLI slot
        opts.onSlot?.();
        await opts.toolExecutor('task_done', { note: 'done after the queue' });
        return { text: 'ok', stopReason: 'completed' };
      },
    };
    const runner = createExecutorTurnRunner({
      ctx: { ...(s as any).ctx, getLLMClient: () => llm },
      botId: 'b1',
      toolRegistry: { getDefinitionsForBot: () => [] },
    });
    const e = env(runner);
    e.config = { ...WORKERS_DEFAULTS, stepTimeoutMs: 40 };
    const end = await runWorker(e);
    expect(typeof s.chatOpts[0].onSlot).toBe('function');
    expect(end.status).toBe('done');
  });

  test('ollama: no slot callback; the step clock starts with the step', async () => {
    const s = setup([]);
    const llm: any = {
      backend: 'ollama',
      chat: async (_messages: any[], opts: any) => {
        s.chatOpts.push(opts);
        await opts.toolExecutor('task_done', { note: 'ok' });
        return { text: 'ok', stopReason: 'completed' };
      },
    };
    const runner = createExecutorTurnRunner({
      ctx: { ...(s as any).ctx, getLLMClient: () => llm },
      botId: 'b1',
      toolRegistry: { getDefinitionsForBot: () => [] },
    });
    const end = await runWorker(env(runner));
    expect(s.chatOpts[0].onSlot).toBeUndefined();
    expect(end.status).toBe('done');
  });
});
