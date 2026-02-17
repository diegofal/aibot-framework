import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { claudeGenerate } from './claude-cli';
import type { Logger } from './logger';

export interface SoulGenerationInput {
  name: string;
  role: string;
  personalityDescription: string;
  language?: string; // default: "Spanish"
  emoji?: string;
}

export interface GeneratedSoul {
  identity: string;
  soul: string;
  motivations: string;
}

/**
 * Read existing bots' soul files from subdirectories as few-shot examples.
 * Returns formatted examples for inclusion in the prompt.
 */
function gatherExamples(soulDir: string): string {
  const examples: string[] = [];

  try {
    const entries = readdirSync(soulDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const botDir = join(soulDir, entry.name);
      const identity = readFileSafe(join(botDir, 'IDENTITY.md'));
      const soul = readFileSafe(join(botDir, 'SOUL.md'));
      const motivations = readFileSafe(join(botDir, 'MOTIVATIONS.md'));

      if (!identity && !soul) continue; // skip empty dirs

      const parts = [`### Example: ${entry.name}`];
      if (identity) parts.push(`**IDENTITY.md:**\n\`\`\`\n${identity}\n\`\`\``);
      if (soul) parts.push(`**SOUL.md:**\n\`\`\`\n${soul}\n\`\`\``);
      if (motivations) parts.push(`**MOTIVATIONS.md:**\n\`\`\`\n${motivations}\n\`\`\``);

      examples.push(parts.join('\n\n'));

      // Include at most 2 examples to keep prompt manageable
      if (examples.length >= 2) break;
    }
  } catch {
    // soulDir doesn't exist or not readable
  }

  return examples.length > 0
    ? `## Examples from existing bots\n\n${examples.join('\n\n---\n\n')}`
    : '';
}

function readFileSafe(filepath: string): string | null {
  try {
    if (!existsSync(filepath)) return null;
    const content = readFileSync(filepath, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

function buildPrompt(input: SoulGenerationInput, soulDir: string): string {
  const language = input.language || 'Spanish';
  const examples = gatherExamples(soulDir);

  const parts = [
    'You are a bot personality designer. Generate three soul files for a new Telegram bot.',
    '',
    '## Output Format',
    'Respond with ONLY a JSON object containing three string fields: identity, soul, motivations.',
    'No markdown fences, no explanations — just the raw JSON.',
    '',
    '## File Formats',
    '',
    '### IDENTITY.md',
    'Key-value format, one per line. Required fields:',
    '- name: the bot\'s display name',
    '- emoji: a single emoji representing the bot',
    '- vibe: a short description of the bot\'s personality (one sentence)',
    '',
    '### SOUL.md',
    'Markdown with these sections:',
    '- ## Personality Foundation — bullet points defining core traits',
    '- ## Communication Style — how the bot talks',
    '- ## Boundaries — what the bot won\'t do',
    'Additional sections are welcome if the role demands them (e.g. ## Therapeutic Approach).',
    '',
    '### MOTIVATIONS.md',
    'Markdown with these sections:',
    '- ## Core Drives — stable anchors, deep values',
    '- ## Current Focus — what to pay attention to right now',
    '- ## Open Questions — curiosities to explore',
    '- ## Self-Observations — behavioral patterns',
    '- ## Last Reflection — date: (none yet), trigger: (none), changes: (none)',
    '',
    `## Language`,
    `Write ALL content in ${language}. Use culturally appropriate idioms and tone.`,
    '',
  ];

  if (examples) {
    parts.push(examples, '');
  }

  parts.push(
    '## Bot to Create',
    `- **Name:** ${input.name}`,
    `- **Role:** ${input.role}`,
    `- **Personality:** ${input.personalityDescription}`,
  );

  if (input.emoji) {
    parts.push(`- **Emoji:** ${input.emoji}`);
  } else {
    parts.push('- **Emoji:** Choose an appropriate emoji based on the role and personality.');
  }

  parts.push(
    '',
    '## Instructions',
    '- Create a rich, distinctive personality — not a generic assistant.',
    '- The soul should feel like a real character with depth, quirks, and opinions.',
    '- Match the voice and tone to the role. A therapist sounds different from a coach, which sounds different from a comedian.',
    '- The motivations should be aspirational but specific to this bot\'s purpose.',
    '- Make the personality coherent across all three files.',
    '',
    'Respond with the JSON now.',
  );

  return parts.join('\n');
}

/**
 * Generate soul files for a new bot using Claude CLI.
 */
export async function generateSoul(
  input: SoulGenerationInput,
  opts: { claudePath?: string; timeout?: number; soulDir: string; logger: Logger },
): Promise<GeneratedSoul> {
  const prompt = buildPrompt(input, opts.soulDir);

  opts.logger.info(
    { name: input.name, role: input.role },
    'soul-generator: calling Claude CLI',
  );

  const raw = await claudeGenerate(prompt, {
    claudePath: opts.claudePath,
    timeout: opts.timeout ?? 90_000,
    maxLength: 30_000,
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
    opts.logger.error({ raw: cleaned.slice(0, 500) }, 'soul-generator: failed to parse JSON');
    throw new Error('Failed to parse generated soul JSON');
  }

  const identity = typeof parsed.identity === 'string' ? parsed.identity.trim() : '';
  const soul = typeof parsed.soul === 'string' ? parsed.soul.trim() : '';
  const motivations = typeof parsed.motivations === 'string' ? parsed.motivations.trim() : '';

  if (!identity || !soul || !motivations) {
    throw new Error('Generated soul is missing required fields (identity, soul, or motivations)');
  }

  opts.logger.info(
    { name: input.name, identityLen: identity.length, soulLen: soul.length, motivationsLen: motivations.length },
    'soul-generator: generation complete',
  );

  return { identity, soul, motivations };
}
