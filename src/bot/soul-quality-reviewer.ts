import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from '../logger';
import type { OllamaClient } from '../ollama';
import { backupSoulFile } from '../soul';
import type { SoulLintIssue } from './soul-lint';

const SOUL_FILES = ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md', 'GOALS.md'] as const;

function readSoulFiles(soulDir: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const name of SOUL_FILES) {
    const filepath = join(soulDir, name);
    try {
      result[name] = readFileSync(filepath, 'utf-8').trim() || null;
    } catch {
      result[name] = null;
    }
  }
  return result;
}

function backupExistingFiles(soulDir: string, logger: Logger): void {
  for (const name of SOUL_FILES) {
    const filepath = join(soulDir, name);
    if (existsSync(filepath)) {
      backupSoulFile(filepath, logger);
    }
  }
}

function buildQualityReviewPrompt(
  soulDir: string,
  soulFiles: Record<string, string | null>,
  lintIssues: SoulLintIssue[]
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
    "1. PRESERVE the core voice and personality — refine, don't replace.",
    '2. Keep the language consistent (if files are in Spanish, edit in Spanish).',
    "3. Make targeted, minimal edits. Don't rewrite entire files unnecessarily.",
    '4. Back up files before editing is handled automatically — just edit directly.',
    '5. **File boundaries are strict**: SOUL.md = personality, voice, tone, behavioral rules. MOTIVATIONS.md = Core Drives, Current Focus, Open Questions, Self-Observations. NEVER copy content from one file into the other. If SOUL.md is missing personality content, generate new personality content — do NOT paste motivations into it.',
    "6. **Core Drives must match identity**: If MOTIVATIONS.md Core Drives are generic and don't match the bot's IDENTITY.md role/vibe (e.g. a news bot with drives about \"being a genuine friend\"), rewrite them to match the bot's actual purpose.",
    ''
  );

  return parts.join('\n');
}

function buildClaudeCliPrompt(
  soulDir: string,
  soulFiles: Record<string, string | null>,
  lintIssues: SoulLintIssue[]
): string {
  const base = buildQualityReviewPrompt(soulDir, soulFiles, lintIssues);
  return (
    base +
    [
      '## Output',
      'After making all edits, output ONLY a concise summary of what you changed and why (max 10 bullet points).',
      'If no changes were needed, say "No changes needed."',
    ].join('\n')
  );
}

function buildOllamaPrompt(
  soulDir: string,
  soulFiles: Record<string, string | null>,
  lintIssues: SoulLintIssue[]
): string {
  const base = buildQualityReviewPrompt(soulDir, soulFiles, lintIssues);
  return (
    base +
    [
      '## Output Format',
      'For each file that needs changes, output it in this EXACT format:',
      '',
      '--- FILE: FILENAME.md ---',
      '(full corrected content of the file)',
      '--- END FILE ---',
      '',
      'After all file corrections, output a summary:',
      '',
      '--- SUMMARY ---',
      '- Change 1',
      '- Change 2',
      '--- END SUMMARY ---',
      '',
      'If no changes are needed, output only:',
      '',
      '--- SUMMARY ---',
      'No changes needed.',
      '--- END SUMMARY ---',
    ].join('\n')
  );
}

interface ParsedReviewOutput {
  files: Record<string, string>;
  summary: string;
}

function parseOllamaOutput(output: string): ParsedReviewOutput {
  const files: Record<string, string> = {};
  const fileRegex = /--- FILE:\s*(\S+)\s*---\n([\s\S]*?)\n--- END FILE ---/g;
  let match: RegExpExecArray | null = fileRegex.exec(output);
  while (match !== null) {
    files[match[1]] = match[2].trim();
    match = fileRegex.exec(output);
  }

  let summary = 'No output from quality review';
  const summaryMatch = output.match(/--- SUMMARY ---\n([\s\S]*?)\n--- END SUMMARY ---/);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  return { files, summary };
}

export interface QualityReviewOptions {
  soulDir: string;
  lintIssues: SoulLintIssue[];
  logger: Logger;
  llmBackend?: 'ollama' | 'claude-cli';
  // Claude CLI specific
  claudePath?: string;
  claudeModel?: string;
  timeout?: number;
  // Ollama specific
  ollamaClient?: OllamaClient;
  model?: string;
}

async function runClaudeCliReview(opts: QualityReviewOptions): Promise<string> {
  const {
    soulDir,
    lintIssues,
    logger,
    claudePath = 'claude',
    claudeModel,
    timeout = 300_000,
  } = opts;

  const soulFiles = readSoulFiles(soulDir);
  backupExistingFiles(soulDir, logger);

  const prompt = buildClaudeCliPrompt(soulDir, soulFiles, lintIssues);

  const env = { ...process.env };
  env.CLAUDECODE = undefined;
  env.TERM = 'dumb';

  const claudeArgs = [claudePath, '-p', prompt, '--allowedTools', 'Read,Edit,Write'];
  if (claudeModel) {
    claudeArgs.push('--model', claudeModel);
  }

  const proc = Bun.spawn(claudeArgs, {
    cwd: resolve(soulDir),
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
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
        { exitCode, stderr: stderr.slice(0, 500), stdout: stdout.slice(0, 500) },
        'Soul quality review: Claude CLI failed'
      );
      return `Quality review failed (exit code ${exitCode}): ${stdout.slice(0, 200) || stderr.slice(0, 200)}`;
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

async function runOllamaReview(opts: QualityReviewOptions): Promise<string> {
  const { soulDir, lintIssues, logger, ollamaClient, model } = opts;

  if (!ollamaClient) {
    return 'Quality review skipped: ollama client not available';
  }

  const soulFiles = readSoulFiles(soulDir);
  backupExistingFiles(soulDir, logger);

  const prompt = buildOllamaPrompt(soulDir, soulFiles, lintIssues);

  try {
    const llmResult = await ollamaClient.generate(prompt, { model });

    const { files, summary } = parseOllamaOutput(llmResult.text);

    let filesWritten = 0;
    for (const [name, content] of Object.entries(files)) {
      if (!SOUL_FILES.includes(name as (typeof SOUL_FILES)[number])) continue;
      if (!content) continue;

      const filepath = join(soulDir, name);
      const existing = soulFiles[name];
      if (existing && content === existing) continue;

      writeFileSync(filepath, content, 'utf-8');
      filesWritten++;
    }

    logger.info(
      { outputLen: llmResult.text.length, filesWritten },
      'Soul quality review: complete'
    );
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'Soul quality review: error');
    return `Quality review error: ${message}`;
  }
}

export async function runQualityReview(opts: QualityReviewOptions): Promise<string> {
  const backend = opts.llmBackend ?? 'claude-cli';
  if (backend === 'ollama') {
    return runOllamaReview(opts);
  }
  return runClaudeCliReview(opts);
}
