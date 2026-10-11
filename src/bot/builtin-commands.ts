import type { Bot, Context } from 'grammy';
import type { BotConfig } from '../config';
import type { MemoryFlusher } from './memory-flush';
import { endConversation } from './session-continuity';
import { sendLongMessage } from './telegram-utils';
import type { BotContext, SeenUser } from './types';

/**
 * Built-in command handlers for Telegram bot
 * Extracted from handler-registrar.ts to reduce SRP violation
 */

export interface BuiltinCommandDeps {
  ctx: BotContext;
  memoryFlusher: MemoryFlusher;
  /**
   * Open a fresh conversation in the bot's own voice (a pipeline turn with the
   * session-start prompt). Without it, /new and /reset confirm in plain text.
   */
  startConversation?: (telegramCtx: Context, command: string) => Promise<void>;
}

/**
 * Check if user is authorized for this bot
 */
function isAuthorized(ctx: BotContext, userId: number | undefined, config: BotConfig): boolean {
  if (!userId) return false;
  if (!config.allowedUsers || config.allowedUsers.length === 0) return true;
  return config.allowedUsers.includes(userId);
}

/**
 * Register all built-in commands
 */
export function registerBuiltinCommands(
  bot: Bot,
  config: BotConfig,
  deps: BuiltinCommandDeps
): void {
  const { ctx, memoryFlusher } = deps;

  /** End this chat's conversation: remember how it left off, flush it to memory, clear it. */
  const endChatConversation = (telegramCtx: Context, flush = true) => {
    const sessionKey = ctx.sessionManager.deriveKey(config.id, telegramCtx);
    return endConversation(
      {
        sessionManager: ctx.sessionManager,
        memoryFlusher,
        soulEnabled: ctx.config.soul.enabled,
        logger: ctx.logger,
      },
      {
        botId: config.id,
        serializedKey: ctx.sessionManager.serializeKey(sessionKey),
        reason: 'command',
        // The sender owns the facts, as in the conversation pipeline.
        memoryUserId: telegramCtx.from?.id ? String(telegramCtx.from.id) : undefined,
        flush,
      }
    );
  };

  // /new, /reset, /start: a fresh conversation, opened by the bot itself
  const freshConversation = async (telegramCtx: Context, command: string) => {
    await endChatConversation(telegramCtx);
    if (!deps.startConversation) {
      await telegramCtx.reply('✨ New conversation started.');
      return;
    }
    await deps.startConversation(telegramCtx, command);
  };

  for (const name of ['new', 'reset']) {
    bot.command(name, async (telegramCtx) => {
      if (!isAuthorized(ctx, telegramCtx.from?.id, config)) {
        await telegramCtx.reply('⛔ Unauthorized');
        return;
      }
      await freshConversation(telegramCtx, `/${name}`);
    });
  }

  // Telegram sends /start when someone opens the bot (again): that is a new conversation.
  bot.command('start', async (telegramCtx) => {
    if (!isAuthorized(ctx, telegramCtx.from?.id, config)) {
      await handleStart(telegramCtx, config);
      return;
    }
    try {
      await freshConversation(telegramCtx, '/start');
    } catch (err) {
      ctx.logger.warn({ err, botId: config.id }, '/start greeting failed, sending static welcome');
      await handleStart(telegramCtx, config);
    }
  });

  // /clear
  bot.command('clear', async (telegramCtx) => {
    if (!isAuthorized(ctx, telegramCtx.from?.id, config)) {
      await telegramCtx.reply('⛔ Unauthorized');
      return;
    }

    const noFlush = (telegramCtx.match || '').toString().trim().includes('--no-flush');
    await endChatConversation(telegramCtx, !noFlush);

    ctx.logger.info(
      { chatId: telegramCtx.chat.id, botId: config.id, noFlush },
      'Session cleared for bot'
    );
    await telegramCtx.reply(
      noFlush
        ? '🗑️ Conversation history cleared. Memory flush skipped.'
        : ctx.config.soul.enabled
          ? '🗑️ Conversation history cleared. Key facts saved to memory.'
          : '🗑️ Conversation history cleared.'
    );
  });

  // /model
  bot.command('model', async (telegramCtx) => {
    if (!isAuthorized(ctx, telegramCtx.from?.id, config)) {
      await telegramCtx.reply('⛔ Unauthorized');
      return;
    }

    const args = telegramCtx.message?.text?.split(' ').slice(1) || [];
    if (args.length > 0) {
      const newModel = args.join(' ');
      ctx.activeModels.set(config.id, newModel);
      ctx.logger.info({ model: newModel, botId: config.id }, 'Active model changed');
      await telegramCtx.reply(`🔄 Model changed to: ${newModel}`);
    } else {
      await telegramCtx.reply(`🤖 Current model: ${ctx.getActiveModel(config.id)}`);
    }
  });

  // /who
  bot.command('who', async (telegramCtx) => {
    if (!isAuthorized(ctx, telegramCtx.from?.id, config)) {
      await telegramCtx.reply('⛔ Unauthorized');
      return;
    }

    const chatId = telegramCtx.chat.id;
    const users = ctx.seenUsers.get(config.id)?.get(chatId);

    if (!users || users.size === 0) {
      await telegramCtx.reply(
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

    await telegramCtx.reply(`👥 Usuarios vistos en este chat:\n\n${lines.join('\n')}`);
  });

  // /memory
  bot.command('memory', async (telegramCtx) => {
    if (!isAuthorized(ctx, telegramCtx.from?.id, config)) {
      await telegramCtx.reply('⛔ Unauthorized');
      return;
    }

    const dump = ctx.getSoulLoader(config.id).dumpMemory();

    await sendLongMessage((t) => telegramCtx.reply(t), dump);
  });
}

/**
 * Handle /start command
 */
export async function handleStart(ctx: Context, config: BotConfig): Promise<void> {
  const message = `👋 Welcome to ${config.name}!

I'm an AI-powered bot with multiple skills.

Use /help to see available commands.`;

  await ctx.reply(message);
}

/**
 * Handle /help command
 */
export async function handleHelp(
  ctx: Context,
  config: BotConfig,
  skillRegistry: {
    get(
      skillId: string
    ): { name: string; commands?: Record<string, { description: string }> } | undefined;
  }
): Promise<void> {
  const lines: string[] = [
    `🤖 *${config.name} - Available Commands*\n`,
    '📋 *General*',
    '/start - Start a new conversation',
    '/new - Start a new conversation (the current one is saved to memory)',
    '/reset - Same as /new',
    '/help - Show this help message',
    '/clear - Clear conversation history (use --no-flush to skip memory save)',
    '/model - Show or change the active AI model',
    '/who - Show users seen in this chat',
    '/memory - Show all stored memory (newest first)\n',
  ];

  for (const skillId of config.skills) {
    const skill = skillRegistry.get(skillId);
    if (!skill || !skill.commands) continue;

    lines.push(`🔧 *${skill.name}*`);

    for (const [command, handler] of Object.entries(skill.commands)) {
      lines.push(`/${command} - ${handler.description}`);
    }

    lines.push('');
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}
