import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { backupSoulFile } from '../soul';
import type { Logger } from '../logger';
import type { Tool, ToolResult } from './types';

export interface ImproveToolConfig {
  claudePath: string;
  timeout: number;
  maxOutputLength: number;
  soulDir: string;
  allowedFocus: string[];
}

export const VALID_FOCUS = ['memory', 'soul', 'motivations', 'identity', 'all'] as const;
export type FocusArea = (typeof VALID_FOCUS)[number];

function buildFileScope(absDir: string, focus: FocusArea): string {
  switch (focus) {
    case 'memory':
      return (
        `Focus ONLY on the daily memory log files in ${absDir}/memory/*.md. ` +
        'Review them for: redundancy, over-verbosity, credential leaks, disorganization. ' +
        'Consolidate duplicate entries, improve clarity, remove noise.'
      );
    case 'soul':
      return (
        `Focus ONLY on ${absDir}/SOUL.md. ` +
        'Review the personality definition for: internal contradictions, vague rules, missing nuance, tone drift. ' +
        'Refine and sharpen while preserving the core voice.'
      );
    case 'motivations':
      return (
        `Focus ONLY on ${absDir}/MOTIVATIONS.md. ` +
        'Review drives, focus areas, open questions, and self-observations for: staleness, resolved questions still listed, missing patterns, vague entries. ' +
        'Update to reflect current reality.'
      );
    case 'identity':
      return (
        `Focus ONLY on ${absDir}/IDENTITY.md. ` +
        'Review name, emoji, and vibe for coherence with the soul and motivations. ' +
        'Suggest refinements if the vibe has drifted from the actual personality.'
      );
    case 'all':
      return (
        `Review ALL soul files in ${absDir}/ AND all bot subdirectories:\n` +
        '- IDENTITY.md (name, emoji, vibe)\n' +
        '- SOUL.md (personality, tone, rules)\n' +
        '- MOTIVATIONS.md (drives, focus, questions, self-observations)\n' +
        '- memory/*.md (daily memory logs)\n\n' +
        'Use Glob to discover all bots, then review each one independently.\n' +
        'Look for: contradictions between files, outdated information, redundancy in memory logs, ' +
        'personality drift, stale motivations, and opportunities to sharpen overall coherence.'
      );
  }
}

function buildClaudePrompt(
  absDir: string,
  focus: FocusArea,
  context?: string,
): string {
  const fileScope = buildFileScope(absDir, focus);

  const parts = [
    'You are a soul editor for a multi-bot AI system. Your job is to review and improve each bot\'s personality and memory files.',
    '',
    '## File Structure',
    `The soul root directory is: ${absDir}`,
    '',
    'Each bot has its own subdirectory with these files:',
    '- IDENTITY.md — name, emoji, vibe (key: value format)',
    '- SOUL.md — personality foundation, communication style, boundaries',
    '- MOTIVATIONS.md — core drives, current focus, open questions, self-observations, last reflection date',
    '- memory/*.md — daily memory logs (YYYY-MM-DD.md format), each line is a timestamped fact',
    '',
    'Use Glob to discover all bot directories: ' + absDir + '/**/IDENTITY.md',
    'Each bot is a separate personality — treat them independently, do NOT merge or mix their content.',
    '',
    '## Your Task',
    fileScope,
    '',
    '## Rules',
    '1. Read the relevant files first, then make targeted edits.',
    '2. PRESERVE the core voice and personality — you are refining, not replacing.',
    '3. NEVER delete facts about real people (names, preferences, relationships) from memory files.',
    '4. NEVER add fabricated information.',
    '5. DO consolidate redundant entries in memory (same fact stated multiple times).',
    '6. DO sharpen vague language into specific, actionable statements.',
    '7. DO remove stale/resolved open questions from MOTIVATIONS.md.',
    '8. DO fix formatting issues (inconsistent headers, missing sections).',
    '9. Keep the language consistent — if the file is in Spanish, edit in Spanish.',
    '10. After making changes, provide a summary of what you changed and why.',
  ];

  if (context) {
    parts.push(
      '',
      '## Additional Context',
      'The user/bot provided this guidance for the improvement:',
      context,
    );
  }

  parts.push(
    '',
    '## Output',
    'After making all edits, output ONLY a concise summary (max 10 bullet points) of what you changed and why. No preamble.',
  );

  return parts.join('\n');
}

/**
 * Core execution logic — spawns Claude Code CLI to improve soul files.
 * Used by both the LLM tool and the /improve skill command.
 */
export async function runImprove(opts: {
  claudePath: string;
  timeout: number;
  maxOutputLength: number;
  soulDir: string;
  focus: FocusArea;
  context?: string;
  botId?: string;
  logger: Logger;
}): Promise<ToolResult> {
  const { claudePath, timeout, maxOutputLength, soulDir, focus, context, botId, logger } = opts;

  // Resolve bot-specific soul dir if botId is provided
  let targetDir = resolve(soulDir);
  if (botId) {
    const candidateDir = resolve(soulDir, botId);
    if (existsSync(candidateDir)) {
      targetDir = candidateDir;
    }
  }

  const prompt = buildClaudePrompt(targetDir, focus, context);

  // Back up soul files that may be modified
  const filesToBackup: string[] = [];
  if (focus === 'soul' || focus === 'all') filesToBackup.push(join(targetDir, 'SOUL.md'));
  if (focus === 'identity' || focus === 'all') filesToBackup.push(join(targetDir, 'IDENTITY.md'));
  if (focus === 'motivations' || focus === 'all') filesToBackup.push(join(targetDir, 'MOTIVATIONS.md'));
  for (const f of filesToBackup) {
    backupSoulFile(f, logger);
  }

  logger.info(
    { focus, hasContext: !!context, botId, targetDir },
    'improve: spawning Claude Code session',
  );

  try {
    const claudeArgs = [
      '-p', prompt,
      '--allowedTools', 'Read,Edit,Write,Glob,Grep',
    ];

    // Clear CLAUDECODE env to avoid nested session detection
    const env = { ...process.env };
    delete env.CLAUDECODE;
    env.TERM = 'dumb';

    const proc = Bun.spawn([claudePath, ...claudeArgs], {
      cwd: resolve(soulDir, '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
    }, timeout);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    let output = stdout.trim();
    if (!output && stderr.trim()) {
      output = `(no stdout)\n--- stderr ---\n${stderr.trim()}`;
    }
    if (!output) {
      output = '(Claude produced no output)';
    }

    if (output.length > maxOutputLength) {
      output =
        output.slice(0, maxOutputLength) +
        `\n... (truncated, ${output.length} total chars)`;
    }

    logger.info(
      { focus, exitCode, outputLength: output.length, output },
      'improve: Claude Code session completed',
    );

    if (exitCode !== 0) {
      return {
        success: false,
        content: `Claude Code exited with code ${exitCode}:\n\n${output}`,
      };
    }

    return {
      success: true,
      content: `Soul improvement completed (focus: ${focus}):\n\n${output}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, focus }, 'improve: Claude Code session failed');
    return {
      success: false,
      content: `Failed to run Claude Code session: ${message}`,
    };
  }
}

export function createImproveTool(config: ImproveToolConfig): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'improve',
        description:
          'Spawn a Claude Code session to review and improve the bot\'s soul/personality/memory files. ' +
          'Use this when the user asks to refine personality, clean up memory, sharpen motivations, or improve coherence across soul files. ' +
          'This is a powerful editing operation — Claude Code will read and edit the actual files on disk.',
        parameters: {
          type: 'object',
          properties: {
            focus: {
              type: 'string',
              enum: ['memory', 'soul', 'motivations', 'identity', 'all'],
              description:
                'Which area to improve. "memory" = daily logs, "soul" = personality/tone, ' +
                '"motivations" = drives/focus/questions, "identity" = name/emoji/vibe, "all" = everything.',
            },
            context: {
              type: 'string',
              description:
                'Optional context or specific instructions for the improvement. ' +
                'E.g. "make the personality more sarcastic" or "clean up duplicate memory entries from today".',
            },
          },
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      logger: Logger,
    ): Promise<ToolResult> {
      const rawFocus = String(args.focus || 'all').toLowerCase();
      const focus: FocusArea = (VALID_FOCUS as readonly string[]).includes(rawFocus)
        ? (rawFocus as FocusArea)
        : 'all';

      if (!config.allowedFocus.includes(focus)) {
        return {
          success: false,
          content: `Focus area "${focus}" is not allowed. Permitted: ${config.allowedFocus.join(', ')}`,
        };
      }

      return runImprove({
        claudePath: config.claudePath,
        timeout: config.timeout,
        maxOutputLength: config.maxOutputLength,
        soulDir: config.soulDir,
        focus,
        context: typeof args.context === 'string' ? args.context.trim() : undefined,
        botId: typeof args._botId === 'string' ? args._botId : undefined,
        logger,
      });
    },
  };
}
