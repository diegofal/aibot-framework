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

interface GenerateFeedbackContext {
  identity: string | null;
  soul: string | null;
  motivations: string | null;
  goals: string | null;
  recentMemory: string;
  productionsStats: { total: number; approved: number; rejected: number; unreviewed: number; avgRating: number | null } | null;
  productionsSummary: string;
  feedbackHistory: string;
  botId: string;
  botName: string;
}

function buildGenerateFeedbackPrompt(ctx: GenerateFeedbackContext): string {
  const sections: string[] = [];

  sections.push(`# Bot Under Review: ${ctx.botName} (${ctx.botId})\n`);

  if (ctx.identity) {
    sections.push(`## Identity\n${truncate(ctx.identity, 500)}`);
  }
  if (ctx.soul) {
    sections.push(`## Soul\n${truncate(ctx.soul, 4000)}`);
  }
  if (ctx.motivations) {
    sections.push(`## Motivations\n${truncate(ctx.motivations, 3000)}`);
  }
  if (ctx.goals) {
    sections.push(`## Goals\n${truncate(ctx.goals, 2000)}`);
  }
  if (ctx.recentMemory) {
    sections.push(`## Recent Memory (last 7 days)\n${truncate(ctx.recentMemory, 5000)}`);
  }
  if (ctx.productionsStats) {
    const s = ctx.productionsStats;
    sections.push(`## Productions Stats\nTotal: ${s.total} | Approved: ${s.approved} | Rejected: ${s.rejected} | Unreviewed: ${s.unreviewed} | Avg Rating: ${s.avgRating ?? 'N/A'}`);
  }
  if (ctx.productionsSummary) {
    sections.push(`## Recent Productions\n${truncate(ctx.productionsSummary, 15000)}`);
  }
  if (ctx.feedbackHistory) {
    sections.push(`## Previous Feedback History\n${truncate(ctx.feedbackHistory, 3000)}`);
  }

  sections.push(`## Task

Analyze this bot's overall performance and produce harsh, actionable feedback. Structure your analysis around:

1. **Production quality** — Are the outputs useful, original, and well-crafted? Or templated garbage? Cite specific files if available.
2. **Soul coherence** — Does the identity align with the soul and motivations? Any contradictions or drift?
3. **Goal progress** — Is the bot advancing toward its goals or spinning in circles?
4. **Memory hygiene** — Is the memory useful and organized, or cluttered noise?
5. **Behavioral patterns** — Is the bot doing productive work or busywork?

Close with 3-5 concrete imperative directives (e.g., "Stop doing X", "Focus on Y", "Rewrite Z").

Write your feedback in the bot's primary language (match the language used in its soul/identity files). Be specific and cite evidence. No pleasantries.`);

  return sections.join('\n\n');
}

const THREAD_SYSTEM_PROMPT = `You are an AI bot in a conversation thread discussing your work or behavior with a human reviewer.
Rules: Be concise (2-4 sentences), no markdown headers, match the bot's language, respond to the latest message in context of the full thread, be specific.`;

const GENERATE_SYSTEM_PROMPT = `You are a ruthless quality auditor for AI bot agents. Your job is to analyze a bot's configuration, outputs, and behavior, then produce blunt, specific, actionable feedback.

Rules:
- Be harsh but fair. Cite specific evidence (file names, memory entries, production outputs).
- No filler, no praise unless genuinely earned.
- Write in the bot's primary language (match whatever language its soul/identity files use).
- Output ONLY the feedback text — no markdown headers, no preamble, no sign-off.
- Keep it under 2000 words.`;

export function agentFeedbackRoutes(deps: {
  config: Config;
  botManager: BotManager;
  logger: Logger;
  productionsService?: ProductionsService;
}) {
  const app = new Hono();

  // List bots with pending feedback counts
  app.get('/', (c) => {
    const botIds = deps.botManager.getAgentFeedbackBotIds();
    const bots = botIds.map((botId) => {
      const botConfig = deps.config.bots.find((b) => b.id === botId);
      const all = deps.botManager.getAgentFeedback(botId);
      const pending = all.filter((e) => e.status === 'pending').length;
      const applied = all.filter((e) => e.status === 'applied').length;
      const dismissed = all.filter((e) => e.status === 'dismissed').length;
      return {
        botId,
        name: botConfig?.name ?? botId,
        total: all.length,
        pending,
        applied,
        dismissed,
      };
    });
    return c.json(bots);
  });

  // Total pending count for badge polling
  app.get('/count', (c) => {
    return c.json({ count: deps.botManager.getAgentFeedbackPendingCount() });
  });

  // Generate feedback via Claude CLI analysis
  app.post('/:botId/generate', async (c) => {
    const botId = c.req.param('botId');
    const botConfig = deps.config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    try {
      const soulLoader = deps.botManager.getSoulLoader(botId);

      // Gather soul context
      const identity = soulLoader.readIdentity();
      const soul = soulLoader.readSoul();
      const motivations = soulLoader.readMotivations();
      const goals = soulLoader.readGoals();

      // Recent memory (7 days)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const sinceDate = localDateStr(sevenDaysAgo);
      const recentMemory = soulLoader.readDailyLogsSince(sinceDate);

      // Productions
      let productionsStats = null;
      let productionsSummary = '';
      if (deps.productionsService) {
        productionsStats = deps.productionsService.getStats(botId);
        const changelog = deps.productionsService.getChangelog(botId, { limit: 15 });
        if (changelog.length > 0) {
          const summaryParts: string[] = [];
          for (const entry of changelog) {
            let line = `- [${entry.timestamp}] ${entry.action} ${entry.path}`;
            if (entry.description) line += ` — ${entry.description}`;
            if (entry.evaluation) {
              line += ` (${entry.evaluation.status}`;
              if (entry.evaluation.rating) line += `, ${entry.evaluation.rating}/5`;
              if (entry.evaluation.feedback) line += `: "${truncate(entry.evaluation.feedback, 100)}"`;
              line += ')';
            }
            summaryParts.push(line);

            // Sample content for first 3 entries
            if (summaryParts.length <= 3) {
              const content = deps.productionsService!.getFileContent(botId, entry.id);
              if (content) {
                summaryParts.push(`  Content preview:\n  ${truncate(content, 1500).split('\n').join('\n  ')}`);
              }
            }
          }
          productionsSummary = summaryParts.join('\n');
        }
      }

      // Feedback history
      const feedbackEntries = deps.botManager.getAgentFeedback(botId, { limit: 20 });
      let feedbackHistory = '';
      if (feedbackEntries.length > 0) {
        feedbackHistory = feedbackEntries.map((e) => {
          let line = `- [${e.status}] ${truncate(e.content, 200)}`;
          if (e.response) line += `\n  Bot response: ${truncate(e.response, 150)}`;
          return line;
        }).join('\n');
      }

      const prompt = buildGenerateFeedbackPrompt({
        identity,
        soul,
        motivations,
        goals,
        recentMemory,
        productionsStats,
        productionsSummary,
        feedbackHistory,
        botId,
        botName: botConfig.name ?? botId,
      });

      const claudePath = deps.config.improve?.claudePath ?? 'claude';
      const timeout = deps.config.improve?.timeout ?? 120_000;

      const feedback = await claudeGenerate(prompt, {
        systemPrompt: GENERATE_SYSTEM_PROMPT,
        claudePath,
        timeout,
        maxLength: 8000,
        logger: deps.logger,
      });

      deps.logger.info({ botId }, 'Generated feedback via Claude CLI');
      return c.json({ feedback });
    } catch (err) {
      deps.logger.error({ err, botId }, 'Failed to generate feedback');
      const message = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: `Failed to generate feedback: ${message}` }, 500);
    }
  });

  // List feedback history for a bot
  app.get('/:botId', (c) => {
    const botId = c.req.param('botId');
    const status = c.req.query('status');
    const limit = parseInt(c.req.query('limit') ?? '100', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    const entries = deps.botManager.getAgentFeedback(botId, {
      status: status || undefined,
      limit,
      offset,
    });

    return c.json({ entries });
  });

  // Submit new feedback
  app.post('/:botId', async (c) => {
    const botId = c.req.param('botId');
    const body = await c.req.json<{ content?: string }>();

    if (!body.content || typeof body.content !== 'string' || !body.content.trim()) {
      return c.json({ error: 'Missing "content" string in body' }, 400);
    }

    const entry = deps.botManager.submitAgentFeedback(botId, body.content.trim());
    deps.logger.info({ botId, id: entry.id }, 'Agent feedback submitted via web');
    return c.json(entry, 201);
  });

  const generationState = new Map<string, { status: 'generating' | 'error'; error?: string }>();

  /** Extracted reply generation logic — shared by reply send and retry. */
  function generateFeedbackReply(botId: string, id: string, entry: { content: string }) {
    const key = `${botId}:${id}`;
    generationState.set(key, { status: 'generating' });

    (async () => {
      try {
        const soulLoader = deps.botManager.getSoulLoader(botId);
        const identity = soulLoader.readIdentity();
        const goals = soulLoader.readGoals();

        // Build thread from legacy fields + thread array
        const current = deps.botManager.getAgentFeedbackById(botId, id);
        const thread = current?.thread ?? [];

        const sections: string[] = [];
        sections.push(`# Agent Feedback Discussion Thread`);
        sections.push(`## Original Feedback\n${current?.content ?? entry.content}`);

        if (identity) sections.push(`## Bot Identity\n${truncate(identity, 500)}`);
        if (goals) sections.push(`## Bot Goals\n${truncate(goals, 1000)}`);

        // Legacy response as context
        if (current?.response) {
          sections.push(`## Initial Bot Response\n${current.response}`);
        }

        // Format thread (last 10 messages)
        const recent = thread.slice(-10);
        if (recent.length > 0) {
          const threadText = recent.map((m) => `${m.role === 'human' ? 'Human' : 'Bot'}: ${m.content}`).join('\n\n');
          sections.push(`## Conversation Thread\n${threadText}`);
        }

        sections.push(`## Task\n\nRespond to the latest message in this thread. Be specific and concise.`);

        const prompt = sections.join('\n\n');
        const claudePath = deps.config.improve?.claudePath ?? 'claude';
        const timeout = deps.config.improve?.timeout ?? 120_000;

        const response = await claudeGenerate(prompt, {
          systemPrompt: THREAD_SYSTEM_PROMPT,
          claudePath,
          timeout,
          maxLength: 2000,
          logger: deps.logger,
        });

        deps.botManager.addAgentFeedbackThreadMessage(botId, id, 'bot', response);

        // Write to bot memory
        if (soulLoader) {
          soulLoader.appendDailyMemory(
            `## Feedback Thread Reply\n- Original feedback: "${truncate(entry.content, 100)}"\n- My response: "${truncate(response, 200)}"`,
          );
        }

        deps.logger.info({ botId, id }, 'Thread bot reply generated for agent feedback');
        generationState.delete(key);
      } catch (err) {
        deps.logger.error({ err, botId, id }, 'Failed to generate thread reply for agent feedback');
        const message = err instanceof Error ? err.message : 'Unknown error';
        generationState.set(key, { status: 'error', error: `Failed to generate reply: ${message}` });
      }
    })();
  }

  // Thread reply: add human message + trigger AI response
  app.post('/:botId/:id/reply', async (c) => {
    const botId = c.req.param('botId');
    const id = c.req.param('id');
    const body = await c.req.json<{ message?: string }>();

    if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: 'Missing "message" string in body' }, 400);
    }

    const entry = deps.botManager.getAgentFeedbackById(botId, id);
    if (!entry) {
      return c.json({ error: 'Feedback not found' }, 404);
    }

    const key = `${botId}:${id}`;
    const state = generationState.get(key);
    if (state?.status === 'generating') {
      return c.json({ error: 'Already generating a reply' }, 409);
    }

    const msg = deps.botManager.addAgentFeedbackThreadMessage(botId, id, 'human', body.message.trim());
    if (!msg) {
      return c.json({ error: 'Failed to add message' }, 500);
    }

    // Reload entry to return updated state
    const updated = deps.botManager.getAgentFeedbackById(botId, id);

    // Clear any previous error state and fire-and-forget AI response
    generationState.delete(key);
    generateFeedbackReply(botId, id, entry);

    return c.json({ message: msg, entry: updated });
  });

  // Thread reply: poll for bot reply generation status
  app.get('/:botId/:id/reply-status', (c) => {
    const botId = c.req.param('botId');
    const id = c.req.param('id');

    const entry = deps.botManager.getAgentFeedbackById(botId, id);
    if (!entry) {
      return c.json({ error: 'Feedback not found' }, 404);
    }

    const key = `${botId}:${id}`;
    const state = generationState.get(key);
    if (state?.status === 'generating') {
      return c.json({ status: 'generating' });
    }
    if (state?.status === 'error') {
      return c.json({ status: 'error', error: state.error });
    }

    const thread = entry.thread ?? [];
    const lastBot = [...thread].reverse().find((m) => m.role === 'bot');
    return c.json({ status: 'idle', lastBotMessage: lastBot ?? null });
  });

  // Retry failed reply generation
  app.post('/:botId/:id/retry-reply', (c) => {
    const botId = c.req.param('botId');
    const id = c.req.param('id');

    const entry = deps.botManager.getAgentFeedbackById(botId, id);
    if (!entry) {
      return c.json({ error: 'Feedback not found' }, 404);
    }

    const key = `${botId}:${id}`;
    const state = generationState.get(key);
    if (state?.status === 'generating') {
      return c.json({ error: 'Already generating a reply' }, 409);
    }

    generateFeedbackReply(botId, id, entry);
    return c.json({ status: 'generating' });
  });

  // Dismiss feedback
  app.delete('/:botId/:id', (c) => {
    const botId = c.req.param('botId');
    const id = c.req.param('id');

    const ok = deps.botManager.dismissAgentFeedback(botId, id);
    if (!ok) {
      return c.json({ error: 'Feedback not found or not pending' }, 404);
    }

    deps.logger.info({ botId, id }, 'Agent feedback dismissed via web');
    return c.json({ ok: true });
  });

  return app;
}
