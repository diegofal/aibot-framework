import { Hono } from 'hono';
import type { Config } from '../../config';
import type { KarmaService } from '../../karma/service';
import type { Logger } from '../../logger';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';

export function karmaRoutes(deps: {
  karmaService: KarmaService;
  config: Config;
  logger: Logger;
}) {
  const app = new Hono();
  const { karmaService, config, logger } = deps;

  // Get karma for all bots (tenant-scoped)
  app.get('/', (c) => {
    const botIds = scopeBots(config.bots, getTenantId(c)).map((b) => b.id);
    const scores = karmaService.getAllScores(botIds);
    return c.json(scores);
  });

  // Get karma for a specific bot
  app.get('/:botId', (c) => {
    const botId = c.req.param('botId');
    const botConfig = config.bots.find((b) => b.id === botId);
    if (!botConfig || !isBotAccessible(botConfig, getTenantId(c))) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    const score = karmaService.getKarmaScore(botId);
    return c.json(score);
  });

  // Get paginated history for a bot
  app.get('/:botId/history', (c) => {
    const botId = c.req.param('botId');
    const botConfig = config.bots.find((b) => b.id === botId);
    if (!botConfig || !isBotAccessible(botConfig, getTenantId(c))) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    const limit = Number(c.req.query('limit')) || 50;
    const offset = Number(c.req.query('offset')) || 0;
    const result = karmaService.getHistory(botId, { limit, offset });
    return c.json(result);
  });

  // Clear all events (reset karma)
  app.delete('/:botId/events', (c) => {
    const botId = c.req.param('botId');
    const botConfig = config.bots.find((b) => b.id === botId);
    if (!botConfig || !isBotAccessible(botConfig, getTenantId(c))) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    karmaService.clearEvents(botId);
    logger.info({ botId }, 'Karma reset via API');
    return c.json({ ok: true, score: karmaService.getScore(botId) });
  });

  // Manual karma adjustment
  app.post('/:botId/adjust', async (c) => {
    const botId = c.req.param('botId');
    const botConfig = config.bots.find((b) => b.id === botId);
    if (!botConfig || !isBotAccessible(botConfig, getTenantId(c))) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    const body = await c.req.json<{ delta: number; reason: string }>();

    if (typeof body.delta !== 'number' || !body.reason) {
      return c.json({ error: 'Missing "delta" (number) or "reason" (string)' }, 400);
    }

    const event = karmaService.addEvent(botId, body.delta, body.reason, 'manual');
    logger.info({ botId, delta: body.delta, reason: body.reason }, 'Karma manually adjusted');
    return c.json({ event, score: karmaService.getScore(botId) });
  });

  return app;
}
