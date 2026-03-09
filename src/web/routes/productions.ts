import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';
import { localDateStr } from '../../date-utils';
import type { Logger } from '../../logger';
import type { ProductionsService } from '../../productions/service';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';
import { webGenerate } from './web-tool-helpers';

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n... [truncated]`;
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

const COHERENCE_SYSTEM_PROMPT = `You are a content quality analyst. Your job is to evaluate whether a piece of AI-generated content is coherent and well-formed.

Check for:
- Logical flow and structure
- Completeness (no unfinished sections, missing content, or placeholder text)
- Language quality (grammar, clarity, readability)
- Internal consistency (no contradictions, no abrupt topic shifts)
- Broken formatting (heading-only outlines with no real content, excessive boilerplate)

Respond ONLY with valid JSON (no markdown, no code fences):
{"coherent": true/false, "issues": ["short issue description", ...], "explanation": "2-3 sentence human-readable explanation of the main problems found, or why the content is good"}

If the content is coherent, return {"coherent": true, "issues": [], "explanation": "...brief positive note..."}.
If incoherent, be specific about what's wrong.`;

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
  const generationState = new Map<string, { status: 'generating' | 'error'; error?: string }>();

  /** Extracted evaluate response generation — shared by evaluate and retry. */
  function generateEvaluateResponse(
    botId: string,
    id: string,
    updated: { path: string; action: string; description: string },
    feedback: { status: string; rating?: number; feedback: string }
  ) {
    const key = `${botId}:${id}`;
    generationState.set(key, { status: 'generating' });

    (async () => {
      try {
        const soulLoaderForResponse = botManager.findSoulLoader(botId);
        const identity = soulLoaderForResponse?.readIdentity();
        const goals = soulLoaderForResponse?.readGoals();

        const sections: string[] = [];
        sections.push('# Production Feedback Response');
        sections.push(
          `## Production\n- Path: ${updated.path}\n- Action: ${updated.action}\n- Description: ${updated.description}`
        );

        const content = productionsService.getFileContent(botId, id);
        if (content) {
          sections.push(`## Content Preview\n${truncate(content, 3000)}`);
        }

        sections.push(
          `## Evaluation\n- Status: ${feedback.status}\n- Rating: ${feedback.rating ?? 'N/A'}/5\n- Feedback: "${feedback.feedback}"`
        );

        if (identity) sections.push(`## Bot Identity\n${truncate(identity, 500)}`);
        if (goals) sections.push(`## Bot Goals\n${truncate(goals, 1000)}`);

        sections.push(
          '## Task\n\nRespond to this feedback. Acknowledge what the human said, explain what you understand from it, and describe what you will improve.'
        );

        const prompt = sections.join('\n\n');

        const response = await webGenerate({
          prompt,
          systemPrompt: RESPONSE_SYSTEM_PROMPT,
          botId,
          botManager,
          config,
          logger,
          maxLength: 2000,
        });

        productionsService.setAiResponse(botId, id, response);

        // Also write response to bot memory
        if (soulLoaderForResponse) {
          soulLoaderForResponse.appendDailyMemory(
            `## AI Response to Production Feedback\n- File: ${updated.path}\n- My response: "${truncate(response, 200)}"`
          );
        }

        logger.info({ botId, id }, 'AI response generated for production feedback');
        generationState.delete(key);
      } catch (err) {
        logger.error({ err, botId, id }, 'Failed to generate AI response for production feedback');
        const message = err instanceof Error ? err.message : 'Unknown error';
        generationState.set(key, {
          status: 'error',
          error: `Failed to generate response: ${message}`,
        });
      }
    })();
  }

  /** Extracted thread reply generation — shared by thread send and retry. */
  function generateThreadReply(
    botId: string,
    id: string,
    entry: { path: string; action: string; description: string }
  ) {
    const key = `${botId}:${id}:thread`;
    generationState.set(key, { status: 'generating' });

    (async () => {
      try {
        const soulLoader = botManager.findSoulLoader(botId);
        const identity = soulLoader?.readIdentity();
        const goals = soulLoader?.readGoals();

        // Reload entry to get full thread
        const current = productionsService.getEntry(botId, id);
        const thread = current?.evaluation?.thread ?? [];

        const sections: string[] = [];
        sections.push('# Production Discussion Thread');
        sections.push(
          `## Production\n- Path: ${entry.path}\n- Action: ${entry.action}\n- Description: ${entry.description}`
        );

        if (identity) sections.push(`## Bot Identity\n${truncate(identity, 500)}`);
        if (goals) sections.push(`## Bot Goals\n${truncate(goals, 1000)}`);

        // Format thread (last 10 messages)
        const recent = thread.slice(-10);
        const threadText = recent
          .map((m) => `${m.role === 'human' ? 'Human' : 'Bot'}: ${m.content}`)
          .join('\n\n');
        sections.push(`## Conversation Thread\n${threadText}`);
        sections.push(
          '## Task\n\nRespond to the latest message in this thread. Be specific and concise.'
        );

        const prompt = sections.join('\n\n');

        const response = await webGenerate({
          prompt,
          systemPrompt: THREAD_SYSTEM_PROMPT,
          botId,
          botManager,
          config,
          logger,
          maxLength: 2000,
        });

        productionsService.addThreadMessage(botId, id, 'bot', response);

        // Write to bot memory
        if (soulLoader) {
          soulLoader.appendDailyMemory(
            `## Production Thread Reply\n- File: ${entry.path}\n- My response: "${truncate(response, 200)}"`
          );
        }

        logger.info({ botId, id }, 'Thread bot reply generated for production');
        generationState.delete(key);
      } catch (err) {
        logger.error({ err, botId, id }, 'Failed to generate thread reply for production');
        const message = err instanceof Error ? err.message : 'Unknown error';
        generationState.set(key, {
          status: 'error',
          error: `Failed to generate reply: ${message}`,
        });
      }
    })();
  }

  const coherenceResults = new Map<
    string,
    { coherent: boolean; issues: string[]; explanation?: string }
  >();

  /** Extracted coherence check generation — LLM-based evaluation. */
  function generateCoherenceCheck(
    botId: string,
    id: string,
    entry: { path: string; action: string; description: string }
  ) {
    const key = `${botId}:${id}:coherence`;
    generationState.set(key, { status: 'generating' });

    (async () => {
      try {
        const content = productionsService.getFileContent(botId, id);
        if (!content || content.trim().length === 0) {
          const result = { coherent: false, issues: ['File is empty or not found'] };
          coherenceResults.set(`${botId}:${id}`, result);
          generationState.delete(key);
          return;
        }

        const soulLoader = botManager.findSoulLoader(botId);
        const identity = soulLoader?.readIdentity();
        const goals = soulLoader?.readGoals();

        const sections: string[] = [];
        sections.push('# Content Coherence Check');
        sections.push(
          `## File Metadata\n- Path: ${entry.path}\n- Action: ${entry.action}\n- Description: ${entry.description}`
        );
        sections.push(`## Content\n${truncate(content, 5000)}`);
        if (identity)
          sections.push(`## Bot Identity (for language matching)\n${truncate(identity, 300)}`);
        if (goals) sections.push(`## Bot Goals (context)\n${truncate(goals, 500)}`);
        sections.push(
          '## Task\n\nEvaluate whether this content is coherent and well-formed. Respond with JSON only.'
        );

        const prompt = sections.join('\n\n');

        const raw = await webGenerate({
          prompt,
          systemPrompt: COHERENCE_SYSTEM_PROMPT,
          botId,
          botManager,
          config,
          logger,
          maxLength: 2000,
          enableTools: false,
        });

        // Parse JSON response from LLM
        let parsed: { coherent: boolean; issues: string[]; explanation?: string };
        try {
          // Strip markdown code fences if present
          const cleaned = raw
            .replace(/^```(?:json)?\s*\n?/i, '')
            .replace(/\n?```\s*$/i, '')
            .trim();
          parsed = JSON.parse(cleaned);
        } catch {
          // Fallback: treat unparseable response as coherent (don't block on LLM format issues)
          logger.warn(
            { botId, id, raw: raw.slice(0, 200) },
            'Could not parse coherence LLM response as JSON'
          );
          parsed = { coherent: true, issues: [], explanation: 'Could not parse LLM response' };
        }

        const result = {
          coherent: !!parsed.coherent,
          issues: Array.isArray(parsed.issues) ? parsed.issues : [],
          explanation: typeof parsed.explanation === 'string' ? parsed.explanation : undefined,
        };
        coherenceResults.set(`${botId}:${id}`, result);
        productionsService.setCoherenceCheck(botId, id, result);

        // Auto-post explanation to discussion thread
        if (result.explanation) {
          const prefix = result.coherent ? 'Coherence Check (OK)' : 'Coherence Check';
          const current = productionsService.getEntry(botId, id);
          const thread = current?.evaluation?.thread ?? [];
          const alreadyPosted = thread.some(
            (m) => m.role === 'bot' && m.content.startsWith('Coherence Check')
          );
          if (!alreadyPosted) {
            productionsService.addThreadMessage(
              botId,
              id,
              'bot',
              `${prefix}: ${result.explanation}`
            );
          }
        }

        logger.info({ botId, id, coherent: result.coherent }, 'LLM coherence check completed');
        generationState.delete(key);
      } catch (err) {
        logger.error({ err, botId, id }, 'Failed to generate LLM coherence check');
        const message = err instanceof Error ? err.message : 'Unknown error';
        generationState.set(key, {
          status: 'error',
          error: `Failed to check coherence: ${message}`,
        });
      }
    })();
  }

  /** Check if botId is accessible to the requesting tenant */
  function checkBotAccess(c: import('hono').Context, botId: string): boolean {
    const bot = config.bots.find((b) => b.id === botId);
    return !bot || isBotAccessible(bot, getTenantId(c));
  }

  // List all bots with production stats
  app.get('/', (c) => {
    const tenantId = getTenantId(c);
    const allowedIds = new Set(scopeBots(config.bots, tenantId).map((b) => b.id));
    const stats = productionsService.getAllBotStats();
    // biome-ignore lint/suspicious/noExplicitAny: stats entries have dynamic shape from service
    return c.json(tenantId ? stats.filter((s: any) => allowedIds.has(s.botId)) : stats);
  });

  // Directory trees for all bots (file explorer at productions level)
  // NOTE: must be registered before GET /:botId to avoid Hono trie router conflicts
  app.get('/all-trees', (c) => {
    const tenantId = getTenantId(c);
    const tree = productionsService.getAllDirectoryTrees();
    if (tenantId) {
      const allowedIds = new Set(scopeBots(config.bots, tenantId).map((b) => b.id));
      return c.json({ tree: tree.filter((node) => allowedIds.has(node.path)) });
    }
    return c.json({ tree });
  });

  // Unified entries across all bots
  // NOTE: must be registered before GET /:botId to avoid Hono trie router conflicts
  app.get('/all-entries', (c) => {
    const tenantId = getTenantId(c);
    const limit = Number(c.req.query('limit')) || 100;
    const offset = Number(c.req.query('offset')) || 0;
    const status = c.req.query('status') || undefined;
    const botId = c.req.query('botId') || undefined;

    // If tenant requests a specific botId, validate access
    if (botId && tenantId && !checkBotAccess(c, botId)) {
      return c.json({ entries: [], total: 0 });
    }

    const result = productionsService.getAllEntries({ limit, offset, status, botId });
    if (tenantId && !botId) {
      // Filter entries to tenant's bots
      const allowedIds = new Set(scopeBots(config.bots, tenantId).map((b) => b.id));
      // biome-ignore lint/suspicious/noExplicitAny: entries have dynamic shape from service
      result.entries = result.entries.filter((e: any) => allowedIds.has(e.botId));
      result.total = result.entries.length;
    }
    return c.json(result);
  });

  // Summary status polling endpoint
  // NOTE: must be registered before GET /:botId to avoid Hono trie router conflicts
  app.get('/:botId/summary-status', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
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
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
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
        const soulLoader = botManager.findSoulLoader(botId);
        const stats = productionsService.getStats(botId);
        const changelog = productionsService.getChangelog(botId, { limit: 20 });

        // Build productions section with content samples for first 5
        const productionParts: string[] = [];
        for (let i = 0; i < changelog.length; i++) {
          const entry = changelog[i];
          let line = `- [${entry.timestamp}] ${entry.action} ${entry.path}`;
          if (entry.description) line += ` — ${entry.description}`;
          if (entry.evaluation) {
            line += ` (${entry.evaluation.status ?? 'unknown'}`;
            if (entry.evaluation.rating) line += `, ${entry.evaluation.rating}/5`;
            if (entry.evaluation.feedback)
              line += `: "${truncate(entry.evaluation.feedback, 100)}"`;
            line += ')';
          }
          productionParts.push(line);

          if (i < 5) {
            const content = productionsService.getFileContent(botId, entry.id);
            if (content) {
              productionParts.push(
                `  Content preview:\n  ${truncate(content, 2000).split('\n').join('\n  ')}`
              );
            }
          }
        }

        // Soul context
        const identity = soulLoader?.readIdentity();
        const goals = soulLoader?.readGoals();
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const sinceDate = localDateStr(sevenDaysAgo);
        const recentMemory = soulLoader?.readDailyLogsSince(sinceDate);

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

        sections.push(
          `## Productions Stats\nTotal: ${stats.total} | Approved: ${stats.approved} | Rejected: ${stats.rejected} | Unreviewed: ${stats.unreviewed} | Avg Rating: ${stats.avgRating ?? 'N/A'}`
        );

        if (productionParts.length > 0) {
          sections.push(
            `## Recent Productions (last 20)\n${truncate(productionParts.join('\n'), 15000)}`
          );
        }

        sections.push(
          '## Task\n\nSummarize what this bot is currently working on. Identify themes, projects, and patterns in its outputs. Note quality trends if rating data exists. Be specific and concise.'
        );

        const prompt = sections.join('\n\n');

        const summary = await webGenerate({
          prompt,
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          botId,
          botManager,
          config,
          logger,
          maxLength: 6000,
          enableTools: false,
        });

        // Generate strategic plan section
        let plan: string | undefined;
        try {
          const planPrompt = `${sections.slice(0, -1).join('\n\n')}\n\n## Task\n\nAnalyze the strategy and plan behind this bot's productions. What themes connect the files? What is the bot building toward? What gaps exist? What should it focus on next? Be specific — cite file names and content when relevant.`;
          const planSystemPrompt = `You are a strategic analyst reviewing an AI bot's body of work. Identify the overarching strategy, recurring themes, gaps in coverage, and recommend next priorities. Write in the bot's language. Keep output under 500 words. No markdown headers, no preamble, no sign-off.`;
          plan = await webGenerate({
            prompt: planPrompt,
            systemPrompt: planSystemPrompt,
            botId,
            botManager,
            config,
            logger,
            maxLength: 3000,
            enableTools: false,
          });
        } catch (planErr) {
          logger.warn({ err: planErr, botId }, 'Failed to generate plan section (non-fatal)');
        }

        productionsService.writeSummary(botId, {
          summary,
          plan,
          generatedAt: new Date().toISOString(),
        });
        productionsService.rebuildIndex(botId);
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
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');

    const entry = productionsService.getEntry(botId, id);
    if (!entry) {
      return c.json({ error: 'Production not found' }, 404);
    }

    const key = `${botId}:${id}`;
    const state = generationState.get(key);
    if (state?.status === 'generating') {
      return c.json({ status: 'generating' });
    }
    if (state?.status === 'error') {
      return c.json({ status: 'error', error: state.error });
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

  // Directory tree for file explorer UI
  // NOTE: must be registered before GET /:botId/:id to avoid Hono trie router conflicts
  app.get('/:botId/tree', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const botConfig = config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    const tree = productionsService.getDirectoryTree(botId);
    return c.json({ tree });
  });

  // Read file content by relative path
  // NOTE: must be registered before GET /:botId/:id to avoid Hono trie router conflicts
  app.get('/:botId/file-content', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const path = c.req.query('path');
    if (!path) {
      return c.json({ error: 'Missing "path" query parameter' }, 400);
    }

    const botConfig = config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    const result = productionsService.getFileContentByPath(botId, path);
    if (!result) {
      return c.json({ error: 'File not found or access denied' }, 404);
    }

    return c.json(result);
  });

  // List productions for a bot (paginated)
  app.get('/:botId', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const limit = Number(c.req.query('limit')) || 50;
    const offset = Number(c.req.query('offset')) || 0;
    const status = c.req.query('status') || undefined;
    const since = c.req.query('since') || undefined;

    const entries = productionsService.getChangelog(botId, { limit, offset, status, since });
    const stats = productionsService.getStats(botId);

    return c.json({ entries, stats });
  });

  // Archive a production file
  // NOTE: must be registered before GET /:botId/:id to avoid Hono trie router conflicts
  app.post('/:botId/:id/archive', async (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>();

    const entry = productionsService.getEntry(botId, id);
    if (!entry) {
      return c.json({ error: 'Production not found' }, 404);
    }

    const reason = body.reason?.trim() || 'Archived from dashboard';
    const ok = productionsService.archiveFile(botId, entry.path, reason);
    if (!ok) {
      return c.json({ error: 'Failed to archive file' }, 500);
    }

    logger.info({ botId, id, path: entry.path, reason }, 'Production archived via web');
    return c.json({ ok: true });
  });

  // Check coherence of a production file (LLM-based, async)
  // NOTE: must be registered before GET /:botId/:id to avoid Hono trie router conflicts
  app.get('/:botId/:id/coherence', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');

    const entry = productionsService.getEntry(botId, id);
    if (!entry) {
      return c.json({ error: 'Production not found' }, 404);
    }

    // Check cached result (in-memory)
    const cacheKey = `${botId}:${id}`;
    const cached = coherenceResults.get(cacheKey);
    if (cached) {
      return c.json(cached);
    }

    // Check persisted result (survives restarts)
    if (entry.coherenceCheck) {
      const persisted = {
        coherent: entry.coherenceCheck.coherent,
        issues: entry.coherenceCheck.issues,
        explanation: entry.coherenceCheck.explanation,
      };
      coherenceResults.set(cacheKey, persisted); // warm the cache
      return c.json(persisted);
    }

    // Check generation state
    const genKey = `${botId}:${id}:coherence`;
    const state = generationState.get(genKey);
    if (state?.status === 'generating') {
      return c.json({ status: 'checking' });
    }
    if (state?.status === 'error') {
      return c.json({ status: 'error', error: state.error });
    }

    // Fire-and-forget LLM coherence check
    generateCoherenceCheck(botId, id, entry);
    return c.json({ status: 'checking' });
  });

  // Get single production with file content
  app.get('/:botId/:id', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
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
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
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
    const soulLoaders = (botManager as Record<string, unknown>).soulLoaders as
      | Map<string, unknown>
      | undefined;
    const soulLoader = soulLoaders?.get(botId);

    const karmaService = botManager.getKarmaService();
    const activityStream = botManager.getActivityStream();
    const updated = productionsService.evaluate(
      botId,
      id,
      body,
      soulLoader,
      karmaService,
      activityStream
    );
    if (!updated) {
      return c.json({ error: 'Production not found' }, 404);
    }

    logger.info({ botId, id, status: body.status }, 'Production evaluated via web');

    // Fire-and-forget AI response generation when feedback text is present
    if (body.feedback?.trim()) {
      const key = `${botId}:${id}`;
      const state = generationState.get(key);
      if (state?.status !== 'generating') {
        generateEvaluateResponse(botId, id, updated, {
          status: body.status,
          rating: body.rating,
          feedback: body.feedback,
        });
      }
    }

    return c.json({ entry: updated });
  });

  // Thread: add human message + trigger AI reply
  app.post('/:botId/:id/thread', async (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');
    const body = await c.req.json<{ message?: string }>();

    if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: 'Missing "message" string in body' }, 400);
    }

    const entry = productionsService.getEntry(botId, id);
    if (!entry) {
      return c.json({ error: 'Production not found' }, 404);
    }

    const key = `${botId}:${id}:thread`;
    const state = generationState.get(key);
    if (state?.status === 'generating') {
      return c.json({ error: 'Already generating a response' }, 409);
    }

    const result = productionsService.addThreadMessage(botId, id, 'human', body.message.trim());
    if (!result) {
      return c.json({ error: 'Failed to add message' }, 500);
    }

    // Clear any previous error state and fire-and-forget AI response
    generationState.delete(key);
    generateThreadReply(botId, id, entry);

    return c.json({ message: result.message, entry: result.entry });
  });

  // Thread: poll for bot reply generation status
  app.get('/:botId/:id/thread-status', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');

    const entry = productionsService.getEntry(botId, id);
    if (!entry) {
      return c.json({ error: 'Production not found' }, 404);
    }

    const key = `${botId}:${id}:thread`;
    const state = generationState.get(key);
    if (state?.status === 'generating') {
      return c.json({ status: 'generating' });
    }
    if (state?.status === 'error') {
      return c.json({ status: 'error', error: state.error });
    }

    const thread = entry.evaluation?.thread ?? [];
    const lastBot = [...thread].reverse().find((m) => m.role === 'bot');
    return c.json({ status: 'idle', lastBotMessage: lastBot ?? null });
  });

  // Retry failed response generation (evaluation feedback response)
  app.post('/:botId/:id/retry-response', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');

    const entry = productionsService.getEntry(botId, id);
    if (!entry) {
      return c.json({ error: 'Production not found' }, 404);
    }

    const key = `${botId}:${id}`;
    const state = generationState.get(key);
    if (state?.status === 'generating') {
      return c.json({ error: 'Already generating a response' }, 409);
    }

    if (!entry.evaluation?.feedback) {
      return c.json({ error: 'No feedback to respond to' }, 400);
    }

    generateEvaluateResponse(botId, id, entry, {
      status: entry.evaluation.status ?? 'approved',
      rating: entry.evaluation.rating,
      feedback: entry.evaluation.feedback,
    });
    return c.json({ status: 'generating' });
  });

  // Retry failed thread reply generation
  app.post('/:botId/:id/retry-thread', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');

    const entry = productionsService.getEntry(botId, id);
    if (!entry) {
      return c.json({ error: 'Production not found' }, 404);
    }

    const key = `${botId}:${id}:thread`;
    const state = generationState.get(key);
    if (state?.status === 'generating') {
      return c.json({ error: 'Already generating a response' }, 409);
    }

    generateThreadReply(botId, id, entry);
    return c.json({ status: 'generating' });
  });

  // Update file content
  app.put('/:botId/:id/content', async (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
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
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
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
