import type { Context } from 'grammy';
import type { BotConfig } from '../config';
import { resolveAgentConfig } from '../config';
import type { Logger } from '../logger';
import type { ChatMessage } from '../ollama';
import type { BotContext } from './types';
import type { MemoryFlusher } from './memory-flush';
import type { SystemPromptBuilder } from './system-prompt-builder';
import type { ToolRegistry } from './tool-registry';

export class ConversationPipeline {
  constructor(
    private ctx: BotContext,
    private systemPromptBuilder: SystemPromptBuilder,
    private memoryFlusher: MemoryFlusher,
    private toolRegistry: ToolRegistry,
  ) {}

  /**
   * Pre-fetch relevant memory context via RAG for injection into the system prompt.
   * Runs in parallel with other setup to minimize latency.
   */
  async prefetchMemoryContext(
    userText: string,
    isGroup: boolean,
    botLogger: Logger
  ): Promise<string | null> {
    const ragConfig = this.ctx.config.soul.search?.autoRag;
    if (!ragConfig?.enabled || !this.ctx.searchEnabled || !this.ctx.memoryManager) {
      return null;
    }

    try {
      // Strip [Name]: prefix in group messages
      let query = isGroup ? userText.replace(/^\[.*?\]:\s*/, '') : userText;
      query = query.trim();

      // Skip very short queries (greetings like "hola", "ok", "jaja")
      if (query.length < 8) {
        return null;
      }

      const results = await this.ctx.memoryManager.search(
        query,
        ragConfig.maxResults,
        ragConfig.minScore
      );

      if (results.length === 0) {
        return null;
      }

      // Filter out today/yesterday daily logs (already in system prompt via readRecentDailyLogs)
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
      const recentDailyPattern = new RegExp(`memory/(${today}|${yesterday})\\.md$`);

      const filtered = results.filter((r) =>
        !recentDailyPattern.test(r.filePath) && r.sourceType !== 'session'
      );
      if (filtered.length === 0) {
        return null;
      }

      // Build context string, capping at maxContentChars
      let totalChars = 0;
      const snippets: string[] = [];
      for (const r of filtered) {
        const snippet = r.content.trim();
        if (totalChars + snippet.length > ragConfig.maxContentChars) {
          const remaining = ragConfig.maxContentChars - totalChars;
          if (remaining >= 100) {
            snippets.push(`[${r.filePath} | score: ${r.score.toFixed(2)}]\n${snippet.slice(0, remaining)}…`);
          }
          break;
        }
        snippets.push(`[${r.filePath} | score: ${r.score.toFixed(2)}]\n${snippet}`);
        totalChars += snippet.length;
      }

      if (snippets.length === 0) {
        return null;
      }

      const previews = snippets.map((s) => s.substring(0, 120).replace(/\n/g, ' '));
      botLogger.info(
        {
          query: query.substring(0, 80),
          resultsFound: results.length,
          injected: snippets.length,
          totalChars,
          previews,
        },
        '🔍 RAG pre-fetch injected'
      );

      return '## Relevant Memory Context\n\n' +
        'The following was retrieved from your long-term memory for this conversation.\n' +
        'USE this information to answer — it takes precedence over daily log entries.\n\n' +
        snippets.join('\n\n');
    } catch (err) {
      botLogger.warn({ err }, 'RAG pre-fetch failed (non-fatal)');
      return null;
    }
  }

  /**
   * Core conversation pipeline shared by text and media handlers.
   * Handles session expiry, history, system prompt, Ollama chat, and persistence.
   */
  async handleConversation(
    ctx: Context,
    config: BotConfig,
    serializedKey: string,
    userText: string,
    images?: string[],
    sessionText?: string
  ): Promise<void> {
    const resolved = resolveAgentConfig(this.ctx.config, config);
    const sessionConfig = this.ctx.config.session;
    const webToolsConfig = this.ctx.config.webTools;
    const hasTools = this.ctx.tools.length > 0;
    const chatId = ctx.chat!.id;
    const isGroup = ctx.chat!.type === 'group' || ctx.chat!.type === 'supergroup';
    const botLogger = this.ctx.getBotLogger(config.id);

    const senderName = isGroup ? (ctx.from?.first_name ?? 'Unknown') : undefined;
    botLogger.info(
      {
        chatId,
        sessionKey: serializedKey,
        isGroup,
        sender: senderName ?? ctx.from?.first_name,
        userId: ctx.from?.id,
        textPreview: userText.substring(0, 120),
        hasImages: !!(images && images.length > 0),
      },
      '🔄 handleConversation start'
    );

    // Start RAG pre-fetch early for parallelism
    const ragPromise = this.prefetchMemoryContext(userText, isGroup, botLogger);

    try {
      // Memory flush on session expiry
      if (sessionConfig.enabled && this.ctx.sessionManager.isExpired(serializedKey)) {
        botLogger.info({ key: serializedKey }, 'Session expired, flushing to memory');
        if (this.ctx.config.soul.enabled) {
          const expiredHistory = this.ctx.sessionManager.getFullHistory(serializedKey);
          if (expiredHistory.length > 0) {
            await this.memoryFlusher.flushSessionToMemory(expiredHistory, config.id);
          }
        }
        this.ctx.sessionManager.clearSession(serializedKey);
      }

      // Proactive memory flush (fire-and-forget)
      const flushConfig = this.ctx.config.soul.memoryFlush;
      if (sessionConfig.enabled && flushConfig?.enabled) {
        const meta = this.ctx.sessionManager.getSessionMeta(serializedKey);
        if (meta && meta.messageCount >= flushConfig.messageThreshold
            && meta.lastFlushCompactionIndex !== (meta.compactionCount ?? 0)) {
          botLogger.info({ key: serializedKey, msgs: meta.messageCount }, 'Proactive memory flush');
          const recentHistory = this.ctx.sessionManager.getFullHistory(serializedKey);
          this.ctx.sessionManager.markMemoryFlushed(serializedKey);
          this.memoryFlusher.flushToDaily(recentHistory, config.id).catch((err) => {
            botLogger.warn({ err }, 'Proactive memory flush failed');
          });
        }
      }

      // Get history
      const history = sessionConfig.enabled
        ? this.ctx.sessionManager.getHistory(serializedKey, resolved.maxHistory)
        : [];

      // Await RAG pre-fetch
      const ragContext = await ragPromise;

      // Build system prompt via unified builder
      const systemPrompt = this.systemPromptBuilder.build({
        mode: 'conversation',
        botId: config.id,
        botConfig: config,
        isGroup,
        ragContext,
      });

      // In groups, prefix messages with sender name
      const prefixedText = senderName ? `[${senderName}]: ${userText}` : userText;

      // Build messages
      const userMessage: ChatMessage = { role: 'user', content: prefixedText };
      if (images && images.length > 0) {
        userMessage.images = images;
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        userMessage,
      ];

      // Typing indicator
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(async () => {
        try {
          await ctx.replyWithChatAction('typing');
        } catch {
          // Ignore errors from typing indicator
        }
      }, 4000);

      try {
        const activeModel = this.ctx.getActiveModel(config.id);
        botLogger.info(
          {
            chatId,
            model: activeModel,
            historyLength: history.length,
            toolCount: hasTools ? this.ctx.toolDefinitions.length : 0,
            promptToLLM: prefixedText.substring(0, 200),
          },
          '🤖 Sending to LLM'
        );

        const response = await this.ctx.ollamaClient.chat(messages, {
          model: activeModel,
          temperature: resolved.temperature,
          tools: hasTools ? this.ctx.toolDefinitions : undefined,
          toolExecutor: hasTools ? this.toolRegistry.createExecutor(chatId, config.id) : undefined,
          maxToolRounds: webToolsConfig?.maxToolRounds,
        });

        botLogger.info(
          {
            chatId,
            responseLength: response.length,
            responsePreview: response.substring(0, 200),
          },
          '📤 LLM response received'
        );

        // Persist messages to session
        if (sessionConfig.enabled) {
          const persistText = sessionText ?? userText;
          const prefixedPersist = senderName ? `[${senderName}]: ${persistText}` : persistText;
          this.ctx.sessionManager.appendMessages(
            serializedKey,
            [
              { role: 'user', content: prefixedPersist },
              { role: 'assistant', content: response },
            ],
            resolved.maxHistory
          );
        }

        if (response.trim()) {
          await ctx.reply(response);
        } else {
          botLogger.debug({ chatId }, 'LLM returned empty response, sending ack');
          await ctx.reply('✅');
        }

        botLogger.info(
          {
            chatId,
            userId: ctx.from?.id,
            firstName: ctx.from?.first_name,
            sessionKey: serializedKey,
            isGroup,
          },
          '✅ Reply sent to Telegram'
        );

        // Keep the reply window open for this user in groups
        if (isGroup && ctx.from?.id) {
          this.ctx.sessionManager.markActive(config.id, chatId, ctx.from.id);
          botLogger.debug({ chatId, userId: ctx.from.id }, 'Reply window refreshed');
        }
      } finally {
        clearInterval(typingInterval);
      }
    } catch (error) {
      botLogger.error({ error, chatId }, 'Conversation handler failed');
      await ctx.reply('❌ Failed to generate response. Please try again later.');
    }
  }
}
