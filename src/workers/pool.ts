/**
 * WorkerPool (plan C10, C16): the only place task workers start.
 *
 * Admission (all required): workers on for the bot (flag + allowlist), the
 * task exists and is open, one run per task (TaskStore `claim`, a CAS lease),
 * the bot's daily step budget, the tenant quota, room in the bot's queue.
 * Runs start from a queue ordered by goal priority then task order, while the
 * fleet cap (`maxConcurrent`), the per-bot cap (`maxPerBot`) and the shared
 * circuit breaker (closed for the bot's backend) allow.
 *
 * Every transition is persisted synchronously (`runs.json`), journaled and
 * published as a `worker:*` event (ActivityStream + subscribers). A run that
 * ends wakes its bot's cycle (debounced) so the planner reads the outcome.
 *
 * Shutdown (`abortAll`) writes `interrupted` before aborting; boot (`recover`)
 * re-binds the claims of every surviving run before queueing any of them, and
 * never replays a step that did something external.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { ActivityEvent } from '../bot/activity-stream';
import type { ApplyOptions, ApplyResult, StoredTask, TaskLane, TaskOp } from '../goals/task-store';
import { liveClaim } from '../goals/task-store';
import type { Logger } from '../logger';
import { taskWorkDir } from './paths';
import type { WorkerRunStore } from './run-store';
import {
  type DispatchRefusal,
  type DispatchRequest,
  type DispatchResult,
  type JournalEntry,
  REFUSED_FAILURES,
  type StopReason,
  type WorkerAnswer,
  type WorkerEvent,
  type WorkerEventData,
  type WorkerEventType,
  type WorkerOutcome,
  type WorkerPoolApi,
  type WorkerPoolStats,
  type WorkerRun,
  type WorkerRunStatus,
  type WorkerRunView,
  type WorkerStepRecord,
  type WorkerToolCall,
  type WorkerWait,
  type WorkersConfig,
  isActiveRun,
  toRunView,
} from './types';
import {
  type JournalInput,
  type WorkerEnd,
  type WorkerTaskContext,
  type WorkerTurnRunner,
  runWorker,
  stepsFromJournal,
} from './worker';

export type PoolTaskStore = {
  get(id: string): StoredTask | undefined;
  list(): StoredTask[];
  apply(ops: TaskOp[], opts: ApplyOptions): ApplyResult;
};

export interface PoolGoal {
  id?: string;
  text: string;
  priority: string;
  notes?: string;
}

export interface WorkerPoolDeps {
  /** Live config (`config.workers`). */
  config: () => WorkersConfig;
  store: WorkerRunStore;
  /** Configured bot ids (the sweep scans their tasks for expired claims). */
  botIds: () => string[];
  taskStore: (botId: string) => PoolTaskStore | null;
  goals: (botId: string) => PoolGoal[];
  /** The bot's productions dir; each task works in `taskWorkDir(dir, taskId)`. */
  productionsDir: (botId: string) => string;
  runTurnFor: (botId: string) => WorkerTurnRunner;
  /** Identity for the worker prompt (light). */
  identity?: (botId: string) => { name?: string; identity?: string };
  botBackend?: (botId: string) => string | undefined;
  /** Runs start only for running bots (default: all). Queued runs wait for the bot. */
  isBotRunning?: (botId: string) => boolean;
  breaker?: { isOpen(backend: string): boolean };
  /** False when the bot's tenant is over quota. */
  quotaOk?: (botId: string) => boolean;
  /** Per-step metering (tenant usage). */
  meter?: (botId: string, info: { runId: string; taskId: string; step: number }) => void;
  activityStream?: { publish(event: ActivityEvent): void };
  /** Wake the bot's cycle after a run ends (debounced per bot). */
  wake?: (botId: string) => void;
  wakeDebounceMs?: number;
  /**
   * Answers / decisions routed to a run while no pool took them (phase 2b
   * stores keep them). Drained on recover, when a run starts and by the sweep.
   */
  drainAnswers?: (runId: string) => WorkerAnswer[];
  /**
   * A run that ends for good while waiting: close its question / permission
   * request without routing anything back to it (wired to the ask stores).
   */
  cancelWait?: (wait: WorkerWait) => void;
  /**
   * A run that ends for good: withdraw every question and permission request
   * it still has pending (a step may ask and then report done), by run id.
   */
  withdrawRunAsks?: (runId: string) => void;
  now?: () => number;
  logger?: Logger;
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const ABORT_GRACE_MS = 5_000;
const ENDED_CACHE = 50;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class WorkerPool implements WorkerPoolApi {
  private readonly runs = new Map<string, WorkerRun>();
  private readonly ended = new Map<string, WorkerRunView[]>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly stopReasons = new Map<string, StopReason>();
  private readonly pendingWaits = new Map<string, WorkerWait>();
  /** Answers to another question of a waiting run: kept until it waits on it or runs again. */
  private readonly held = new Map<string, WorkerAnswer[]>();
  /** Runs loaded from disk that nothing has resumed yet (recover / kick take them). */
  private readonly survivors = new Set<string>();
  /** Bots being stopped: nothing resumes or starts their runs until `kick`. */
  private readonly paused = new Set<string>();
  private readonly listeners = new Set<(e: WorkerEvent) => void>();
  private readonly wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly daily = new Map<string, { day: string; steps: number }>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private shuttingDown = false;
  private pumping = false;
  private readonly now: () => number;

  constructor(private readonly deps: WorkerPoolDeps) {
    this.now = deps.now ?? (() => Date.now());
    // Load what survived the last process so dispatch never overwrites it.
    for (const botId of deps.store.listBots()) {
      for (const run of deps.store.loadActive(botId)) {
        this.runs.set(run.runId, run);
        this.survivors.add(run.runId);
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  isEnabledFor(botId: string): boolean {
    const cfg = this.deps.config();
    if (!cfg.enabled) return false;
    return cfg.bots.length === 0 || cfg.bots.includes(botId);
  }

  dispatch(req: DispatchRequest): DispatchResult[] {
    const results = req.taskIds.map((taskId) =>
      this.admit(req.botId, taskId, { cycleId: req.cycleId, attempt: 1 })
    );
    this.ensureSweep();
    this.pump();
    return results.map((r) =>
      r.ok ? { ...r, queued: this.runs.get(r.runId)?.status === 'queued' } : r
    );
  }

  list(botId?: string, opts: { endedLimit?: number } = {}): WorkerRunView[] {
    const limit = opts.endedLimit ?? 20;
    const active = [...this.runs.values()]
      .filter((r) => !botId || r.botId === botId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toRunView);
    if (limit <= 0) return active;
    const bots = botId ? [botId] : this.knownBots();
    const ended = bots
      .flatMap((b) => this.endedFor(b))
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
      .slice(0, limit);
    return [...active, ...ended];
  }

  get(runId: string): WorkerRunView | null {
    const run = this.runs.get(runId);
    if (run) return toRunView(run);
    for (const b of this.knownBots()) {
      const hit = this.endedFor(b).find((r) => r.runId === runId);
      if (hit) return hit;
    }
    for (const b of this.knownBots()) {
      const hit = this.deps.store
        .readEnded(b, { limit: 500, days: 30 })
        .find((r) => r.runId === runId);
      if (hit) return hit;
    }
    return null;
  }

  journal(runId: string): JournalEntry[] {
    const view = this.get(runId);
    return view ? this.deps.store.readJournal(view.botId, runId) : [];
  }

  stop(runId: string, reason: StopReason): boolean {
    const run = this.runs.get(runId);
    if (!run || !isActiveRun(run.status)) return false;
    // The move / the closure already released (or releases) the claim itself.
    if (reason === 'task-moved' || reason === 'goal-closed') run.claimToken = undefined;
    this.stopReasons.set(runId, reason);
    const ctl = this.controllers.get(runId);
    if (ctl) {
      ctl.abort(reason);
      return true;
    }
    if (reason === 'shutdown') {
      // Not running: keep the claim, resume on boot.
      this.stopReasons.delete(runId);
      if (run.status === 'queued') run.status = 'interrupted';
      this.persist(run.botId);
      return true;
    }
    const end = this.stopEnd(reason);
    this.endRun(run, end.status, end.outcome, end.release);
    return true;
  }

  retry(runId: string): DispatchResult {
    const prev = this.get(runId);
    if (!prev) return { taskId: '', ok: false, reason: 'not-found', message: `No run ${runId}` };
    if (isActiveRun(prev.status))
      return {
        taskId: prev.taskId,
        ok: false,
        reason: 'claimed',
        message: `Run ${runId} is still ${prev.status}`,
      };
    const r = this.admit(prev.botId, prev.taskId, { cycleId: null, attempt: prev.attempt + 1 });
    this.ensureSweep();
    this.pump();
    return r.ok ? { ...r, queued: this.runs.get(r.runId)?.status === 'queued' } : r;
  }

  /**
   * Accepts an answer for a run waiting on it. False otherwise (no such active
   * run, its step still running, or it waits on another question): the store
   * keeps the answer and `drainFor` picks it up when the run parks.
   */
  onAnswer(runId: string, answer: WorkerAnswer): boolean {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'waiting') {
      this.deps.logger?.info(
        { runId, answerId: answer.id },
        'Workers: answer for a run that is not waiting'
      );
      return false;
    }
    if (run.wait && run.wait.id !== answer.id) {
      this.deps.logger?.warn(
        { runId, answerId: answer.id, waitingFor: run.wait.id },
        'Workers: answer for another question; ignored'
      );
      return false;
    }
    this.applyAnswer(run, answer);
    this.pump();
    return true;
  }

  /** Phase 2b: a wait opened during the current step (an ask routed to this run). */
  markWaiting(runId: string, wait: WorkerWait): void {
    if (this.runs.get(runId)?.status === 'running') this.pendingWaits.set(runId, wait);
  }

  async abortAll(reason: StopReason): Promise<void> {
    this.shuttingDown = true;
    this.stopSweep();
    for (const t of this.wakeTimers.values()) clearTimeout(t);
    this.wakeTimers.clear();
    const bots = new Set<string>();
    for (const run of this.runs.values()) {
      if (run.status === 'running' || run.status === 'queued') run.status = 'interrupted';
      // `currentTool` stays: the record says which call was in flight.
      this.stopReasons.set(run.runId, reason);
      bots.add(run.botId);
    }
    // Persist first, synchronously: the process may be killed any moment now.
    for (const b of bots) this.persist(b);
    for (const ctl of this.controllers.values()) ctl.abort(reason);
    const pending = [...this.running.values()];
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((r) => {
          timer = setTimeout(r, ABORT_GRACE_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    for (const b of bots) this.persist(b);
  }

  recover(): void {
    this.shuttingDown = false;
    this.paused.clear();
    this.resume(this.resumable());
    this.ensureSweep();
    this.pump();
  }

  /**
   * A bot (re)started: resume its interrupted runs (a bot stop keeps their
   * claims) and start whatever is queued, without waiting for the sweep.
   * Without a bot id, every bot.
   */
  kick(botId?: string): void {
    if (this.shuttingDown) return;
    if (botId) this.paused.delete(botId);
    else this.paused.clear();
    this.resume(this.resumable(botId));
    this.ensureSweep();
    this.pump();
  }

  /**
   * A bot is being stopped (call before interrupting its runs): until `kick`,
   * neither the sweep nor the queue resumes or starts its runs — the bot may
   * still look running while it is torn down.
   */
  pause(botId: string): void {
    this.paused.add(botId);
  }

  /** The bot is up: running and not being stopped. */
  private botUp(botId: string): boolean {
    return !this.paused.has(botId) && (this.deps.isBotRunning?.(botId) ?? true);
  }

  /** Runs nothing is running: loaded from disk and not resumed yet, or interrupted here. */
  private resumable(botId?: string): WorkerRun[] {
    return [...this.runs.values()].filter(
      (r) =>
        (!botId || r.botId === botId) &&
        !this.running.has(r.runId) &&
        (this.survivors.has(r.runId) || r.status === 'interrupted')
    );
  }

  /**
   * Re-bind every claim before anything is queued, then resume, block or fail
   * each run. A step cut in the middle uses an attempt and is never replayed
   * when it did (or was doing) something external.
   */
  private resume(survivors: WorkerRun[]): void {
    if (survivors.length === 0) return;
    const cfg = this.deps.config();
    for (const run of survivors) this.survivors.delete(run.runId);

    // 1. Re-bind every claim before anything is queued, so a cycle that runs
    //    right after boot can never dispatch the same task twice.
    const lost: WorkerRun[] = [];
    for (const run of survivors) {
      if (!this.rebind(run)) lost.push(run);
    }
    for (const run of lost) {
      this.endRun(run, 'stopped', {
        kind: 'interrupted',
        note: 'the task changed while the system was down',
      });
    }

    // 2. Resume, block or fail what is left.
    for (const run of survivors) {
      if (!this.runs.has(run.runId)) continue;
      if (run.status === 'waiting') {
        this.drainFor(run);
        continue;
      }
      const journal = this.deps.store.readJournal(run.botId, run.runId);
      const unfinished = unfinishedStep(journal);
      const external = unfinished?.toolCalls.find(
        (t) =>
          t.sideEffect === 'external' &&
          !(t.failureKind && REFUSED_FAILURES.includes(t.failureKind))
      );
      if (external) {
        const what = `${external.name}${external.target ? ` (${external.target})` : ''}`;
        const during = unfinished?.inFlight.includes(external);
        const note = `interrupted ${during ? 'during' : 'after'} ${what}; check it before retrying`;
        this.endRun(run, 'blocked', { kind: 'interrupted', note }, { lane: 'blocked', note });
        continue;
      }
      if (!this.isEnabledFor(run.botId)) {
        const note = 'workers are off for this bot';
        this.endRun(run, 'stopped', { kind: 'interrupted', note }, { lane: 'todo', note });
        continue;
      }
      // Only a step cut in the middle costs an attempt (a queued run never
      // ran), and not when we stopped it cleanly (shutdown, bot stop: the run
      // was persisted `interrupted`) with no tool in flight. A crash leaves it
      // `running`.
      const clean =
        run.status === 'interrupted' &&
        !run.currentTool &&
        (unfinished?.inFlight.length ?? 0) === 0;
      const attempt = unfinished && !clean ? run.attempt + 1 : run.attempt;
      if (attempt > cfg.maxAttempts) {
        const note = `interrupted; ${run.attempt} of ${cfg.maxAttempts} attempts used`;
        this.endRun(run, 'failed', { kind: 'interrupted', note }, { lane: 'blocked', note });
        continue;
      }
      run.attempt = attempt;
      run.status = 'queued';
      run.currentTool = undefined;
      this.persist(run.botId);
      this.publish('worker:queued', run);
    }
  }

  stats(): WorkerPoolStats {
    const stats: WorkerPoolStats = { running: 0, queued: 0, waiting: 0, byBot: {} };
    for (const r of this.runs.values()) {
      if (!stats.byBot[r.botId]) stats.byBot[r.botId] = { running: 0, queued: 0, waiting: 0 };
      const b = stats.byBot[r.botId];
      if (r.status === 'running') {
        stats.running++;
        b.running++;
      } else if (r.status === 'queued' || r.status === 'interrupted') {
        stats.queued++;
        b.queued++;
      } else if (r.status === 'waiting') {
        stats.waiting++;
        b.waiting++;
      }
    }
    return stats;
  }

  subscribe(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One sweep pass (also run every `sweepIntervalMs`). */
  sweep(): void {
    if (this.shuttingDown) return;
    const cfg = this.deps.config();
    const now = this.now();
    // A bot that is running again but was never kicked: resume its interrupted runs.
    this.resume(this.resumable().filter((r) => r.status === 'interrupted' && this.botUp(r.botId)));
    for (const run of [...this.runs.values()]) {
      if (run.status === 'running') {
        const hb = Date.parse(run.heartbeatAt ?? run.startedAt ?? run.createdAt);
        if (Number.isFinite(hb) && now - hb > 2 * cfg.stepTimeoutMs) {
          this.deps.logger?.warn(
            { runId: run.runId, botId: run.botId },
            'Workers: no heartbeat; aborting'
          );
          this.stopReasons.set(run.runId, 'sweep');
          const ctl = this.controllers.get(run.runId);
          if (ctl) ctl.abort('sweep');
          else this.finish(run, { status: 'stopped', outcome: { kind: 'stopped', note: 'sweep' } });
        }
        continue;
      }
      // A stopped bot does not hold its tasks: no renewal, and once the claim
      // expires the run ends and the task goes back to To do.
      if (!this.botUp(run.botId)) {
        if (run.claimToken && this.claimExpired(run, now)) {
          const note = 'bot stopped';
          this.endRun(run, 'stopped', { kind: 'interrupted', note }, { lane: 'todo', note });
        }
        continue;
      }
      // Runs that hold a task without running keep their claim alive.
      if (run.claimToken && !this.renew(run)) {
        this.endRun(run, 'stopped', { kind: 'stopped', note: 'the task was taken from this run' });
        continue;
      }
      if (run.status === 'waiting') this.drainFor(run);
    }
    this.releaseExpiredClaims(now);
    this.pump();
  }

  /** Stop timers (tests, BotManager teardown). Runs are not touched. */
  dispose(): void {
    this.stopSweep();
    for (const t of this.wakeTimers.values()) clearTimeout(t);
    this.wakeTimers.clear();
    for (const ctl of this.controllers.values()) ctl.abort('shutdown');
  }

  // ── Admission ──────────────────────────────────────────────────────────

  private refuse(taskId: string, reason: DispatchRefusal, message: string): DispatchResult {
    return { taskId, ok: false, reason, message };
  }

  private admit(
    botId: string,
    taskId: string,
    origin: { cycleId: string | null; attempt: number }
  ): DispatchResult {
    const cfg = this.deps.config();
    if (!this.isEnabledFor(botId))
      return this.refuse(taskId, 'disabled', `Workers are off for ${botId}`);
    if (typeof taskId !== 'string' || !taskId.trim())
      return this.refuse(String(taskId ?? ''), 'invalid', 'No task id');
    if ([...this.runs.values()].some((r) => r.botId === botId && r.taskId === taskId))
      return this.refuse(taskId, 'claimed', `Task ${taskId} already has a run`);
    const ts = this.deps.taskStore(botId);
    if (!ts) return this.refuse(taskId, 'invalid', `No task store for ${botId}`);
    const task = ts.get(taskId);
    if (!task) return this.refuse(taskId, 'not-found', `No task ${taskId}`);
    if (task.lane === 'done') return this.refuse(taskId, 'done', `Task ${taskId} is done`);
    const live = liveClaim(task, this.now());
    if (live)
      return this.refuse(
        taskId,
        'claimed',
        `Task ${taskId} is being worked on by run ${live.runId}`
      );
    if (this.stepsToday(botId) >= cfg.dailyStepsPerBot)
      return this.refuse(taskId, 'budget', `Daily step budget (${cfg.dailyStepsPerBot}) used`);
    if (this.deps.quotaOk && !this.deps.quotaOk(botId))
      return this.refuse(taskId, 'quota', 'Tenant quota exceeded');
    const holding = [...this.runs.values()].filter(
      (r) => r.botId === botId && r.status !== 'waiting'
    ).length;
    // Room for `maxPerBot` running plus as many queued behind them.
    if (holding >= cfg.maxPerBot * 2)
      return this.refuse(taskId, 'cap', `${botId} already has ${holding} runs going or queued`);

    const runId = `wr-${randomUUID()}`;
    const claim = ts.apply([{ op: 'claim', id: taskId, runId, ttlMs: cfg.claimTtlMs }], {
      actor: 'system',
      runId,
      ...(origin.cycleId ? { cycleId: origin.cycleId } : {}),
    });
    if (!claim.ok)
      return this.refuse(
        taskId,
        claim.reason === 'not-found' ? 'not-found' : 'claimed',
        claim.message
      );
    const goal = this.deps.goals(botId).find((g) => g.id === task.goalId);
    const run: WorkerRun = {
      runId,
      botId,
      taskId,
      goalId: task.goalId ?? null,
      dispatchCycleId: origin.cycleId,
      taskText: task.text,
      goalTitle: goal?.text ?? null,
      status: 'queued',
      attempt: origin.attempt,
      step: 0,
      budget: { ...cfg.budget },
      used: { steps: 0, toolCalls: 0, wallMs: 0 },
      createdAt: new Date(this.now()).toISOString(),
      claimToken: claim.results[0]?.token,
    };
    this.runs.set(runId, run);
    this.persist(botId);
    this.publish('worker:queued', run);
    return { taskId, ok: true, runId, queued: true };
  }

  // ── Queue ──────────────────────────────────────────────────────────────

  private pump(): void {
    if (this.pumping || this.shuttingDown) return;
    this.pumping = true;
    try {
      const cfg = this.deps.config();
      const queued = [...this.runs.values()].filter((r) => r.status === 'queued');
      if (queued.length === 0) return;
      const rank = this.rankFn(queued);
      queued.sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
      for (const run of queued) {
        const s = this.stats();
        if (s.running >= cfg.maxConcurrent) break;
        if ((s.byBot[run.botId]?.running ?? 0) >= cfg.maxPerBot) continue;
        if (!this.isEnabledFor(run.botId)) continue;
        if (!this.botUp(run.botId)) continue;
        const backend = this.deps.botBackend?.(run.botId);
        if (backend && this.deps.breaker?.isOpen(backend)) continue;
        this.start(run);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Goal priority (high first), then the task's order in its goal. */
  private rankFn(runs: WorkerRun[]): (r: WorkerRun) => number {
    const goalRank = new Map<string, Map<string, number>>();
    const order = new Map<string, number>();
    for (const botId of new Set(runs.map((r) => r.botId))) {
      const m = new Map<string, number>();
      for (const g of this.deps.goals(botId)) if (g.id) m.set(g.id, PRIORITY_RANK[g.priority] ?? 1);
      goalRank.set(botId, m);
      const ts = this.deps.taskStore(botId);
      for (const r of runs.filter((x) => x.botId === botId))
        order.set(r.runId, ts?.get(r.taskId)?.order ?? 0);
    }
    return (r) =>
      (goalRank.get(r.botId)?.get(r.goalId ?? '') ?? 1) * 1_000_000 + (order.get(r.runId) ?? 0);
  }

  private start(run: WorkerRun): void {
    const ctl = new AbortController();
    this.controllers.set(run.runId, ctl);
    run.status = 'running';
    this.drainFor(run);
    const env = this.makeEnv(run, ctl.signal);
    const p = runWorker(env)
      .then((end) => this.finish(run, end))
      .catch((err) => {
        const note = `worker crashed: ${err instanceof Error ? err.message : String(err)}`;
        this.deps.logger?.error({ err, runId: run.runId }, 'Workers: run crashed');
        this.finish(run, {
          status: 'failed',
          outcome: { kind: 'failed', note },
          release: { lane: 'todo', note },
        });
      });
    this.running.set(run.runId, p);
  }

  private makeEnv(run: WorkerRun, signal: AbortSignal) {
    const deps = this.deps;
    const workDir = taskWorkDir(deps.productionsDir(run.botId), run.taskId);
    try {
      mkdirSync(workDir, { recursive: true });
    } catch (err) {
      deps.logger?.warn({ err, workDir }, 'Workers: could not create the task folder');
    }
    return {
      run,
      config: deps.config(),
      signal,
      now: this.now,
      context: (): WorkerTaskContext => {
        const task = deps.taskStore(run.botId)?.get(run.taskId);
        const goal = deps.goals(run.botId).find((g) => g.id === run.goalId);
        const who = deps.identity?.(run.botId);
        return {
          ...(who?.name ? { botName: who.name } : {}),
          ...(who?.identity ? { identity: who.identity } : {}),
          goalTitle: goal?.text ?? run.goalTitle,
          ...(goal?.notes ? { goalNotes: goal.notes } : {}),
          taskText: task?.text ?? run.taskText,
          ...(task?.note ? { taskNote: task.note } : {}),
          workDir,
        };
      },
      runTurn: deps.runTurnFor(run.botId),
      journal: (e: JournalInput) => this.journalOf(run, e),
      readJournal: () => deps.store.readJournal(run.botId, run.runId),
      save: () => this.persist(run.botId),
      publish: (type: WorkerEventType, extra?: Partial<WorkerEventData>) =>
        this.publish(type, run, extra),
      renewClaim: () => this.renew(run),
      releaseTask: (lane: TaskLane, note: string) => this.release(run, lane, note),
      dailyStepsLeft: () => deps.config().dailyStepsPerBot - this.stepsToday(run.botId),
      takeWait: () => {
        const w = this.pendingWaits.get(run.runId);
        this.pendingWaits.delete(run.runId);
        return w;
      },
      onStepEnd: ({ n }: { n: number }) => {
        this.countStep(run.botId);
        try {
          deps.meter?.(run.botId, { runId: run.runId, taskId: run.taskId, step: n });
        } catch (err) {
          deps.logger?.warn({ err }, 'Workers: metering failed');
        }
      },
      onToolStart: (name: string) => this.publish('worker:tool', run, { tool: name }),
    };
  }

  // ── Ending ─────────────────────────────────────────────────────────────

  private stopEnd(reason: StopReason): WorkerEnd {
    switch (reason) {
      case 'operator':
        return {
          status: 'stopped',
          outcome: { kind: 'stopped', note: 'stopped by the operator' },
          release: { lane: 'todo', note: 'stopped by the operator' },
        };
      case 'goal-closed':
        return {
          status: 'stopped',
          outcome: { kind: 'stopped', note: 'the goal was closed' },
          release: { lane: 'todo', note: 'the goal was closed' },
        };
      case 'task-moved':
        // The operator's move already released the claim.
        return { status: 'stopped', outcome: { kind: 'stopped', note: 'the task was moved' } };
      case 'sweep':
        return {
          status: 'failed',
          outcome: { kind: 'failed', note: 'worker stopped responding' },
          release: { lane: 'todo', note: 'worker stopped responding' },
        };
      default:
        return { status: 'interrupted', outcome: { kind: 'interrupted', note: reason } };
    }
  }

  private finish(run: WorkerRun, end: WorkerEnd): void {
    this.controllers.delete(run.runId);
    this.running.delete(run.runId);
    this.pendingWaits.delete(run.runId);
    const reason = this.stopReasons.get(run.runId);
    this.stopReasons.delete(run.runId);

    if (this.shuttingDown || reason === 'shutdown') {
      // Keep the claim (and the tool in flight); recover / kick resume it.
      run.status = 'interrupted';
      this.persist(run.botId);
      return;
    }
    if (end.status === 'waiting' && end.wait && !reason) {
      run.status = 'waiting';
      run.wait = end.wait;
      run.currentTool = undefined;
      this.journalOf(run, { kind: 'wait', wait: end.wait });
      this.persist(run.botId);
      this.publish('worker:waiting', run, { wait: end.wait });
      this.drainFor(run);
      this.pump();
      return;
    }
    const final = reason ? this.stopEnd(reason) : end;
    this.endRun(run, final.status, final.outcome, final.release);
  }

  private endRun(
    run: WorkerRun,
    status: WorkerRunStatus,
    outcome: WorkerOutcome,
    release?: { lane: TaskLane; note: string }
  ): void {
    const cfg = this.deps.config();
    let rel = release;
    // ≥ maxAttempts failures: the task goes to Blocked for the operator.
    if (status === 'failed' && rel && rel.lane === 'todo' && run.attempt >= cfg.maxAttempts)
      rel = { lane: 'blocked', note: `${rel.note} (attempt ${run.attempt} of ${cfg.maxAttempts})` };
    if (run.claimToken) {
      if (rel) this.release(run, rel.lane, rel.note);
      else if (status !== 'done' && status !== 'blocked') this.release(run, 'todo', outcome.note);
    }
    const wait = run.wait;
    run.status = status;
    run.outcome = outcome;
    run.endedAt = new Date(this.now()).toISOString();
    run.currentTool = undefined;
    run.wait = undefined;
    this.held.delete(run.runId);
    if (wait && this.deps.cancelWait) {
      try {
        this.deps.cancelWait(wait);
      } catch (err) {
        this.deps.logger?.warn(
          { err, runId: run.runId, waitId: wait.id },
          'Workers: could not withdraw the wait'
        );
      }
    }
    if (this.deps.withdrawRunAsks) {
      try {
        this.deps.withdrawRunAsks(run.runId);
      } catch (err) {
        this.deps.logger?.warn(
          { err, runId: run.runId },
          'Workers: could not withdraw the pending asks of the run'
        );
      }
    }
    this.journalOf(run, { kind: 'run-end', status, outcome });
    this.runs.delete(run.runId);
    this.persist(run.botId);
    this.deps.store.appendEnded(run);
    const list = this.ended.get(run.botId) ?? this.endedFor(run.botId);
    this.ended.set(
      run.botId,
      [toRunView(run), ...list.filter((r) => r.runId !== run.runId)].slice(0, ENDED_CACHE)
    );
    this.publish('worker:ended', run, { outcome });
    this.scheduleWake(run.botId);
    this.pump();
  }

  // ── Answers ────────────────────────────────────────────────────────────

  private applyAnswer(run: WorkerRun, answer: WorkerAnswer): void {
    if (answer.dismissed) {
      // The question is closed already: nothing to withdraw.
      run.wait = undefined;
      this.journalOf(run, { kind: 'resume' });
      const note = 'the question was dismissed';
      this.endRun(run, 'blocked', { kind: 'blocked', note }, { lane: 'blocked', note });
      return;
    }
    const text =
      answer.answer ??
      (answer.decision
        ? `${answer.kind === 'approval' ? 'Permission' : 'Decision'} ${answer.decision}`
        : '');
    this.journalOf(run, { kind: 'resume', ...(text ? { answer: text } : {}) });
    run.wait = undefined;
    run.status = 'queued';
    this.persist(run.botId);
    this.publish('worker:queued', run);
  }

  /**
   * Answers that arrived while the pool could not take them (the stores keep
   * them), plus answers held for another question of this run. A waiting run
   * resumes with the one it waits on; an answer to another of its questions
   * is held until it waits on that one or runs again; a running or queued run
   * gets them in its journal, so its next step reads them.
   */
  private drainFor(run: WorkerRun): void {
    const answers = this.held.get(run.runId) ?? [];
    this.held.delete(run.runId);
    if (this.deps.drainAnswers) {
      try {
        answers.push(...this.deps.drainAnswers(run.runId));
      } catch (err) {
        this.deps.logger?.warn({ err, runId: run.runId }, 'Workers: draining answers failed');
      }
    }
    const keep: WorkerAnswer[] = [];
    for (const a of answers) {
      if (!this.runs.has(run.runId)) return;
      if (run.status === 'waiting') {
        if (!run.wait || run.wait.id === a.id) this.applyAnswer(run, a);
        else keep.push(a);
      } else this.recordEarlyAnswer(run, a);
    }
    if (keep.length === 0 || !this.runs.has(run.runId)) return;
    if (run.status === 'waiting') this.held.set(run.runId, keep);
    else for (const a of keep) this.recordEarlyAnswer(run, a);
  }

  /** An answer the run did not wait on: journaled for its next step (dismissals dropped). */
  private recordEarlyAnswer(run: WorkerRun, a: WorkerAnswer): void {
    if (a.dismissed) return;
    const text = a.answer ?? (a.decision ? `Permission ${a.decision}` : '');
    if (text)
      this.journalOf(run, {
        kind: 'resume',
        answer: text,
        ...(a.question ? { question: a.question } : {}),
      });
  }

  // ── Claims ─────────────────────────────────────────────────────────────

  private renew(run: WorkerRun): boolean {
    if (!run.claimToken) return false;
    const ts = this.deps.taskStore(run.botId);
    if (!ts) return false;
    const r = ts.apply(
      [
        {
          op: 'renew',
          id: run.taskId,
          token: run.claimToken,
          ttlMs: this.deps.config().claimTtlMs,
        },
      ],
      { actor: 'system', runId: run.runId, claimToken: run.claimToken }
    );
    return r.ok;
  }

  /** The run's claim lapsed (its token still on the task, past expiry). Someone else's claim: dropped. */
  private claimExpired(run: WorkerRun, now: number): boolean {
    const task = this.deps.taskStore(run.botId)?.get(run.taskId);
    if (!task?.claim || task.claim.token !== run.claimToken) {
      run.claimToken = undefined;
      return true;
    }
    return !liveClaim(task, now);
  }

  private release(run: WorkerRun, lane: TaskLane, note: string): boolean {
    if (!run.claimToken) return false;
    const ts = this.deps.taskStore(run.botId);
    if (!ts) return false;
    const r = ts.apply(
      [{ op: 'release', id: run.taskId, token: run.claimToken, lane, note: note.slice(0, 200) }],
      { actor: 'system', runId: run.runId, claimToken: run.claimToken }
    );
    if (r.ok) run.claimToken = undefined;
    else this.deps.logger?.warn({ runId: run.runId, reason: r.message }, 'Workers: release failed');
    return r.ok;
  }

  /** Renew with the stored token, else claim again. False: the task is gone or someone else's. */
  private rebind(run: WorkerRun): boolean {
    if (this.renew(run)) return true;
    const ts = this.deps.taskStore(run.botId);
    if (!ts) return false;
    const task = ts.get(run.taskId);
    if (!task || task.lane === 'done') return false;
    const r = ts.apply(
      [{ op: 'claim', id: run.taskId, runId: run.runId, ttlMs: this.deps.config().claimTtlMs }],
      { actor: 'system', runId: run.runId }
    );
    if (!r.ok) return false;
    run.claimToken = r.results[0]?.token;
    this.persist(run.botId);
    return true;
  }

  private releaseExpiredClaims(now: number): void {
    const held = new Set([...this.runs.values()].map((r) => `${r.botId}:${r.taskId}`));
    for (const botId of this.deps.botIds()) {
      const ts = this.deps.taskStore(botId);
      if (!ts) continue;
      let tasks: StoredTask[];
      try {
        tasks = ts.list();
      } catch {
        continue;
      }
      for (const t of tasks) {
        if (!t.claim || liveClaim(t, now) || held.has(`${botId}:${t.id}`)) continue;
        const r = ts.apply(
          [
            {
              op: 'release',
              id: t.id,
              token: t.claim.token,
              lane: 'todo',
              note: 'worker claim expired',
            },
          ],
          { actor: 'system', runId: t.claim.runId, claimToken: t.claim.token }
        );
        if (!r.ok)
          this.deps.logger?.warn({ botId, taskId: t.id }, 'Workers: expired claim not released');
      }
    }
  }

  // ── Plumbing ───────────────────────────────────────────────────────────

  private journalOf(run: WorkerRun, e: JournalInput): void {
    this.deps.store.appendJournal(run.botId, run.runId, {
      ts: new Date(this.now()).toISOString(),
      runId: run.runId,
      ...e,
    } as JournalEntry);
  }

  private persist(botId: string): void {
    try {
      this.deps.store.saveActive(
        botId,
        [...this.runs.values()].filter((r) => r.botId === botId)
      );
    } catch (err) {
      this.deps.logger?.error({ err, botId }, 'Workers: could not persist runs');
    }
  }

  private publish(
    type: WorkerEventType,
    run: WorkerRun,
    extra: Partial<WorkerEventData> = {}
  ): void {
    const data: WorkerEventData = {
      runId: run.runId,
      taskId: run.taskId,
      goalId: run.goalId,
      status: run.status,
      step: run.step,
      budget: { ...run.budget },
      used: { ...run.used },
      ...extra,
    };
    const event: WorkerEvent = { type, botId: run.botId, timestamp: this.now(), data };
    try {
      this.deps.activityStream?.publish({
        type,
        botId: run.botId,
        timestamp: event.timestamp,
        data: data as unknown as Record<string, unknown>,
      });
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Workers: activity publish failed');
    }
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.deps.logger?.warn({ err }, 'Workers: listener failed');
      }
    }
  }

  private scheduleWake(botId: string): void {
    if (!this.deps.wake || this.shuttingDown) return;
    const prev = this.wakeTimers.get(botId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.wakeTimers.delete(botId);
      try {
        this.deps.wake?.(botId);
      } catch (err) {
        this.deps.logger?.warn({ err, botId }, 'Workers: wake failed');
      }
    }, this.deps.wakeDebounceMs ?? 2_000);
    (t as { unref?: () => void }).unref?.();
    this.wakeTimers.set(botId, t);
  }

  private ensureSweep(): void {
    if (this.sweepTimer || this.shuttingDown) return;
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        this.deps.logger?.error({ err }, 'Workers: sweep failed');
      }
    }, this.deps.config().sweepIntervalMs);
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  private stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private knownBots(): string[] {
    return [
      ...new Set([
        ...this.deps.store.listBots(),
        ...[...this.runs.values()].map((r) => r.botId),
        ...this.ended.keys(),
      ]),
    ];
  }

  private endedFor(botId: string): WorkerRunView[] {
    let list = this.ended.get(botId);
    if (!list) {
      list = this.deps.store.readEnded(botId, { limit: ENDED_CACHE });
      this.ended.set(botId, list);
    }
    return list;
  }

  private stepsToday(botId: string): number {
    const day = isoDay(this.now());
    let d = this.daily.get(botId);
    if (!d || d.day !== day) {
      // Seed from what already ran today (ended runs + the active ones).
      const endedSteps = this.deps.store
        .readEnded(botId, { limit: 1000, days: 1 })
        .filter((r) => (r.endedAt ?? '').startsWith(day))
        .reduce((n, r) => n + (r.used?.steps ?? 0), 0);
      const activeSteps = [...this.runs.values()]
        .filter((r) => r.botId === botId && (r.startedAt ?? '').startsWith(day))
        .reduce((n, r) => n + r.used.steps, 0);
      d = { day, steps: endedSteps + activeSteps };
      this.daily.set(botId, d);
    }
    return d.steps;
  }

  private countStep(botId: string): void {
    this.stepsToday(botId);
    const d = this.daily.get(botId);
    if (d) d.steps++;
  }
}

/**
 * The step a run was in when it stopped: started, never ended. `inFlight`:
 * calls journaled as started without their end (the process stopped during
 * them); they count as done, so they are in `toolCalls` too.
 */
export function unfinishedStep(
  journal: JournalEntry[]
): (WorkerStepRecord & { inFlight: WorkerToolCall[] }) | undefined {
  let lastStart = -1;
  for (let i = journal.length - 1; i >= 0; i--) {
    if (journal[i].kind === 'step-start') {
      lastStart = i;
      break;
    }
  }
  if (lastStart < 0) return undefined;
  const n = (journal[lastStart] as { n: number }).n;
  if (journal.some((e) => e.kind === 'step-end' && e.n === n)) return undefined;
  const record = stepsFromJournal(journal).find((s) => s.n === n);
  if (!record) return undefined;
  const inFlight: WorkerToolCall[] = [];
  for (const e of journal.slice(lastStart + 1)) {
    if (e.kind === 'tool-start' && e.n === n) {
      inFlight.push({
        name: e.name,
        ok: false,
        sideEffect: e.sideEffect,
        ...(e.target ? { target: e.target } : {}),
      });
    } else if (e.kind === 'tool' && e.n === n) {
      const i = inFlight.findIndex((c) => c.name === e.name);
      if (i >= 0) inFlight.splice(i, 1);
    }
  }
  return { ...record, toolCalls: [...record.toolCalls, ...inFlight], inFlight };
}
