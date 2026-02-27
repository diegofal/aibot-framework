import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool, ToolResult } from './types';
import type { Logger } from '../logger';
import type { AskHumanStore } from '../bot/ask-human-store';
import type { ConversationsService } from '../conversations/service';
import type { FileRef } from '../types/thread';
import type { Bot } from 'grammy';

const MAX_TIMEOUT_MINUTES = 120;
const DEFAULT_TIMEOUT_MINUTES = 30;

export interface AskHumanDeps {
  store: AskHumanStore;
  getBotInstance: (botId: string) => Bot | undefined;
  getBotName: (botId: string) => string;
  conversationsService?: ConversationsService;
}

/**
 * Tool that lets the bot ask the human operator a question.
 * The question is queued to the web inbox and returns immediately (non-blocking).
 * The answer will be injected into the bot's next agent loop cycle.
 */
export function createAskHumanTool(deps: AskHumanDeps): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_human',
        description:
          'Ask the human operator a question. The question is queued in the web inbox (non-blocking). ' +
          'Use when you need information, approval, or a decision that you cannot determine on your own. ' +
          'The answer will be delivered to you in your next cycle. Continue working on other tasks in the meantime.',
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The question to ask the human operator',
            },
            timeout_minutes: {
              type: 'number',
              description: `Minutes to wait for a response (default: ${DEFAULT_TIMEOUT_MINUTES}, max: ${MAX_TIMEOUT_MINUTES})`,
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'File paths relevant to this question (relative to your working directory)',
            },
          },
          required: ['question'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const question = args.question as string;
      const botId = args._botId as string;
      const chatId = (args._chatId as number) || 0;

      if (!question) {
        return { success: false, content: 'Missing required parameter: question' };
      }
      if (!botId) {
        return { success: false, content: 'ask_human requires _botId (only available in agent loop)' };
      }

      if (deps.store.hasPendingForBot(botId)) {
        return {
          success: true,
          content: 'You already have a pending question in the inbox. Wait for the human to respond before asking again.',
        };
      }

      const timeoutMinutes = Math.min(
        Math.max(1, Number(args.timeout_minutes) || DEFAULT_TIMEOUT_MINUTES),
        MAX_TIMEOUT_MINUTES,
      );
      const timeoutMs = timeoutMinutes * 60_000;

      // Register the question in the store (always works — visible in web inbox)
      const { id, promise } = deps.store.ask(botId, chatId, question, timeoutMs);
      promise.catch((err) => {
        logger.info({ questionId: id, botId, reason: err.message }, 'ask_human: question closed without answer');
      });

      // Resolve file references
      const rawFiles = Array.isArray(args.files) ? args.files as string[] : [];
      const workDir = args._workDir as string | undefined;
      const fileRefs: FileRef[] = [];
      for (const filePath of rawFiles) {
        if (typeof filePath !== 'string' || !filePath) continue;
        try {
          const absPath = workDir ? resolve(workDir, filePath) : filePath;
          if (existsSync(absPath)) {
            const st = statSync(absPath);
            fileRefs.push({ path: filePath, size: st.size });
          } else {
            fileRefs.push({ path: filePath });
          }
        } catch {
          fileRefs.push({ path: filePath });
        }
      }

      // Create inbox conversation so the question persists as a thread
      if (deps.conversationsService) {
        try {
          const truncatedQuestion = question.length > 60
            ? question.slice(0, 57) + '...'
            : question;
          const conv = deps.conversationsService.createConversation(botId, 'inbox', truncatedQuestion, {
            askHumanQuestionId: id,
            inboxStatus: 'pending',
          });
          deps.conversationsService.addMessage(botId, conv.id, 'bot', question, fileRefs.length > 0 ? fileRefs : undefined);
          deps.store.setConversationId(id, conv.id);
          logger.debug({ questionId: id, conversationId: conv.id, files: fileRefs.length }, 'ask_human: inbox conversation created');
        } catch (err) {
          logger.warn({ err, questionId: id }, 'ask_human: failed to create inbox conversation (non-fatal)');
        }
      }

      // Send Telegram notification if we have a valid chatId and bot instance
      if (chatId) {
        const bot = deps.getBotInstance(botId);
        if (bot) {
          const botName = deps.getBotName(botId);
          const messageText =
            `🤖 **${botName} needs your input:**\n\n${question}\n\n_Reply to this message to answer._`;
          try {
            const sent = await bot.api.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });
            deps.store.setMessageId(id, sent.message_id);
          } catch (telegramErr) {
            logger.warn({ botId, chatId, err: telegramErr }, 'ask_human: failed to send Telegram notification, question still queued in inbox');
          }
        }
      }

      logger.info(
        { questionId: id, botId, chatId: chatId || null, timeoutMinutes },
        'ask_human: question queued to inbox (non-blocking)',
      );

      return {
        success: true,
        content: 'Question has been queued to the human inbox. ' +
          'The answer will be available in your next cycle. ' +
          'Continue with other tasks in the meantime.',
      };
    },
  };
}
