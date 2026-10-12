/**
 * Live per-bot presence derived from the activity stream.
 *
 * The agent loop hands the whole plan to one agentic LLM call, so there is no
 * observable "step 2 of 5"; what *is* observable is the phase the cycle is in
 * (`agent:phase`) and the tool being executed (`tool:start` / `tool:end`).
 * This tracker folds those events into a tiny state per bot that the presence
 * endpoint reads. It never throws and never keeps history.
 *
 * Task workers (C19) run beside the cycle: their `worker:*` events fold into
 * a per-bot map by `runId`, and a `tool:*` event carrying `data.runId` is a
 * worker's tool — it moves that run, never the bot's phase or current tool.
 * Ended runs leave the map (the workers API serves history).
 */
import type { ActivityEvent } from '../bot/activity-stream';
import type { WorkerBudget, WorkerRunStatus, WorkerUsage } from '../workers/types';

/** A worker run as the live presence sees it. */
export interface LiveWorker {
  runId: string;
  taskId: string;
  goalId: string | null;
  status: WorkerRunStatus;
  step: number;
  budget: WorkerBudget;
  used: WorkerUsage;
  /** Tool running now, null between tools. */
  tool: string | null;
  /** The question of a waiting run. */
  question?: string;
  /** First event seen for the run (ms): the elapsed clock. */
  since: number;
  updatedAt: number;
}

const ZERO_BUDGET: WorkerBudget = { steps: 0, toolCalls: 0, wallMs: 0 };

export interface LivePresence {
  executing: boolean;
  phase: string | null;
  currentTool: string | null;
  /** When the current phase / tool started (ms), null when idle. */
  since: number | null;
}

const IDLE: LivePresence = { executing: false, phase: null, currentTool: null, since: null };

export class PresenceTracker {
  private state = new Map<string, LivePresence>();
  private runs = new Map<string, Map<string, LiveWorker>>();

  /** Subscribe to an ActivityStream (or anything with the same `on`). */
  attach(stream: { on(event: 'activity', listener: (e: ActivityEvent) => void): unknown }): this {
    stream.on('activity', (e) => this.handle(e));
    return this;
  }

  handle(event: ActivityEvent): void {
    if (!event || typeof event.botId !== 'string') return;
    const ts = Number(event.timestamp) || Date.now();
    if (event.type.startsWith('worker:')) {
      this.handleWorker(event, ts);
      return;
    }
    const runId = event.data?.runId;
    if (typeof runId === 'string' && runId && event.type.startsWith('tool:')) {
      this.handleWorkerTool(event, runId, ts);
      return;
    }
    const cur = this.state.get(event.botId) ?? { ...IDLE };
    switch (event.type) {
      case 'agent:phase': {
        const phase = typeof event.phase === 'string' ? event.phase : null;
        this.state.set(event.botId, {
          executing: true,
          phase,
          currentTool: phase?.endsWith(':start') || phase === 'start' ? null : cur.currentTool,
          since: ts,
        });
        return;
      }
      case 'tool:start': {
        const name = event.data?.toolName;
        this.state.set(event.botId, {
          executing: true,
          phase: cur.phase ?? 'executor:start',
          currentTool: typeof name === 'string' ? name : null,
          since: ts,
        });
        return;
      }
      case 'tool:end':
      case 'tool:error': {
        if (!cur.executing) return;
        this.state.set(event.botId, { ...cur, currentTool: null, since: ts });
        return;
      }
      case 'agent:result':
      case 'agent:idle': {
        this.state.set(event.botId, { ...IDLE });
        return;
      }
      default:
        return;
    }
  }

  get(botId: string): LivePresence {
    return { ...(this.state.get(botId) ?? IDLE) };
  }

  /** Live worker runs of a bot, newest first (copies). */
  workers(botId: string): LiveWorker[] {
    const runs = this.runs.get(botId);
    if (!runs) return [];
    return [...runs.values()]
      .sort((a, b) => b.since - a.since)
      .map((w) => ({ ...w, budget: { ...w.budget }, used: { ...w.used } }));
  }

  /** Test / reset helper. */
  clear(botId?: string): void {
    if (botId) {
      this.state.delete(botId);
      this.runs.delete(botId);
    } else {
      this.state.clear();
      this.runs.clear();
    }
  }

  private handleWorker(event: ActivityEvent, ts: number): void {
    const d = (event.data ?? {}) as Record<string, unknown>;
    const runId = typeof d.runId === 'string' ? d.runId : '';
    if (!runId) return;
    const runs = this.runs.get(event.botId) ?? new Map<string, LiveWorker>();
    if (event.type === 'worker:ended') {
      runs.delete(runId);
      if (runs.size === 0) this.runs.delete(event.botId);
      return;
    }
    const prev = runs.get(runId);
    const wait = d.wait as { question?: unknown } | undefined;
    const status = (
      typeof d.status === 'string' ? d.status : (prev?.status ?? 'running')
    ) as WorkerRunStatus;
    const next: LiveWorker = {
      runId,
      taskId: typeof d.taskId === 'string' ? d.taskId : (prev?.taskId ?? ''),
      goalId: typeof d.goalId === 'string' ? d.goalId : (prev?.goalId ?? null),
      status,
      step: typeof d.step === 'number' ? d.step : (prev?.step ?? 0),
      budget: (d.budget as WorkerBudget) ?? prev?.budget ?? { ...ZERO_BUDGET },
      used: (d.used as WorkerUsage) ?? prev?.used ?? { ...ZERO_BUDGET },
      tool:
        event.type === 'worker:tool'
          ? typeof d.tool === 'string'
            ? d.tool
            : null
          : event.type === 'worker:step' || status !== 'running'
            ? null
            : (prev?.tool ?? null),
      since: prev?.since ?? ts,
      updatedAt: ts,
    };
    if (status === 'waiting') {
      const q = typeof wait?.question === 'string' ? wait.question : prev?.question;
      if (q) next.question = q;
    }
    runs.set(runId, next);
    this.runs.set(event.botId, runs);
  }

  private handleWorkerTool(event: ActivityEvent, runId: string, ts: number): void {
    const run = this.runs.get(event.botId)?.get(runId);
    if (!run) return;
    const name = event.data?.toolName;
    run.tool = event.type === 'tool:start' && typeof name === 'string' ? name : null;
    run.updatedAt = ts;
  }
}
