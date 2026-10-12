import { Hono } from 'hono';
import type { Config } from '../../config';
import type { KarmaService } from '../../karma/service';
import type { KarmaEvent } from '../../karma/types';
import type { Logger } from '../../logger';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';
import { karmaEventToWhy } from '../../why/builders/karma';
import { CycleIndex, type CycleReader } from '../../why/cycle-index';

export function karmaRoutes(deps: {
  karmaService: KarmaService;
  config: Config;
  logger: Logger;
  /** Cycle-log rows of a bot, for each event's `why` (one read per request). */
  readCycles?: CycleReader;
}) {
  const app = new Hono();
  const { karmaService, config, logger } = deps;

  /** Each event with the `why` the Karma page renders. */
  const explain = (events: KarmaEvent[]) => {
    const cycles = CycleIndex.for(
      deps.readCycles,
      events
        .filter((e) => typeof e.metadata?.cycleId === 'string')
        .map((e) => ({ botId: e.botId, at: e.timestamp })),
      (botId, err) => logger.warn({ err, botId }, 'Karma: cycle log read failed')
    );
    return events.map((event) => {
      const id = event.metadata?.cycleId;
      const cycle = typeof id === 'string' ? cycles.byId(event.botId, id) : undefined;
      return { ...event, why: karmaEventToWhy({ event, ...(cycle ? { cycle } : {}) }) };
    });
  };

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
    return c.json({ ...result, events: explain(result.events) });
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
