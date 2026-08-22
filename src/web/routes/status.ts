import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';
import { getTenantId, scopeBots } from '../../tenant/tenant-scoping';

const startedAt = Date.now();

export function statusRoutes(deps: { config: Config; botManager: BotManager }) {
  const app = new Hono();

  app.get('/', (c) => {
    const tenantId = getTenantId(c);
    const allowedBots = scopeBots(deps.config.bots, tenantId);
    const allowedIds = new Set(allowedBots.map((b) => b.id));
    const runningBots = deps.botManager.getBotIds().filter((id) => allowedIds.has(id));
    const runningSet = new Set(runningBots);
    return c.json({
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      startedAt: new Date(startedAt).toISOString(),
      bots: {
        configured: allowedBots.length,
        running: runningBots.length,
        ids: runningBots,
        // Per-bot channel outcome so a revoked token and a deliberately
        // headless bot stop looking the same. null = never started, unknown.
        // Optional-called because route tests stub BotManager with only the
        // methods they exercise.
        channels: allowedBots.map((bot) => ({
          id: bot.id,
          running: runningSet.has(bot.id),
          channel: deps.botManager.getChannelState?.(bot.id) ?? null,
        })),
      },
    });
  });

  return app;
}
