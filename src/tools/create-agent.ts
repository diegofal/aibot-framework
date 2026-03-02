import type { BotConfig } from '../config';
import type { Logger } from '../logger';
import type { AgentProposalStore } from './agent-proposal-store';
import type { Tool, ToolResult } from './types';

const ID_PATTERN = /^[a-z][a-z0-9_-]{2,39}$/;

const RESERVED_IDS = new Set([
  'admin',
  'system',
  'bot',
  'test',
  'root',
  'api',
  'web',
  'mcp',
  'cron',
]);

export function createCreateAgentTool(
  store: AgentProposalStore,
  configBots: BotConfig[],
  maxAgents: number,
  maxProposalsPerBot: number
): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'create_agent',
        description:
          'Propose the creation of a new agent in the ecosystem. ' +
          'The proposal will be reviewed by a human before the agent is created. ' +
          'Use this when you identify a gap in the ecosystem that a new specialized agent could fill.',
        parameters: {
          type: 'object',
          properties: {
            agent_id: {
              type: 'string',
              description:
                'Unique ID for the agent (lowercase, 3-40 chars, starts with letter). Example: "content-creator"',
            },
            name: {
              type: 'string',
              description: 'Display name for the agent. Example: "ContentBot"',
            },
            role: {
              type: 'string',
              description:
                'What this agent does. Example: "Content creation and editorial planning"',
            },
            personality_description: {
              type: 'string',
              description:
                'Detailed personality description (min 50 chars) used to generate soul files. ' +
                'Describe tone, style, values, and behavioral traits.',
            },
            skills: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of skill IDs to assign to the agent',
            },
            justification: {
              type: 'string',
              description:
                'Why this agent is needed in the ecosystem (min 20 chars). ' +
                'Explain the gap it fills and how it complements existing agents.',
            },
            emoji: {
              type: 'string',
              description: 'Optional emoji representing the agent',
            },
            language: {
              type: 'string',
              description: 'Language for soul generation (default: "Spanish")',
            },
            model: {
              type: 'string',
              description: 'Optional LLM model override',
            },
            llm_backend: {
              type: 'string',
              description: 'Optional LLM backend: "ollama" or "claude-cli"',
            },
            agent_loop: {
              type: 'object',
              description:
                'Optional agent loop config: { mode: "periodic"|"continuous", every: "6h" }',
            },
          },
          required: [
            'agent_id',
            'name',
            'role',
            'personality_description',
            'skills',
            'justification',
          ],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const agentId = String(args.agent_id ?? '').trim();
      const name = String(args.name ?? '').trim();
      const role = String(args.role ?? '').trim();
      const personalityDescription = String(args.personality_description ?? '').trim();
      const skills = Array.isArray(args.skills) ? (args.skills as string[]) : [];
      const justification = String(args.justification ?? '').trim();
      const emoji = args.emoji ? String(args.emoji).trim() : undefined;
      const language = args.language ? String(args.language).trim() : undefined;
      const model = args.model ? String(args.model).trim() : undefined;
      const llmBackend = args.llm_backend
        ? (String(args.llm_backend).trim() as 'ollama' | 'claude-cli')
        : undefined;
      const agentLoop = args.agent_loop as
        | { mode?: 'periodic' | 'continuous'; every?: string }
        | undefined;
      const botId = String(args._botId ?? '');

      // Validation
      if (!agentId || !name || !role || !personalityDescription || !justification) {
        return {
          success: false,
          content:
            'Missing required parameters: agent_id, name, role, personality_description, justification',
        };
      }

      if (!ID_PATTERN.test(agentId)) {
        return {
          success: false,
          content:
            'agent_id must be 3-40 characters, start with a lowercase letter, and contain only lowercase letters, numbers, hyphens, and underscores',
        };
      }

      if (RESERVED_IDS.has(agentId)) {
        return {
          success: false,
          content: `agent_id "${agentId}" is reserved and cannot be used`,
        };
      }

      if (personalityDescription.length < 50) {
        return {
          success: false,
          content: `personality_description must be at least 50 characters (got ${personalityDescription.length})`,
        };
      }

      if (justification.length < 20) {
        return {
          success: false,
          content: `justification must be at least 20 characters (got ${justification.length})`,
        };
      }

      if (llmBackend && llmBackend !== 'ollama' && llmBackend !== 'claude-cli') {
        return {
          success: false,
          content: 'llm_backend must be "ollama" or "claude-cli"',
        };
      }

      // Check duplicate against existing bots
      if (configBots.some((b) => b.id === agentId)) {
        return {
          success: false,
          content: `An agent with id "${agentId}" already exists`,
        };
      }

      // Check duplicate against pending proposals
      const allProposals = store.list();
      const pendingWithSameId = allProposals.find(
        (p) => p.agentId === agentId && p.status === 'pending'
      );
      if (pendingWithSameId) {
        return {
          success: false,
          content: `A pending proposal for agent "${agentId}" already exists`,
        };
      }

      // Check total agents + pending < maxAgents
      const pendingCount = allProposals.filter((p) => p.status === 'pending').length;
      if (configBots.length + pendingCount >= maxAgents) {
        return {
          success: false,
          content: `Agent limit reached (${maxAgents} total agents including pending proposals)`,
        };
      }

      // Check per-bot limit
      const botPending = allProposals.filter(
        (p) => p.proposedBy === botId && p.status === 'pending'
      );
      if (botPending.length >= maxProposalsPerBot) {
        return {
          success: false,
          content: `You already have ${maxProposalsPerBot} pending proposals. Wait for them to be reviewed before proposing more.`,
        };
      }

      try {
        const proposal = store.create({
          agentId,
          agentName: name,
          role,
          personalityDescription,
          skills,
          justification,
          emoji,
          language,
          model,
          llmBackend,
          agentLoop,
          proposedBy: botId,
        });

        logger.info(
          { proposalId: proposal.id, agentId, proposedBy: botId },
          'Agent proposal created (pending approval)'
        );

        return {
          success: true,
          content: `Agent proposal for "${name}" (${agentId}) submitted successfully. It is now pending human approval in the web dashboard. Proposal ID: ${proposal.id}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, content: `Failed to create proposal: ${msg}` };
      }
    },
  };
}
