import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';
import { localDateStr } from '../../date-utils';
import type { Logger } from '../../logger';
import type { ProductionsService } from '../../productions/service';
import { claudeGenerate } from '../../claude-cli';

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n... [truncated]';
}

const RESPONSE_SYSTEM_PROMPT = `You are an AI bot responding to human feedback on one of your productions (a file you created or edited). Your job is to acknowledge the feedback, explain what you understood from it, and describe what you will change or improve going forward.

Rules:
- Be concise (2-4 sentences).
- No markdown headers, no preamble, no sign-off.
- Write in the same language as the bot's identity/soul files.
- Be specific about what you'll improve based on the feedback.
- If the feedback is positive, briefly acknowledge and mention how you'll maintain quality.
- If the feedback is negative, acknowledge the issue and describe concrete improvements.`;

const THREAD_SYSTEM_PROMPT = `You are an AI bot in a conversation thread discussing your work or behavior with a human reviewer.
Rules: Be concise (2-4 sentences), no markdown headers, match the bot's language, respond to the latest message in context of the full thread, be specific.`;

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

  const generatingBots = new Set<string>();
  const generatingResponses = new Set<string>();

  // List all bots with production stats
  app.get('/', (c) => {
    const stats = productionsService.getAllBotStats();
    return c.json(stats);
  });

  // Unified entries across all bots
  // NOTE: must be registered before GET /:botId to avoid Hono trie router conflicts
  app.get('/all-entries', (c) => {
    const limit = Number(c.req.query('limit')) || 100;
    const offset = Number(c.req.query('offset')) || 0;
    const status = c.req.query('status') || undefined;
    const botId = c.req.query('botId') || undefined;

    const result = productionsService.getAllEntries({ limit, offset, status, botId });
    return c.json(result);
  });

  // Summary status polling endpoint
  // NOTE: must be registered before GET /:botId to avoid Hono trie router conflicts
  app.get('/:botId/summary-status', (c) => {
    const botId = c.req.param('botId');
    const botConfig = config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    if (generatingBots.has(botId)) {
      return c.json({ status: 'generating' });
    }

    const data = productionsService.readSummary(botId);
    if (data?.summary) {
      return c.json({ status: 'done', summary: data.summary, generatedAt: data.generatedAt });
    }
    if (data?.error) {
      return c.json({ status: 'error', error: data.error, generatedAt: data.generatedAt });
    }

    return c.json({ status: 'idle' });
  });

  // Fire-and-forget summary generation
  app.post('/:botId/generate-summary', (c) => {
    const botId = c.req.param('botId');
    const botConfig = config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    if (generatingBots.has(botId)) {
      return c.json({ status: 'generating' });
    }

    generatingBots.add(botId);

    (async () => {
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
        const sinceDate = localDateStr(sevenDaysAgo);
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

        productionsService.writeSummary(botId, {
          summary,
          generatedAt: new Date().toISOString(),
        });
        logger.info({ botId }, 'Generated productions summary via Claude CLI');
      } catch (err) {
        logger.error({ err, botId }, 'Failed to generate productions summary');
        const message = err instanceof Error ? err.message : 'Unknown error';
        productionsService.writeSummary(botId, {
          error: `Failed to generate summary: ${message}`,
          generatedAt: new Date().toISOString(),
        });
      } finally {
        generatingBots.delete(botId);
      }
    })();

    return c.json({ status: 'generating' });
  });

  // Response status polling endpoint
  // NOTE: must be registered before GET /:botId/:id to avoid Hono trie conflicts
  app.get('/:botId/:id/response-status', (c) => {
    const botId = c.req.param('botId');
    const id = c.req.param('id');

    const entry = productionsService.getEntry(botId, id);
    if (!entry) {
      return c.json({ error: 'Production not found' }, 404);
    }

    const key = `${botId}:${id}`;
    if (generatingResponses.has(key)) {
      return c.json({ status: 'generating' });
    }

    if (entry.evaluation?.aiResponse) {
      return c.json({
        status: 'done',
        response: entry.evaluation.aiResponse,
        generatedAt: entry.evaluation.aiResponseAt,
      });
    }

    return c.json({ status: 'idle' });
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

    // Fire-and-forget AI response generation when feedback text is present
    if (body.feedback?.trim()) {
      const key = `${botId}:${id}`;
      if (!generatingResponses.has(key)) {
        generatingResponses.add(key);

        (async () => {
          try {
            const soulLoaderForResponse = botManager.getSoulLoader(botId);
            const identity = soulLoaderForResponse.readIdentity();
            const goals = soulLoaderForResponse.readGoals();

            const sections: string[] = [];
            sections.push(`# Production Feedback Response`);
            sections.push(`## Production\n- Path: ${updated.path}\n- Action: ${updated.action}\n- Description: ${updated.description}`);

            const content = productionsService.getFileContent(botId, id);
            if (content) {
              sections.push(`## Content Preview\n${truncate(content, 3000)}`);
            }

            sections.push(`## Evaluation\n- Status: ${body.status}\n- Rating: ${body.rating ?? 'N/A'}/5\n- Feedback: "${body.feedback}"`);

            if (identity) sections.push(`## Bot Identity\n${truncate(identity, 500)}`);
            if (goals) sections.push(`## Bot Goals\n${truncate(goals, 1000)}`);

            sections.push(`## Task\n\nRespond to this feedback. Acknowledge what the human said, explain what you understand from it, and describe what you will improve.`);

            const prompt = sections.join('\n\n');
            const claudePath = config.improve?.claudePath ?? 'claude';
            const timeout = config.improve?.timeout ?? 120_000;

            const response = await claudeGenerate(prompt, {
              systemPrompt: RESPONSE_SYSTEM_PROMPT,
              claudePath,
              timeout,
              maxLength: 2000,
              logger,
            });

            productionsService.setAiResponse(botId, id, response);

            // Also write response to bot memory
            if (soulLoaderForResponse) {
              soulLoaderForResponse.appendDailyMemory(
                `## AI Response to Production Feedback\n- File: ${updated.path}\n- My response: "${truncate(response, 200)}"`,
              );
            }

            logger.info({ botId, id }, 'AI response generated for production feedback');
          } catch (err) {
            logger.error({ err, botId, id }, 'Failed to generate AI response for production feedback');
          } finally {
            generatingResponses.delete(key);
          }
        })();
      }
    }

    return c.json({ entry: updated });
  });

  // Thread: add human message + trigger AI reply
  app.post('/:botId/:id/thread', async (c) => {
    const botId = c.req.param('botId');
    const id = c.req.param('id');
    const body = await c.req.json<{ message?: string }>();

    if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: 'Missing "message" string in body' }, 400);
    }

    const entry = productionsService.getEntry(botId, id);
    if (!entry) {
      return c.json({ error: 'Production not found' }, 404);
    }

    const key = `${botId}:${id}`;
    if (generatingResponses.has(key)) {
      return c.json({ error: 'Already generating a response' }, 409);
    }

    const result = productionsService.addThreadMessage(botId, id, 'human', body.message.trim());
    if (!result) {
      return c.json({ error: 'Failed to add message' }, 500);
    }

    // Fire-and-forget AI response
    generatingResponses.add(key);
    (async () => {
      try {
        const soulLoader = botManager.getSoulLoader(botId);
        const identity = soulLoader.readIdentity();
        const goals = soulLoader.readGoals();

        // Reload entry to get full thread
        const current = productionsService.getEntry(botId, id);
        const thread = current?.evaluation?.thread ?? [];

        const sections: string[] = [];
        sections.push(`# Production Discussion Thread`);
        sections.push(`## Production\n- Path: ${entry.path}\n- Action: ${entry.action}\n- Description: ${entry.description}`);

        if (identity) sections.push(`## Bot Identity\n${truncate(identity, 500)}`);
        if (goals) sections.push(`## Bot Goals\n${truncate(goals, 1000)}`);

        // Format thread (last 10 messages)
        const recent = thread.slice(-10);
        const threadText = recent.map((m) => `${m.role === 'human' ? 'Human' : 'Bot'}: ${m.content}`).join('\n\n');
        sections.push(`## Conversation Thread\n${threadText}`);
        sections.push(`## Task\n\nRespond to the latest message in this thread. Be specific and concise.`);

        const prompt = sections.join('\n\n');
        const claudePath = config.improve?.claudePath ?? 'claude';
        const timeout = config.improve?.timeout ?? 120_000;

        const response = await claudeGenerate(prompt, {
          systemPrompt: THREAD_SYSTEM_PROMPT,
          claudePath,
          timeout,
          maxLength: 2000,
          logger,
        });

        productionsService.addThreadMessage(botId, id, 'bot', response);

        // Write to bot memory
        if (soulLoader) {
          soulLoader.appendDailyMemory(
            `## Production Thread Reply\n- File: ${entry.path}\n- My response: "${truncate(response, 200)}"`,
          );
        }

        logger.info({ botId, id }, 'Thread bot reply generated for production');
      } catch (err) {
        logger.error({ err, botId, id }, 'Failed to generate thread reply for production');
      } finally {
        generatingResponses.delete(key);
      }
    })();

    return c.json({ message: result.message, entry: result.entry });
  });

  // Thread: poll for bot reply generation status
  app.get('/:botId/:id/thread-status', (c) => {
    const botId = c.req.param('botId');
    const id = c.req.param('id');

    const entry = productionsService.getEntry(botId, id);
    if (!entry) {
      return c.json({ error: 'Production not found' }, 404);
    }

    const key = `${botId}:${id}`;
    if (generatingResponses.has(key)) {
      return c.json({ status: 'generating' });
    }

    const thread = entry.evaluation?.thread ?? [];
    const lastBot = [...thread].reverse().find((m) => m.role === 'bot');
    return c.json({ status: 'idle', lastBotMessage: lastBot ?? null });
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
