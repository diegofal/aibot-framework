import { Hono } from 'hono';
import type { Config } from '../../config';
import type { CronService } from '../../cron';
import type { CronRunLogEntry } from '../../cron/run-log';
import { weekOfRunsMs } from '../../cron/schedule';
import type { CronJob, CronJobCreate, CronJobPatch } from '../../cron/types';
import type { Logger } from '../../logger';
import { getTenantId, isAdminOrSingleTenant, scopeBots } from '../../tenant/tenant-scoping';
import { cronJobToWhy, cronRunToWhy } from '../../why/builders/cron';
import { CycleIndex, type CycleReader } from '../../why/cycle-index';

export function cronRoutes(deps: {
  cronService: CronService;
  config: Config;
  logger?: Logger;
  /** Cycle-log rows of a bot, for the `why` of jobs an agent set up in a cycle. */
  readCycles?: CycleReader;
}) {
  const app = new Hono();

  /** Each job with the `why` the Automations page renders (one cycle-log read per bot). */
  const explain = (jobs: CronJob[]) => {
    const fromCycles = jobs.filter((j) => j.createdBy?.kind === 'agent' && j.createdBy.cycleId);
    const cycles = CycleIndex.for(
      deps.readCycles,
      fromCycles.map((j) => ({
        botId: (j.createdBy as { botId: string }).botId,
        at: new Date(j.createdAtMs).toISOString(),
      })),
      (botId, err) => deps.logger?.warn({ err, botId }, 'Cron: cycle log read failed')
    );
    return jobs.map((job) => {
      const by = job.createdBy;
      const cycle =
        by?.kind === 'agent' && by.cycleId ? cycles.byId(by.botId, by.cycleId) : undefined;
      const nowMs = Date.now();
      // The next 7 days of runs, for the page's week strip (paused: none).
      const upcoming = job.enabled === false ? [] : weekOfRunsMs(job.schedule, nowMs);
      return { ...job, upcoming, why: cronJobToWhy({ job, ...(cycle ? { cycle } : {}) }) };
    });
  };

  const explainRuns = (job: CronJob, runs: CronRunLogEntry[]) =>
    runs.map((run) => ({ ...run, why: cronRunToWhy({ run, job }) }));

  /** Get the set of botIds accessible to the requesting tenant */
  function allowedBotIds(c: import('hono').Context): Set<string> | null {
    const tenantId = getTenantId(c);
    if (!tenantId || tenantId === '__admin__') return null; // null = no filtering
    return new Set(scopeBots(deps.config.bots, tenantId).map((b) => b.id));
  }

  /** Check if a cron job is accessible to the requesting tenant */
  // biome-ignore lint/suspicious/noExplicitAny: job shape varies across cron implementations
  function isJobAccessible(job: any, allowed: Set<string> | null): boolean {
    if (!allowed) return true; // no tenant filtering
    const botId = job.payload?.botId ?? job.botId;
    return botId ? allowed.has(botId) : false;
  }

  // List cron jobs (tenant-scoped)
  app.get('/', async (c) => {
    const jobs = await deps.cronService.list({ includeDisabled: true });
    const allowed = allowedBotIds(c);
    return c.json(explain(allowed ? jobs.filter((j) => isJobAccessible(j, allowed)) : jobs));
  });

  // Get single cron job
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const jobs = await deps.cronService.list({ includeDisabled: true });
    const job = jobs.find((j) => j.id === id);
    if (!job) return c.json({ error: 'Cron job not found' }, 404);
    if (!isJobAccessible(job, allowedBotIds(c)))
      return c.json({ error: 'Cron job not found' }, 404);

    // Include recent run history
    const runs = await deps.cronService.runs(id, { limit: 20 });
    const [explained] = explain([job]);
    return c.json({ ...explained, runs: explainRuns(job, runs) });
  });

  /** Look up a cron job and verify tenant access. Returns the job or null. */
  async function findAccessibleJob(c: import('hono').Context, id: string) {
    const jobs = await deps.cronService.list({ includeDisabled: true });
    const job = jobs.find((j) => j.id === id);
    if (!job) return null;
    if (!isJobAccessible(job, allowedBotIds(c))) return null;
    return job;
  }

  // Create cron job (tenant-scoped: payload.botId must belong to tenant)
  app.post('/', async (c) => {
    const body = await c.req.json<CronJobCreate>();
    if (!body.name || !body.schedule || !body.payload) {
      return c.json({ error: 'name, schedule, and payload are required' }, 400);
    }
    const allowed = allowedBotIds(c);
    // biome-ignore lint/suspicious/noExplicitAny: payload schema is user-defined
    const payloadBotId = (body.payload as any)?.botId;
    if (allowed && payloadBotId && !allowed.has(payloadBotId)) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    // Only the instance operator's dashboard (admin / single-tenant) stamps
    // `operator`, the creator `src/cron/trust.ts` trusts with personal data; a
    // tenant API caller is recorded as the tenant. A body never claims either.
    const tenantId = getTenantId(c);
    const createdBy: CronJob['createdBy'] = isAdminOrSingleTenant(tenantId)
      ? { kind: 'operator' }
      : { kind: 'tenant', tenantId: tenantId as string };
    const job = await deps.cronService.add({ ...body, createdBy });
    return c.json(job, 201);
  });

  // Update cron job
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await findAccessibleJob(c, id))) return c.json({ error: 'Cron job not found' }, 404);
    const body = await c.req.json<CronJobPatch>();
    // A patch cannot move the job to a bot outside the caller's tenant.
    const allowed = allowedBotIds(c);
    const newBotId = (body.payload as { botId?: unknown } | undefined)?.botId;
    if (allowed && typeof newBotId === 'string' && !allowed.has(newBotId)) {
      return c.json({ error: 'Cron job not found' }, 404);
    }

    try {
      const job = await deps.cronService.update(id, body);
      return c.json(job);
    } catch (err: unknown) {
      if (err instanceof Error && err.message?.includes('not found')) {
        return c.json({ error: 'Cron job not found' }, 404);
      }
      throw err;
    }
  });

  // Force-run every enabled job whose last run errored (tenant-scoped).
  // Must be registered before /:id/run so 'rerun-failed' isn't read as an id.
  app.post('/rerun-failed', async (c) => {
    const jobs = await deps.cronService.list({ includeDisabled: true });
    const allowed = allowedBotIds(c);
    const isFailing = (j: CronJob) =>
      j.enabled !== false && j.state?.lastStatus === 'error' && isJobAccessible(j, allowed);
    const failing = jobs.filter(isFailing);

    const results: Array<{ id: string; name: string; ran: boolean; reason?: string }> = [];
    for (const job of failing) {
      try {
        const result = await deps.cronService.run(job.id, 'force');
        results.push({ id: job.id, name: job.name, ran: result.ran, reason: result.reason });
      } catch (err: unknown) {
        results.push({
          id: job.id,
          name: job.name,
          ran: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json({ ok: true, attempted: results.length, results });
  });

  // Rerun a cron job immediately
  app.post('/:id/run', async (c) => {
    const id = c.req.param('id');
    if (!(await findAccessibleJob(c, id))) return c.json({ error: 'Cron job not found' }, 404);
    try {
      const result = await deps.cronService.run(id, 'force');
      if (!result.ran) {
        return c.json({ ok: false, reason: result.reason ?? 'unknown' }, 409);
      }
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found') || message.includes('Unknown cron job')) {
        return c.json({ ok: false, reason: 'not-found' }, 404);
      }
      return c.json({ ok: false, reason: message }, 500);
    }
  });

  // Clear all run logs for a job
  app.delete('/:id/runs', async (c) => {
    const id = c.req.param('id');
    if (!(await findAccessibleJob(c, id))) return c.json({ error: 'Cron job not found' }, 404);
    await deps.cronService.clearRuns(id);
    return c.json({ ok: true });
  });

  // Delete specific run log entries by timestamp
  app.post('/:id/runs/delete', async (c) => {
    const id = c.req.param('id');
    if (!(await findAccessibleJob(c, id))) return c.json({ error: 'Cron job not found' }, 404);
    const body = await c.req.json<{ timestamps?: number[] }>();
    if (!Array.isArray(body.timestamps) || body.timestamps.length === 0) {
      return c.json({ error: 'timestamps array is required' }, 400);
    }
    const deleted = await deps.cronService.deleteRuns(id, body.timestamps);
    return c.json({ ok: true, deleted });
  });

  // Delete cron job
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await findAccessibleJob(c, id))) return c.json({ error: 'Cron job not found' }, 404);
    const result = await deps.cronService.remove(id);
    if (!result.removed) return c.json({ error: 'Cron job not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
