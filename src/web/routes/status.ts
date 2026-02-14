import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';

const startedAt = Date.now();

export function statusRoutes(deps: { config: Config; botManager: BotManager }) {
  const app = new Hono();

  app.get('/', (c) => {
    const runningBots = deps.botManager.getBotIds();
    return c.json({
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      startedAt: new Date(startedAt).toISOString(),
      bots: {
        configured: deps.config.bots.length,
        running: runningBots.length,
        ids: runningBots,
      },
    });
  });

  return app;
}
