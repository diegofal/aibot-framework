import type { AgentInfo } from '../agent-registry';
import type { Tool, ToolResult } from './types';

export interface CollaborateHandler {
  discoverAgents(excludeBotId: string): Array<AgentInfo & { model?: string }>;
  collaborationStep(
    sessionId: string | undefined,
    targetBotId: string,
    message: string,
    sourceBotId: string,
  ): Promise<{ sessionId: string; response: string }>;
  endSession(sessionId: string): void;
  sendVisibleMessage(chatId: number, sourceBotId: string, targetBotId: string, message: string): Promise<void>;
}

export function createCollaborateTool(getHandler: () => CollaborateHandler): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'collaborate',
        description:
          'Collaborate with other AI agents in the system. ' +
          'Use action "discover" to list available agents with their capabilities. ' +
          'Use action "send" to send a message to another agent (supports multi-turn conversations via sessionId). ' +
          'Use action "end_session" to close a collaboration session.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['discover', 'send', 'end_session'],
              description: '"discover" to see agents and capabilities, "send" to message one, "end_session" to close a session',
            },
            targetBotId: {
              type: 'string',
              description: 'The bot ID to collaborate with (required for "send")',
            },
            message: {
              type: 'string',
              description: 'The message to send to the target agent (required for "send")',
            },
            sessionId: {
              type: 'string',
              description: 'Session ID to continue a multi-turn conversation (optional for "send", required for "end_session")',
            },
            visible: {
              type: 'boolean',
              description: 'If true, sends the message visibly in the group chat (target bot responds publicly). If false (default), the exchange is internal and invisible.',
            },
          },
          required: ['action'],
        },
      },
    },

    async execute(args, logger): Promise<ToolResult> {
      const action = args.action as string;
      const sourceBotId = args._botId as string | undefined;

      if (!sourceBotId) {
        return { success: false, content: 'Internal error: missing bot context' };
      }

      const handler = getHandler();

      if (action === 'discover') {
        const agents = handler.discoverAgents(sourceBotId);

        if (agents.length === 0) {
          return { success: true, content: 'No other agents available.' };
        }

        const list = agents.map((a) => {
          const parts = [`- **${a.botId}** (${a.name}, @${a.telegramUsername})`];
          if (a.description) parts.push(`  Description: ${a.description}`);
          if (a.skills.length > 0) parts.push(`  Skills: ${a.skills.join(', ')}`);
          if (a.tools && a.tools.length > 0) parts.push(`  Tools: ${a.tools.join(', ')}`);
          if (a.model) parts.push(`  Model: ${a.model}`);
          return parts.join('\n');
        }).join('\n\n');

        return { success: true, content: `Available agents:\n\n${list}` };
      }

      if (action === 'send') {
        const targetBotId = args.targetBotId as string;
        const message = args.message as string;
        const sessionId = args.sessionId as string | undefined;
        const visible = args.visible === true;

        if (!targetBotId) {
          return { success: false, content: 'targetBotId is required for action "send"' };
        }
        if (!message) {
          return { success: false, content: 'message is required for action "send"' };
        }
        if (targetBotId === sourceBotId) {
          return { success: false, content: 'Cannot collaborate with yourself' };
        }

        // Visible mode: send a message in the group chat mentioning the target bot
        if (visible) {
          const chatId = args._chatId as number;
          if (!chatId || chatId === 0) {
            return { success: false, content: 'Visible collaboration requires a group chat context' };
          }
          try {
            await handler.sendVisibleMessage(chatId, sourceBotId, targetBotId, message);
            return {
              success: true,
              content: 'Message sent visibly to the group chat. The target bot will respond publicly. Do NOT repeat the message content in your reply — just let the user know you asked.',
            };
          } catch (err) {
            logger.error({ err, targetBotId, sourceBotId, chatId }, 'visible collaborate send failed');
            return { success: false, content: `Visible collaboration failed: ${String(err)}` };
          }
        }

        try {
          const result = await handler.collaborationStep(sessionId, targetBotId, message, sourceBotId);
          return {
            success: true,
            content: JSON.stringify({
              sessionId: result.sessionId,
              response: result.response,
            }),
          };
        } catch (err) {
          logger.error({ err, targetBotId, sourceBotId, sessionId }, 'collaborate send failed');
          return { success: false, content: `Collaboration failed: ${String(err)}` };
        }
      }

      if (action === 'end_session') {
        const sessionId = args.sessionId as string;
        if (!sessionId) {
          return { success: false, content: 'sessionId is required for action "end_session"' };
        }
        handler.endSession(sessionId);
        return { success: true, content: `Session ${sessionId} ended.` };
      }

      return { success: false, content: `Unknown action: ${action}. Use "discover", "send", or "end_session".` };
    },
  };
}
