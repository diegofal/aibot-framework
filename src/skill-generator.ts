import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudeGenerate } from './claude-cli';
import type { Logger } from './logger';

export interface SkillGenerationInput {
  id: string;
  name: string;
  description: string;
  purpose: string;
}

export interface GeneratedSkill {
  skillJson: Record<string, unknown>;
  handlerCode: string;
}

/**
 * Gather 1-2 examples from existing external skill directories.
 */
function gatherExamples(skillsFolderPaths: string[]): string {
  const examples: string[] = [];

  for (const basePath of skillsFolderPaths) {
    if (!existsSync(basePath)) continue;

    let entries: string[];
    try {
      entries = readdirSync(basePath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillDir = join(basePath, entry);
      const manifestPath = join(skillDir, 'skill.json');
      const handlerPath = join(skillDir, 'index.ts');

      if (!existsSync(manifestPath)) continue;

      let manifest: string;
      let handler: string | null = null;
      try {
        manifest = readFileSync(manifestPath, 'utf-8').trim();
        if (existsSync(handlerPath)) {
          handler = readFileSync(handlerPath, 'utf-8').trim();
        }
      } catch {
        continue;
      }

      const parts = [`### Example: ${entry}`];
      parts.push(`**skill.json:**\n\`\`\`json\n${manifest}\n\`\`\``);
      if (handler) {
        // Truncate long handlers
        const truncated =
          handler.length > 2000 ? `${handler.slice(0, 2000)}\n// ... truncated` : handler;
        parts.push(`**index.ts:**\n\`\`\`typescript\n${truncated}\n\`\`\``);
      }

      examples.push(parts.join('\n\n'));
      if (examples.length >= 2) break;
    }

    if (examples.length >= 2) break;
  }

  return examples.length > 0
    ? `## Examples from existing skills\n\n${examples.join('\n\n---\n\n')}`
    : '';
}

function buildPrompt(input: SkillGenerationInput, skillsFolderPaths: string[]): string {
  const examples = gatherExamples(skillsFolderPaths);

  const parts = [
    "You are an external skill designer for the AIBot Framework. Generate a skill package (skill.json + index.ts) based on the user's requirements.",
    '',
    '## Output Format',
    'Respond with ONLY a JSON object containing two fields:',
    '- `skillJson`: the full skill.json manifest object',
    '- `handlerCode`: the full index.ts source code as a string',
    'No markdown fences, no explanations — just the raw JSON.',
    '',
    '## skill.json Format',
    '```json',
    '{',
    '  "id": "skill-id",',
    '  "name": "Skill Name",',
    '  "version": "1.0.0",',
    '  "description": "What this skill does",',
    '  "requires": {',
    '    "bins": ["optional-binary"],',
    '    "env": ["OPTIONAL_ENV_VAR"]',
    '  },',
    '  "tools": [',
    '    {',
    '      "name": "tool_name",',
    '      "description": "What this tool does",',
    '      "parameters": {',
    '        "type": "object",',
    '        "properties": {',
    '          "param_name": { "type": "string", "description": "..." }',
    '        },',
    '        "required": ["param_name"]',
    '      }',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '## index.ts Handler Format',
    '```typescript',
    'import type { SkillContext } from "./types";',
    '',
    'export const handlers = {',
    '  tool_name: async (args: Record<string, unknown>, ctx: SkillContext) => {',
    '    // Implementation here',
    '    return { success: true, result: "..." };',
    '  },',
    '};',
    '```',
    '',
    '## SkillContext Interface',
    '- `state`: Map<string, unknown> — per-skill persistent state during runtime',
    '- `config`: Record<string, unknown> — skill configuration from skill.json + framework overrides',
    '- `logger`: Logger — structured logger with info/warn/error/debug methods',
    '',
    '## Rules',
    '- Tool names must be snake_case and match handler keys exactly.',
    '- Keep the skill focused on its stated purpose.',
    '- Include proper error handling in handlers.',
    '- The `requires` field is optional — only include it if the skill needs specific binaries or env vars.',
    '- Do not import from the framework — skills are self-contained.',
    '',
  ];

  if (examples) {
    parts.push(examples, '');
  }

  parts.push(
    '## Skill to Create',
    `- **ID:** ${input.id}`,
    `- **Name:** ${input.name}`,
    `- **Description:** ${input.description}`,
    `- **Purpose:** ${input.purpose}`,
    '',
    'Respond with the JSON now.'
  );

  return parts.join('\n');
}

/**
 * Generate an external skill package using Claude CLI.
 */
export async function generateSkill(
  input: SkillGenerationInput,
  opts: {
    claudePath?: string;
    timeout?: number;
    skillsFolderPaths: string[];
    logger: Logger;
  }
): Promise<GeneratedSkill> {
  const prompt = buildPrompt(input, opts.skillsFolderPaths);

  opts.logger.info({ id: input.id, name: input.name }, 'skill-generator: calling Claude CLI');

  const raw = await claudeGenerate(prompt, {
    claudePath: opts.claudePath,
    timeout: opts.timeout ?? 300_000,
    maxLength: 50_000,
    logger: opts.logger,
  });

  // Strip markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    opts.logger.error({ raw: cleaned.slice(0, 500) }, 'skill-generator: failed to parse JSON');
    throw new Error('Failed to parse generated skill JSON');
  }

  const skillJson = parsed.skillJson;
  const handlerCode = parsed.handlerCode;

  if (!skillJson || typeof skillJson !== 'object') {
    throw new Error('Generated skill is missing "skillJson" field');
  }
  if (typeof handlerCode !== 'string' || !handlerCode.trim()) {
    throw new Error('Generated skill is missing "handlerCode" field');
  }

  opts.logger.info(
    { id: input.id, handlerLen: (handlerCode as string).length },
    'skill-generator: generation complete'
  );

  return {
    skillJson: skillJson as Record<string, unknown>,
    handlerCode: handlerCode as string,
  };
}
