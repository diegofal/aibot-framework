/**
 * The worker step loop (plan C11) against a fake turn runner: every step ends
 * with a report, two silent steps end the run, budgets end it, a step timeout
 * aborts the turn, the tool-call budget is enforced in the callback, and each
 * tool call is journaled with its side-effect class.
 */
import { describe, expect, test } from 'bun:test';
import type { TaskLane } from '../../src/goals/task-store';
import type { ToolResult } from '../../src/tools/types';
import {
  type JournalEntry,
  WORKERS_DEFAULTS,
  type WorkerEventType,
  type WorkerRun,
  type WorkerWait,
} from '../../src/workers/types';
import {
  type WorkerEnv,
  type WorkerTurnRequest,
  buildWorkerPrompt,
  classifySideEffect,
  parseWaitId,
  runWorker,
  stepsFromJournal,
} from '../../src/workers/worker';

type Call = { name: string; args?: Record<string, unknown> };
type StepScript = Call[] | 'hang' | 'error';

function makeRun(over: Partial<WorkerRun> = {}): WorkerRun {
  return {
    runId: 'r-1',
    botId: 'b1',
    taskId: 't-1',
    goalId: 'g-1',
    dispatchCycleId: 'c-1',
    taskText: 'Write the brief',
    goalTitle: 'Launch',
    status: 'queued',
    attempt: 1,
    step: 0,
    budget: { steps: 8, toolCalls: 40, wallMs: 3_600_000 },
    used: { steps: 0, toolCalls: 0, wallMs: 0 },
    createdAt: new Date().toISOString(),
    claimToken: 'tok',
    ...over,
  };
}

function harness(
  steps: StepScript[],
  opts: {
    run?: Partial<WorkerRun>;
    config?: Partial<typeof WORKERS_DEFAULTS>;
    wait?: WorkerWait;
    signal?: AbortSignal;
    dailyLeft?: number;
  } = {}
) {
  const run = makeRun(opts.run);
  const journal: JournalEntry[] = [];
  const events: Array<{ type: WorkerEventType; extra?: Record<string, unknown> }> = [];
  const releases: Array<{ lane: TaskLane; note: string }> = [];
  const requests: WorkerTurnRequest[] = [];
  const innerCalls: string[] = [];
  let renews = 0;
  let stepIdx = 0;
  let wait = opts.wait;

  const env: WorkerEnv = {
    run,
    config: { ...WORKERS_DEFAULTS, ...opts.config },
    signal: opts.signal ?? new AbortController().signal,
    now: () => Date.now(),
    context: () => ({
      goalTitle: 'Launch',
      taskText: 'Write the brief',
      workDir: '/p/b1/tasks/t-1',
    }),
    journal: (e) =>
      journal.push({ ts: new Date().toISOString(), runId: run.runId, ...e } as JournalEntry),
    readJournal: () => journal,
    save: () => {},
    publish: (type, extra) => events.push({ type, extra: extra as Record<string, unknown> }),
    renewClaim: () => {
      renews++;
      return true;
    },
    releaseTask: (lane, note) => {
      releases.push({ lane, note });
      return true;
    },
    dailyStepsLeft: () => opts.dailyLeft ?? 100,
    takeWait: () => {
      const w = wait;
      wait = undefined;
      return w;
    },
    runTurn: async (req) => {
      requests.push(req);
      const script = steps[stepIdx++] ?? [];
      if (script === 'error')
        return { ok: false, stopReason: 'error', error: new Error('boom'), text: '' };
      if (script === 'hang') {
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) resolve();
          else req.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { ok: false, stopReason: 'aborted', error: new Error('aborted'), text: '' };
      }
      const inner = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
        innerCalls.push(name);
        const extra = req.extraTools.find((t) => t.definition.function.name === name);
        const result = extra
          ? await extra.execute(args, undefined as never)
          : typeof args._result === 'string'
            ? { success: true, content: args._result }
            : { success: true, content: 'ok' };
        req.onToolEnd({
          toolName: name,
          args,
          success: result.success,
          result: result.content,
          durationMs: 1,
          retryAttempts: 0,
          botId: 'b1',
          chatId: 0,
          timestamp: Date.now(),
        });
        return result;
      };
      const cb = req.wrapToolCallback(inner);
      for (const c of script) await cb(c.name, c.args ?? {});
      return { ok: true, stopReason: 'completed', text: 'done' };
    },
  };
  return { env, run, journal, events, releases, requests, innerCalls, renews: () => renews };
}

const progress = (note = 'did a thing'): Call => ({ name: 'task_progress', args: { note } });

describe('runWorker — reports', () => {
  test('each step reports; done ends the run and moves the task', async () => {
    const h = harness([
      [{ name: 'web_fetch', args: { url: 'https://a.com/x' } }, progress()],
      [progress('next')],
      [{ name: 'task_done', args: { note: 'brief.md written' } }],
    ]);
    const end = await runWorker(h.env);
    expect(end.status).toBe('done');
    expect(end.outcome).toEqual({ kind: 'done', note: 'brief.md written' });
    expect(h.run.step).toBe(3);
    expect(h.run.used.steps).toBe(3);
    expect(h.run.used.toolCalls).toBe(1);
    expect(h.releases).toEqual([{ lane: 'done', note: 'brief.md written' }]);
    expect(h.events.filter((e) => e.type === 'worker:step')).toHaveLength(3);
    expect(h.events[0].type).toBe('worker:started');
    expect(h.renews()).toBeGreaterThanOrEqual(2);
    const kinds = h.journal.map((e) => e.kind);
    expect(kinds[0]).toBe('run-start');
    expect(kinds.filter((k) => k === 'report')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'step-end')).toHaveLength(3);
  });

  test('blocked ends the run blocked with the task in Blocked', async () => {
    const h = harness([[{ name: 'task_blocked', args: { why: 'need creds' } }]]);
    const end = await runWorker(h.env);
    expect(end.status).toBe('blocked');
    expect(h.releases).toEqual([{ lane: 'blocked', note: 'need creds' }]);
  });

  test('one silent step is tolerated; two in a row end the run blocked (protocol)', async () => {
    const ok = harness([[], [progress()], [], [{ name: 'task_done', args: { note: 'x' } }]]);
    expect((await runWorker(ok.env)).status).toBe('done');

    const h = harness([[progress()], [{ name: 'web_fetch', args: {} }], []]);
    const end = await runWorker(h.env);
    expect(end.status).toBe('blocked');
    expect(end.outcome.kind).toBe('protocol');
    expect(end.release).toEqual({ lane: 'blocked', note: 'worker stopped reporting' });
  });

  test('the step log feeds the next prompt from report + journal tools', async () => {
    const h = harness([
      [{ name: 'web_fetch', args: { url: 'https://a.com' } }, progress('read a.com')],
      [{ name: 'task_done', args: { note: 'ok' } }],
    ]);
    await runWorker(h.env);
    expect(h.requests[1].prompt.user).toContain('read a.com');
    expect(h.requests[1].prompt.user).toContain('web_fetch');
    const steps = stepsFromJournal(h.journal);
    expect(steps[0].summary).toContain('web_fetch');
  });
});

describe('runWorker — budgets', () => {
  test('step budget used: task back to To do with the last progress note', async () => {
    const h = harness(
      [[progress('half done')], [progress('three quarters')], [progress('never')]],
      {
        run: { budget: { steps: 2, toolCalls: 40, wallMs: 3_600_000 } },
      }
    );
    const end = await runWorker(h.env);
    expect(end.outcome.kind).toBe('budget');
    expect(end.release).toEqual({ lane: 'todo', note: 'budget used: three quarters' });
    expect(h.requests).toHaveLength(2);
  });

  test('daily step budget stops before the next step', async () => {
    const h = harness([[progress()]], { dailyLeft: 0 });
    const end = await runWorker(h.env);
    expect(end.outcome.kind).toBe('budget');
    expect(h.requests).toHaveLength(0);
  });

  test('the tool-call budget is enforced in the callback, report tools still pass', async () => {
    const calls = [1, 2, 3, 4, 5].map(() => ({ name: 'web_search', args: { q: 'x' } }));
    const h = harness([[...calls, progress('cut')]], {
      run: { budget: { steps: 8, toolCalls: 3, wallMs: 3_600_000 } },
    });
    const end = await runWorker(h.env);
    expect(h.innerCalls.filter((n) => n === 'web_search')).toHaveLength(3);
    expect(h.innerCalls).toContain('task_progress');
    expect(h.run.used.toolCalls).toBe(3);
    expect(end.outcome.kind).toBe('budget');
  });

  test('after the report, further tool calls in the step are refused', async () => {
    const h = harness([
      [progress(), { name: 'web_search' }, { name: 'task_done', args: { note: 'x' } }],
      [{ name: 'task_done', args: { note: 'y' } }],
    ]);
    await runWorker(h.env);
    expect(h.innerCalls.slice(0, 1)).toEqual(['task_progress']);
    expect(h.innerCalls.filter((n) => n === 'web_search')).toHaveLength(0);
  });
});

describe('runWorker — timeouts, stops, waits, errors', () => {
  test('a step timeout aborts the turn and fails the run', async () => {
    const h = harness(['hang'], { config: { stepTimeoutMs: 30 } });
    const end = await runWorker(h.env);
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(end.status).toBe('failed');
    expect(end.outcome.note).toContain('timed out');
    expect(end.release?.lane).toBe('todo');
    const stepEnd = h.journal.find((e) => e.kind === 'step-end');
    expect(stepEnd && 'error' in stepEnd ? stepEnd.error : '').toContain('timed out');
  });

  test('the run signal aborts the step: stopped', async () => {
    const ctl = new AbortController();
    const h = harness(['hang'], { signal: ctl.signal });
    setTimeout(() => ctl.abort('operator'), 10);
    const end = await runWorker(h.env);
    expect(end.status).toBe('stopped');
    expect(h.requests[0].signal.aborted).toBe(true);
  });

  test('an LLM error fails the run', async () => {
    const h = harness(['error']);
    const end = await runWorker(h.env);
    expect(end.status).toBe('failed');
    expect(end.outcome.note).toContain('boom');
  });

  test('a wait recorded during a step parks the run', async () => {
    const wait: WorkerWait = { kind: 'ask', id: 'q-1', question: 'Which?', since: 'now' };
    const h = harness([[progress()]], { wait });
    const end = await runWorker(h.env);
    expect(end.status).toBe('waiting');
    expect(end.wait).toEqual(wait);
  });
});

describe('runWorker — asks park the run', () => {
  test('an ask_human result with an id moves the run to waiting', async () => {
    const h = harness([
      [
        {
          name: 'ask_human',
          args: {
            question: 'Which tone?',
            _result: 'Question sent (id q-7) — the run will pause until the operator answers.',
          },
        },
      ],
    ]);
    const end = await runWorker(h.env);
    expect(end.status).toBe('waiting');
    expect(end.wait).toMatchObject({ kind: 'ask', id: 'q-7', question: 'Which tone?' });
  });

  test('an approval request parks the run as an approval wait', async () => {
    const h = harness([
      [
        {
          name: 'file_edit',
          args: { path: 'a.md', _result: 'Approval requested (id p-3) for file_edit: a.md.' },
        },
        progress(),
      ],
    ]);
    const end = await runWorker(h.env);
    expect(end.wait).toMatchObject({ kind: 'approval', id: 'p-3' });
  });

  test('ids are parsed defensively', () => {
    expect(parseWaitId('Question sent (id q-1) — pause')).toBe('q-1');
    expect(parseWaitId('Question sent, no id')).toBeUndefined();
  });
});

describe('runWorker — tool context', () => {
  test('attribution has the run ids and never a cycleId; tools are denied; own write root', async () => {
    const h = harness([[progress()], [{ name: 'task_done', args: { note: 'x' } }]]);
    await runWorker(h.env);
    const req = h.requests[0];
    expect(req.attribution).toEqual({
      runId: 'r-1',
      taskId: 't-1',
      goalId: 'g-1',
      dispatchCycleId: 'c-1',
    });
    expect('cycleId' in req.attribution).toBe(false);
    for (const t of ['manage_goals', 'send_message', 'cron']) expect(req.denied).toContain(t);
    // Asks route per run since phase 2b: a worker may ask and wait.
    for (const t of ['ask_human', 'ask_permission']) expect(req.denied).not.toContain(t);
    expect(req.extraTools.map((t) => t.definition.function.name).sort()).toEqual([
      'task_blocked',
      'task_done',
      'task_progress',
    ]);
    expect(req.workDir).toBe('/p/b1/tasks/t-1');
    expect(req.maxToolRounds).toBe(WORKERS_DEFAULTS.maxToolRoundsPerStep);
  });

  test('tool calls are journaled with their side-effect class', async () => {
    const h = harness([
      [
        { name: 'exec', args: { command: 'ls' } },
        { name: 'file_write', args: { path: 'a.md' } },
        { name: 'web_fetch', args: { url: 'https://x.io/p' } },
        progress(),
      ],
      [{ name: 'task_done', args: { note: 'x' } }],
    ]);
    await runWorker(h.env);
    const tools = h.journal.filter((e) => e.kind === 'tool') as Array<{
      name: string;
      sideEffect: string;
      target?: string;
    }>;
    expect(tools.map((t) => [t.name, t.sideEffect])).toEqual([
      ['exec', 'external'],
      ['file_write', 'write'],
      ['web_fetch', 'read'],
    ]);
    expect(tools[2].target).toBe('x.io/p');
    expect(classifySideEffect('mcp_github_create_issue')).toBe('external');
    expect(classifySideEffect('core_memory_append')).toBe('write');
  });

  test('the prompt carries goal, task, note, answers and the protocol', () => {
    const p = buildWorkerPrompt({
      context: {
        goalTitle: 'Launch',
        taskText: 'Write the brief',
        taskNote: 'use the template',
        workDir: '/w',
        identity: 'I am Finny',
      },
      run: makeRun({ step: 1 }),
      steps: [{ n: 1, startedAt: 'x', summary: 'progress: half', toolCalls: [] }],
      answers: [{ question: 'Which tone?', answer: 'Formal' }],
    });
    for (const s of [
      'Launch',
      'Write the brief',
      'use the template',
      'Which tone?',
      'Formal',
      'progress: half',
      'task_progress',
      'task_done',
      'task_blocked',
      '/w',
    ])
      expect(`${p.system}\n${p.user}`).toContain(s);
  });
});

describe('runWorker — side effects (review S4)', () => {
  test('tools that send, post, register or call out are external', () => {
    for (const n of [
      'calendar_schedule',
      'mesh_publish',
      'moltbook_register',
      'twitter_post',
      'phone_call',
      'exec',
      'process',
      'browser',
    ])
      expect(classifySideEffect(n)).toBe('external');
  });

  test('unknown tools (custom, MCP, A2A, skill tools) default to external', () => {
    for (const n of [
      'my_custom_tool',
      'mcp_github_create_issue',
      'a2a_peer_search',
      'schedule_brief',
    ])
      expect(classifySideEffect(n)).toBe('external');
  });

  test('read-only tools are read, own-state writers are write', () => {
    for (const n of [
      'web_search',
      'web_fetch',
      'file_read',
      'memory_search',
      'memory_get',
      'recall_memory',
      'core_memory_search',
      'get_datetime',
      'calendar_list',
      'calendar_availability',
      'reddit_search',
      'twitter_search',
      'mesh_query',
      'read_production_log',
    ])
      expect(classifySideEffect(n)).toBe('read');
    for (const n of [
      'file_write',
      'file_edit',
      'archive_file',
      'save_memory',
      'ask_human',
      'ask_permission',
    ])
      expect(classifySideEffect(n)).toBe('write');
  });
});

describe('runWorker — in-flight tools (review S3)', () => {
  test('a tool-start is journaled before the call runs, with its side-effect class', async () => {
    const h = harness([
      [{ name: 'exec', args: { command: 'curl -X POST x' } }, progress()],
      [{ name: 'task_done', args: { note: 'x' } }],
    ]);
    await runWorker(h.env);
    const kinds = h.journal.map((e) => e.kind);
    const start = kinds.indexOf('tool-start');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(kinds.indexOf('tool'));
    expect(h.journal[start]).toMatchObject({ n: 1, name: 'exec', sideEffect: 'external' });
    // Report tools are not tool calls.
    expect(h.journal.filter((e) => e.kind === 'tool-start')).toHaveLength(1);
  });

  test('a stop mid-tool keeps currentTool on the run', async () => {
    const ctl = new AbortController();
    const h = harness([], { signal: ctl.signal });
    h.env.runTurn = async (req) => {
      h.requests.push(req);
      const cb = req.wrapToolCallback(async () => {
        ctl.abort('shutdown');
        await new Promise((r) => setTimeout(r, 5));
        return { success: false, content: 'aborted' };
      });
      await cb('exec', { command: 'deploy' });
      return { ok: false, stopReason: 'aborted', text: '' };
    };
    const end = await runWorker(h.env);
    expect(end.status).toBe('stopped');
    expect(h.run.currentTool).toBe('exec');
  });

  test('currentTool is cleared once the call returns', async () => {
    const h = harness([
      [{ name: 'web_search', args: { q: 'x' } }, progress()],
      [{ name: 'task_done', args: { note: 'x' } }],
    ]);
    await runWorker(h.env);
    expect(h.run.currentTool).toBeUndefined();
  });
});

describe('runWorker — write root (review S5)', () => {
  const WORK = '/p/b1/tasks/t-1';

  /** Runs one call then reports; returns what the wrapped callback answered for it. */
  async function callOnce(call: Call) {
    const h = harness([[call, progress()], [{ name: 'task_done', args: { note: 'x' } }]]);
    const results: ToolResult[] = [];
    const orig = h.env.runTurn;
    h.env.runTurn = (req) =>
      orig({
        ...req,
        wrapToolCallback: (inner) => {
          const cb = req.wrapToolCallback(inner);
          return async (n, a) => {
            const r = await cb(n, a);
            if (n === call.name) results.push(r);
            return r;
          };
        },
      });
    await runWorker(h.env);
    return { h, result: results[0] };
  }

  test('relative paths and absolute paths inside the task folder pass', async () => {
    for (const call of [
      { name: 'file_write', args: { path: 'brief.md', content: 'x' } },
      { name: 'file_write', args: { path: `${WORK}/notes/a.md`, content: 'x' } },
      { name: 'file_edit', args: { file_path: './brief.md' } },
      { name: 'archive_file', args: { path: 'tasks/t-1/old.md', reason: 'r' } },
    ]) {
      const { h, result } = await callOnce(call);
      expect(h.innerCalls).toContain(call.name);
      expect(result.success).toBe(true);
    }
  });

  test('absolute paths outside and ../ escapes are refused before the call', async () => {
    for (const call of [
      { name: 'file_write', args: { path: '/p/b1/other.md', content: 'x' } },
      { name: 'file_write', args: { path: '../t-2/brief.md', content: 'x' } },
      { name: 'file_edit', args: { path: 'sub/../../../escape.md' } },
      { name: 'file_write', args: { filepath: '/etc/passwd', content: 'x' } },
      { name: 'archive_file', args: { path: 'report.md', reason: 'r' } },
      { name: 'archive_file', args: { path: 'tasks/t-2/x.md', reason: 'r' } },
    ]) {
      const { h, result } = await callOnce(call);
      expect(h.innerCalls).not.toContain(call.name);
      expect(result.success).toBe(false);
      expect(result.content).toContain('workers write only inside their task directory');
      expect(result.failureKind).toBe('scope');
      const journaled = h.journal.find((e) => e.kind === 'tool' && e.name === call.name);
      expect(journaled).toMatchObject({ ok: false, sideEffect: 'write' });
    }
  });

  test.if(process.platform === 'win32')('win32: the comparison ignores case', async () => {
    const { h } = await callOnce({
      name: 'file_write',
      args: { path: '/P/B1/TASKS/T-1/a.md', content: 'x' },
    });
    expect(h.innerCalls).toContain('file_write');
  });
});

describe('runWorker — LLM queue time (review M4)', () => {
  const waitAbort = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });

  test('time queued for an LLM slot does not count toward the step timeout', async () => {
    const h = harness([], { config: { stepTimeoutMs: 40 } });
    let turn = 0;
    h.env.runTurn = async (req) => {
      h.requests.push(req);
      turn++;
      req.onQueued?.();
      await new Promise((r) => setTimeout(r, 120)); // queued 3× the step timeout
      req.onTurnStart?.();
      const cb = req.wrapToolCallback(async (name, args) => {
        const extra = req.extraTools.find((t) => t.definition.function.name === name);
        return extra ? extra.execute(args, undefined as never) : { success: true, content: 'ok' };
      });
      await cb(turn === 1 ? 'task_progress' : 'task_done', { note: `step ${turn}` });
      return { ok: !req.signal.aborted, stopReason: 'completed', text: '' };
    };
    const end = await runWorker(h.env);
    expect(h.requests[0].signal.aborted).toBe(false);
    expect(end.status).toBe('done');
  });

  test('once the turn starts, the step timeout applies', async () => {
    const h = harness([], { config: { stepTimeoutMs: 40 } });
    h.env.runTurn = async (req) => {
      h.requests.push(req);
      req.onQueued?.();
      await new Promise((r) => setTimeout(r, 60));
      req.onTurnStart?.();
      await waitAbort(req.signal);
      return { ok: false, stopReason: 'aborted', text: '' };
    };
    const end = await runWorker(h.env);
    expect(end.status).toBe('failed');
    expect(end.outcome.note).toContain('timed out');
  });

  test('a queue that outlasts the time budget ends the step', async () => {
    const h = harness([], {
      config: { stepTimeoutMs: 20 },
      run: { budget: { steps: 8, toolCalls: 40, wallMs: 60 } },
    });
    h.env.runTurn = async (req) => {
      h.requests.push(req);
      req.onQueued?.();
      await waitAbort(req.signal);
      return { ok: false, stopReason: 'aborted', text: '' };
    };
    const end = await runWorker(h.env);
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(end.status).toBe('failed');
    expect(end.outcome.note).toContain('LLM slot');
  });
});

describe('worker prompt (review S1)', () => {
  test('asks pause the run and approvals wait; no blanket "cannot ask"', () => {
    const p = buildWorkerPrompt({
      context: { goalTitle: 'g', taskText: 't', workDir: '/w' },
      run: makeRun(),
      steps: [],
      answers: [],
    });
    expect(p.system).not.toContain('ask the operator here');
    expect(p.system).toContain('ask_human');
    expect(p.system).toMatch(/pauses the run until the operator answers/);
    expect(p.system).toMatch(/approval/i);
    expect(p.system).toContain('task_blocked');
  });
});
