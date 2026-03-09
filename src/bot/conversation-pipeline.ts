import { type Context, InputFile } from 'grammy';
import type { Channel, InboundMessage } from '../channel/types';
import type { BotConfig } from '../config';
import { resolveAgentConfig, resolveTtsConfig } from '../config';
import { localDateStr } from '../date-utils';
import type { Logger } from '../logger';
import type { ChatMessage } from '../ollama';
import { generateSpeech } from '../tts';
import { type ContextCompactor, truncateOversizedMessages } from './context-compaction';
import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_CONFIG,
  type LLMErrorInfo,
  executeWithResilience,
  formatLLMErrorForUser,
} from './llm-resilience';
import type { MemoryFlusher } from './memory-flush';
import type { SystemPromptBuilder } from './system-prompt-builder';
import { sendLongMessage } from './telegram-utils';
import type { ToolRegistry } from './tool-registry';
import { TopicGuard, type TopicGuardConfig } from './topic-guard';
import type { BotContext } from './types';

export class ConversationPipeline {
  private circuitBreaker: CircuitBreaker;
  private topicGuard: TopicGuard;

  constructor(
    private ctx: BotContext,
    private systemPromptBuilder: SystemPromptBuilder,
    private memoryFlusher: MemoryFlusher,
    private toolRegistry: ToolRegistry,
    private contextCompactor: ContextCompactor
  ) {
    // Initialize circuit breaker for LLM calls (uses shared defaults from llm-resilience)
    this.circuitBreaker = new CircuitBreaker(DEFAULT_CIRCUIT_CONFIG, ctx.logger);
    this.topicGuard = new TopicGuard(ctx);
  }

  /**
   * Pre-fetch relevant memory context via RAG for injection into the system prompt.
   * Runs in parallel with other setup to minimize latency.
   */
  async prefetchMemoryContext(
    userText: string,
    isGroup: boolean,
    botLogger: Logger,
    botId: string,
    userId?: string
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
        ragConfig.minScore,
        botId,
        userId
      );

      if (results.length === 0) {
        return null;
      }

      // Filter out today/yesterday daily logs (already in system prompt via readRecentDailyLogs)
      const now = new Date();
      const today = localDateStr(now);
      const yesterday = localDateStr(new Date(now.getTime() - 86_400_000));
      const recentDailyPattern = new RegExp(`memory/(${today}|${yesterday})\\.md$`);

      const filtered = results.filter(
        (r) => !recentDailyPattern.test(r.filePath) && r.sourceType !== 'session'
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
            snippets.push(
              `[${r.filePath} | score: ${r.score.toFixed(2)}]\n${snippet.slice(0, remaining)}…`
            );
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
      this.ctx.activityStream?.publish({
        type: 'memory:rag',
        botId: '',
        timestamp: Date.now(),
        data: {
          query: query.substring(0, 80),
          resultsFound: results.length,
          injected: snippets.length,
        },
      });

      return `## Relevant Memory Context\n\nThe following was retrieved from your long-term memory and MAY be relevant.\nUse it as background reference — but do NOT assume you have already discussed\nthese topics with the user unless the current conversation history confirms it.\n\n${snippets.join('\n\n')}`;
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
    sessionText?: string,
    isVoice?: boolean
  ): Promise<void> {
    const resolved = resolveAgentConfig(this.ctx.config, config);
    const sessionConfig = this.ctx.config.session;
    const webToolsConfig = this.ctx.config.webTools;
    const maxToolRounds = config.maxToolRounds ?? webToolsConfig?.maxToolRounds;
    const botToolDefs = this.toolRegistry.getDefinitionsForBot(config.id);
    const hasTools = botToolDefs.length > 0;
    const chatId = ctx.chat?.id;
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
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

    // Resolve userId early (synchronous) so it's available for RAG pre-fetch
    // Auto-enable user isolation for tenant bots (BaaS multi-tenant)
    const userIsolation = config.userIsolation;
    const rawUserId = ctx.from?.id;
    const isolationActive = userIsolation?.enabled || !!config.tenantId;
    const userId = isolationActive && rawUserId ? String(rawUserId) : undefined;

    // Start RAG pre-fetch early for parallelism
    const ragPromise = this.prefetchMemoryContext(userText, isGroup, botLogger, config.id, userId);

    try {
      // Memory flush on session expiry
      if (sessionConfig.enabled && this.ctx.sessionManager.isExpired(serializedKey)) {
        botLogger.info({ key: serializedKey }, 'Session expired, flushing to memory');
        if (this.ctx.config.soul.enabled) {
          const expiredHistory = this.ctx.sessionManager.getFullHistory(serializedKey);
          if (expiredHistory.length > 0) {
            await this.memoryFlusher.flushSessionToMemory(expiredHistory, config.id, userId);
          }
        }
        this.ctx.sessionManager.clearSession(serializedKey);
      }

      // Proactive memory flush (fire-and-forget)
      const flushConfig = this.ctx.config.soul.memoryFlush;
      if (sessionConfig.enabled && flushConfig?.enabled) {
        const meta = this.ctx.sessionManager.getSessionMeta(serializedKey);
        if (
          meta &&
          meta.messageCount >= flushConfig.messageThreshold &&
          meta.lastFlushCompactionIndex !== (meta.compactionCount ?? 0)
        ) {
          botLogger.info(
            { key: serializedKey, msgs: meta.messageCount },
            'Proactive memory flush with scoring'
          );
          const recentHistory = this.ctx.sessionManager.getFullHistory(serializedKey);
          this.ctx.sessionManager.markMemoryFlushed(serializedKey);
          // Use flushWithScoring for importance-weighted Core Memory storage
          this.memoryFlusher.flushWithScoring(recentHistory, config.id, userId).catch((err) => {
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

      // Topic guard pre-filter (merge tenant overlay if present)
      const rawTopicGuard = config.topicGuard as TopicGuardConfig | undefined;
      const topicGuardConfig =
        (this.ctx.customizationService
          ? (this.ctx.customizationService.getTopicGuardOverlay(config.id, rawTopicGuard) as
              | TopicGuardConfig
              | undefined)
          : rawTopicGuard) ?? rawTopicGuard;
      if (topicGuardConfig?.enabled) {
        const guardResult = await this.topicGuard.check(
          userText,
          config.id,
          topicGuardConfig,
          botLogger
        );
        if (!guardResult.allowed) {
          botLogger.info(
            { botId: config.id, chatId, reason: guardResult.reason },
            'Topic guard blocked message'
          );
          const rejectMessage =
            topicGuardConfig.customRejectMessage ||
            "I'm not able to help with that topic. Could you ask me something related to my area of expertise?";
          await sendLongMessage((t: string) => ctx.reply(t), rejectMessage);

          // Record analytics
          if (config.tenantId) {
            this.ctx.analyticsService?.record({
              type: 'topic_guard.blocked' as any,
              tenantId: config.tenantId,
              botId: config.id,
              chatId: String(chatId ?? ''),
              userId: ctx.from?.id ? String(ctx.from.id) : undefined,
              channelKind: 'telegram',
              data: { reason: guardResult.reason },
            });
          }

          return;
        }
      }

      // Resolve tenant root for path sandboxing
      const tenantRoot =
        config.tenantId && this.ctx.config.multiTenant?.enabled
          ? `${this.ctx.config.multiTenant.dataDir ?? './data/tenants'}/${config.tenantId}`
          : undefined;

      // Build system prompt via unified builder
      const systemPrompt = this.systemPromptBuilder.build({
        mode: 'conversation',
        botId: config.id,
        botConfig: config,
        isGroup,
        ragContext,
        userId,
      });

      // In groups, prefix messages with sender name
      const prefixedText = senderName ? `[${senderName}]: ${userText}` : userText;

      // Build messages
      const userMessage: ChatMessage = { role: 'user', content: prefixedText };
      if (images && images.length > 0) {
        userMessage.images = images;
      }

      const rawMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        userMessage,
      ];

      // Truncate oversized individual messages + proactive compaction
      const compactionConfig = this.ctx.config.conversation.compaction;
      const { messages: truncated } = truncateOversizedMessages(
        rawMessages,
        compactionConfig.maxMessageChars
      );

      const compResult = await this.contextCompactor.maybeCompact(
        truncated,
        serializedKey,
        config.id,
        compactionConfig,
        userId
      );
      if (compResult.compacted) {
        botLogger.info(
          {
            botId: config.id,
            messagesBefore: truncated.length,
            messagesAfter: compResult.messages.length,
          },
          'Context compaction applied'
        );
      }
      let currentMessages = compResult.messages;

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
        // Quota check: block if tenant exceeded message quota
        if (config.tenantId && this.ctx.tenantFacade?.isMultiTenant()) {
          const allowed = this.ctx.tenantFacade.checkQuota(config.tenantId, 'messages');
          if (!allowed) {
            botLogger.warn(
              { tenantId: config.tenantId, botId: config.id },
              'Message quota exceeded'
            );
            clearInterval(typingInterval);
            await sendLongMessage(
              ctx,
              'Sorry, the message quota for this service has been exceeded. Please try again later or contact support.',
              undefined,
              botLogger
            );
            return;
          }
        }

        const activeModel = this.ctx.getActiveModel(config.id);
        botLogger.info(
          {
            chatId,
            model: activeModel,
            historyLength: history.length,
            toolCount: hasTools ? botToolDefs.length : 0,
            promptToLLM: prefixedText.substring(0, 200),
            compacted: compResult.compacted,
          },
          '🤖 Sending to LLM'
        );
        const llmBackend = this.ctx.getLLMClient(config.id).backend;
        this.ctx.activityStream?.publish({
          type: 'llm:start',
          botId: config.id,
          timestamp: Date.now(),
          data: {
            model: activeModel,
            historyLength: history.length,
            toolCount: hasTools ? botToolDefs.length : 0,
            backend: llmBackend,
            caller: 'conversation',
          },
        });

        // Execute LLM call with overflow retry loop
        let llmResult = await executeWithResilience(
          () =>
            this.ctx.getLLMClient(config.id).chat(currentMessages, {
              model: activeModel,
              temperature: resolved.temperature,
              tools: hasTools ? botToolDefs : undefined,
              toolExecutor: hasTools
                ? this.toolRegistry.createExecutor(chatId, config.id, userId, tenantRoot)
                : undefined,
              maxToolRounds,
            }),
          'conversation-pipeline.chat',
          {
            retryConfig: {
              maxRetries: 3,
              baseDelayMs: 1000,
              maxDelayMs: 15000,
              backoffMultiplier: 2,
            },
            circuitBreaker: this.circuitBreaker,
            logger: botLogger,
            onRetry: (attempt, delayMs, error) => {
              botLogger.warn(
                { attempt, delayMs, category: error.category },
                'LLM call retry scheduled'
              );
            },
          }
        );

        // Overflow retry: if context_length error, emergency compact and retry
        let overflowRetries = 0;
        while (
          !llmResult.success &&
          llmResult.error?.category === 'context_length' &&
          overflowRetries < compactionConfig.maxOverflowRetries
        ) {
          overflowRetries++;
          botLogger.warn({ attempt: overflowRetries }, 'Context overflow, emergency compaction');

          const emergencyBefore = currentMessages.length;
          const emergency = await this.contextCompactor.maybeCompact(
            currentMessages,
            serializedKey,
            config.id,
            { ...compactionConfig, thresholdRatio: 0.1, keepRecentMessages: 2 },
            userId
          );
          currentMessages = emergency.messages;
          botLogger.info(
            {
              botId: config.id,
              messagesBefore: emergencyBefore,
              messagesAfter: currentMessages.length,
            },
            'Emergency overflow compaction applied'
          );

          llmResult = await executeWithResilience(
            () =>
              this.ctx.getLLMClient(config.id).chat(currentMessages, {
                model: activeModel,
                temperature: resolved.temperature,
                tools: hasTools ? botToolDefs : undefined,
                toolExecutor: hasTools
                  ? this.toolRegistry.createExecutor(chatId, config.id, userId, tenantRoot)
                  : undefined,
                maxToolRounds,
              }),
            'conversation-pipeline.chat',
            {
              retryConfig: {
                maxRetries: 1,
                baseDelayMs: 1000,
                maxDelayMs: 5000,
                backoffMultiplier: 2,
              },
              circuitBreaker: this.circuitBreaker,
              logger: botLogger,
            }
          );
        }

        if (!llmResult.success) {
          const error = llmResult.error ?? {
            message: 'unknown error',
            category: 'unknown' as const,
          };
          botLogger.error(
            {
              chatId,
              category: error.category,
              attempts: llmResult.attempts,
              durationMs: llmResult.totalDurationMs,
              message: error.message,
            },
            'LLM call failed after retries'
          );
          this.ctx.activityStream?.publish({
            type: 'llm:error',
            botId: config.id,
            timestamp: Date.now(),
            data: {
              error: error.message,
              category: error.category,
              durationMs: llmResult.totalDurationMs,
              attempts: llmResult.attempts,
              backend: llmBackend,
              caller: 'conversation',
            },
          });
          throw new Error(`LLM call failed: ${error.message}`);
        }

        const llmResponse = llmResult.data;
        const response = llmResponse?.text ?? '';
        const tokenUsage = llmResponse?.usage;

        botLogger.info(
          {
            chatId,
            responseLength: response.length,
            attempts: llmResult.attempts,
            durationMs: llmResult.totalDurationMs,
            responsePreview: response.substring(0, 200),
          },
          '📤 LLM response received'
        );
        this.ctx.activityStream?.publish({
          type: 'llm:end',
          botId: config.id,
          timestamp: Date.now(),
          data: {
            responseLength: response.length,
            durationMs: llmResult.totalDurationMs,
            attempts: llmResult.attempts,
            backend: llmBackend,
            caller: 'conversation',
            model: tokenUsage?.model,
            tokensIn: tokenUsage?.promptTokens,
            tokensOut: tokenUsage?.completionTokens,
          },
        });

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
          botLogger.debug({ botId: config.id, messagesAppended: 2 }, 'Session messages persisted');
        }

        if (response.trim()) {
          // TTS: if inbound was voice and TTS is configured, generate voice note
          if (isVoice && this.ctx.config.media.tts) {
            try {
              await ctx.replyWithChatAction('record_voice');
              const ttsConfig = resolveTtsConfig(this.ctx.config.media.tts, config);
              const ttsResult = await generateSpeech(response, ttsConfig, botLogger);
              await ctx.replyWithVoice(new InputFile(ttsResult.audioBuffer, 'reply.opus'));
              botLogger.info({ latencyMs: ttsResult.latencyMs }, 'Voice reply sent');
            } catch (ttsErr) {
              botLogger.warn({ err: ttsErr }, 'TTS failed, falling back to text');
              await sendLongMessage((t) => ctx.reply(t), response);
            }
          } else {
            await sendLongMessage((t) => ctx.reply(t), response);
          }
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

        // Record usage for tenant metering
        if (config.tenantId && this.ctx.tenantFacade?.isMultiTenant()) {
          this.ctx.tenantFacade.recordUsage(config.tenantId, config.id, 'message_processed');
          this.ctx.tenantFacade.recordUsage(config.tenantId, config.id, 'llm_request');
        }

        // Webhook & analytics (fire-and-forget) — Telegram path
        if (config.tenantId) {
          const chatIdStr = String(chatId ?? '');
          const senderId = ctx.from?.id ? String(ctx.from.id) : undefined;

          // conversation.started — first message in session
          if (history.length === 0 && this.ctx.analyticsService) {
            this.ctx.analyticsService.record({
              type: 'conversation.started',
              tenantId: config.tenantId,
              botId: config.id,
              chatId: chatIdStr,
              userId: senderId,
              channelKind: 'telegram',
            });
          }

          this.ctx.webhookService
            ?.emit(
              config.tenantId,
              'message.received',
              {
                botId: config.id,
                senderId,
                channelKind: 'telegram',
                messageLength: userText.length,
              },
              config.id
            )
            .catch(() => {});

          this.ctx.webhookService
            ?.emit(
              config.tenantId,
              'message.sent',
              {
                botId: config.id,
                senderId,
                channelKind: 'telegram',
                replyLength: response.length,
              },
              config.id
            )
            .catch(() => {});

          this.ctx.analyticsService?.record({
            type: 'conversation.message',
            tenantId: config.tenantId,
            botId: config.id,
            chatId: chatIdStr,
            userId: senderId,
            channelKind: 'telegram',
          });
        }

        // Keep the reply window open for this user in groups
        if (isGroup && ctx.from?.id) {
          this.ctx.sessionManager.markActive(config.id, chatId, ctx.from.id);
          botLogger.debug({ chatId, userId: ctx.from.id }, 'Reply window refreshed');
        }
      } finally {
        clearInterval(typingInterval);
      }
    } catch (error) {
      const errorInfo = error instanceof Error ? error.message : String(error);
      botLogger.error(
        { error, chatId, circuitState: this.circuitBreaker.getState() },
        'Conversation handler failed'
      );

      // Emit bot.error webhook + error.occurred analytics (fire-and-forget)
      if (config.tenantId) {
        this.ctx.webhookService
          ?.emit(
            config.tenantId,
            'bot.error',
            {
              botId: config.id,
              channelKind: 'telegram',
              error: errorInfo,
            },
            config.id
          )
          .catch(() => {});
        this.ctx.analyticsService?.record({
          type: 'error.occurred',
          tenantId: config.tenantId,
          botId: config.id,
          chatId: String(chatId ?? ''),
          channelKind: 'telegram',
          data: { error: errorInfo },
        });
      }

      // Determine user-facing message based on error context
      let userMessage = '❌ Failed to generate response. Please try again later.';

      if (error instanceof Error) {
        // Check if it's a circuit breaker open error
        if (error.message.includes('Circuit breaker is open')) {
          userMessage =
            '⏳ The AI service is temporarily overloaded. Please wait a moment and try again.';
        }
        // Check if it was a timeout after retries
        else if (error.message.includes('timeout') || error.message.includes('timed out')) {
          userMessage = '⏱️ The request took too long. The service might be busy. Please try again.';
        }
        // Check for context length errors
        else if (
          error.message.includes('context length') ||
          error.message.includes('too many tokens')
        ) {
          userMessage = '📏 The conversation is too long. Try /reset to start fresh.';
        }
      }

      try {
        await ctx.reply(userMessage);
      } catch (replyError) {
        botLogger.error({ replyError }, 'Failed to send error message to user');
      }
    }
  }

  /**
   * Channel-agnostic conversation pipeline entry point.
   *
   * Accepts an InboundMessage + Channel instead of a grammy Context,
   * allowing non-Telegram channels (REST API, web widget, MCP) to share
   * the same LLM call, session management, RAG, memory flush, and tool
   * execution pipeline.
   */
  async handleChannelMessage(
    msg: InboundMessage,
    channel: Channel,
    config: BotConfig,
    sessionKey: string
  ): Promise<string> {
    const resolved = resolveAgentConfig(this.ctx.config, config);
    const sessionConfig = this.ctx.config.session;
    const webToolsConfig = this.ctx.config.webTools;
    const maxToolRounds = config.maxToolRounds ?? webToolsConfig?.maxToolRounds;
    const botToolDefs = this.toolRegistry.getDefinitionsForBot(config.id);
    const hasTools = botToolDefs.length > 0;
    const isGroup = msg.chatType === 'group' || msg.chatType === 'supergroup';
    const botLogger = this.ctx.getBotLogger(config.id);

    const senderName = isGroup ? (msg.sender.firstName ?? 'Unknown') : undefined;
    botLogger.info(
      {
        chatId: msg.chatId,
        sessionKey,
        isGroup,
        sender: msg.sender.firstName,
        userId: msg.sender.id,
        channelKind: msg.channelKind,
        textPreview: msg.text.substring(0, 120),
        hasImages: !!(msg.images && msg.images.length > 0),
      },
      'handleChannelMessage start'
    );

    // Resolve userId for user isolation
    // Auto-enable user isolation for tenant bots (BaaS multi-tenant)
    const userIsolation = config.userIsolation;
    const isolationActive = userIsolation?.enabled || !!config.tenantId;
    const userId = isolationActive && msg.sender.id ? msg.sender.id : undefined;

    // Start RAG pre-fetch early
    const ragPromise = this.prefetchMemoryContext(msg.text, isGroup, botLogger, config.id, userId);

    try {
      // Memory flush on session expiry
      if (sessionConfig.enabled && this.ctx.sessionManager.isExpired(sessionKey)) {
        botLogger.info({ key: sessionKey }, 'Session expired, flushing to memory');
        if (this.ctx.config.soul.enabled) {
          const expiredHistory = this.ctx.sessionManager.getFullHistory(sessionKey);
          if (expiredHistory.length > 0) {
            await this.memoryFlusher.flushSessionToMemory(expiredHistory, config.id, userId);
          }
        }
        this.ctx.sessionManager.clearSession(sessionKey);
      }

      // Proactive memory flush
      const flushConfig = this.ctx.config.soul.memoryFlush;
      if (sessionConfig.enabled && flushConfig?.enabled) {
        const meta = this.ctx.sessionManager.getSessionMeta(sessionKey);
        if (
          meta &&
          meta.messageCount >= flushConfig.messageThreshold &&
          meta.lastFlushCompactionIndex !== (meta.compactionCount ?? 0)
        ) {
          botLogger.info({ key: sessionKey, msgs: meta.messageCount }, 'Proactive memory flush');
          const recentHistory = this.ctx.sessionManager.getFullHistory(sessionKey);
          this.ctx.sessionManager.markMemoryFlushed(sessionKey);
          this.memoryFlusher.flushWithScoring(recentHistory, config.id, userId).catch((err) => {
            botLogger.warn({ err }, 'Proactive memory flush failed');
          });
        }
      }

      // Get history
      const history = sessionConfig.enabled
        ? this.ctx.sessionManager.getHistory(sessionKey, resolved.maxHistory)
        : [];

      // Await RAG
      const ragContext = await ragPromise;

      // Topic guard pre-filter (merge tenant overlay if present)
      const rawChannelTopicGuard = config.topicGuard as TopicGuardConfig | undefined;
      const topicGuardConfig =
        (this.ctx.customizationService
          ? (this.ctx.customizationService.getTopicGuardOverlay(config.id, rawChannelTopicGuard) as
              | TopicGuardConfig
              | undefined)
          : rawChannelTopicGuard) ?? rawChannelTopicGuard;
      if (topicGuardConfig?.enabled) {
        const guardResult = await this.topicGuard.check(
          msg.text,
          config.id,
          topicGuardConfig,
          botLogger
        );
        if (!guardResult.allowed) {
          botLogger.info(
            { botId: config.id, reason: guardResult.reason, channelKind: msg.channelKind },
            'Topic guard blocked message'
          );
          const rejectMessage =
            topicGuardConfig.customRejectMessage ||
            "I'm not able to help with that topic. Could you ask me something related to my area of expertise?";
          await channel.sendText(rejectMessage);

          // Record analytics
          if (config.tenantId) {
            this.ctx.analyticsService?.record({
              type: 'topic_guard.blocked' as any,
              tenantId: config.tenantId,
              botId: config.id,
              chatId: msg.chatId,
              userId: msg.sender.id,
              channelKind: msg.channelKind,
              data: { reason: guardResult.reason },
            });
          }

          return rejectMessage;
        }
      }

      // Tenant root
      const tenantRoot =
        config.tenantId && this.ctx.config.multiTenant?.enabled
          ? `${this.ctx.config.multiTenant.dataDir ?? './data/tenants'}/${config.tenantId}`
          : undefined;

      // Build system prompt
      const systemPrompt = this.systemPromptBuilder.build({
        mode: 'conversation',
        botId: config.id,
        botConfig: config,
        isGroup,
        ragContext,
        userId,
      });

      // In groups, prefix messages with sender name
      const prefixedText = senderName ? `[${senderName}]: ${msg.text}` : msg.text;

      // Build messages
      const userMessage: ChatMessage = { role: 'user', content: prefixedText };
      if (msg.images && msg.images.length > 0) {
        userMessage.images = msg.images;
      }

      const rawMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        userMessage,
      ];

      // Truncate + compact
      const compactionConfig = this.ctx.config.conversation.compaction;
      const { messages: truncated } = truncateOversizedMessages(
        rawMessages,
        compactionConfig.maxMessageChars
      );
      const compResult = await this.contextCompactor.maybeCompact(
        truncated,
        sessionKey,
        config.id,
        compactionConfig,
        userId
      );
      let currentMessages = compResult.messages;

      // Typing indicator
      await channel.showTyping();
      const typingInterval = setInterval(async () => {
        try {
          await channel.showTyping();
        } catch {
          // Ignore
        }
      }, 4000);

      try {
        // Tenant quota check
        if (config.tenantId && this.ctx.tenantFacade?.isMultiTenant()) {
          const allowed = this.ctx.tenantFacade.checkQuota(config.tenantId, 'messages');
          if (!allowed) {
            botLogger.warn(
              { tenantId: config.tenantId, botId: config.id },
              'Message quota exceeded'
            );
            clearInterval(typingInterval);
            const quotaMsg =
              'Sorry, the message quota for this service has been exceeded. Please try again later.';
            await channel.sendText(quotaMsg);
            return quotaMsg;
          }
        }

        const activeModel = this.ctx.getActiveModel(config.id);
        const llmBackend = this.ctx.getLLMClient(config.id).backend;
        botLogger.info(
          {
            chatId: msg.chatId,
            model: activeModel,
            historyLength: history.length,
            toolCount: hasTools ? botToolDefs.length : 0,
            channelKind: msg.channelKind,
          },
          'Sending to LLM'
        );
        this.ctx.activityStream?.publish({
          type: 'llm:start',
          botId: config.id,
          timestamp: Date.now(),
          data: {
            model: activeModel,
            historyLength: history.length,
            toolCount: hasTools ? botToolDefs.length : 0,
            backend: llmBackend,
            caller: `channel:${msg.channelKind}`,
          },
        });

        const chatId = Number(msg.chatId) || 0;

        // LLM call with resilience
        let llmResult = await executeWithResilience(
          () =>
            this.ctx.getLLMClient(config.id).chat(currentMessages, {
              model: activeModel,
              temperature: resolved.temperature,
              tools: hasTools ? botToolDefs : undefined,
              toolExecutor: hasTools
                ? this.toolRegistry.createExecutor(chatId, config.id, userId, tenantRoot)
                : undefined,
              maxToolRounds,
            }),
          `channel-pipeline.chat:${msg.channelKind}`,
          {
            retryConfig: {
              maxRetries: 3,
              baseDelayMs: 1000,
              maxDelayMs: 15000,
              backoffMultiplier: 2,
            },
            circuitBreaker: this.circuitBreaker,
            logger: botLogger,
          }
        );

        // Overflow retry
        let overflowRetries = 0;
        while (
          !llmResult.success &&
          llmResult.error?.category === 'context_length' &&
          overflowRetries < compactionConfig.maxOverflowRetries
        ) {
          overflowRetries++;
          botLogger.warn({ attempt: overflowRetries }, 'Context overflow, emergency compaction');
          const emergency = await this.contextCompactor.maybeCompact(
            currentMessages,
            sessionKey,
            config.id,
            { ...compactionConfig, thresholdRatio: 0.1, keepRecentMessages: 2 },
            userId
          );
          currentMessages = emergency.messages;

          llmResult = await executeWithResilience(
            () =>
              this.ctx.getLLMClient(config.id).chat(currentMessages, {
                model: activeModel,
                temperature: resolved.temperature,
                tools: hasTools ? botToolDefs : undefined,
                toolExecutor: hasTools
                  ? this.toolRegistry.createExecutor(chatId, config.id, userId, tenantRoot)
                  : undefined,
                maxToolRounds,
              }),
            `channel-pipeline.chat:${msg.channelKind}`,
            {
              retryConfig: {
                maxRetries: 1,
                baseDelayMs: 1000,
                maxDelayMs: 5000,
                backoffMultiplier: 2,
              },
              circuitBreaker: this.circuitBreaker,
              logger: botLogger,
            }
          );
        }

        if (!llmResult.success) {
          const error = llmResult.error ?? {
            message: 'unknown error',
            category: 'unknown' as const,
          };
          this.ctx.activityStream?.publish({
            type: 'llm:error',
            botId: config.id,
            timestamp: Date.now(),
            data: {
              error: error.message,
              category: error.category,
              durationMs: llmResult.totalDurationMs,
              attempts: llmResult.attempts,
              backend: llmBackend,
              caller: `channel:${msg.channelKind}`,
            },
          });
          throw new Error(`LLM call failed: ${error.message}`);
        }

        const response = llmResult.data?.text ?? '';
        const tokenUsage = llmResult.data?.usage;

        botLogger.info(
          {
            chatId: msg.chatId,
            responseLength: response.length,
            attempts: llmResult.attempts,
            durationMs: llmResult.totalDurationMs,
          },
          'LLM response received'
        );
        this.ctx.activityStream?.publish({
          type: 'llm:end',
          botId: config.id,
          timestamp: Date.now(),
          data: {
            responseLength: response.length,
            durationMs: llmResult.totalDurationMs,
            attempts: llmResult.attempts,
            backend: llmBackend,
            caller: `channel:${msg.channelKind}`,
            model: tokenUsage?.model,
            tokensIn: tokenUsage?.promptTokens,
            tokensOut: tokenUsage?.completionTokens,
          },
        });

        // Persist to session
        if (sessionConfig.enabled) {
          const persistText = msg.sessionText ?? msg.text;
          const prefixedPersist = senderName ? `[${senderName}]: ${persistText}` : persistText;
          this.ctx.sessionManager.appendMessages(
            sessionKey,
            [
              { role: 'user', content: prefixedPersist },
              { role: 'assistant', content: response },
            ],
            resolved.maxHistory
          );
        }

        // Send reply through channel
        if (response.trim()) {
          if (msg.isVoice && this.ctx.config.media.tts && channel.sendVoice) {
            try {
              const ttsConfig = resolveTtsConfig(this.ctx.config.media.tts, config);
              const ttsResult = await generateSpeech(response, ttsConfig, botLogger);
              await channel.sendVoice(ttsResult.audioBuffer, 'reply.opus');
            } catch (ttsErr) {
              botLogger.warn({ err: ttsErr }, 'TTS failed, falling back to text');
              await sendLongMessage((t) => channel.sendText(t), response);
            }
          } else {
            await sendLongMessage((t) => channel.sendText(t), response);
          }
        }

        // Tenant metering
        if (config.tenantId && this.ctx.tenantFacade?.isMultiTenant()) {
          this.ctx.tenantFacade.recordUsage(config.tenantId, config.id, 'message_processed');
          this.ctx.tenantFacade.recordUsage(config.tenantId, config.id, 'llm_request');
        }

        // Webhook & analytics (fire-and-forget) — channel-agnostic path
        if (config.tenantId) {
          // conversation.started — first message in session
          if (history.length === 0 && this.ctx.analyticsService) {
            this.ctx.analyticsService.record({
              type: 'conversation.started',
              tenantId: config.tenantId,
              botId: config.id,
              chatId: msg.chatId,
              userId: msg.sender.id,
              channelKind: msg.channelKind,
            });
          }

          this.ctx.webhookService
            ?.emit(
              config.tenantId,
              'message.received',
              {
                botId: config.id,
                senderId: msg.sender.id,
                channelKind: msg.channelKind,
                messageLength: msg.text.length,
              },
              config.id
            )
            .catch(() => {});

          this.ctx.webhookService
            ?.emit(
              config.tenantId,
              'message.sent',
              {
                botId: config.id,
                senderId: msg.sender.id,
                channelKind: msg.channelKind,
                replyLength: response.length,
              },
              config.id
            )
            .catch(() => {});

          this.ctx.analyticsService?.record({
            type: 'conversation.message',
            tenantId: config.tenantId,
            botId: config.id,
            chatId: msg.chatId,
            userId: msg.sender.id,
            channelKind: msg.channelKind,
          });
        }

        return response;
      } finally {
        clearInterval(typingInterval);
      }
    } catch (error) {
      const errorInfo = error instanceof Error ? error.message : String(error);
      botLogger.error({ error, chatId: msg.chatId }, 'Channel conversation handler failed');

      // Emit bot.error webhook + error.occurred analytics (fire-and-forget)
      if (config.tenantId) {
        this.ctx.webhookService
          ?.emit(
            config.tenantId,
            'bot.error',
            {
              botId: config.id,
              channelKind: msg.channelKind,
              error: errorInfo,
            },
            config.id
          )
          .catch(() => {});
        this.ctx.analyticsService?.record({
          type: 'error.occurred',
          tenantId: config.tenantId,
          botId: config.id,
          chatId: msg.chatId,
          channelKind: msg.channelKind,
          data: { error: errorInfo },
        });
      }

      let userMessage = 'Failed to generate response. Please try again later.';
      if (error instanceof Error) {
        if (error.message.includes('Circuit breaker is open')) {
          userMessage = 'The AI service is temporarily overloaded. Please wait and try again.';
        } else if (error.message.includes('timeout') || error.message.includes('timed out')) {
          userMessage = 'The request took too long. The service might be busy. Please try again.';
        } else if (
          error.message.includes('context length') ||
          error.message.includes('too many tokens')
        ) {
          userMessage = 'The conversation is too long. Try starting a new conversation.';
        }
      }

      try {
        await channel.sendText(userMessage);
      } catch (replyError) {
        botLogger.error({ replyError }, 'Failed to send error message through channel');
      }
      return userMessage;
    }
  }
}
