import { Bot, InputFile, type Context } from 'grammy';
import { resolveAgentConfig, type BotConfig } from '../config';
import type { CallbackQueryData, Skill, SkillContext, TelegramClient } from '../core/types';
import type { BotContext, SeenUser } from './types';
import type { ConversationPipeline } from './conversation-pipeline';
import type { GroupActivation } from './group-activation';
import type { MemoryFlusher } from './memory-flush';
import type { ToolRegistry } from './tool-registry';
import type { AskHumanStore } from './ask-human-store';
import type { ConversationsService } from '../conversations/service';
import { sendLongMessage } from './telegram-utils';
import { registerMediaHandlers, trackUser, isAuthorized as isAuthorizedMedia, buildFileUrl } from './media-handlers';
import { registerBuiltinCommands, handleStart, handleHelp } from './builtin-commands';
import { ConversationGate } from './conversation-gate';

export class HandlerRegistrar {
  private conversationGate: ConversationGate;

  constructor(
    private ctx: BotContext,
    private conversationPipeline: ConversationPipeline,
    private groupActivation: GroupActivation,
    private memoryFlusher: MemoryFlusher,
    private toolRegistry: ToolRegistry,
    private askHumanStore?: AskHumanStore,
    private conversationsService?: ConversationsService,
  ) {
    this.conversationGate = new ConversationGate(ctx, groupActivation, askHumanStore, conversationsService);
  }

  /**
   * Register all handlers on a bot instance.
   */
  registerAll(bot: Bot, config: BotConfig): void {
    // Register skill commands
    const externalSkillNames = this.toolRegistry.getExternalSkillNames();
    for (const skillId of config.skills) {
      // External skills are handled as LLM tools via ToolRegistry, not as built-in skills
      if (externalSkillNames.includes(skillId)) continue;

      const skill = this.ctx.skillRegistry.get(skillId);
      if (!skill) {
        this.ctx.logger.debug({ skillId, botId: config.id }, 'Skill not found in built-in registry (may be external-only)');
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
    bot.command('start', async (ctx) => this.handleStartWrapper(ctx, config));
    bot.command('help', async (ctx) => this.handleHelpWrapper(ctx, config));
    this.registerBuiltInCommands(bot, config);

    // Conversation handler (must be last)
    if (this.ctx.config.conversation.enabled) {
      this.registerConversationHandler(bot, config);
    }
  }

  // --- Built-in commands ---

  private registerBuiltInCommands(bot: Bot, config: BotConfig): void {
    registerBuiltinCommands(bot, config, {
      ctx: this.ctx,
      memoryFlusher: this.memoryFlusher,
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
    const hasTools = this.toolRegistry.getDefinitionsForBot(config.id).length > 0;
    const botLogger = this.ctx.getBotLogger(config.id);

    // Text message handler
    bot.on('message:text', async (ctx) => {
      const chatTitle = 'title' in ctx.chat ? (ctx.chat as { title?: string }).title : undefined;
      botLogger.info(
        {
          chatId: ctx.chat.id, chatType: ctx.chat.type, chatTitle,
          userId: ctx.from?.id, username: ctx.from?.username,
          firstName: ctx.from?.first_name, text: ctx.message.text.substring(0, 120),
        },
        '📩 Incoming text message',
      );

      this.trackUser(ctx);

      const gate = await this.conversationGate.evaluate(ctx as any, config, botLogger);
      if (!gate.allowed) return;

      const userMessage = gate.strippedText ?? ctx.message.text;
      const sessionKey = this.ctx.sessionManager.deriveKey(config.id, ctx);
      const serializedKey = this.ctx.sessionManager.serializeKey(sessionKey);
      this.ctx.messageBuffer.enqueue({
        sessionKey: serializedKey,
        ctx, config,
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
        groupActivation: config.groupActivation,
      },
      'Native conversation handler registered'
    );
  }

  // --- Media handlers ---

  private registerMediaHandlers(bot: Bot, config: BotConfig): void {
    registerMediaHandlers(bot, config, { ctx: this.ctx });
  }

  // --- Utility methods ---

  private trackUser(ctx: Context): void {
    trackUser(this.ctx, ctx);
  }

  private isAuthorized(userId: number | undefined, config: BotConfig): boolean {
    return isAuthorizedMedia(this.ctx, userId, config);
  }

  private handleStartWrapper(ctx: Context, config: BotConfig): Promise<void> {
    return handleStart(ctx, config);
  }

  private handleHelpWrapper(ctx: Context, config: BotConfig): Promise<void> {
    return handleHelp(ctx, config, this.ctx.skillRegistry);
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
      soulDir: resolveAgentConfig(this.ctx.config, config).soulDir,
    };
  }

  private buildFileUrl(config: BotConfig, filePath: string): string {
    return buildFileUrl(config, filePath);
  }
}
