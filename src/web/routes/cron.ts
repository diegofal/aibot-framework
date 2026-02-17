import { Hono } from 'hono';
import type { CronService } from '../../cron';
import type { CronJobCreate, CronJobPatch } from '../../cron/types';

export function cronRoutes(deps: { cronService: CronService }) {
  const app = new Hono();

  // List all cron jobs
  app.get('/', async (c) => {
    const jobs = await deps.cronService.list({ includeDisabled: true });
    return c.json(jobs);
  });

  // Get single cron job
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const jobs = await deps.cronService.list({ includeDisabled: true });
    const job = jobs.find((j) => j.id === id);
    if (!job) return c.json({ error: 'Cron job not found' }, 404);

    // Include recent run history
    const runs = await deps.cronService.runs(id, { limit: 20 });
    return c.json({ ...job, runs });
  });

  // Create cron job
  app.post('/', async (c) => {
    const body = await c.req.json<CronJobCreate>();
    if (!body.name || !body.schedule || !body.payload) {
      return c.json({ error: 'name, schedule, and payload are required' }, 400);
    }

    const job = await deps.cronService.add(body);
    return c.json(job, 201);
  });

  // Update cron job
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<CronJobPatch>();

    try {
      const job = await deps.cronService.update(id, body);
      return c.json(job);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return c.json({ error: 'Cron job not found' }, 404);
      }
      throw err;
    }
  });

  // Rerun a cron job immediately
  app.post('/:id/run', async (c) => {
    const id = c.req.param('id');
    try {
      const result = await deps.cronService.run(id, 'force');
      if (!result.ran) {
        return c.json({ ok: false, reason: result.reason ?? 'unknown' }, 409);
      }
      return c.json({ ok: true });
    } catch (err: any) {
      if (err.message?.includes('not found') || err.message?.includes('Unknown cron job')) {
        return c.json({ ok: false, reason: 'not-found' }, 404);
      }
      return c.json({ ok: false, reason: String(err.message ?? err) }, 500);
    }
  });

  // Clear all run logs for a job
  app.delete('/:id/runs', async (c) => {
    const id = c.req.param('id');
    await deps.cronService.clearRuns(id);
    return c.json({ ok: true });
  });

  // Delete specific run log entries by timestamp
  app.post('/:id/runs/delete', async (c) => {
    const id = c.req.param('id');
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
    const result = await deps.cronService.remove(id);
    if (!result.removed) return c.json({ error: 'Cron job not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
