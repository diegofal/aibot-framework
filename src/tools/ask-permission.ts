import type { Tool, ToolResult } from './types';
import type { Logger } from '../logger';
import type { AskPermissionStore } from '../bot/ask-permission-store';
import type { Bot } from 'grammy';

const MAX_TIMEOUT_MINUTES = 480;
const DEFAULT_TIMEOUT_MINUTES = 60;

export interface AskPermissionDeps {
  store: AskPermissionStore;
  getBotInstance: (botId: string) => Bot | undefined;
  getBotName: (botId: string) => string;
}

/**
 * Tool that lets the bot request permission to perform a sensitive action.
 * The request is queued to the web dashboard and returns immediately (non-blocking).
 * The decision (approved/denied) will be injected into the bot's next agent loop cycle.
 */
export function createAskPermissionTool(deps: AskPermissionDeps): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_permission',
        description:
          'Request permission to perform a sensitive action (file writes, command execution, external API calls, etc.). ' +
          'The request is queued in the permissions dashboard (non-blocking). ' +
          'Use BEFORE performing any sensitive action. ' +
          'The decision (approved/denied) will be delivered to you in your next cycle. Continue working on other tasks in the meantime.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'The type of action: "file_write", "exec", "api_call", "resource_modify", etc.',
            },
            resource: {
              type: 'string',
              description: 'What is affected: file path, command, URL, resource name, etc.',
            },
            description: {
              type: 'string',
              description: 'Human-readable explanation of why you need to do this and what will happen.',
            },
            urgency: {
              type: 'string',
              enum: ['low', 'normal', 'high'],
              description: 'How urgent the request is (default: "normal").',
            },
            timeout_minutes: {
              type: 'number',
              description: `Minutes to wait for a decision (default: ${DEFAULT_TIMEOUT_MINUTES}, max: ${MAX_TIMEOUT_MINUTES}).`,
            },
          },
          required: ['action', 'resource', 'description'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const action = args.action as string;
      const resource = args.resource as string;
      const description = args.description as string;
      const botId = args._botId as string;
      const chatId = (args._chatId as number) || 0;

      if (!action || !resource || !description) {
        return { success: false, content: 'Missing required parameters: action, resource, description' };
      }
      if (!botId) {
        return { success: false, content: 'ask_permission requires _botId (only available in agent loop)' };
      }

      // Dedup check
      if (deps.store.hasPendingDuplicate(botId, action, resource)) {
        return {
          success: true,
          content: `You already have a pending permission request for "${action}" on "${resource}". Wait for the human to decide before requesting again.`,
        };
      }

      const urgency = (['low', 'normal', 'high'].includes(args.urgency as string)
        ? args.urgency as 'low' | 'normal' | 'high'
        : 'normal');

      const timeoutMinutes = Math.min(
        Math.max(1, Number(args.timeout_minutes) || DEFAULT_TIMEOUT_MINUTES),
        MAX_TIMEOUT_MINUTES,
      );
      const timeoutMs = timeoutMinutes * 60_000;

      // Register in store
      const { id, promise } = deps.store.request(botId, action, resource, description, urgency, timeoutMs);
      promise.catch((err) => {
        logger.info({ requestId: id, botId, reason: err.message }, 'ask_permission: request closed without decision');
      });

      // Send Telegram notification if possible
      if (chatId) {
        const bot = deps.getBotInstance(botId);
        if (bot) {
          const botName = deps.getBotName(botId);
          const urgencyEmoji = urgency === 'high' ? '🔴' : urgency === 'low' ? '🟢' : '🟡';
          const messageText =
            `${urgencyEmoji} **${botName} requests permission:**\n\n` +
            `**Action:** ${action}\n` +
            `**Resource:** ${resource}\n` +
            `**Reason:** ${description}\n\n` +
            `_Approve or deny in the web dashboard._`;
          try {
            await bot.api.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });
          } catch (telegramErr) {
            logger.warn({ botId, chatId, err: telegramErr }, 'ask_permission: failed to send Telegram notification');
          }
        }
      }

      logger.info(
        { requestId: id, botId, action, resource, urgency, timeoutMinutes },
        'ask_permission: request queued to dashboard (non-blocking)',
      );

      return {
        success: true,
        content: `Permission request queued (${action} on ${resource}). ` +
          'The decision will be available in your next cycle. ' +
          'Continue with other tasks in the meantime. ' +
          'Do NOT proceed with this action until you receive approval.',
      };
    },
  };
}
