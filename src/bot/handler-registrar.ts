import { Bot, InputFile, type Context } from 'grammy';
import type { BotConfig } from '../config';
import type { CallbackQueryData, Skill, SkillContext, TelegramClient } from '../core/types';
import { MediaError } from '../media';
import type { BotContext, SeenUser } from './types';
import type { ConversationPipeline } from './conversation-pipeline';
import type { GroupActivation } from './group-activation';
import type { MemoryFlusher } from './memory-flush';
import type { ToolRegistry } from './tool-registry';

export class HandlerRegistrar {
  constructor(
    private ctx: BotContext,
    private conversationPipeline: ConversationPipeline,
    private groupActivation: GroupActivation,
    private memoryFlusher: MemoryFlusher,
    private toolRegistry: ToolRegistry,
  ) {}

  /**
   * Register all handlers on a bot instance.
   */
  registerAll(bot: Bot, config: BotConfig): void {
    // Register skill commands
    for (const skillId of config.skills) {
      const skill = this.ctx.skillRegistry.get(skillId);
      if (!skill) {
        this.ctx.logger.warn({ skillId, botId: config.id }, 'Skill not found');
        continue;
      }
      if (skill.commands) {
        this.registerCommands(bot, skill, config);
      }
      if (skill.onMessage) {
        this.registerMessageHandler(bot, skill, config);
      }
    }

    // Register callback query handler
    this.registerCallbackQueryHandler(bot, config);

    // Built-in commands
    bot.command('start', async (ctx) => this.handleStart(ctx, config));
    bot.command('help', async (ctx) => this.handleHelp(ctx, config));
    this.registerBuiltInCommands(bot, config);

    // Conversation handler (must be last)
    if (this.ctx.config.conversation.enabled) {
      this.registerConversationHandler(bot, config);
    }
  }

  // --- Built-in commands ---

  private registerBuiltInCommands(bot: Bot, config: BotConfig): void {
    // /clear
    bot.command('clear', async (ctx) => {
      if (!this.isAuthorized(ctx.from?.id, config)) {
        await ctx.reply('⛔ Unauthorized');
        return;
      }

      const noFlush = (ctx.match || '').toString().trim().includes('--no-flush');

      const clearedBots: string[] = [];
      for (const botId of this.ctx.bots.keys()) {
        const sessionKey = this.ctx.sessionManager.deriveKey(botId, ctx);
        const serializedKey = this.ctx.sessionManager.serializeKey(sessionKey);

        if (!noFlush && this.ctx.config.soul.enabled) {
          const history = this.ctx.sessionManager.getFullHistory(serializedKey);
          if (history.length > 0) {
            await this.memoryFlusher.flushSessionToMemory(history, botId);
          }
        }

        this.ctx.sessionManager.clearSession(serializedKey);
        clearedBots.push(botId);
      }

      this.ctx.logger.info({ chatId: ctx.chat.id, clearedBots, noFlush }, 'Sessions cleared for all bots');
      await ctx.reply(
        noFlush
          ? '🗑️ Conversation history cleared for all bots. Memory flush skipped.'
          : this.ctx.config.soul.enabled
            ? '🗑️ Conversation history cleared for all bots. Key facts saved to memory.'
            : '🗑️ Conversation history cleared for all bots.'
      );
    });

    // /model
    bot.command('model', async (ctx) => {
      if (!this.isAuthorized(ctx.from?.id, config)) {
        await ctx.reply('⛔ Unauthorized');
        return;
      }

      const args = ctx.message?.text?.split(' ').slice(1) || [];
      if (args.length > 0) {
        const newModel = args.join(' ');
        this.ctx.activeModels.set(config.id, newModel);
        this.ctx.logger.info({ model: newModel, botId: config.id }, 'Active model changed');
        await ctx.reply(`🔄 Model changed to: ${newModel}`);
      } else {
        await ctx.reply(`🤖 Current model: ${this.ctx.getActiveModel(config.id)}`);
      }
    });

    // /who
    bot.command('who', async (ctx) => {
      if (!this.isAuthorized(ctx.from?.id, config)) {
        await ctx.reply('⛔ Unauthorized');
        return;
      }

      const chatId = ctx.chat.id;
      const users = this.ctx.seenUsers.get(chatId);

      if (!users || users.size === 0) {
        await ctx.reply(
          'No he visto a nadie todavía en este chat. Manden mensajes y los voy trackeando.'
        );
        return;
      }

      const lines = Array.from(users.values())
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .map((u) => {
          const username = u.username ? ` (@${u.username})` : '';
          const ago = Math.round((Date.now() - u.lastSeen) / 60_000);
          const time = ago < 1 ? 'just now' : `${ago}m ago`;
          return `• ${u.firstName}${username} — ID: ${u.id} (${time})`;
        });

      await ctx.reply(`👥 Usuarios vistos en este chat:\n\n${lines.join('\n')}`);
    });

    // /memory
    bot.command('memory', async (ctx) => {
      if (!this.isAuthorized(ctx.from?.id, config)) {
        await ctx.reply('⛔ Unauthorized');
        return;
      }

      const dump = this.ctx.getSoulLoader(config.id).dumpMemory();

      if (dump.length <= 4096) {
        await ctx.reply(dump);
      } else {
        const chunks: string[] = [];
        let remaining = dump;
        while (remaining.length > 0) {
          if (remaining.length <= 4096) {
            chunks.push(remaining);
            break;
          }
          const cutAt = remaining.lastIndexOf('\n', 4096);
          const splitPos = cutAt > 0 ? cutAt : 4096;
          chunks.push(remaining.slice(0, splitPos));
          remaining = remaining.slice(splitPos + 1);
        }
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      }
    });
  }

  // --- Skill handlers ---

  private registerCommands(bot: Bot, skill: Skill, config: BotConfig): void {
    if (!skill.commands) return;

    for (const [command, handler] of Object.entries(skill.commands)) {
      bot.command(command, async (ctx) => {
        if (!this.isAuthorized(ctx.from?.id, config)) {
          await ctx.reply('⛔ Unauthorized');
          this.ctx.logger.warn(
            { userId: ctx.from?.id, command, botId: config.id },
            'Unauthorized command attempt'
          );
          return;
        }

        try {
          const args = ctx.message?.text?.split(' ').slice(1) || [];
          const skillContext = this.createSkillContext(skill.id, ctx, config);
          const result = await handler.handler(args, skillContext);

          if (result) {
            await ctx.reply(result);
          }

          this.ctx.logger.debug(
            { userId: ctx.from?.id, command, skillId: skill.id },
            'Command executed'
          );
        } catch (error) {
          this.ctx.logger.error({ error, command, skillId: skill.id }, 'Command execution failed');
          await ctx.reply('❌ Command failed. Please try again later.');
        }
      });

      this.ctx.logger.debug({ command, skillId: skill.id, botId: config.id }, 'Command registered');
    }
  }

  private registerMessageHandler(bot: Bot, skill: Skill, config: BotConfig): void {
    if (!skill.onMessage) return;

    bot.on('message:text', async (ctx, next) => {
      if (ctx.message.text.startsWith('/')) {
        await next();
        return;
      }

      if (!this.isAuthorized(ctx.from?.id, config)) {
        await next();
        return;
      }

      try {
        const message = {
          text: ctx.message.text,
          from: {
            id: ctx.from.id,
            username: ctx.from.username,
            first_name: ctx.from.first_name,
          },
          chat: {
            id: ctx.chat.id,
            type: ctx.chat.type,
          },
        };

        const skillContext = this.createSkillContext(skill.id, ctx, config);
        const consumed = await skill.onMessage!(message, skillContext);
        if (consumed === true) {
          this.ctx.handledMessageIds.add(`${config.id}:${ctx.message.message_id}`);
        }
      } catch (error) {
        this.ctx.logger.error({ error, skillId: skill.id }, 'Message handler failed');
      }

      await next();
    });
  }

  private registerCallbackQueryHandler(bot: Bot, config: BotConfig): void {
    bot.on('callback_query:data', async (ctx) => {
      this.ctx.logger.info({ data: ctx.callbackQuery.data, userId: ctx.from?.id }, 'Callback query received');

      if (!this.isAuthorized(ctx.from?.id, config)) {
        await ctx.answerCallbackQuery({ text: '⛔ Unauthorized' });
        return;
      }

      const raw = ctx.callbackQuery.data;
      const colonIdx = raw.indexOf(':');
      if (colonIdx === -1) {
        this.ctx.logger.warn({ data: raw }, 'Callback query missing colon separator');
        await ctx.answerCallbackQuery();
        return;
      }

      const skillId = raw.slice(0, colonIdx);
      const rest = raw.slice(colonIdx + 1);

      const skill = this.ctx.skillRegistry.get(skillId);
      if (!skill?.onCallbackQuery) {
        this.ctx.logger.warn({ skillId, data: raw }, 'No callback handler for skill');
        await ctx.answerCallbackQuery();
        return;
      }

      try {
        const query: CallbackQueryData = {
          id: ctx.callbackQuery.id,
          chatId: ctx.callbackQuery.message?.chat.id ?? 0,
          messageId: ctx.callbackQuery.message?.message_id ?? 0,
          userId: ctx.from.id,
          data: rest,
        };
        const skillContext = this.createSkillContext(skillId, ctx, config);
        await skill.onCallbackQuery(query, skillContext);
      } catch (error) {
        this.ctx.logger.error({ error, skillId, data: raw }, 'Callback query handler failed');
        await ctx.answerCallbackQuery({ text: '❌ Error' });
      }
    });
  }

  // --- Conversation handler ---

  private registerConversationHandler(bot: Bot, config: BotConfig): void {
    const sessionConfig = this.ctx.config.session;
    const hasTools = this.toolRegistry.getDefinitionsForBot(config.id).length > 0;
    const botLogger = this.ctx.getBotLogger(config.id);

    // Text message handler
    bot.on('message:text', async (ctx) => {
      const chatTitle = 'title' in ctx.chat ? (ctx.chat as { title?: string }).title : undefined;
      botLogger.info(
        {
          chatId: ctx.chat.id,
          chatType: ctx.chat.type,
          chatTitle,
          userId: ctx.from?.id,
          username: ctx.from?.username,
          firstName: ctx.from?.first_name,
          text: ctx.message.text.substring(0, 120),
        },
        '📩 Incoming text message'
      );

      this.trackUser(ctx);

      if (ctx.message.text.startsWith('/')) {
        botLogger.debug({ text: ctx.message.text }, 'Skipping: command message');
        return;
      }

      if (this.ctx.handledMessageIds.delete(`${config.id}:${ctx.message.message_id}`)) {
        botLogger.debug({ messageId: ctx.message.message_id }, 'Skipping: consumed by skill');
        return;
      }

      // Bot-to-bot collaboration gate
      const collabConfig = this.ctx.config.collaboration;
      const senderAgent = ctx.from?.id ? this.ctx.agentRegistry.getByTelegramUserId(ctx.from.id) : undefined;
      let isPeerBotMessage = false;
      if (senderAgent) {
        if (!collabConfig.enabled) {
          botLogger.debug({ fromBot: senderAgent.botId }, 'Skipping: collaboration disabled');
          return;
        }

        const botUsername = ctx.me?.username;
        if (botUsername && !ctx.message.text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) {
          botLogger.debug(
            { fromBot: senderAgent.botId, text: ctx.message.text.substring(0, 80) },
            'Skipping bot message: no @mention of this bot'
          );
          return;
        }

        const check = this.ctx.collaborationTracker.checkAndRecord(
          senderAgent.botId, config.id, ctx.chat.id
        );
        if (!check.allowed) {
          botLogger.info(
            { fromBot: senderAgent.botId, chatId: ctx.chat.id, reason: check.reason },
            'Skipping bot message: collaboration limit'
          );
          return;
        }

        isPeerBotMessage = true;
        botLogger.info(
          { fromBot: senderAgent.botId, chatId: ctx.chat.id },
          'Processing bot-to-bot message (collaboration)'
        );
      } else if (!this.isAuthorized(ctx.from?.id, config)) {
        botLogger.info(
          { userId: ctx.from?.id, username: ctx.from?.username },
          'Skipping: unauthorized user'
        );
        return;
      }

      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const botUsername = ctx.me?.username;

      // Group activation gate
      if (isGroup && sessionConfig.enabled && !isPeerBotMessage) {
        let groupReason = this.ctx.sessionManager.shouldRespondInGroup(
          ctx,
          botUsername,
          config.id,
          config.mentionPatterns
        );

        if (groupReason && groupReason !== 'mention' && groupReason !== 'replyToBot') {
          if (this.groupActivation.messageTargetsAnotherBot(ctx, config.id)) {
            botLogger.info(
              { chatId: ctx.chat.id, chatTitle, firstName: ctx.from?.first_name, reason: groupReason },
              'Deferring to @mentioned bot'
            );
            return;
          }
        }

        if (groupReason === 'replyWindow' && sessionConfig.llmRelevanceCheck.enabled) {
          const sessionKey = this.ctx.sessionManager.deriveKey(config.id, ctx);
          const serializedKey = this.ctx.sessionManager.serializeKey(sessionKey);
          const isRelevant = await this.groupActivation.checkLlmRelevance(ctx, config.name, serializedKey, config.id);
          if (!isRelevant) {
            botLogger.info(
              {
                chatId: ctx.chat.id,
                chatTitle,
                userId: ctx.from?.id,
                firstName: ctx.from?.first_name,
                text: ctx.message.text.substring(0, 80),
              },
              'Skipping group message: LLM relevance check said no'
            );
            return;
          }
        }

        if (
          !groupReason &&
          sessionConfig.llmRelevanceCheck.enabled &&
          sessionConfig.llmRelevanceCheck.broadcastCheck
        ) {
          const shouldRespond = await this.groupActivation.checkBroadcastRelevance(ctx, config.name, config.id);
          if (shouldRespond) {
            groupReason = 'broadcast';
          }
        }

        if (!groupReason) {
          botLogger.info(
            {
              chatId: ctx.chat.id,
              chatTitle,
              userId: ctx.from?.id,
              firstName: ctx.from?.first_name,
              text: ctx.message.text.substring(0, 80),
              botUsername,
              mentionPatterns: config.mentionPatterns,
            },
            'Skipping group message: no mention/reply/active window'
          );
          return;
        }

        botLogger.info(
          { chatId: ctx.chat.id, chatTitle, firstName: ctx.from?.first_name, reason: groupReason },
          'Group activation gate passed'
        );
      }

      // Strip @botusername
      let userMessage = ctx.message.text;
      if (isGroup && botUsername) {
        userMessage = this.ctx.sessionManager.stripBotMention(
          userMessage,
          botUsername,
          config.mentionPatterns
        );
      }

      const sessionKey = this.ctx.sessionManager.deriveKey(config.id, ctx);
      const serializedKey = this.ctx.sessionManager.serializeKey(sessionKey);
      this.ctx.messageBuffer.enqueue({
        sessionKey: serializedKey,
        ctx,
        config,
        userText: userMessage,
        messageId: ctx.message.message_id,
        isMedia: false,
        timestamp: Date.now(),
      });
    });

    // Media handlers
    if (this.ctx.mediaHandler) {
      this.registerMediaHandlers(bot, config);
    }

    botLogger.info(
      {
        toolsEnabled: hasTools,
        mediaEnabled: !!this.ctx.mediaHandler,
        groupActivation: sessionConfig.groupActivation,
      },
      'Native conversation handler registered'
    );
  }

  // --- Media handlers ---

  private registerMediaHandlers(bot: Bot, config: BotConfig): void {
    const sessionConfig = this.ctx.config.session;
    const mediaHandler = this.ctx.mediaHandler!;
    const botLogger = this.ctx.getBotLogger(config.id);

    // Photo handler
    bot.on('message:photo', async (ctx) => {
      this.trackUser(ctx);
      if (!this.isAuthorized(ctx.from?.id, config)) return;

      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const botUsername = ctx.me?.username;

      if (isGroup && sessionConfig.enabled) {
        if (!this.ctx.sessionManager.shouldRespondInGroup(ctx, botUsername, config.id, config.mentionPatterns)) {
          return;
        }
      }

      try {
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];
        const file = await ctx.api.getFile(photo.file_id);
        const fileUrl = this.buildFileUrl(config, file.file_path!);

        let caption = ctx.message.caption;
        if (caption && isGroup && botUsername) {
          caption = this.ctx.sessionManager.stripBotMention(caption, botUsername, config.mentionPatterns);
        }

        const result = await mediaHandler.processPhoto(fileUrl, caption ?? undefined, photo.file_size);
        const sessionKey = this.ctx.sessionManager.deriveKey(config.id, ctx);
        const serializedKey = this.ctx.sessionManager.serializeKey(sessionKey);
        this.ctx.messageBuffer.enqueue({
          sessionKey: serializedKey,
          ctx,
          config,
          userText: result.text,
          images: result.images,
          sessionText: result.sessionText,
          messageId: ctx.message!.message_id,
          isMedia: true,
          timestamp: Date.now(),
        });
      } catch (error) {
        if (error instanceof MediaError) {
          await ctx.reply(error.message);
        } else {
          botLogger.error({ error, chatId: ctx.chat.id }, 'Failed to process photo');
          await ctx.reply('❌ Failed to process image. Please try again later.');
        }
      }
    });

    // Document handler
    bot.on('message:document', async (ctx) => {
      this.trackUser(ctx);
      if (!this.isAuthorized(ctx.from?.id, config)) return;

      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const botUsername = ctx.me?.username;

      if (isGroup && sessionConfig.enabled) {
        if (!this.ctx.sessionManager.shouldRespondInGroup(ctx, botUsername, config.id, config.mentionPatterns)) {
          return;
        }
      }

      try {
        const doc = ctx.message.document;
        const file = await ctx.api.getFile(doc.file_id);
        const fileUrl = this.buildFileUrl(config, file.file_path!);

        let caption = ctx.message.caption;
        if (caption && isGroup && botUsername) {
          caption = this.ctx.sessionManager.stripBotMention(caption, botUsername, config.mentionPatterns);
        }

        const result = await mediaHandler.processDocument(
          fileUrl,
          doc.mime_type,
          doc.file_name,
          caption ?? undefined,
          doc.file_size
        );
        const sessionKey = this.ctx.sessionManager.deriveKey(config.id, ctx);
        const serializedKey = this.ctx.sessionManager.serializeKey(sessionKey);
        this.ctx.messageBuffer.enqueue({
          sessionKey: serializedKey,
          ctx,
          config,
          userText: result.text,
          images: result.images,
          sessionText: result.sessionText,
          messageId: ctx.message!.message_id,
          isMedia: true,
          timestamp: Date.now(),
        });
      } catch (error) {
        if (error instanceof MediaError) {
          await ctx.reply(error.message);
        } else {
          botLogger.error({ error, chatId: ctx.chat.id }, 'Failed to process document');
          await ctx.reply('❌ Failed to process document. Please try again later.');
        }
      }
    });

    // Voice handler
    bot.on('message:voice', async (ctx) => {
      this.trackUser(ctx);
      if (!this.isAuthorized(ctx.from?.id, config)) return;

      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const botUsername = ctx.me?.username;

      if (isGroup && sessionConfig.enabled) {
        if (!this.ctx.sessionManager.shouldRespondInGroup(ctx, botUsername, config.id, config.mentionPatterns)) {
          return;
        }
      }

      try {
        const voice = ctx.message.voice;
        const file = await ctx.api.getFile(voice.file_id);
        const fileUrl = this.buildFileUrl(config, file.file_path!);

        const result = await mediaHandler.processVoice(fileUrl, voice.duration, voice.file_size);
        const sessionKey = this.ctx.sessionManager.deriveKey(config.id, ctx);
        const serializedKey = this.ctx.sessionManager.serializeKey(sessionKey);
        this.ctx.messageBuffer.enqueue({
          sessionKey: serializedKey,
          ctx,
          config,
          userText: result.text,
          sessionText: result.sessionText,
          messageId: ctx.message!.message_id,
          isMedia: true,
          timestamp: Date.now(),
        });
      } catch (error) {
        if (error instanceof MediaError) {
          await ctx.reply(error.message);
        } else {
          botLogger.error({ error, chatId: ctx.chat.id }, 'Failed to process voice message');
          await ctx.reply('❌ Failed to process voice message. Please try again later.');
        }
      }
    });

    botLogger.info('Media handlers registered (photo, document, voice)');
  }

  // --- Utility methods ---

  private trackUser(ctx: Context): void {
    const chatId = ctx.chat?.id;
    const from = ctx.from;
    if (!chatId || !from || from.is_bot) return;

    if (!this.ctx.seenUsers.has(chatId)) {
      this.ctx.seenUsers.set(chatId, new Map());
    }
    this.ctx.seenUsers.get(chatId)!.set(from.id, {
      id: from.id,
      firstName: from.first_name,
      username: from.username,
      lastSeen: Date.now(),
    });
  }

  private isAuthorized(userId: number | undefined, config: BotConfig): boolean {
    if (!userId) return false;
    if (!config.allowedUsers || config.allowedUsers.length === 0) return true;
    return config.allowedUsers.includes(userId);
  }

  private createSkillContext(skillId: string, ctx: Context, config: BotConfig): SkillContext {
    const telegramClient: TelegramClient = {
      async sendMessage(chatId: number, text: string, options?: unknown) {
        await ctx.api.sendMessage(
          chatId,
          text,
          options as Parameters<typeof ctx.api.sendMessage>[2]
        );
      },
      async sendDocument(chatId: number, document: string | Buffer, options?: unknown) {
        const opts = (options || {}) as Record<string, unknown>;
        const file = Buffer.isBuffer(document)
          ? new InputFile(new Uint8Array(document), opts.filename as string | undefined)
          : document;
        await ctx.api.sendDocument(
          chatId,
          file as Parameters<typeof ctx.api.sendDocument>[1],
          opts as Parameters<typeof ctx.api.sendDocument>[2]
        );
      },
      async answerCallbackQuery(callbackQueryId: string, options?: unknown) {
        await ctx.api.answerCallbackQuery(
          callbackQueryId,
          options as Parameters<typeof ctx.api.answerCallbackQuery>[1]
        );
      },
      async editMessageText(chatId: number, messageId: number, text: string, options?: unknown) {
        await ctx.api.editMessageText(
          chatId,
          messageId,
          text,
          options as Parameters<typeof ctx.api.editMessageText>[3]
        );
      },
    };

    const baseContext = this.ctx.skillRegistry.getContext(skillId);
    if (!baseContext) {
      throw new Error(`Skill context not found: ${skillId}`);
    }

    let session;
    if (this.ctx.config.session.enabled && ctx.chat) {
      const sessionKey = this.ctx.sessionManager.deriveKey(config.id, ctx);
      session = this.ctx.sessionManager.buildSessionInfo(sessionKey);
    }

    return {
      ...baseContext,
      telegram: telegramClient,
      session,
    };
  }

  private buildFileUrl(config: BotConfig, filePath: string): string {
    return `https://api.telegram.org/file/bot${config.token}/${filePath}`;
  }

  // --- /start and /help ---

  private async handleStart(ctx: Context, config: BotConfig): Promise<void> {
    const message = `👋 Welcome to ${config.name}!

I'm an AI-powered bot with multiple skills.

Use /help to see available commands.`;

    await ctx.reply(message);
  }

  private async handleHelp(ctx: Context, config: BotConfig): Promise<void> {
    const lines: string[] = [
      `🤖 *${config.name} - Available Commands*\n`,
      '📋 *General*',
      '/start - Start the bot',
      '/help - Show this help message',
      '/clear - Clear conversation history (use --no-flush to skip memory save)',
      '/model - Show or change the active AI model',
      '/who - Show users seen in this chat',
      '/memory - Show all stored memory (newest first)\n',
    ];

    for (const skillId of config.skills) {
      const skill = this.ctx.skillRegistry.get(skillId);
      if (!skill || !skill.commands) continue;

      lines.push(`🔧 *${skill.name}*`);

      for (const [command, handler] of Object.entries(skill.commands)) {
        lines.push(`/${command} - ${handler.description}`);
      }

      lines.push('');
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  }
}
