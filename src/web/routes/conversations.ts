import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';
import type { ConversationsService } from '../../conversations/service';
import type { Logger } from '../../logger';
import type { ProductionsService } from '../../productions/service';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';
import { webGenerate } from './web-tool-helpers';

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n... [truncated]`;
}

const CONVERSATION_SYSTEM_PROMPT = `You are an AI bot having a direct conversation with your human operator through the web dashboard. This is a meta-conversation about yourself — your goals, motivations, work, and behavior.

Rules:
- Be authentic and reflective about your goals and work.
- Be concise (2-4 sentences per reply unless more detail is requested).
- No markdown headers, no preamble, no sign-off.
- Write in the same language as your identity/soul files.
- Be specific about your current work, goals, and motivations when asked.`;

const PRODUCTIONS_CHAT_SYSTEM_PROMPT = `You are an AI bot discussing your production work (files you created or edited) with your human operator through the web dashboard.

Rules:
- Reference specific productions (file names, content) when relevant.
- Be concise (2-4 sentences per reply unless more detail is requested).
- No markdown headers, no preamble, no sign-off.
- Write in the same language as your identity/soul files.
- Be reflective about the quality and purpose of your work.`;

const INBOX_CHAT_SYSTEM_PROMPT = `You are an AI bot having a follow-up discussion with your human operator about a question you asked through your inbox.

Rules:
- Be concise (2-4 sentences per reply unless more detail is requested).
- No markdown headers, no preamble, no sign-off.
- Write in the same language as your identity/soul files.
- Reference the original question and the operator's answer when relevant.
- Be appreciative that the human took the time to respond.`;

export function conversationsRoutes(deps: {
  conversationsService: ConversationsService;
  botManager: BotManager;
  logger: Logger;
  config: Config;
  productionsService?: ProductionsService;
}) {
  const app = new Hono();
  const { conversationsService, botManager, logger, config, productionsService } = deps;

  const generationState = new Map<string, { status: 'generating' | 'error'; error?: string }>();

  /** Extracted bot reply generation logic — shared by message send and retry. */
  function generateBotReply(
    botId: string,
    id: string,
    conversation: { type: string; title: string }
  ) {
    const key = `${botId}:${id}`;
    generationState.set(key, { status: 'generating' });

    (async () => {
      try {
        const soulLoader = botManager.getSoulLoader(botId);
        const identity = soulLoader.readIdentity();
        const soul = soulLoader.readSoul();
        const motivations = soulLoader.readMotivations();
        const goals = soulLoader.readGoals();

        const recentMessages = conversationsService.getMessages(botId, id, { limit: 20 });

        const sections: string[] = [];
        const botConfig = config.bots.find((b) => b.id === botId);
        sections.push(`# Conversation with operator — Bot: ${botConfig?.name ?? botId}`);

        if (identity) sections.push(`## Identity\n${truncate(identity, 500)}`);
        if (soul) sections.push(`## Soul\n${truncate(soul, 1000)}`);
        if (motivations) sections.push(`## Motivations\n${truncate(motivations, 1000)}`);
        if (goals) sections.push(`## Goals\n${truncate(goals, 1000)}`);

        // For productions type, include production context
        if (conversation.type === 'productions' && productionsService) {
          const stats = productionsService.getStats(botId);
          const recent = productionsService.getChangelog(botId, { limit: 10 });
          sections.push(
            `## Productions Stats\nTotal: ${stats.total} | Approved: ${stats.approved} | Rejected: ${stats.rejected} | Unreviewed: ${stats.unreviewed} | Avg Rating: ${stats.avgRating ?? 'N/A'}`
          );
          if (recent.length > 0) {
            const lines = recent.map((e) => {
              let line = `- [${e.timestamp}] ${e.action} ${e.path}`;
              if (e.description) line += ` — ${e.description}`;
              return line;
            });
            sections.push(`## Recent Productions\n${lines.join('\n')}`);
          }
        }

        // Format conversation thread
        const threadText = recentMessages
          .map((m) => `${m.role === 'human' ? 'Human' : 'Bot'}: ${m.content}`)
          .join('\n\n');
        sections.push(`## Conversation\n${threadText}`);
        sections.push('## Task\n\nRespond to the latest message. Be authentic and reflective.');

        const prompt = sections.join('\n\n');
        const systemPrompt =
          conversation.type === 'productions'
            ? PRODUCTIONS_CHAT_SYSTEM_PROMPT
            : conversation.type === 'inbox'
              ? INBOX_CHAT_SYSTEM_PROMPT
              : CONVERSATION_SYSTEM_PROMPT;

        const response = await webGenerate({
          prompt,
          systemPrompt,
          botId,
          botManager,
          config,
          logger,
          maxLength: 3000,
        });

        conversationsService.addMessage(botId, id, 'bot', response);

        // Write to daily memory
        soulLoader.appendDailyMemory(
          `## Web Conversation\n- Type: ${conversation.type}\n- Topic: "${conversation.title}"\n- My response: "${truncate(response, 200)}"`
        );

        logger.info({ botId, conversationId: id }, 'Conversation bot reply generated');
        generationState.delete(key);
      } catch (err) {
        logger.error({ err, botId, conversationId: id }, 'Failed to generate conversation reply');
        const message = err instanceof Error ? err.message : 'Unknown error';
        generationState.set(key, {
          status: 'error',
          error: `Failed to generate reply: ${message}`,
        });
      }
    })();
  }

  /** Check if botId is accessible to the requesting tenant */
  function checkBotAccess(c: import('hono').Context, botId: string): boolean {
    const bot = config.bots.find((b) => b.id === botId);
    return !bot || isBotAccessible(bot, getTenantId(c));
  }

  // List bots with conversation counts
  app.get('/', (c) => {
    const tenantId = getTenantId(c);
    const allowedBots = scopeBots(config.bots, tenantId);
    const allowedIds = new Set(allowedBots.map((b) => b.id));

    const botIds = conversationsService.getBotIds().filter((id) => allowedIds.has(id));
    const result = botIds.map((botId) => {
      const convos = conversationsService.listConversations(botId);
      const botConfig = allowedBots.find((b) => b.id === botId);
      return {
        botId,
        name: botConfig?.name ?? botId,
        conversationCount: convos.length,
      };
    });

    // Also include bots with no conversations yet
    for (const bot of allowedBots) {
      if (!result.find((r) => r.botId === bot.id)) {
        result.push({ botId: bot.id, name: bot.name, conversationCount: 0 });
      }
    }

    return c.json(result);
  });

  // List conversations for a bot
  app.get('/:botId', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const type = c.req.query('type') || undefined;
    const limit = Number(c.req.query('limit')) || 50;
    const offset = Number(c.req.query('offset')) || 0;

    const conversations = conversationsService.listConversations(botId, { type, limit, offset });
    return c.json(conversations);
  });

  // Create conversation
  app.post('/:botId', async (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const body = await c.req
      .json<{ type?: 'general' | 'productions' | 'inbox'; title?: string }>()
      .catch(() => ({}) as { type?: string; title?: string });

    const validTypes: readonly string[] = ['general', 'productions', 'inbox'];
    const type = (body.type && validTypes.includes(body.type) ? body.type : 'general') as
      | 'general'
      | 'productions'
      | 'inbox';
    const convo = conversationsService.createConversation(botId, type, body.title);
    return c.json(convo, 201);
  });

  // Get conversation + messages
  // NOTE: must be registered after fixed-segment routes to avoid collision
  app.get('/:botId/:id', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');

    const conversation = conversationsService.getConversation(botId, id);
    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const messages = conversationsService.getMessages(botId, id);
    return c.json({ conversation, messages });
  });

  // Delete all conversations across all bots
  app.delete('/', (c) => {
    const tenantId = getTenantId(c);
    if (tenantId) {
      // In multi-tenant mode, only delete conversations for tenant's bots
      const allowedBots = scopeBots(config.bots, tenantId);
      let deleted = 0;
      for (const bot of allowedBots) {
        deleted += conversationsService.deleteAllForBot(bot.id);
      }
      return c.json({ ok: true, deleted });
    }
    const deleted = conversationsService.deleteAll();
    return c.json({ ok: true, deleted });
  });

  // Delete all conversations for a specific bot
  app.delete('/:botId', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const deleted = conversationsService.deleteAllForBot(botId);
    return c.json({ ok: true, deleted });
  });

  // Delete conversation
  app.delete('/:botId/:id', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');

    const ok = conversationsService.deleteConversation(botId, id);
    if (!ok) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    return c.json({ ok: true });
  });

  // Send human message + fire-and-forget bot reply
  app.post('/:botId/:id/messages', async (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');
    const body = await c.req.json<{ message?: string }>();

    if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: 'Missing "message" string in body' }, 400);
    }

    const conversation = conversationsService.getConversation(botId, id);
    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const key = `${botId}:${id}`;
    const state = generationState.get(key);
    if (state?.status === 'generating') {
      return c.json({ error: 'Already generating a response' }, 409);
    }

    // If this is a pending inbox conversation with an ask_human question, resolve it
    let inboxResolved = false;
    let message: ReturnType<typeof conversationsService.addMessage> | undefined;

    if (
      conversation.type === 'inbox' &&
      conversation.inboxStatus === 'pending' &&
      conversation.askHumanQuestionId
    ) {
      const answered = botManager.answerAskHuman(
        conversation.askHumanQuestionId,
        body.message.trim()
      );
      if (answered) {
        // answerAskHuman already wrote the human message and marked as answered
        // Retrieve the written message to return to frontend
        const messages = conversationsService.getMessages(botId, id);
        const lastHuman = [...messages].reverse().find((m) => m.role === 'human');
        message = lastHuman;
        inboxResolved = true;
        // Don't return — fall through to bot reply generation
      }
      // If the question already expired, fall through to normal chat
    }

    if (!inboxResolved) {
      message = conversationsService.addMessage(botId, id, 'human', body.message.trim());
      if (!message) {
        return c.json({ error: 'Failed to add message' }, 500);
      }
    }

    // Clear any previous error state and fire-and-forget bot reply
    generationState.delete(key);
    generateBotReply(botId, id, conversation);

    return c.json({ message, inboxResolved: inboxResolved || undefined });
  });

  // Poll for bot reply status
  app.get('/:botId/:id/status', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');

    const conversation = conversationsService.getConversation(botId, id);
    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const key = `${botId}:${id}`;
    const state = generationState.get(key);
    if (state?.status === 'generating') {
      return c.json({ status: 'generating' });
    }
    if (state?.status === 'error') {
      return c.json({ status: 'error', error: state.error });
    }

    const messages = conversationsService.getMessages(botId, id);
    const lastBot = [...messages].reverse().find((m) => m.role === 'bot');
    return c.json({ status: 'idle', lastBotMessage: lastBot ?? null });
  });

  // Retry failed bot reply generation
  app.post('/:botId/:id/retry', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');

    const conversation = conversationsService.getConversation(botId, id);
    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const key = `${botId}:${id}`;
    const state = generationState.get(key);
    if (state?.status === 'generating') {
      return c.json({ error: 'Already generating a response' }, 409);
    }

    generateBotReply(botId, id, conversation);
    return c.json({ status: 'generating' });
  });

  return app;
}
