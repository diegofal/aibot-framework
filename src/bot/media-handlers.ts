import type { Bot, Context } from 'grammy';
import type { BotConfig } from '../config';
import { MediaError } from '../media';
import type { BotContext } from './types';

/**
 * Media handlers for Telegram bot
 * Extracted from handler-registrar.ts to reduce SRP violation
 */

export interface MediaHandlerDeps {
  ctx: BotContext;
}

/**
 * Track user in seen users map
 */
export function trackUser(ctx: BotContext, telegramCtx: Context): void {
  const chatId = telegramCtx.chat?.id;
  const from = telegramCtx.from;
  if (!chatId || !from || from.is_bot) return;

  if (!ctx.seenUsers.has(chatId)) {
    ctx.seenUsers.set(chatId, new Map());
  }
  ctx.seenUsers.get(chatId)?.set(from.id, {
    id: from.id,
    firstName: from.first_name,
    username: from.username,
    lastSeen: Date.now(),
  });
}

/**
 * Check if user is authorized for this bot
 */
export function isAuthorized(
  ctx: BotContext,
  userId: number | undefined,
  config: BotConfig
): boolean {
  if (!userId) return false;
  if (!config.allowedUsers || config.allowedUsers.length === 0) return true;
  return config.allowedUsers.includes(userId);
}

/**
 * Build Telegram file URL from file path
 */
export function buildFileUrl(config: BotConfig, filePath: string): string {
  return `https://api.telegram.org/file/bot${config.token}/${filePath}`;
}

/**
 * Register all media handlers (photo, document, voice)
 */
export function registerMediaHandlers(bot: Bot, config: BotConfig, deps: MediaHandlerDeps): void {
  const { ctx } = deps;
  const sessionConfig = ctx.config.session;
  const mediaHandler = ctx.mediaHandler!;
  const botLogger = ctx.getBotLogger(config.id);

  // Photo handler
  bot.on('message:photo', async (telegramCtx) => {
    trackUser(ctx, telegramCtx);
    if (!isAuthorized(ctx, telegramCtx.from?.id, config)) return;

    const isGroup = telegramCtx.chat.type === 'group' || telegramCtx.chat.type === 'supergroup';
    const botUsername = telegramCtx.me?.username;

    if (isGroup && sessionConfig.enabled) {
      if (
        !ctx.sessionManager.shouldRespondInGroup(
          telegramCtx,
          botUsername,
          config.id,
          config.mentionPatterns
        )
      ) {
        return;
      }
    }

    try {
      const photos = telegramCtx.message.photo;
      const photo = photos[photos.length - 1];
      const file = await telegramCtx.api.getFile(photo.file_id);
      const fileUrl = buildFileUrl(config, file.file_path!);

      let caption = telegramCtx.message.caption;
      if (caption && isGroup && botUsername) {
        caption = ctx.sessionManager.stripBotMention(caption, botUsername, config.mentionPatterns);
      }

      const result = await mediaHandler.processPhoto(
        fileUrl,
        caption ?? undefined,
        photo.file_size
      );
      const sessionKey = ctx.sessionManager.deriveKey(config.id, telegramCtx);
      const serializedKey = ctx.sessionManager.serializeKey(sessionKey);
      ctx.messageBuffer?.enqueue({
        sessionKey: serializedKey,
        ctx: telegramCtx,
        config,
        userText: result.text,
        images: result.images,
        sessionText: result.sessionText,
        messageId: telegramCtx.message?.message_id,
        isMedia: true,
        timestamp: Date.now(),
      });
    } catch (error) {
      if (error instanceof MediaError) {
        await telegramCtx.reply(error.message);
      } else {
        botLogger.error({ error, chatId: telegramCtx.chat.id }, 'Failed to process photo');
        await telegramCtx.reply('❌ Failed to process image. Please try again later.');
      }
    }
  });

  // Document handler
  bot.on('message:document', async (telegramCtx) => {
    trackUser(ctx, telegramCtx);
    if (!isAuthorized(ctx, telegramCtx.from?.id, config)) return;

    const isGroup = telegramCtx.chat.type === 'group' || telegramCtx.chat.type === 'supergroup';
    const botUsername = telegramCtx.me?.username;

    if (isGroup && sessionConfig.enabled) {
      if (
        !ctx.sessionManager.shouldRespondInGroup(
          telegramCtx,
          botUsername,
          config.id,
          config.mentionPatterns
        )
      ) {
        return;
      }
    }

    try {
      const doc = telegramCtx.message.document;
      const file = await telegramCtx.api.getFile(doc.file_id);
      const fileUrl = buildFileUrl(config, file.file_path!);

      let caption = telegramCtx.message.caption;
      if (caption && isGroup && botUsername) {
        caption = ctx.sessionManager.stripBotMention(caption, botUsername, config.mentionPatterns);
      }

      const result = await mediaHandler.processDocument(
        fileUrl,
        doc.mime_type,
        doc.file_name,
        caption ?? undefined,
        doc.file_size
      );
      const sessionKey = ctx.sessionManager.deriveKey(config.id, telegramCtx);
      const serializedKey = ctx.sessionManager.serializeKey(sessionKey);
      ctx.messageBuffer?.enqueue({
        sessionKey: serializedKey,
        ctx: telegramCtx,
        config,
        userText: result.text,
        images: result.images,
        sessionText: result.sessionText,
        messageId: telegramCtx.message?.message_id,
        isMedia: true,
        timestamp: Date.now(),
      });
    } catch (error) {
      if (error instanceof MediaError) {
        await telegramCtx.reply(error.message);
      } else {
        botLogger.error({ error, chatId: telegramCtx.chat.id }, 'Failed to process document');
        await telegramCtx.reply('❌ Failed to process document. Please try again later.');
      }
    }
  });

  // Voice handler
  bot.on('message:voice', async (telegramCtx) => {
    trackUser(ctx, telegramCtx);
    if (!isAuthorized(ctx, telegramCtx.from?.id, config)) return;

    const isGroup = telegramCtx.chat.type === 'group' || telegramCtx.chat.type === 'supergroup';
    const botUsername = telegramCtx.me?.username;

    if (isGroup && sessionConfig.enabled) {
      if (
        !ctx.sessionManager.shouldRespondInGroup(
          telegramCtx,
          botUsername,
          config.id,
          config.mentionPatterns
        )
      ) {
        return;
      }
    }

    try {
      const voice = telegramCtx.message.voice;
      const file = await telegramCtx.api.getFile(voice.file_id);
      const fileUrl = buildFileUrl(config, file.file_path!);

      const result = await mediaHandler.processVoice(fileUrl, voice.duration, voice.file_size);
      const sessionKey = ctx.sessionManager.deriveKey(config.id, telegramCtx);
      const serializedKey = ctx.sessionManager.serializeKey(sessionKey);
      ctx.messageBuffer?.enqueue({
        sessionKey: serializedKey,
        ctx: telegramCtx,
        config,
        userText: result.text,
        sessionText: result.sessionText,
        messageId: telegramCtx.message?.message_id,
        isMedia: true,
        isVoice: true,
        timestamp: Date.now(),
      });
    } catch (error) {
      if (error instanceof MediaError) {
        await telegramCtx.reply(error.message);
      } else {
        botLogger.error({ error, chatId: telegramCtx.chat.id }, 'Failed to process voice message');
        await telegramCtx.reply('❌ Failed to process voice message. Please try again later.');
      }
    }
  });

  botLogger.info('Media handlers registered (photo, document, voice)');
}
