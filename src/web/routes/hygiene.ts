/**
 * /api/hygiene — deterministic maintenance routines (preview + apply).
 *
 *   GET  /routines                → HygieneRoutineInfo[]
 *   POST /run                     → HygieneRun   body: { routine, botId?, apply?, options? }
 *   GET  /history?botId=&limit=   → HygieneRun[] (newest first)
 *
 * Bot-scoped routines are tenant-scoped like /api/karma; fleet routines and
 * the fleet half of `all` are admin-only.
 */

import { Hono } from 'hono';
import type { Config } from '../../config';
import { ALL_ROUTINE_ID, HygieneRegistry, type HygieneRegistryDeps } from '../../hygiene/registry';
import type { Logger } from '../../logger';
import {
  getTenantId,
  isAdminOrSingleTenant,
  isBotAccessible,
  scopeBots,
} from '../../tenant/tenant-scoping';

export interface HygieneRoutesDeps {
  config: Config;
  logger: Logger;
  /** Reserved for future use (e.g. refusing apply on a running bot). Not required. */
  botManager?: unknown;
  toolSucceededRecently?: HygieneRegistryDeps['toolSucceededRecently'];
  channelStateOf?: HygieneRegistryDeps['channelStateOf'];
  lastHealthCheckOf?: HygieneRegistryDeps['lastHealthCheckOf'];
  /** Inject a prebuilt registry (tests). */
  registry?: HygieneRegistry;
}

interface RunBody {
  routine?: unknown;
  botId?: unknown;
  apply?: unknown;
  options?: unknown;
}

export function hygieneRoutes(deps: HygieneRoutesDeps) {
  const app = new Hono();
  const { config, logger } = deps;
  const registry =
    deps.registry ??
    new HygieneRegistry({
      config,
      logger,
      toolSucceededRecently: deps.toolSucceededRecently,
      channelStateOf: deps.channelStateOf,
      lastHealthCheckOf: deps.lastHealthCheckOf,
    });

  app.get('/routines', (c) => c.json(registry.listRoutines()));

  app.post('/run', async (c) => {
    let body: RunBody;
    try {
      body = await c.req.json<RunBody>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object' || typeof body.routine !== 'string') {
      return c.json({ error: 'Missing "routine" (string)' }, 400);
    }
    const routineId = body.routine;
    const apply = body.apply === true;
    const options =
      body.options && typeof body.options === 'object' && !Array.isArray(body.options)
        ? (body.options as Record<string, unknown>)
        : {};
    const tenantId = getTenantId(c);

    if (routineId === ALL_ROUTINE_ID) {
      const bots = scopeBots(config.bots, tenantId);
      const run = await registry.run({
        routine: ALL_ROUTINE_ID,
        apply,
        options,
        botIds: bots.map((b) => b.id),
        includeFleet: isAdminOrSingleTenant(tenantId),
      });
      logger.info({ routine: routineId, apply, findings: run.findings.length }, 'Hygiene run');
      return c.json(run);
    }

    const routine = registry.get(routineId);
    if (!routine) return c.json({ error: `Unknown routine: ${routineId}` }, 400);

    let botId: string | undefined;
    if (routine.scope === 'bot') {
      if (typeof body.botId !== 'string' || !body.botId) {
        return c.json({ error: 'Missing "botId" for bot-scoped routine' }, 400);
      }
      const bot = config.bots.find((b) => b.id === body.botId);
      if (!bot || !isBotAccessible(bot, tenantId)) return c.json({ error: 'Bot not found' }, 404);
      botId = bot.id;
    } else if (!isAdminOrSingleTenant(tenantId)) {
      return c.json({ error: 'Fleet routines are admin-only' }, 403);
    }

    const run = await registry.run({ routine: routineId, botId, apply, options });
    if (run.error && run.findings.length === 0 && run.finishedAt === run.startedAt) {
      // Validation-style failure before the routine ran.
      return c.json(run, 400);
    }
    logger.info(
      {
        routine: routineId,
        botId,
        apply,
        findings: run.findings.length,
        applied: run.applied.length,
      },
      'Hygiene run'
    );
    return c.json(run);
  });

  app.get('/history', (c) => {
    const tenantId = getTenantId(c);
    const botId = c.req.query('botId') || undefined;
    const limit = Number(c.req.query('limit')) || 50;

    if (botId) {
      const bot = config.bots.find((b) => b.id === botId);
      if (!bot || !isBotAccessible(bot, tenantId)) return c.json({ error: 'Bot not found' }, 404);
      return c.json(registry.history.list({ botId, limit }));
    }

    if (isAdminOrSingleTenant(tenantId)) return c.json(registry.history.list({ limit }));

    const allowed = new Set(scopeBots(config.bots, tenantId).map((b) => b.id));
    return c.json(
      registry.history.list({
        limit,
        filter: (run) => run.botId !== null && allowed.has(run.botId),
      })
    );
  });

  return app;
}
