import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Logger } from '../../logger';

export function askPermissionRoutes(deps: {
  botManager: BotManager;
  logger: Logger;
}) {
  const app = new Hono();

  // List all pending permission requests
  app.get('/', (c) => {
    const requests = deps.botManager.getPermissionsPending();
    return c.json({
      requests,
      totalCount: requests.length,
    });
  });

  // Lightweight count for badge polling
  app.get('/count', (c) => {
    const count = deps.botManager.getPermissionsCount();
    return c.json({ count });
  });

  // Approve a pending request
  app.post('/:id/approve', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string });
    const note = typeof body.note === 'string' ? body.note : undefined;

    const ok = deps.botManager.approvePermission(id, note);
    if (!ok) {
      return c.json({ error: 'Permission request not found or already resolved' }, 404);
    }

    deps.logger.info({ requestId: id, note }, 'Permission request approved via web');
    return c.json({ ok: true });
  });

  // Deny a pending request
  app.post('/:id/deny', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string });
    const note = typeof body.note === 'string' ? body.note : undefined;

    const ok = deps.botManager.denyPermission(id, note);
    if (!ok) {
      return c.json({ error: 'Permission request not found or already resolved' }, 404);
    }

    deps.logger.info({ requestId: id, note }, 'Permission request denied via web');
    return c.json({ ok: true });
  });

  // History of resolved permission decisions
  app.get('/history', (c) => {
    const limit = Number.parseInt(c.req.query('limit') ?? '20', 10);
    const entries = deps.botManager.getPermissionsHistory(limit);
    return c.json({ entries });
  });

  // Requeue a failed/consumed history entry back into the resolved queue
  app.post('/history/:id/requeue', (c) => {
    const id = c.req.param('id');
    const ok = deps.botManager.requeuePermission(id);
    if (!ok) {
      return c.json(
        { error: 'Entry not found or not requeueable (must be approved + failed/consumed)' },
        404
      );
    }
    deps.logger.info({ requestId: id }, 'Permission request requeued via web');
    return c.json({ ok: true });
  });

  // Single history entry (for polling execution status)
  app.get('/history/:id', (c) => {
    const id = c.req.param('id');
    const entry = deps.botManager.getPermissionHistoryById(id);
    if (!entry) {
      return c.json({ error: 'History entry not found' }, 404);
    }
    return c.json({ entry });
  });

  return app;
}
