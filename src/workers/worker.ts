import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ExecutorTurnStopReason, ToolCallback } from '../bot/executor-turn';
import { runExecutorTurn } from '../bot/executor-turn';
import type { ToolAttribution, ToolEndEvent } from '../bot/tool-executor';
import { toolTarget } from '../bot/tool-executor';
import { ToolLoopDetector } from '../bot/tool-loop-detector';
import { getPermissionLevel } from '../bot/tool-permissions';
import type { ToolRegistry } from '../bot/tool-registry';
import type { BotContext } from '../bot/types';
/**
 * The worker step loop (plan C11): one run of one agent on one task, in
 * bounded steps. Each step is one executor turn (`runExecutorTurn`, through
 * `WorkerTurnRunner`) with the worker protocol prompt, the bot's tools minus
 * the denied ones, plus the three report tools; it must end with exactly one
 * report. Between steps the worker remembers only the step log (report note +
 * the journal's tool list), so a step's trace survives on claude-cli too.
 *
 * The loop never touches the pool: everything goes through `WorkerEnv`
 * (journal, persistence, events, the claim). It returns how the run ended and
 * what to do with the task; the pool applies it.
 */
import { resolveAgentConfig } from '../config';
import type { TaskLane } from '../goals/task-store';
import type { KarmaService } from '../karma/service';
import { resolvePathParam } from '../tools/file';
import type { Tool, ToolResult } from '../tools/types';
import { productionsDirOfTaskWorkDir } from './paths';
import { createReportTools, isReportTool } from './report-tools';
import {
  EXTERNAL_SIDE_EFFECT_TOOLS,
  type JournalEntry,
  type SideEffectClass,
  type StepReport,
  WORKER_DENIED_TOOLS,
  type WorkerEventData,
  type WorkerEventType,
  type WorkerOutcome,
  type WorkerRun,
  type WorkerRunStatus,
  type WorkerStepRecord,
  type WorkerWait,
  type WorkersConfig,
} from './types';

// ── Side effects ─────────────────────────────────────────────────────────

/**
 * Tools that change only our own state (files, memory, soul, the ask and
 * approval queues, the task): `write`. Replaying them is safe enough.
 */
export const WRITE_SIDE_EFFECT_TOOLS: readonly string[] = [
  'file_write',
  'file_edit',
  'file_delete',
  'file_move',
  'archive_file',
  'save_memory',
  'core_memory_append',
  'core_memory_replace',
  'update_soul',
  'update_identity',
  'improve',
  'signal_completion',
  'ask_human',
  'ask_permission',
  'task_progress',
  'task_done',
  'task_blocked',
];

/** Tools that only read (our files and memory, the web, calendars, feeds): `read`. */
export const READ_SIDE_EFFECT_TOOLS: readonly string[] = [
  'file_read',
  'web_search',
  'web_fetch',
  'memory_search',
  'memory_get',
  'recall_memory',
  'core_memory_search',
  'read_production_log',
  'get_datetime',
  'calendar_list',
  'calendar_availability',
  'reddit_hot',
  'reddit_read',
  'reddit_search',
  'twitter_read',
  'twitter_search',
  'mesh_query',
];

/**
 * What a call may have done. Known readers are `read` and known own-state
 * writers `write`; everything else is `external` — the contract's list, MCP
 * and A2A tools (a remote server can do anything), and any tool name we do
 * not know (custom `create_tool` tools, skill tools): never replayed.
 */
export function classifySideEffect(name: string): SideEffectClass {
  if (EXTERNAL_SIDE_EFFECT_TOOLS.includes(name)) return 'external';
  if (WRITE_SIDE_EFFECT_TOOLS.includes(name)) return 'write';
  if (READ_SIDE_EFFECT_TOOLS.includes(name)) return 'read';
  return 'external';
}

// ── Write root ───────────────────────────────────────────────────────────

/** File tools whose target must stay inside the run's task folder (C11). */
export const TASK_DIR_WRITE_TOOLS: readonly string[] = [
  'file_write',
  'file_edit',
  'file_delete',
  'file_move',
  'archive_file',
];

export const TASK_DIR_REFUSAL = 'workers write only inside their task directory';

function isWithin(root: string, target: string): boolean {
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(fold(root), fold(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The refusal for a file write outside the task folder, or undefined. Paths
 * resolve as the executor resolves them: against the task folder, except
 * `archive_file`, whose path is relative to the bot's productions dir. A call
 * without a path is left to the tool (it fails on its own).
 */
export function taskDirRefusal(
  name: string,
  args: Record<string, unknown>,
  workDir: string
): string | undefined {
  if (!TASK_DIR_WRITE_TOOLS.includes(name)) return undefined;
  const raw = resolvePathParam(args);
  if (!raw) return undefined;
  const root = resolve(workDir);
  const base = name === 'archive_file' ? resolve(productionsDirOfTaskWorkDir(workDir)) : root;
  if (isWithin(root, resolve(base, raw))) return undefined;
  return `${TASK_DIR_REFUSAL}: ${root} (refused ${name} on ${raw})`;
}

/** Tools a worker never gets (orchestration and outreach stay with the cycle). Asks are allowed: they route per run. */
export function workerDeniedTools(): string[] {
  return [...WORKER_DENIED_TOOLS];
}

// ── Waits (phase 2b) ─────────────────────────────────────────────────────

/**
 * The id in a tool result that parks the run: "Question sent (id q-1) — the
 * run will pause …" (ask_human), "Permission request sent (id p-1, exec on
 * x) — …" (ask_permission) or "Approval requested (id p-1) for …" (a confirm
 * tool). Parsed defensively: no id, no wait.
 */
export function parseWaitId(content: string): string | undefined {
  const m = /\(id[:\s]+([A-Za-z0-9_.:-]+)[,)]/.exec(content);
  return m?.[1];
}

/** The wait a tool call opened, if its result says the run must pause. */
export function waitFromToolEnd(e: ToolEndEvent, nowIso: string): WorkerWait | undefined {
  const content = e.result ?? '';
  if (/^\s*Question sent/i.test(content) || (e.toolName === 'ask_human' && e.success)) {
    const id = parseWaitId(content);
    if (!id) return undefined;
    const q = typeof e.args?.question === 'string' ? e.args.question : 'a question';
    return { kind: 'ask', id, question: q.slice(0, 300), since: nowIso };
  }
  if (
    /^\s*Permission request sent/i.test(content) ||
    (e.toolName === 'ask_permission' && e.success)
  ) {
    const id = parseWaitId(content);
    if (!id) return undefined;
    const action = typeof e.args?.action === 'string' ? e.args.action : 'an action';
    const resource = typeof e.args?.resource === 'string' ? e.args.resource : '';
    const question = `${action}${resource ? ` on ${resource}` : ''}`;
    return { kind: 'approval', id, question: question.slice(0, 300), since: nowIso };
  }
  if (/^\s*Approval requested/i.test(content) || e.failureKind === 'approval-pending') {
    const id = parseWaitId(content);
    if (!id) return undefined;
    const target = toolTarget(e.args);
    return {
      kind: 'approval',
      id,
      question: `${e.toolName}${target ? `: ${target}` : ''}`,
      since: nowIso,
    };
  }
  return undefined;
}

// ── Prompt ───────────────────────────────────────────────────────────────

export interface WorkerTaskContext {
  botName?: string;
  /** A few lines of IDENTITY.md (light: the worker is the same agent, not its whole soul). */
  identity?: string;
  goalTitle: string | null;
  goalNotes?: string;
  taskText: string;
  taskNote?: string;
  workDir: string;
}

export interface WorkerAnswerRecord {
  question: string;
  answer: string;
}

const IDENTITY_MAX = 600;
const STEP_LOG_MAX = 12;

export function buildWorkerPrompt(input: {
  context: WorkerTaskContext;
  run: Pick<WorkerRun, 'step' | 'budget' | 'used' | 'attempt'>;
  steps: WorkerStepRecord[];
  answers: WorkerAnswerRecord[];
}): { system: string; user: string } {
  const { context: c, run } = input;
  const identity = (c.identity ?? '').trim().slice(0, IDENTITY_MAX);
  const system = [
    `You are ${c.botName ?? 'the agent'}, working as a task worker: one task, in short steps.`,
    identity ? `\n## Who you are\n${identity}` : '',
    '\n## Worker protocol',
    '- Work only on the task below. Do one meaningful piece of it per step.',
    '- End EVERY step with exactly one report tool call, then stop:',
    '  - `task_progress(note)`: what this step did and what comes next (the task stays yours);',
    '  - `task_done(note)`: the task is finished; say what you produced and where;',
    '  - `task_blocked(why)`: you cannot go on without someone else; say what would unblock it.',
    '- A step without a report is a protocol violation; two in a row end your run.',
    '- Your memory between steps is only the step log below: put what the next step needs in the note.',
    `- Write files only inside your task folder: ${c.workDir}`,
    '- To ask the operator, call `ask_human` (one question): it pauses the run until the operator answers, and the answer reaches your next step. Report the step as usual after asking.',
    '- A tool that needs approval files an approval request instead of running; the run waits for the decision. Do not retry it in the same step.',
    '- You cannot message people, manage goals or schedule jobs here: if the task needs that, report task_blocked and say what is needed.',
  ]
    .filter(Boolean)
    .join('\n');

  const lines: string[] = [];
  lines.push(`## Goal\n${c.goalTitle ?? '(no goal)'}`);
  if (c.goalNotes) lines.push(c.goalNotes.slice(0, 600));
  lines.push(`\n## Your task\n${c.taskText}`);
  if (c.taskNote) lines.push(`Note on the task: ${c.taskNote}`);
  if (input.answers.length > 0) {
    lines.push('\n## Answers you received');
    for (const a of input.answers) lines.push(`- Q: ${a.question}\n  A: ${a.answer}`);
  }
  const log = input.steps.filter((s) => s.summary).slice(-STEP_LOG_MAX);
  lines.push('\n## Step log');
  if (log.length === 0) lines.push('(first step)');
  for (const s of log) lines.push(`- step ${s.n}: ${s.summary}`);
  const left = {
    steps: run.budget.steps - run.used.steps,
    toolCalls: run.budget.toolCalls - run.used.toolCalls,
  };
  lines.push(
    `\n## This step\nStep ${run.step + 1} of at most ${run.budget.steps} (attempt ${run.attempt}). Tool calls left: ${Math.max(0, left.toolCalls)}.`,
    'Do the next piece of work, then call one report tool.'
  );
  return { system, user: lines.join('\n') };
}

// ── Journal → steps ──────────────────────────────────────────────────────

function toolList(calls: Array<{ name: string; ok: boolean }>): string {
  if (calls.length === 0) return '';
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return [...counts.entries()].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(', ');
}

export function stepSummary(
  report: StepReport | undefined,
  calls: Array<{ name: string; ok: boolean }>,
  error?: string
): string {
  const head = report ? `${report.kind}: ${report.note}` : '(no report)';
  const tools = toolList(calls);
  return [head, tools ? `tools: ${tools}` : '', error ? `error: ${error}` : '']
    .filter(Boolean)
    .join(' — ');
}

/** The step records of a run, rebuilt from its journal (all attempts). */
export function stepsFromJournal(entries: JournalEntry[]): WorkerStepRecord[] {
  const steps = new Map<number, WorkerStepRecord>();
  const get = (n: number, ts: string) => {
    let s = steps.get(n);
    if (!s) {
      s = { n, startedAt: ts, toolCalls: [] };
      steps.set(n, s);
    }
    return s;
  };
  for (const e of entries) {
    switch (e.kind) {
      case 'step-start': {
        // A resumed step starts over: forget the interrupted attempt's trace.
        steps.set(e.n, { n: e.n, startedAt: e.ts, toolCalls: [] });
        break;
      }
      case 'tool':
        get(e.n, e.ts).toolCalls.push({
          name: e.name,
          ok: e.ok,
          sideEffect: e.sideEffect,
          ...(e.target ? { target: e.target } : {}),
        });
        break;
      case 'report':
        get(e.n, e.ts).report = e.report;
        break;
      case 'step-end': {
        const s = get(e.n, e.ts);
        s.endedAt = e.ts;
        s.summary = e.summary;
        if (e.error) s.error = e.error;
        break;
      }
      default:
        break;
    }
  }
  return [...steps.values()].sort((a, b) => a.n - b.n);
}

/** Answers routed to the run, paired with the question each one answered. */
export function answersFromJournal(entries: JournalEntry[]): WorkerAnswerRecord[] {
  const out: WorkerAnswerRecord[] = [];
  let lastQuestion = '';
  for (const e of entries) {
    if (e.kind === 'wait') lastQuestion = e.wait.question;
    else if (e.kind === 'resume' && e.answer)
      out.push({ question: e.question ?? lastQuestion, answer: e.answer });
  }
  return out;
}

// ── The loop ─────────────────────────────────────────────────────────────

export interface WorkerTurnRequest {
  prompt: { system: string; user: string };
  extraTools: Tool[];
  denied: string[];
  wrapToolCallback: (callback: ToolCallback) => ToolCallback;
  onToolEnd: (event: ToolEndEvent) => void;
  signal: AbortSignal;
  timeoutMs: number;
  maxToolRounds: number;
  attribution: ToolAttribution;
  workDir: string;
  /**
   * The runner calls this when the turn may wait for an LLM slot (the Claude
   * CLI semaphore): the step timeout stops counting until `onTurnStart`.
   */
  onQueued?: () => void;
  /** The runner calls this once the LLM call actually starts (slot held). */
  onTurnStart?: () => void;
}

export interface WorkerTurnOutcome {
  ok: boolean;
  stopReason: ExecutorTurnStopReason;
  error?: unknown;
  text: string;
}

export type WorkerTurnRunner = (req: WorkerTurnRequest) => Promise<WorkerTurnOutcome>;

/** Journal entry before the env stamps `ts` / `runId`. */
export type JournalInput = JournalEntry extends infer E
  ? E extends JournalEntry
    ? Omit<E, 'ts' | 'runId'>
    : never
  : never;

export interface WorkerEnv {
  /** The run, mutated in place (`save` persists it). */
  run: WorkerRun;
  config: WorkersConfig;
  /** The run's stop signal (Stop, sweep, shutdown). */
  signal: AbortSignal;
  now: () => number;
  /** Goal, task, note, folder — read fresh each step. */
  context: () => WorkerTaskContext;
  runTurn: WorkerTurnRunner;
  journal: (entry: JournalInput) => void;
  readJournal: () => JournalEntry[];
  save: () => void;
  publish: (type: WorkerEventType, extra?: Partial<WorkerEventData>) => void;
  /** Extend the claim; false when the run no longer holds the task. */
  renewClaim: () => boolean;
  /** Move the task out of the claim (report tools). */
  releaseTask: (lane: TaskLane, note: string) => boolean;
  dailyStepsLeft: () => number;
  /** A wait (ask / approval) recorded during the step, if any (phase 2b). */
  takeWait?: () => WorkerWait | undefined;
  /** After each step (metering). */
  onStepEnd?: (info: { n: number; durationMs: number; ok: boolean }) => void;
  onToolStart?: (name: string) => void;
}

export interface WorkerEnd {
  status: WorkerRunStatus;
  outcome: WorkerOutcome;
  wait?: WorkerWait;
  /** What the pool should do with the task (the report tools already moved it for done / blocked). */
  release?: { lane: TaskLane; note: string };
}

export const BUDGET_USED_MESSAGE = 'budget used — report now with task_progress';
const REPORTED_MESSAGE = 'This step already reported. End your turn now.';

class StepTimeout extends Error {}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'unknown error');
}

export async function runWorker(env: WorkerEnv): Promise<WorkerEnd> {
  const { run, config } = env;
  const startedMs = env.now();
  run.status = 'running';
  run.startedAt = run.startedAt ?? new Date(startedMs).toISOString();
  run.heartbeatAt = new Date(startedMs).toISOString();
  env.journal({ kind: 'run-start', attempt: run.attempt });
  env.save();
  env.publish('worker:started');

  let silentSteps = 0;
  const lastProgress = () => run.lastReport?.note ?? 'no progress reported';
  const budgetEnd = (why: string): WorkerEnd => ({
    status: 'stopped',
    outcome: { kind: 'budget', note: why },
    release: { lane: 'todo', note: `budget used: ${lastProgress()}` },
  });
  const stopped = (): WorkerEnd => ({
    status: 'stopped',
    outcome: { kind: 'stopped', note: 'stopped' },
  });

  while (true) {
    if (env.signal.aborted) return stopped();
    if (run.used.steps >= run.budget.steps)
      return budgetEnd(`step budget (${run.budget.steps}) used`);
    if (run.used.toolCalls >= run.budget.toolCalls)
      return budgetEnd(`tool-call budget (${run.budget.toolCalls}) used`);
    if (run.used.wallMs >= run.budget.wallMs) return budgetEnd('time budget used');
    if (env.dailyStepsLeft() <= 0) return budgetEnd('daily step budget used');

    const n = run.step + 1;
    const stepStart = env.now();
    run.heartbeatAt = new Date(stepStart).toISOString();
    env.journal({ kind: 'step-start', n });
    env.save();

    const journal = env.readJournal();
    const ctx = env.context();
    const prompt = buildWorkerPrompt({
      context: ctx,
      run,
      steps: stepsFromJournal(journal).filter((s) => s.n < n),
      answers: answersFromJournal(journal),
    });

    let report: StepReport | undefined;
    let stepWait: WorkerWait | undefined;
    const stepCalls: Array<{ name: string; ok: boolean }> = [];
    const reportTools = createReportTools({
      hasReported: () => report !== undefined,
      onReport: (r) => {
        report = r;
        env.journal({ kind: 'report', n, report: r });
      },
      release: (lane, note) =>
        env.releaseTask(lane, note) ? { ok: true } : { ok: false, message: 'claim lost' },
    });

    // The step's own controller: our timeout aborts it, and so does the run.
    const step = new AbortController();
    const onRunAbort = () => step.abort(env.signal.reason);
    if (env.signal.aborted) step.abort(env.signal.reason);
    else env.signal.addEventListener('abort', onRunAbort, { once: true });
    const wallLeftNow = () =>
      Math.max(1, run.budget.wallMs - run.used.wallMs - (env.now() - stepStart));
    const wallLeft = wallLeftNow();

    // The step timeout counts the turn's own time, not a wait for an LLM slot
    // (`onQueued` … `onTurnStart`). While queued, a watchdog keeps the
    // heartbeat fresh and ends the step only when the time budget is gone.
    let stepTimer: ReturnType<typeof setTimeout> | undefined;
    let queueTimer: ReturnType<typeof setTimeout> | undefined;
    let turnStarted = false;
    const armStepTimer = () => {
      const ms = Math.min(config.stepTimeoutMs, wallLeftNow());
      stepTimer = setTimeout(() => step.abort(new StepTimeout(`step timed out after ${ms}ms`)), ms);
    };
    const clearTimers = () => {
      if (stepTimer) clearTimeout(stepTimer);
      if (queueTimer) clearTimeout(queueTimer);
      stepTimer = undefined;
      queueTimer = undefined;
    };
    const onQueued = () => {
      if (turnStarted || step.signal.aborted) return;
      clearTimers();
      const watch = () => {
        if (turnStarted || step.signal.aborted) return;
        run.heartbeatAt = new Date(env.now()).toISOString();
        env.save();
        if (env.now() - stepStart >= run.budget.wallMs - run.used.wallMs) {
          step.abort(new StepTimeout('time budget used while waiting for an LLM slot'));
          return;
        }
        queueTimer = setTimeout(watch, Math.min(config.stepTimeoutMs, wallLeftNow()));
      };
      queueTimer = setTimeout(watch, Math.min(config.stepTimeoutMs, wallLeftNow()));
    };
    const onTurnStart = () => {
      if (turnStarted) return;
      turnStarted = true;
      clearTimers();
      if (step.signal.aborted) return;
      run.heartbeatAt = new Date(env.now()).toISOString();
      armStepTimer();
    };
    armStepTimer();

    const wrapToolCallback = (inner: ToolCallback): ToolCallback => {
      return async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
        if (report !== undefined) return { success: false, content: REPORTED_MESSAGE };
        if (isReportTool(name)) return inner(name, args);
        if (run.used.toolCalls >= run.budget.toolCalls)
          return { success: false, content: BUDGET_USED_MESSAGE };
        run.used.toolCalls++;
        const sideEffect = classifySideEffect(name);
        const target = toolTarget(args);
        const refusal = taskDirRefusal(name, args, ctx.workDir);
        if (refusal) {
          stepCalls.push({ name, ok: false });
          env.journal({
            kind: 'tool',
            n,
            name,
            ok: false,
            sideEffect,
            ...(target ? { target } : {}),
          });
          return { success: false, content: refusal, failureKind: 'scope' };
        }
        run.currentTool = name;
        run.heartbeatAt = new Date(env.now()).toISOString();
        // Before the call: a process that dies during it must not replay it.
        env.journal({ kind: 'tool-start', n, name, sideEffect, ...(target ? { target } : {}) });
        env.save();
        env.onToolStart?.(name);
        try {
          return await inner(name, args);
        } finally {
          // Stopped during the call: the record keeps the tool that was in flight.
          if (!env.signal.aborted) run.currentTool = undefined;
        }
      };
    };

    let turn: WorkerTurnOutcome;
    try {
      turn = await env.runTurn({
        prompt,
        extraTools: reportTools,
        denied: workerDeniedTools(),
        wrapToolCallback,
        onToolEnd: (e) => {
          if (isReportTool(e.toolName)) return;
          stepWait = stepWait ?? waitFromToolEnd(e, new Date(env.now()).toISOString());
          stepCalls.push({ name: e.toolName, ok: e.success });
          const target = toolTarget(e.args);
          env.journal({
            kind: 'tool',
            n,
            name: e.toolName,
            ok: e.success,
            sideEffect: classifySideEffect(e.toolName),
            ...(target ? { target } : {}),
          });
        },
        signal: step.signal,
        // Backstop only: the step's own timers fire first (a queued turn may
        // legitimately wait longer than one step timeout).
        timeoutMs: wallLeft + 5_000,
        maxToolRounds: config.maxToolRoundsPerStep,
        attribution: {
          runId: run.runId,
          taskId: run.taskId,
          goalId: run.goalId,
          ...(run.dispatchCycleId ? { dispatchCycleId: run.dispatchCycleId } : {}),
        },
        workDir: ctx.workDir,
        onQueued,
        onTurnStart,
      });
    } catch (err) {
      turn = { ok: false, stopReason: 'error', error: err, text: '' };
    } finally {
      clearTimers();
      env.signal.removeEventListener('abort', onRunAbort);
    }

    const durationMs = env.now() - stepStart;
    const timedOut = step.signal.reason instanceof StepTimeout;
    if (env.signal.aborted) {
      // Stopped mid-step: the step is NOT finished (no step-end), so a resume
      // re-runs it — unless its journal shows an external side effect. A tool
      // still in flight stays on the record (`currentTool`).
      run.used.wallMs += durationMs;
      if (report) run.lastReport = report;
      env.save();
      return stopped();
    }
    const error = timedOut
      ? errorText(step.signal.reason)
      : !turn.ok
        ? errorText(turn.error)
        : undefined;

    run.step = n;
    run.used.steps++;
    run.used.wallMs += durationMs;
    run.currentTool = undefined;
    run.heartbeatAt = new Date(env.now()).toISOString();
    const summary = stepSummary(report, stepCalls, error);
    env.journal({ kind: 'step-end', n, summary, ...(error ? { error } : {}) });
    if (report) run.lastReport = report;
    if (error) run.error = error;
    env.save();
    env.onStepEnd?.({ n, durationMs, ok: !error });
    env.publish('worker:step', report ? { report } : {});

    const r = report as StepReport | undefined;
    if (r?.kind === 'done') return { status: 'done', outcome: { kind: 'done', note: r.note } };
    if (r?.kind === 'blocked')
      return { status: 'blocked', outcome: { kind: 'blocked', note: r.note } };
    if (!r && error) {
      const note = timedOut ? error : `step failed: ${error}`;
      return {
        status: 'failed',
        outcome: { kind: 'failed', note },
        release: { lane: 'todo', note },
      };
    }

    // A step that asked (or filed an approval) parks the run, report or not.
    const wait = stepWait ?? env.takeWait?.();
    if (wait) {
      if (!env.renewClaim())
        return {
          status: 'stopped',
          outcome: { kind: 'stopped', note: 'the task was taken from this run' },
        };
      return { status: 'waiting', outcome: { kind: 'stopped', note: 'waiting' }, wait };
    }

    if (r) silentSteps = 0;
    else silentSteps++;
    if (silentSteps >= 2) {
      const note = 'worker stopped reporting';
      return {
        status: 'blocked',
        outcome: { kind: 'protocol', note },
        release: { lane: 'blocked', note },
      };
    }

    if (!env.renewClaim())
      return {
        status: 'stopped',
        outcome: { kind: 'stopped', note: 'the task was taken from this run' },
      };
  }
}

// ── The default turn runner: runExecutorTurn with the bot's tools ────────

export interface ExecutorTurnRunnerDeps {
  ctx: BotContext;
  botId: string;
  toolRegistry: Pick<ToolRegistry, 'getDefinitionsForBot'>;
  karmaService?: KarmaService;
}

const WORKER_TEMPERATURE = 0.4;

/**
 * Confirm-level tools for the agent loop. Denied to workers unless the bot has
 * `enforceToolPermissions` on: then they go through the non-blocking approval
 * (the run waits for the decision). Without the flag nothing would gate them.
 */
export function confirmLevelTools(ctx: BotContext, botId: string, names: string[]): string[] {
  const botConfig = ctx.config.bots.find((b) => b.id === botId);
  return names.filter(
    (n) => getPermissionLevel(n, 'agent-loop', botConfig?.toolPermissions) === 'confirm'
  );
}

export function createExecutorTurnRunner(deps: ExecutorTurnRunnerDeps): WorkerTurnRunner {
  const { ctx, botId } = deps;
  return async (req) => {
    const botConfig = ctx.config.bots.find((b) => b.id === botId);
    if (!botConfig)
      return { ok: false, stopReason: 'error', error: new Error(`No bot ${botId}`), text: '' };
    const global = ctx.config.agentLoop;
    const botOverride = botConfig.agentLoop;
    const disabled = new Set<string>([
      ...(botConfig.disabledTools ?? []),
      ...(global?.disabledTools ?? []),
      ...(botOverride?.disabledTools ?? []),
    ]);
    const definitions = deps.toolRegistry
      .getDefinitionsForBot(botId, 'agent-loop')
      .filter((d) => !disabled.has(d.function.name));
    const enforce = botOverride?.enforceToolPermissions === true;
    const denied = [
      ...req.denied,
      ...(enforce
        ? []
        : confirmLevelTools(
            ctx,
            botId,
            definitions.map((d) => d.function.name)
          )),
    ];
    const tenantRoot =
      botConfig.tenantId && ctx.config.multiTenant?.enabled
        ? `${ctx.config.multiTenant.dataDir ?? './data/tenants'}/${botConfig.tenantId}`
        : undefined;
    const ld = global?.loopDetection;
    const loopDetector = ld?.enabled
      ? new ToolLoopDetector({
          enabled: true,
          historySize: ld.historySize,
          warningThreshold: ld.warningThreshold,
          criticalThreshold: ld.criticalThreshold,
          globalCircuitBreakerThreshold: ld.globalCircuitBreakerThreshold,
          detectors: ld.detectors,
          knownPollTools: ld.knownPollTools,
        })
      : undefined;
    const a = req.attribution;
    const llmClient = ctx.getLLMClient(botId);
    // Claude CLI turns may queue for a slot: the step clock waits for it.
    const queues = llmClient.backend === 'claude-cli';
    if (queues) req.onQueued?.();
    else req.onTurnStart?.();
    const turn = await runExecutorTurn({
      ctx,
      botId,
      botConfig,
      llmClient,
      model: ctx.getActiveModel(botId) || resolveAgentConfig(ctx.config, botConfig).model,
      caller: 'worker',
      prompt: req.prompt,
      tools: { definitions, disabled, extra: req.extraTools, denied },
      attribution: a,
      temperature: WORKER_TEMPERATURE,
      maxToolRounds: req.maxToolRounds,
      timeoutMs: req.timeoutMs,
      timeoutLabel: 'Worker step',
      signal: req.signal,
      workDir: req.workDir,
      tenantRoot,
      loopDetector,
      karmaService: deps.karmaService,
      enforceToolPermissions: enforce,
      breaker: ctx.circuitBreaker,
      priority: 'worker',
      ...(queues && req.onTurnStart ? { onLlmSlot: req.onTurnStart } : {}),
      wrapToolCallback: req.wrapToolCallback,
      onToolEnd: req.onToolEnd,
      autoAttachFiles: false,
      queryLog: (entry) =>
        ctx.llmQueryLog?.append({
          ...entry,
          ...(a.goalId ? { goalId: a.goalId } : {}),
          ...(a.runId ? { runId: a.runId } : {}),
          ...(a.taskId ? { taskId: a.taskId } : {}),
          ...(a.dispatchCycleId ? { dispatchCycleId: a.dispatchCycleId } : {}),
        }),
      logger: ctx.getBotLogger(botId),
    });
    return { ok: turn.ok, stopReason: turn.stopReason, error: turn.error, text: turn.text };
  };
}
