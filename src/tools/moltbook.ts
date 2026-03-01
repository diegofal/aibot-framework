import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from '../logger';
import type { Tool, ToolResult } from './types';

const CREDENTIALS_PATH = join(homedir(), '.config', 'moltbook', 'credentials.json');
const REGISTER_URL = 'https://www.moltbook.com/api/v1/agents/register';
const AGENT_NAME = 'NodeSpider';

interface MoltbookCredentials {
  api_key: string;
  claim_url: string;
  verification_code: string;
  registered_at: string;
}

export function createMoltbookRegisterTool(): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'moltbook_register',
        description:
          'Register this agent as "NodeSpider" on the Moltbook agent directory. Returns a claim URL for human verification via ask_human. Checks if already registered before calling the API.',
        parameters: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'A short description of this agent for the Moltbook profile',
            },
          },
          required: ['description'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const description = args.description as string;
      if (!description || typeof description !== 'string') {
        return { success: false, content: 'Missing required parameter: description' };
      }

      // Check if already registered
      if (existsSync(CREDENTIALS_PATH)) {
        try {
          const existing = JSON.parse(
            readFileSync(CREDENTIALS_PATH, 'utf-8')
          ) as MoltbookCredentials;
          if (existing.api_key && existing.claim_url) {
            return {
              success: true,
              content: `Already registered on Moltbook as "${AGENT_NAME}". Claim URL: ${existing.claim_url}\nAPI key stored at: ${CREDENTIALS_PATH}`,
            };
          }
        } catch {
          // Corrupted file, proceed with registration
        }
      }

      try {
        const response = await fetch(REGISTER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: AGENT_NAME, description }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error(
            { status: response.status, body: errorText },
            'Moltbook registration failed'
          );
          return {
            success: false,
            content: `Moltbook registration failed (HTTP ${response.status}): ${errorText}`,
          };
        }

        const data = (await response.json()) as MoltbookCredentials;
        logger.info(
          { name: AGENT_NAME, claimUrl: data.claim_url },
          'Moltbook registration successful'
        );

        // Save credentials
        const dir = dirname(CREDENTIALS_PATH);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          CREDENTIALS_PATH,
          JSON.stringify({ ...data, registered_at: new Date().toISOString() }, null, 2)
        );

        return {
          success: true,
          content: `Registered as "${AGENT_NAME}" on Moltbook.\nClaim URL: ${data.claim_url}\nVerification code: ${data.verification_code}\nAPI key saved to: ${CREDENTIALS_PATH}\n\nUse ask_human to send the claim URL to the human for verification.`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'Moltbook registration error');
        return { success: false, content: `Moltbook registration error: ${message}` };
      }
    },
  };
}
