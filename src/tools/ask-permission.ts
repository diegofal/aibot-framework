import type { Bot } from 'grammy';
import type { AskPermissionStore } from '../bot/ask-permission-store';
import type { Logger } from '../logger';
import type { Tool, ToolResult } from './types';

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
          'Request permission to perform a sensitive action (file writes outside allowed paths, command execution, external API calls, etc.). ' +
          'The request is queued in the permissions dashboard (non-blocking). Permissions never expire — the human will review them eventually. ' +
          'Use BEFORE performing any sensitive action. ' +
          'The decision (approved/denied) will be delivered to you in your next cycle. Continue working on other tasks in the meantime.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description:
                'The type of action: "file_write", "exec", "api_call", "resource_modify", etc.',
            },
            resource: {
              type: 'string',
              description: 'What is affected: file path, command, URL, resource name, etc.',
            },
            description: {
              type: 'string',
              description:
                'Human-readable explanation of why you need to do this and what will happen.',
            },
            urgency: {
              type: 'string',
              enum: ['low', 'normal', 'high'],
              description: 'How urgent the request is (default: "normal").',
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
        return {
          success: false,
          content: 'Missing required parameters: action, resource, description',
        };
      }
      if (!botId) {
        return {
          success: false,
          content: 'ask_permission requires _botId context injection',
        };
      }

      // Dedup: check pending requests
      if (deps.store.hasPendingDuplicate(botId, action, resource)) {
        return {
          success: true,
          content: `You already have a pending permission request for "${action}" on "${resource}". Wait for the human to decide before requesting again.`,
        };
      }

      // Dedup: check recently approved (resolved queue + history within 24h)
      if (deps.store.hasRecentApproval(botId, action, resource)) {
        return {
          success: true,
          content: `Permission for "${action}" on "${resource}" was already approved recently. You may proceed without requesting again.`,
        };
      }

      const urgency = ['low', 'normal', 'high'].includes(args.urgency as string)
        ? (args.urgency as 'low' | 'normal' | 'high')
        : 'normal';

      // Register in store (no timeout — permissions never expire)
      const { id, promise } = deps.store.request(botId, action, resource, description, urgency);
      promise.catch((err) => {
        logger.info(
          { requestId: id, botId, reason: err.message },
          'ask_permission: request closed without decision'
        );
      });

      // Send Telegram notification if possible
      if (chatId) {
        const bot = deps.getBotInstance(botId);
        if (bot) {
          const botName = deps.getBotName(botId);
          const urgencyEmoji = urgency === 'high' ? '🔴' : urgency === 'low' ? '🟢' : '🟡';
          const messageText = `${urgencyEmoji} **${botName} requests permission:**\n\n**Action:** ${action}\n**Resource:** ${resource}\n**Reason:** ${description}\n\n_Approve or deny in the web dashboard._`;
          try {
            await bot.api.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });
          } catch (telegramErr) {
            logger.warn(
              { botId, chatId, err: telegramErr },
              'ask_permission: failed to send Telegram notification'
            );
          }
        }
      }

      logger.info(
        { requestId: id, botId, action, resource, urgency },
        'ask_permission: request queued to dashboard (non-blocking)'
      );

      return {
        success: true,
        content: `Permission request queued (${action} on ${resource}). The decision will be available in your next cycle. Continue with other tasks in the meantime. Do NOT proceed with this action until you receive approval.`,
      };
    },
  };
}
