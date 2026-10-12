/**
 * Task workers API (plan: docs/plans/goal-tasks-architecture-plan.md, C19).
 *
 *   GET  /api/agents/:id/workers    active runs + the last 20 ended ones of a bot
 *   GET  /api/workers               the same across every bot the caller can see
 *   GET  /api/workers/:runId        run + journal + the journal grouped by step + why
 *   POST /api/workers/:runId/stop   abort an active run (reason `operator`)
 *   POST /api/workers/:runId/retry  a new attempt of an ended run's task
 *
 * Tenant-scoped like the Agent Home routes: a run is visible only when its bot
 * is in the live config and accessible to the caller (else 404). The pool is
 * read per request; without one (or with workers off) the lists answer
 * `{ enabled: false, runs: [] }` and the run endpoints 404. Mounted at `/api`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';
import { workerRunToWhy } from '../../why/builders/worker-run';
import { CycleIndex, type CycleReader } from '../../why/cycle-index';
import type { Why } from '../../why/types';
import {
  type JournalEntry,
  type WorkerPoolApi,
  type WorkerRun,
  type WorkerRunView,
  type WorkerStepRecord,
  isActiveRun,
  toRunView,
} from '../../workers/types';

/** Ended runs listed per bot. */
export const WORKERS_ENDED_LIMIT = 20;
/** Ended runs listed across the fleet. */
export const FLEET_WORKERS_ENDED_LIMIT = 50;

export interface WorkersRouteDeps {
  config: Config;
  logger: Logger;
  /** The pool, read per request (it may come up after the routes, or never). */
  workerPool: () => WorkerPoolApi | undefined;
  /** Cycle-log rows of a bot, for the dispatching cycle in a run's `why`. */
  readCycles?: CycleReader;
}

export interface WorkersListResponse {
  enabled: boolean;
  runs: WorkerRunView[];
}

export interface WorkerDetailResponse {
  run: WorkerRunView;
  journal: JournalEntry[];
  steps: WorkerStepRecord[];
  /** Who dispatched the run and why (`workerRunToWhy`). */
  why: Why;
}

/** The journal of a run folded into one record per step, in step order. Pure. */
export function groupJournalSteps(journal: JournalEntry[]): WorkerStepRecord[] {
  const byN = new Map<number, WorkerStepRecord>();
  const step = (n: number, ts: string): WorkerStepRecord => {
    let s = byN.get(n);
    if (!s) {
      s = { n, startedAt: ts, toolCalls: [] };
      byN.set(n, s);
    }
    return s;
  };
  for (const e of journal) {
    switch (e.kind) {
      case 'step-start':
        step(e.n, e.ts).startedAt = e.ts;
        break;
      case 'tool': {
        const { name, target, ok, sideEffect } = e;
        step(e.n, e.ts).toolCalls.push({
          name,
          ...(target ? { target } : {}),
          ok,
          sideEffect,
        });
        break;
      }
      case 'report':
        step(e.n, e.ts).report = e.report;
        break;
      case 'step-end': {
        const s = step(e.n, e.ts);
        s.endedAt = e.ts;
        if (e.summary) s.summary = e.summary;
        if (e.error) s.error = e.error;
        break;
      }
      default:
        break;
    }
  }
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

/** Never send a claim token, whatever the pool hands back. */
function view(run: WorkerRunView): WorkerRunView {
  return toRunView(run as WorkerRun);
}

const endedTs = (r: WorkerRunView) => r.endedAt ?? r.heartbeatAt ?? r.createdAt;

/** Active first (newest first), then ended (most recently ended first). */
function sortRuns(runs: WorkerRunView[]): WorkerRunView[] {
  const active = runs.filter((r) => isActiveRun(r.status));
  const ended = runs.filter((r) => !isActiveRun(r.status));
  active.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  ended.sort((a, b) => endedTs(b).localeCompare(endedTs(a)));
  return [...active, ...ended];
}

export function workersRoutes(deps: WorkersRouteDeps) {
  const app = new Hono();
  const DISABLED: WorkersListResponse = { enabled: false, runs: [] };

  const pool = (): WorkerPoolApi | undefined => {
    try {
      return deps.workerPool() ?? undefined;
    } catch (err) {
      deps.logger.warn({ err }, 'Worker pool unavailable');
      return undefined;
    }
  };

  /** The run and its pool, when the caller may see it. */
  const findRun = (c: Context) => {
    const p = pool();
    if (!p) return null;
    const run = p.get(c.req.param('runId') ?? '');
    if (!run) return null;
    const bot = deps.config.bots.find((b) => b.id === run.botId);
    if (!bot || !isBotAccessible(bot, getTenantId(c))) return null;
    return { pool: p, run };
  };

  app.get('/agents/:id/workers', (c) => {
    const id = c.req.param('id');
    const bot = deps.config.bots.find((b) => b.id === id);
    if (!bot || !isBotAccessible(bot, getTenantId(c)))
      return c.json({ error: 'Bot not found' }, 404);
    const p = pool();
    if (!p) return c.json(DISABLED);
    try {
      if (!p.isEnabledFor(bot.id)) return c.json(DISABLED);
      const runs = p.list(bot.id, { endedLimit: WORKERS_ENDED_LIMIT }).map(view);
      return c.json({ enabled: true, runs: sortRuns(runs) } satisfies WorkersListResponse);
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Worker list failed');
      return c.json({ error: 'Worker list failed' }, 500);
    }
  });

  app.get('/workers', (c) => {
    const p = pool();
    if (!p) return c.json(DISABLED);
    try {
      const bots = scopeBots(deps.config.bots, getTenantId(c));
      const enabledBots = bots.filter((b) => p.isEnabledFor(b.id));
      if (enabledBots.length === 0) return c.json(DISABLED);
      const runs = enabledBots.flatMap((b) =>
        p.list(b.id, { endedLimit: WORKERS_ENDED_LIMIT }).map(view)
      );
      const sorted = sortRuns(runs);
      const active = sorted.filter((r) => isActiveRun(r.status));
      const ended = sorted
        .filter((r) => !isActiveRun(r.status))
        .slice(0, FLEET_WORKERS_ENDED_LIMIT);
      return c.json({ enabled: true, runs: [...active, ...ended] } satisfies WorkersListResponse);
    } catch (err) {
      deps.logger.warn({ err }, 'Fleet worker list failed');
      return c.json({ error: 'Worker list failed' }, 500);
    }
  });

  app.get('/workers/:runId', (c) => {
    const found = findRun(c);
    if (!found) return c.json({ error: 'Run not found' }, 404);
    try {
      const journal = found.pool.journal(found.run.runId);
      const run = view(found.run);
      const cycleId = run.dispatchCycleId;
      const cycle = cycleId
        ? CycleIndex.for(deps.readCycles, [{ botId: run.botId, at: run.createdAt }], (botId, err) =>
            deps.logger.warn({ err, botId }, 'Worker detail: cycle log read failed')
          ).byId(run.botId, cycleId)
        : undefined;
      return c.json({
        run,
        journal,
        steps: groupJournalSteps(journal),
        why: workerRunToWhy({ run, journal, ...(cycle ? { cycle } : {}) }),
      } satisfies WorkerDetailResponse);
    } catch (err) {
      deps.logger.warn({ err, runId: found.run.runId }, 'Worker detail failed');
      return c.json({ error: 'Worker detail failed' }, 500);
    }
  });

  app.post('/workers/:runId/stop', (c) => {
    const found = findRun(c);
    if (!found) return c.json({ error: 'Run not found' }, 404);
    const { runId } = found.run;
    const stopped = found.pool.stop(runId, 'operator');
    if (!stopped) return c.json({ stopped: false, runId, error: 'The run is not active' }, 409);
    deps.logger.info({ botId: found.run.botId, runId }, 'Operator stopped a worker');
    return c.json({ stopped: true, runId });
  });

  app.post('/workers/:runId/retry', (c) => {
    const found = findRun(c);
    if (!found) return c.json({ error: 'Run not found' }, 404);
    const result = found.pool.retry(found.run.runId);
    if (!result.ok) return c.json(result, 409);
    deps.logger.info(
      { botId: found.run.botId, runId: found.run.runId, newRunId: result.runId },
      'Operator retried a worker'
    );
    return c.json(result);
  });

  return app;
}
