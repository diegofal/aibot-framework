import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';
import type { ProductionsService } from '../../productions/service';
import type { Logger } from '../../logger';
import { claudeGenerate } from '../../claude-cli';

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n... [truncated]';
}

const SUMMARY_SYSTEM_PROMPT = `You are a concise work analyst reviewing an AI bot's recent productions. Your job is to summarize what the bot is currently working on.

Rules:
- Group outputs by themes or projects if patterns are visible.
- Note quality trends (ratings, approval rate) if data is available.
- Highlight recent focus areas vs older work.
- Write in the bot's language (match the language used in its identity/soul files).
- Keep output under 1000 words.
- No markdown headers, no preamble, no sign-off.
- Be specific — cite file names and content when relevant.`;

export function productionsRoutes(deps: {
  productionsService: ProductionsService;
  botManager: BotManager;
  logger: Logger;
  config: Config;
}) {
  const app = new Hono();
  const { productionsService, botManager, logger, config } = deps;

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

  // Generate summary of bot's recent productions
  app.post('/:botId/generate-summary', async (c) => {
    const botId = c.req.param('botId');
    const botConfig = config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    try {
      const soulLoader = botManager.getSoulLoader(botId);
      const stats = productionsService.getStats(botId);
      const changelog = productionsService.getChangelog(botId, { limit: 20 });

      // Build productions section with content samples for first 5
      const productionParts: string[] = [];
      for (let i = 0; i < changelog.length; i++) {
        const entry = changelog[i];
        let line = `- [${entry.timestamp}] ${entry.action} ${entry.path}`;
        if (entry.description) line += ` — ${entry.description}`;
        if (entry.evaluation) {
          line += ` (${entry.evaluation.status}`;
          if (entry.evaluation.rating) line += `, ${entry.evaluation.rating}/5`;
          if (entry.evaluation.feedback) line += `: "${truncate(entry.evaluation.feedback, 100)}"`;
          line += ')';
        }
        productionParts.push(line);

        if (i < 5) {
          const content = productionsService.getFileContent(botId, entry.id);
          if (content) {
            productionParts.push(`  Content preview:\n  ${truncate(content, 2000).split('\n').join('\n  ')}`);
          }
        }
      }

      // Soul context
      const identity = soulLoader.readIdentity();
      const goals = soulLoader.readGoals();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const sinceDate = sevenDaysAgo.toISOString().slice(0, 10);
      const recentMemory = soulLoader.readDailyLogsSince(sinceDate);

      // Build prompt
      const sections: string[] = [];
      sections.push(`# Bot: ${botConfig.name ?? botId} (${botId})`);

      if (identity) {
        sections.push(`## Identity\n${truncate(identity, 500)}`);
      }
      if (goals) {
        sections.push(`## Goals\n${truncate(goals, 2000)}`);
      }
      if (recentMemory) {
        sections.push(`## Recent Memory (last 7 days)\n${truncate(recentMemory, 4000)}`);
      }

      sections.push(`## Productions Stats\nTotal: ${stats.total} | Approved: ${stats.approved} | Rejected: ${stats.rejected} | Unreviewed: ${stats.unreviewed} | Avg Rating: ${stats.avgRating ?? 'N/A'}`);

      if (productionParts.length > 0) {
        sections.push(`## Recent Productions (last 20)\n${truncate(productionParts.join('\n'), 15000)}`);
      }

      sections.push(`## Task\n\nSummarize what this bot is currently working on. Identify themes, projects, and patterns in its outputs. Note quality trends if rating data exists. Be specific and concise.`);

      const prompt = sections.join('\n\n');

      const claudePath = config.improve?.claudePath ?? 'claude';
      const timeout = config.improve?.timeout ?? 120_000;

      const summary = await claudeGenerate(prompt, {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        claudePath,
        timeout,
        maxLength: 6000,
        logger,
      });

      logger.info({ botId }, 'Generated productions summary via Claude CLI');
      return c.json({ summary });
    } catch (err) {
      logger.error({ err, botId }, 'Failed to generate productions summary');
      const message = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: `Failed to generate summary: ${message}` }, 500);
    }
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
