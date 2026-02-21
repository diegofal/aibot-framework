import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { ProductionsService } from '../../productions/service';
import type { Logger } from '../../logger';

export function productionsRoutes(deps: {
  productionsService: ProductionsService;
  botManager: BotManager;
  logger: Logger;
}) {
  const app = new Hono();
  const { productionsService, botManager, logger } = deps;

  // List all bots with production stats
  app.get('/', (c) => {
    const stats = productionsService.getAllBotStats();
    return c.json(stats);
  });

  // List productions for a bot (paginated)
  app.get('/:botId', (c) => {
    const botId = c.req.param('botId');
    const limit = Number(c.req.query('limit')) || 50;
    const offset = Number(c.req.query('offset')) || 0;
    const status = c.req.query('status') || undefined;
    const since = c.req.query('since') || undefined;

    const entries = productionsService.getChangelog(botId, { limit, offset, status, since });
    const stats = productionsService.getStats(botId);

    return c.json({ entries, stats });
  });

  // Get single production with file content
  app.get('/:botId/:id', (c) => {
    const botId = c.req.param('botId');
    const id = c.req.param('id');

    const entry = productionsService.getEntry(botId, id);
    if (!entry) {
      return c.json({ error: 'Production not found' }, 404);
    }

    const content = productionsService.getFileContent(botId, id);
    return c.json({ entry, content });
  });

  // Evaluate a production
  app.post('/:botId/:id/evaluate', async (c) => {
    const botId = c.req.param('botId');
    const id = c.req.param('id');
    const body = await c.req.json<{
      status: 'approved' | 'rejected';
      rating?: number;
      feedback?: string;
    }>();

    if (!body.status || !['approved', 'rejected'].includes(body.status)) {
      return c.json({ error: 'Missing or invalid "status" (approved|rejected)' }, 400);
    }

    if (body.rating != null && (body.rating < 1 || body.rating > 5)) {
      return c.json({ error: 'Rating must be between 1 and 5' }, 400);
    }

    // Get soul loader for feedback-to-memory
    const soulLoaders = (botManager as any).soulLoaders as Map<string, any> | undefined;
    const soulLoader = soulLoaders?.get(botId);

    const updated = productionsService.evaluate(botId, id, body, soulLoader);
    if (!updated) {
      return c.json({ error: 'Production not found' }, 404);
    }

    logger.info({ botId, id, status: body.status }, 'Production evaluated via web');
    return c.json({ entry: updated });
  });

  // Update file content
  app.put('/:botId/:id/content', async (c) => {
    const botId = c.req.param('botId');
    const id = c.req.param('id');
    const body = await c.req.json<{ content: string }>();

    if (typeof body.content !== 'string') {
      return c.json({ error: 'Missing "content" string in body' }, 400);
    }

    const ok = productionsService.updateContent(botId, id, body.content);
    if (!ok) {
      return c.json({ error: 'Production not found or update failed' }, 404);
    }

    logger.info({ botId, id }, 'Production content updated via web');
    return c.json({ ok: true });
  });

  // Delete production
  app.delete('/:botId/:id', (c) => {
    const botId = c.req.param('botId');
    const id = c.req.param('id');

    const ok = productionsService.deleteProduction(botId, id);
    if (!ok) {
      return c.json({ error: 'Production not found' }, 404);
    }

    logger.info({ botId, id }, 'Production deleted via web');
    return c.json({ ok: true });
  });

  return app;
}
