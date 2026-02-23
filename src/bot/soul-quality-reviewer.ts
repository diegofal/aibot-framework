import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from '../logger';
import { backupSoulFile } from '../soul';
import type { SoulLintIssue } from './soul-lint';

function buildQualityReviewPrompt(
  soulDir: string,
  soulFiles: Record<string, string | null>,
  lintIssues: SoulLintIssue[],
): string {
  const parts = [
    'You are a soul quality reviewer for an AI bot personality system.',
    'Review the following soul files for quality issues and fix them directly.',
    '',
    `Soul directory: ${soulDir}`,
    '',
  ];

  if (lintIssues.length > 0) {
    parts.push('## Structural Issues Found (fix these first)');
    for (const issue of lintIssues) {
      parts.push(`- [${issue.severity}] ${issue.file}: ${issue.message}`);
    }
    parts.push('');
  }

  parts.push('## Current File Contents');
  for (const [name, content] of Object.entries(soulFiles)) {
    if (content) {
      parts.push(`### ${name}`, '```', content, '```', '');
    } else {
      parts.push(`### ${name}`, '(file missing or empty)', '');
    }
  }

  parts.push(
    '## Quality Checks',
    '1. **Personality drift**: Does SOUL.md describe a coherent personality? Are there contradictions?',
    '2. **Vague language**: Replace vague statements with specific, actionable ones.',
    '3. **Contradictions between files**: Do IDENTITY, SOUL, and MOTIVATIONS tell the same story?',
    '4. **Outdated content**: Is anything clearly stale or no longer relevant?',
    '5. **Duplicated content**: Is the same content appearing in multiple files? (e.g., motivations in SOUL.md)',
    '6. **Structural issues**: Fix any lint issues listed above.',
    '',
    '## Rules',
    '1. PRESERVE the core voice and personality — refine, don\'t replace.',
    '2. Keep the language consistent (if files are in Spanish, edit in Spanish).',
    '3. Make targeted, minimal edits. Don\'t rewrite entire files unnecessarily.',
    '4. Back up files before editing is handled automatically — just edit directly.',
    '',
    '## Output',
    'After making all edits, output ONLY a concise summary of what you changed and why (max 10 bullet points).',
    'If no changes were needed, say "No changes needed."',
  );

  return parts.join('\n');
}

export async function runQualityReview(opts: {
  soulDir: string;
  claudePath: string;
  timeout: number;
  lintIssues: SoulLintIssue[];
  logger: Logger;
}): Promise<string> {
  const { soulDir, claudePath, timeout, lintIssues, logger } = opts;

  const fileNames = ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md', 'GOALS.md'];
  const soulFiles: Record<string, string | null> = {};
  for (const name of fileNames) {
    const filepath = join(soulDir, name);
    try {
      soulFiles[name] = readFileSync(filepath, 'utf-8').trim() || null;
    } catch {
      soulFiles[name] = null;
    }
  }

  for (const name of fileNames) {
    const filepath = join(soulDir, name);
    if (existsSync(filepath)) {
      backupSoulFile(filepath, logger);
    }
  }

  const prompt = buildQualityReviewPrompt(soulDir, soulFiles, lintIssues);

  const env = { ...process.env };
  delete env.CLAUDECODE;
  env.TERM = 'dumb';

  const proc = Bun.spawn(
    [claudePath, '-p', prompt, '--allowedTools', 'Read,Edit,Write'],
    {
      cwd: resolve(soulDir, '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    },
  );

  const timer = setTimeout(() => {
    try { proc.kill(); } catch {}
  }, timeout);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (exitCode !== 0) {
      logger.warn(
        { exitCode, stderr: stderr.slice(0, 500) },
        'Soul quality review: Claude CLI failed',
      );
      return `Quality review failed (exit code ${exitCode})`;
    }

    const output = stdout.trim() || 'No output from quality review';
    logger.info({ outputLen: output.length }, 'Soul quality review: complete');
    return output;
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'Soul quality review: error');
    return `Quality review error: ${message}`;
  }
}
