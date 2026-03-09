import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import { BotExportService, ConflictError } from '../../bot/bot-export-service';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import type { CoreMemoryManager } from '../../memory/core-memory';
import type { MemoryManager } from '../../memory/manager';
import { getTenantId, isBotAccessible } from '../../tenant/tenant-scoping';

export function agentExportRoutes(deps: {
  config: Config;
  configPath: string;
  botManager: BotManager;
  logger: Logger;
  memoryManager?: MemoryManager;
}) {
  const app = new Hono();

  const service = new BotExportService(
    deps.config,
    deps.configPath,
    deps.logger,
    deps.memoryManager ? () => deps.memoryManager?.getCoreMemory() ?? null : undefined,
    deps.memoryManager ? () => deps.memoryManager?.reindex() ?? Promise.resolve() : undefined
  );

  // GET /:id/export — Download .tar.gz
  app.get('/:id/export', async (c) => {
    const botId = c.req.param('id');
    const bot = deps.config.bots.find((b) => b.id === botId);
    if (!bot || !isBotAccessible(bot, getTenantId(c))) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    const productions = c.req.query('productions') === 'true';
    const conversations = c.req.query('conversations') === 'true';
    const karma = c.req.query('karma') === 'true';

    try {
      const buffer = await service.exportBot(botId, { productions, conversations, karma });

      const date = new Date().toISOString().slice(0, 10);
      const filename = `${botId}-export-${date}.tar.gz`;

      return new Response(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(buffer.length),
        },
      });
    } catch (err: unknown) {
      deps.logger.error({ err, botId }, 'Export failed');
      const message = err instanceof Error ? err.message : 'Export failed';
      return c.json({ error: message }, 500);
    }
  });

  // POST /import — Upload .tar.gz (multipart)
  app.post('/import', async (c) => {
    try {
      const contentType = c.req.header('content-type') ?? '';

      let buffer: Buffer;
      if (contentType.includes('multipart/form-data')) {
        const formData = await c.req.formData();
        const file = formData.get('file');
        if (!file || !(file instanceof File)) {
          return c.json(
            { error: 'No file uploaded. Send as multipart with field name "file".' },
            400
          );
        }
        buffer = Buffer.from(await file.arrayBuffer());
      } else if (
        contentType.includes('application/gzip') ||
        contentType.includes('application/octet-stream')
      ) {
        buffer = Buffer.from(await c.req.arrayBuffer());
      } else {
        return c.json(
          { error: 'Unsupported content type. Use multipart/form-data or application/gzip.' },
          400
        );
      }

      if (buffer.length === 0) {
        return c.json({ error: 'Empty file' }, 400);
      }

      const newBotId = c.req.query('newBotId') || undefined;
      const newBotName = c.req.query('newBotName') || undefined;
      const overwrite = c.req.query('overwrite') === 'true';

      // If overwriting, check if bot is running
      if (overwrite && newBotId) {
        if (deps.botManager.isRunning(newBotId)) {
          return c.json({ error: 'Stop the agent before overwriting' }, 400);
        }
      }

      const result = await service.importBot(buffer, { newBotId, newBotName, overwrite });

      return c.json(result, result.created ? 201 : 200);
    } catch (err: unknown) {
      if (err instanceof ConflictError) {
        return c.json({ error: err.message }, 409);
      }
      deps.logger.error({ err }, 'Import failed');
      const message = err instanceof Error ? err.message : 'Import failed';
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
