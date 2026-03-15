import type { Logger } from '../logger';
import type { Tool, ToolResult } from '../tools/types';
import type { A2AClient } from './client';
import type { AgentCard, AgentSkill, TextPart } from './types';

/**
 * Create framework tools from an external A2A agent's skills.
 * Each skill becomes a tool: `a2a_{agentName}_{skillId}`
 */
export function adaptA2AAgentToTools(
  agentName: string,
  card: AgentCard,
  client: A2AClient
): Tool[] {
  return card.skills.map((skill) => createA2AToolFromSkill(agentName, skill, client));
}

function createA2AToolFromSkill(agentName: string, skill: AgentSkill, client: A2AClient): Tool {
  const toolName = `a2a_${sanitize(agentName)}_${sanitize(skill.id)}`;

  return {
    definition: {
      type: 'function',
      function: {
        name: toolName,
        description: `[A2A Agent: ${agentName}] ${skill.description}`,
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The message/request to send to the agent',
            },
            sessionId: {
              type: 'string',
              description: 'Session ID for multi-turn conversations (optional)',
            },
          },
          required: ['message'],
        },
      },
    },
    async execute(args: Record<string, unknown>, _logger: Logger): Promise<ToolResult> {
      const message = String(args.message ?? '');
      const sessionId = args.sessionId as string | undefined;

      try {
        const task = await client.sendMessage(
          { role: 'user', parts: [{ type: 'text', text: message }] },
          sessionId
        );

        const responseText =
          task.messages
            ?.filter((m) => m.role === 'agent')
            .flatMap((m) => m.parts)
            .filter((p): p is TextPart => p.type === 'text')
            .map((p) => p.text)
            .join('\n') ?? 'No response';

        return {
          success: true,
          content: responseText,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return { success: false, content: `A2A call failed: ${errMsg}` };
      }
    },
  };
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}
