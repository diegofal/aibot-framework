import type { Tool, ToolResult } from './types';
import type { SoulLoader } from '../soul';
import type { Logger } from '../logger';

/**
 * Tool that lets the LLM persist facts to the daily memory log
 */
export function createSaveMemoryTool(soulLoader: SoulLoader): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'save_memory',
        description:
          'Save a fact, preference, or piece of context to your persistent memory. ' +
          'Use this when you learn something worth remembering for future conversations.',
        parameters: {
          type: 'object',
          properties: {
            fact: {
              type: 'string',
              description: 'The fact or preference to remember',
            },
          },
          required: ['fact'],
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      logger: Logger
    ): Promise<ToolResult> {
      const fact = String(args.fact ?? '').trim();
      if (!fact) {
        return { success: false, content: 'Missing required parameter: fact' };
      }

      try {
        soulLoader.appendDailyMemory(fact);
        logger.info({ fact }, 'save_memory executed');
        return { success: true, content: `Saved to memory: ${fact}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'save_memory failed');
        return { success: false, content: `Failed to save memory: ${message}` };
      }
    },
  };
}

/**
 * Tool that lets the LLM rewrite SOUL.md (personality/tone/rules)
 */
export function createUpdateSoulTool(soulLoader: SoulLoader): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'update_soul',
        description:
          'Rewrite your personality, tone, and behavioral rules. ' +
          'The content you provide replaces your entire soul definition. ' +
          'Use this when the user asks you to change how you behave.',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description:
                'The full new soul content (personality, tone, style rules)',
            },
          },
          required: ['content'],
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      logger: Logger
    ): Promise<ToolResult> {
      const content = String(args.content ?? '').trim();
      if (!content) {
        return { success: false, content: 'Missing required parameter: content' };
      }

      try {
        soulLoader.writeSoul(content);
        logger.info('update_soul executed');
        return { success: true, content: 'Soul updated.' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'update_soul failed');
        return { success: false, content: `Failed to update soul: ${message}` };
      }
    },
  };
}

/**
 * Tool that lets the LLM change identity fields in IDENTITY.md
 */
export function createUpdateIdentityTool(soulLoader: SoulLoader): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'update_identity',
        description:
          'Change your name, emoji, or vibe. ' +
          'Only the fields you provide will be updated; others stay the same.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'New display name',
            },
            emoji: {
              type: 'string',
              description: 'New emoji that represents you',
            },
            vibe: {
              type: 'string',
              description: 'New vibe or short personality tagline',
            },
          },
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      logger: Logger
    ): Promise<ToolResult> {
      const fields: { name?: string; emoji?: string; vibe?: string } = {};
      if (args.name !== undefined) fields.name = String(args.name);
      if (args.emoji !== undefined) fields.emoji = String(args.emoji);
      if (args.vibe !== undefined) fields.vibe = String(args.vibe);

      if (Object.keys(fields).length === 0) {
        return {
          success: false,
          content: 'At least one field (name, emoji, or vibe) is required',
        };
      }

      try {
        soulLoader.writeIdentity(fields);
        const changed = Object.entries(fields)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        logger.info({ fields }, 'update_identity executed');
        return { success: true, content: `Identity updated: ${changed}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'update_identity failed');
        return { success: false, content: `Failed to update identity: ${message}` };
      }
    },
  };
}
