/**
 * Agent Home API.
 *
 *   GET /api/agents/presence       fleet map id -> presence + karma + last output (cached 3 s)
 *   GET /api/agents/:id/home       everything the agent's home page needs (cached 15 s)
 *   GET /api/agents/:id/presence   posture + first-person "now" line (never cached)
 *
 * Read-only, tenant-scoped like /api/stats, never throws on missing data.
 * Mounted BEFORE the CRUD agents routes in server.ts: their `GET /:id` would
 * otherwise answer `/presence` with "Agent not found". `/:id/home` and
 * `/:id/presence` do not collide with `/:id`.
 */
import { Hono } from 'hono';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import {
  type AgentHomeDeps,
  FLEET_PRESENCE_TTL_MS,
  HOME_CACHE_TTL_MS,
  type HomeKarmaSource,
  buildAgentHome,
  buildFleetPresence,
  buildPresence,
} from '../../stats/agent-home-aggregator';
import { type StatsBotManager, createStatsContext } from '../../stats/context';
import type { PresenceTracker } from '../../stats/presence-tracker';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';

export interface AgentHomeRouteDeps {
  config: Config;
  botManager: StatsBotManager & { isRunning?(botId: string): boolean };
  logger: Logger;
  karmaService?: HomeKarmaSource;
  presence?: PresenceTracker;
  pendingPermissions?: (botId: string) => number;
  /** Injectable clock (tests). */
  now?: () => number;
  cacheTtlMs?: number;
}

export function agentHomeRoutes(deps: AgentHomeRouteDeps) {
  const app = new Hono();
  const ctx = createStatsContext({
    config: deps.config,
    botManager: deps.botManager,
    now: deps.now,
  });
  const ttl = deps.cacheTtlMs ?? HOME_CACHE_TTL_MS;
  const homeDeps: AgentHomeDeps = {
    karma: deps.karmaService,
    presence: deps.presence ? (id) => deps.presence?.get(id) ?? undefined : undefined,
    isRunning: (id) => deps.botManager.isRunning?.(id) ?? false,
    pendingPermissions: deps.pendingPermissions,
  } as AgentHomeDeps;

  const findBot = (c: import('hono').Context) => {
    const id = c.req.param('id');
    const bot = deps.config.bots.find((b) => b.id === id);
    if (!bot || !isBotAccessible(bot, getTenantId(c))) return null;
    return bot;
  };

  // Literal path first: with a bot whose id is "presence" the fleet map still wins.
  app.get('/presence', (c) => {
    const tenantId = getTenantId(c);
    const bots = scopeBots(deps.config.bots, tenantId);
    try {
      const body = ctx.cache.get(`fleet-presence:${tenantId ?? '*'}`, FLEET_PRESENCE_TTL_MS, () =>
        buildFleetPresence(ctx, bots, homeDeps)
      );
      return c.json(body);
    } catch (err) {
      deps.logger.warn({ err }, 'Fleet presence aggregation failed');
      return c.json({ error: 'Fleet presence aggregation failed' }, 500);
    }
  });

  app.get('/:id/home', (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    try {
      const body = ctx.cache.get(`home:${bot.id}`, ttl, () => buildAgentHome(ctx, bot, homeDeps));
      return c.json(body);
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Agent home aggregation failed');
      return c.json({ error: 'Agent home aggregation failed' }, 500);
    }
  });

  app.get('/:id/presence', (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    try {
      return c.json(buildPresence(ctx, bot, homeDeps));
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Agent presence failed');
      return c.json({ error: 'Agent presence failed' }, 500);
    }
  });

  return app;
}
