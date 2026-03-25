import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import { describeToolCall } from '../../bot/inline-approval';
import type { BotConfig, Config } from '../../config';
import type { ConversationsService } from '../../conversations/service';
import type { Logger } from '../../logger';
import type { ChatMessage } from '../../ollama';
import type { ProductionsService } from '../../productions/service';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';
import type { ApprovalRequest, DocumentRef } from '../../types/thread';
import { webGenerate } from './web-tool-helpers';

const ALLOWED_DOC_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
]);

const MAX_DOC_CONTENT_CHARS = 50_000;
const MAX_DOCS = 4;

async function extractDocumentText(doc: {
  name: string;
  mimeType: string;
  content: string;
}): Promise<string> {
  if (doc.mimeType === 'application/pdf') {
    // content is base64-encoded PDF
    const buffer = Buffer.from(doc.content, 'base64');
    // @ts-ignore -- pdf-parse has no type declarations
    const pdfParse = (await import('pdf-parse')).default;
    const data = (await pdfParse(buffer)) as { text: string };
    return data.text;
  }
  // For text-based types, content is already text
  return doc.content;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n... [truncated]`;
}

const WEB_DASHBOARD_OVERLAY = `\n\nYou are chatting with your human operator through the web dashboard. This is a direct conversation about yourself — your goals, motivations, work, and behavior.
- Be authentic and reflective.
- Be concise (2-4 sentences per reply unless more detail is requested).
- No markdown headers, no preamble, no sign-off.`;

const PRODUCTIONS_OVERLAY =
  '\n\nThis conversation is about your production work (files you created or edited). Reference specific productions when relevant. Be reflective about the quality and purpose of your work.';

const INBOX_OVERLAY = `\n\nThis is a follow-up discussion about a question you asked through your inbox. Reference the original question and the operator's answer when relevant. Be appreciative that the human took the time to respond.`;

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

  /** Build the type-specific overlay appended to the unified system prompt. */
  function getConversationOverlay(conversationType: string, botId: string): string {
    let overlay =
      conversationType === 'productions'
        ? PRODUCTIONS_OVERLAY
        : conversationType === 'inbox'
          ? INBOX_OVERLAY
          : WEB_DASHBOARD_OVERLAY;

    if (conversationType === 'productions' && productionsService) {
      const stats = productionsService.getStats(botId);
      const recent = productionsService.getChangelog(botId, { limit: 10 });
      overlay += `\n\n## Productions Stats\nTotal: ${stats.total} | Approved: ${stats.approved} | Rejected: ${stats.rejected} | Unreviewed: ${stats.unreviewed} | Avg Rating: ${stats.avgRating ?? 'N/A'}`;
      if (recent.length > 0) {
        const lines = recent.map((e) => {
          let line = `- [${e.timestamp}] ${e.action} ${e.path}`;
          if (e.description) line += ` — ${e.description}`;
          return line;
        });
        overlay += `\n\n## Recent Productions\n${lines.join('\n')}`;
      }
    }

    return overlay;
  }

  /** Extracted bot reply generation logic — shared by message send and retry. */
  function generateBotReply(
    botId: string,
    id: string,
    conversation: { type: string; title: string }
  ) {
    const key = `${botId}:${id}`;
    generationState.set(key, { status: 'generating' });
    const startMs = Date.now();
    const botConfig = config.bots.find((b) => b.id === botId);
    const botName = botConfig?.name ?? botId;

    logger.info(
      { botId, botName, conversationId: id, type: conversation.type },
      'Web conversation: generating reply…'
    );

    (async () => {
      try {
        const soulLoader = botManager.getSoulLoader(botId);
        const recentMessages = conversationsService.getMessages(botId, id, { limit: 20 });

        // Extract latest user message for RAG query
        const latestHuman = [...recentMessages].reverse().find((m) => m.role === 'human');
        const ragQuery = latestHuman?.content ?? '';

        // Pre-fetch RAG context (same as Telegram ConversationPipeline)
        const ragContext =
          ragQuery.length >= 8 ? await botManager.prefetchMemoryContext(ragQuery, botId) : null;

        // Build unified system prompt (soul, memory, core mem, tools, karma, humanizer, RAG)
        let systemPrompt = botManager.buildSystemPrompt({
          mode: 'conversation',
          botId,
          botConfig: botConfig as BotConfig,
          isGroup: false,
          ragContext,
          permissionMode: 'conversation',
        });

        // Append conversation-type overlay
        systemPrompt += getConversationOverlay(conversation.type, botId);

        // Build multi-turn message array (same format as Telegram pipeline)
        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          ...recentMessages.map((m) => ({
            role: (m.role === 'human' ? 'user' : 'assistant') as ChatMessage['role'],
            content: m.content,
            ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
          })),
        ];

        logger.info(
          {
            botId,
            botName,
            conversationId: id,
            systemPromptLen: systemPrompt.length,
            messageCount: recentMessages.length,
            hasRag: !!ragContext,
          },
          'Web conversation: calling LLM…'
        );

        const inlineApprovalStore = botManager.getInlineApprovalStore();
        const sessionKey = `web:${botId}:${id}`;

        const response = await webGenerate({
          prompt: '',
          systemPrompt: '',
          botId,
          botManager,
          config,
          logger,
          maxLength: 3000,
          messages,
          permissionMode: 'conversation',
          inlineApprovalStore,
          sessionKey,
        });

        // Check if the LLM triggered a confirm-level tool (pending approval)
        const pending = inlineApprovalStore.getPending(sessionKey);
        if (pending) {
          const approval: ApprovalRequest = {
            toolName: pending.toolName,
            description: describeToolCall(pending.toolName, pending.args),
            status: 'pending',
            args: pending.args,
          };
          conversationsService.addMessage(
            botId,
            id,
            'bot',
            response,
            undefined,
            undefined,
            undefined,
            approval
          );
        } else {
          conversationsService.addMessage(botId, id, 'bot', response);
        }

        // Write to daily memory
        soulLoader.appendDailyMemory(
          `## Web Conversation\n- Type: ${conversation.type}\n- Topic: "${conversation.title}"\n- My response: "${truncate(response, 200)}"`
        );

        const durationMs = Date.now() - startMs;
        logger.info(
          { botId, botName, conversationId: id, durationMs, responseLen: response.length },
          'Web conversation: reply generated'
        );
        generationState.delete(key);
      } catch (err) {
        const durationMs = Date.now() - startMs;
        logger.error(
          { err, botId, botName, conversationId: id, durationMs },
          'Web conversation: failed to generate reply'
        );
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
    const body = await c.req.json<{
      message?: string;
      images?: string[];
      documents?: { name: string; mimeType: string; content: string }[];
    }>();

    if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: 'Missing "message" string in body' }, 400);
    }

    // Validate images if provided
    const images: string[] | undefined =
      Array.isArray(body.images) && body.images.length > 0
        ? body.images
            .filter((img): img is string => typeof img === 'string' && img.length > 0)
            .slice(0, 4)
        : undefined;

    // Validate and process documents if provided
    let documentsMeta: DocumentRef[] | undefined;
    let docTextPrefix = '';
    if (Array.isArray(body.documents) && body.documents.length > 0) {
      const docs = body.documents.slice(0, MAX_DOCS);
      // Validate MIME types and content size
      for (const doc of docs) {
        if (!ALLOWED_DOC_MIME_TYPES.has(doc.mimeType)) {
          return c.json(
            {
              error: `Unsupported document type: ${doc.mimeType}. Allowed: ${[...ALLOWED_DOC_MIME_TYPES].join(', ')}`,
            },
            400
          );
        }
        if (typeof doc.content !== 'string' || doc.content.length > MAX_DOC_CONTENT_CHARS) {
          return c.json(
            {
              error: `Document "${doc.name}" content exceeds ${MAX_DOC_CONTENT_CHARS} character limit`,
            },
            400
          );
        }
      }

      documentsMeta = [];
      const textParts: string[] = [];
      for (const doc of docs) {
        try {
          const text = await extractDocumentText(doc);
          const truncated =
            text.length > MAX_DOC_CONTENT_CHARS
              ? `${text.slice(0, MAX_DOC_CONTENT_CHARS)}\n... [truncated]`
              : text;
          textParts.push(`Content of "${doc.name}":\n\n${truncated}`);
          documentsMeta.push({
            name: doc.name,
            mimeType: doc.mimeType,
            size:
              doc.mimeType === 'application/pdf'
                ? Math.ceil(doc.content.length * 0.75) // approximate decoded size from base64
                : doc.content.length,
          });
        } catch (err) {
          logger.warn({ err, docName: doc.name }, 'Failed to extract document text');
          return c.json({ error: `Failed to process document "${doc.name}"` }, 400);
        }
      }
      if (textParts.length > 0) {
        docTextPrefix = `${textParts.join('\n\n---\n\n')}\n\n---\n\n`;
      }
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

    // Prepend document text to the user message for LLM consumption
    const fullMessage = docTextPrefix + body.message.trim();

    // If this is a pending inbox conversation with an ask_human question, resolve it
    let inboxResolved = false;
    let message: ReturnType<typeof conversationsService.addMessage> | undefined;

    if (
      conversation.type === 'inbox' &&
      conversation.inboxStatus === 'pending' &&
      conversation.askHumanQuestionId
    ) {
      const answered = botManager.answerAskHuman(conversation.askHumanQuestionId, fullMessage);
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
      message = conversationsService.addMessage(
        botId,
        id,
        'human',
        fullMessage,
        undefined,
        images,
        documentsMeta
      );
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

  // Approve or deny a pending tool confirmation
  app.post('/:botId/:id/approve', async (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.param('id');

    const conversation = conversationsService.getConversation(botId, id);
    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const body = await c.req.json<{ action: 'approve' | 'deny'; messageId?: string }>();
    if (body.action !== 'approve' && body.action !== 'deny') {
      return c.json({ error: 'Invalid action, must be "approve" or "deny"' }, 400);
    }

    const sessionKey = `web:${botId}:${id}`;
    const store = botManager.getInlineApprovalStore();
    let pending = store.consumePending(sessionKey);

    // Fallback: if in-memory/disk store lost the entry, recover from persisted message
    if (!pending && body.messageId) {
      const messages = conversationsService.getMessages(botId, id);
      const msg = messages?.find((m) => m.id === body.messageId);
      if (msg?.approval?.status === 'pending' && msg.approval.toolName && msg.approval.args) {
        pending = {
          toolName: msg.approval.toolName,
          args: msg.approval.args,
          createdAt: Date.now(),
          botId,
          sessionKey,
        };
      }
    }

    if (!pending) {
      return c.json({ error: 'No pending approval' }, 404);
    }

    // Update the approval status on the original message
    if (body.messageId) {
      conversationsService.updateApprovalStatus(
        botId,
        id,
        body.messageId,
        body.action === 'approve' ? 'approved' : 'denied'
      );
    }

    if (body.action === 'approve') {
      try {
        const toolRegistry = botManager.getToolRegistry();
        const executor = toolRegistry.createExecutor(0, botId);
        const result = await executor(pending.toolName, pending.args);
        const resultText = result.content ?? JSON.stringify(result);
        conversationsService.addMessage(
          botId,
          id,
          'bot',
          `Tool \`${pending.toolName}\` executed:\n${resultText}`
        );

        // Continue the conversation with the tool result so the bot can respond naturally
        generateBotReply(botId, id, conversation);

        return c.json({ status: 'approved', result: resultText });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        conversationsService.addMessage(
          botId,
          id,
          'bot',
          `Tool \`${pending.toolName}\` failed: ${errMsg}`
        );
        return c.json({ status: 'error', error: errMsg }, 500);
      }
    } else {
      conversationsService.addMessage(
        botId,
        id,
        'bot',
        `Tool \`${pending.toolName}\` was denied by the user.`
      );
      return c.json({ status: 'denied' });
    }
  });

  return app;
}
