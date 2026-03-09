/**
 * Tool that lets the agent loop send proactive messages to users.
 * For Telegram: uses bot.api.sendMessage()
 * For Widget: appends to session transcript (visible on reconnect via history endpoint)
 */
import type { Logger } from '../logger';
import type { Tool, ToolResult } from './types';

export interface SendProactiveMessageDeps {
  sendTelegramMessage: (chatId: number, text: string) => Promise<void>;
  appendToSession: (botId: string, userId: string, text: string) => void;
}

export function createSendProactiveMessageTool(deps: SendProactiveMessageDeps): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'send_proactive_message',
        description:
          'Send a proactive message to a user. Use this to check in on student progress, ' +
          'send reminders, or follow up on goals. The message will be delivered via Telegram ' +
          'or visible when the user reconnects via the widget.',
        parameters: {
          type: 'object',
          properties: {
            chatId: {
              type: 'string',
              description: 'The chat ID or user ID to send the message to',
            },
            message: {
              type: 'string',
              description: 'The message text to send',
            },
          },
          required: ['chatId', 'message'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const chatId = String(args.chatId ?? '').trim();
      const message = String(args.message ?? '').trim();

      if (!chatId) return { success: false, content: 'Missing chatId' };
      if (!message) return { success: false, content: 'Missing message' };
      if (message.length > 4000)
        return { success: false, content: 'Message too long (max 4000 chars)' };

      const botId = String(args._botId ?? '');

      try {
        // Try Telegram first (numeric chat ID)
        const numericId = Number(chatId);
        if (!Number.isNaN(numericId) && numericId !== 0) {
          await deps.sendTelegramMessage(numericId, message);
          logger.info(
            { chatId, botId, messageLength: message.length },
            'Proactive message sent via Telegram'
          );
          return { success: true, content: `Message sent to chat ${chatId}` };
        }

        // For non-numeric IDs (widget users), append to session
        deps.appendToSession(botId, chatId, message);
        logger.info(
          { userId: chatId, botId, messageLength: message.length },
          'Proactive message appended to session'
        );
        return {
          success: true,
          content: `Message queued for user ${chatId} (visible on reconnect)`,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err, chatId, botId }, 'Failed to send proactive message');
        return { success: false, content: `Failed to send: ${errMsg}` };
      }
    },
  };
}
