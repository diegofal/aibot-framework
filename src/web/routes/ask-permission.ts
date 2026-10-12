import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { PermissionHistoryEntry, PermissionRequestInfo } from '../../bot/ask-permission-store';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import { getTenantId, scopeBots } from '../../tenant/tenant-scoping';
import { permissionToWhy } from '../../why/builders/permission';
import { CycleIndex, type CycleReader } from '../../why/cycle-index';
import type { Why } from '../../why/types';

type PermissionRow = (PermissionRequestInfo | PermissionHistoryEntry) & { createdAt?: number };

const toIso = (ms: unknown): string | undefined =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;

/**
 * "Why this?" for each request or decision: one cycle-log read per bot, then
 * `permissionToWhy`. A builder that throws leaves its row without a `why`.
 */
export function withPermissionWhy<T extends PermissionRow>(
  rows: T[],
  read: CycleReader | undefined,
  logger: Logger
): Array<T & { why?: Why }> {
  const at = (r: T) => toIso(r.createdAt) ?? toIso((r as PermissionHistoryEntry).resolvedAt);
  const cycles = CycleIndex.for(
    read,
    rows.flatMap((r) => {
      const iso = r.cycleId ? at(r) : undefined;
      return iso ? [{ botId: r.botId, at: iso }] : [];
    }),
    (botId, err) => logger.warn({ err, botId }, 'ask-permission: cycle log read failed')
  );
  return rows.map((r) => {
    try {
      const h = r as Partial<PermissionHistoryEntry>;
      return {
        ...r,
        why: permissionToWhy({
          botId: r.botId,
          action: r.action,
          resource: r.resource,
          description: r.description,
          cycleId: r.cycleId,
          goalId: r.goalId,
          cycle: r.cycleId ? cycles.byId(r.botId, r.cycleId) : undefined,
          status: r.status,
          executionStatus: h.executionStatus,
          executionSummary: h.executionSummary,
          note: h.note,
        }),
      };
    } catch (err) {
      logger.warn({ err, id: r.id }, 'ask-permission: why failed, skipping');
      return r;
    }
  });
}

export function askPermissionRoutes(deps: {
  botManager: BotManager;
  logger: Logger;
  config?: Config;
  /** Agent-loop cycle rows of a bot (shared `readCycles` of server.ts): plan and goal for `why`. */
  readCycles?: CycleReader;
}) {
  const app = new Hono();

  /** Get allowed bot IDs for the requesting tenant (undefined = all allowed) */
  function getAllowedBotIds(c: import('hono').Context): Set<string> | undefined {
    const tenantId = getTenantId(c);
    if (!tenantId || !deps.config) return undefined;
    return new Set(scopeBots(deps.config.bots, tenantId).map((b) => b.id));
  }

  // List all pending permission requests
  app.get('/', (c) => {
    let requests = deps.botManager.getPermissionsPending();
    const allowedIds = getAllowedBotIds(c);
    if (allowedIds) {
      requests = requests.filter((r: any) => allowedIds.has(r.botId));
    }
    return c.json({
      requests: withPermissionWhy(requests, deps.readCycles, deps.logger),
      totalCount: requests.length,
    });
  });

  // Lightweight count for badge polling
  app.get('/count', (c) => {
    const allowedIds = getAllowedBotIds(c);
    if (allowedIds) {
      const requests = deps.botManager.getPermissionsPending();
      const count = requests.filter((r: any) => allowedIds.has(r.botId)).length;
      return c.json({ count });
    }
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
    let entries = deps.botManager.getPermissionsHistory(limit);
    const allowedIds = getAllowedBotIds(c);
    if (allowedIds) {
      entries = entries.filter((e: any) => allowedIds.has(e.botId));
    }
    return c.json({ entries: withPermissionWhy(entries, deps.readCycles, deps.logger) });
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
