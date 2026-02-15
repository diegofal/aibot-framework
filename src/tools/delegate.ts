import type { Tool, ToolResult } from './types';

export interface DelegationHandler {
  handleDelegation(targetBotId: string, chatId: number, message: string, sourceBotId: string): Promise<string>;
}

export function createDelegationTool(getHandler: () => DelegationHandler): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'delegate_to_bot',
        description:
          'Delegate a message to another bot in the group. The target bot will respond as itself. ' +
          'Use this when the user\'s request is better handled by another bot.',
        parameters: {
          type: 'object',
          properties: {
            targetBotId: {
              type: 'string',
              description: 'The ID of the bot to delegate to',
            },
            message: {
              type: 'string',
              description: 'The context/prompt to pass to the target bot (what the user wants)',
            },
          },
          required: ['targetBotId', 'message'],
        },
      },
    },

    async execute(args, logger): Promise<ToolResult> {
      const targetBotId = args.targetBotId as string;
      const message = args.message as string;
      const chatId = args._chatId as number | undefined;
      const sourceBotId = args._botId as string | undefined;

      if (!chatId || !sourceBotId) {
        return { success: false, content: 'Internal error: missing chat context for delegation' };
      }

      if (targetBotId === sourceBotId) {
        return { success: false, content: 'Cannot delegate to yourself' };
      }

      if (!message) {
        return { success: false, content: 'message is required for delegation' };
      }

      try {
        const handler = getHandler();
        const response = await handler.handleDelegation(targetBotId, chatId, message, sourceBotId);
        return {
          success: true,
          content: `Delegation successful. ${targetBotId} responded in the chat.`,
        };
      } catch (err) {
        logger.error({ err, targetBotId, chatId }, 'Delegation failed');
        return { success: false, content: `Delegation failed: ${String(err)}` };
      }
    },
  };
}
