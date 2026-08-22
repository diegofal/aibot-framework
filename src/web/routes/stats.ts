/**
 * Stats & Behaviour dashboard API.
 *
 *   GET /api/stats/fleet?window=24h|7d|30d   fleet overview (default 7d)
 *   GET /api/stats/                          alias of /fleet
 *   GET /api/stats/bots/:botId?window=       per-bot detail
 *   GET /api/stats/behaviour?window=         cross-bot behavioural views
 *   GET /api/stats/infra                     backends, cron, telegram, logs
 *
 * Read-only, tenant-scoped (same rules as /api/karma), never throws on
 * missing data, and caches each aggregation for 60 s in memory.
 */
import { Hono } from 'hono';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import { buildBehaviour } from '../../stats/behaviour-aggregator';
import { type StatsBotManager, createStatsContext } from '../../stats/context';
import { buildBotDetail, buildFleet } from '../../stats/fleet-aggregator';
import { buildInfra } from '../../stats/infra-aggregator';
import type { KarmaScoreSource } from '../../stats/readers/karma';
import { parseWindow } from '../../stats/util';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';

export interface StatsRouteDeps {
  config: Config;
  botManager: StatsBotManager;
  logger: Logger;
  karmaService?: KarmaScoreSource;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Bytes of log tail to scan (default 8 MB). */
  logTailBytes?: number;
}

export function statsRoutes(deps: StatsRouteDeps) {
  const app = new Hono();
  const ctx = createStatsContext({
    config: deps.config,
    botManager: deps.botManager,
    karmaService: deps.karmaService,
    now: deps.now,
    logTailBytes: deps.logTailBytes,
  });

  const scopeKey = (ids: string[]) => [...ids].sort().join(',');

  const fleet = (c: import('hono').Context) => {
    const window = parseWindow(c.req.query('window'));
    const bots = scopeBots(deps.config.bots, getTenantId(c));
    try {
      return c.json(buildFleet(ctx, bots, window));
    } catch (err) {
      deps.logger.warn({ err }, 'Stats: fleet aggregation failed');
      return c.json({ error: 'Stats aggregation failed' }, 500);
    }
  };

  app.get('/', fleet);
  app.get('/fleet', fleet);

  app.get('/bots/:botId', (c) => {
    const botId = c.req.param('botId');
    const bot = deps.config.bots.find((b) => b.id === botId);
    if (!bot || !isBotAccessible(bot, getTenantId(c))) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    const window = parseWindow(c.req.query('window'));
    try {
      return c.json(buildBotDetail(ctx, bot, window));
    } catch (err) {
      deps.logger.warn({ err, botId }, 'Stats: bot detail aggregation failed');
      return c.json({ error: 'Stats aggregation failed' }, 500);
    }
  });

  app.get('/behaviour', (c) => {
    const window = parseWindow(c.req.query('window'));
    const bots = scopeBots(deps.config.bots, getTenantId(c));
    try {
      const key = `behaviour:${window}:${scopeKey(bots.map((b) => b.id))}`;
      return c.json(ctx.cache.get(key, ctx.cacheTtlMs, () => buildBehaviour(ctx, bots, window)));
    } catch (err) {
      deps.logger.warn({ err }, 'Stats: behaviour aggregation failed');
      return c.json({ error: 'Stats aggregation failed' }, 500);
    }
  });

  app.get('/infra', (c) => {
    const bots = scopeBots(deps.config.bots, getTenantId(c));
    try {
      const key = `infra:${scopeKey(bots.map((b) => b.id))}`;
      return c.json(ctx.cache.get(key, ctx.cacheTtlMs, () => buildInfra(ctx, bots)));
    } catch (err) {
      deps.logger.warn({ err }, 'Stats: infra aggregation failed');
      return c.json({ error: 'Stats aggregation failed' }, 500);
    }
  });

  return app;
}
