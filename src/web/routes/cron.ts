import { Hono } from 'hono';
import type { Config } from '../../config';
import type { CronService } from '../../cron';
import type { CronJobCreate, CronJobPatch } from '../../cron/types';
import { getTenantId, scopeBots } from '../../tenant/tenant-scoping';

export function cronRoutes(deps: { cronService: CronService; config: Config }) {
  const app = new Hono();

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
    if (!allowed) return c.json(jobs);
    return c.json(jobs.filter((j) => isJobAccessible(j, allowed)));
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
    return c.json({ ...job, runs });
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

    const job = await deps.cronService.add(body);
    return c.json(job, 201);
  });

  // Update cron job
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await findAccessibleJob(c, id))) return c.json({ error: 'Cron job not found' }, 404);
    const body = await c.req.json<CronJobPatch>();

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
