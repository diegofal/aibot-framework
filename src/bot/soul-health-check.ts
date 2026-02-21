import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backupSoulFile } from '../soul';
import type { Logger } from '../logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SoulLintIssue {
  file: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface StartupSoulCheckOptions {
  botId: string;
  soulDir: string;
  cooldownMs: number;
  claudePath: string;
  timeout: number;
  logger: Logger;
  consolidateMemory?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUIRED_FILES = ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md'] as const;

/** Headers that indicate duplicated content leaked into SOUL.md */
const SOUL_DUPLICATE_HEADERS = [
  '## Your Inner Motivations',
  '## Goals',
  '## Impulsos centrales',
  '## Foco actual',
];

/** Stale placeholder patterns in MOTIVATIONS.md */
const STALE_PLACEHOLDERS = [
  'ninguna todavia',
  'none yet',
  'populated by first reflection',
  'se poblara con',
];

const COOLDOWN_FILE = '.last-health-check';

// ---------------------------------------------------------------------------
// Structural Lint (no LLM)
// ---------------------------------------------------------------------------

export function lintSoulDirectory(soulDir: string): SoulLintIssue[] {
  const issues: SoulLintIssue[] = [];

  // Check required files exist
  for (const file of REQUIRED_FILES) {
    const filepath = join(soulDir, file);
    if (!existsSync(filepath)) {
      issues.push({ file, severity: 'error', message: `Missing required file: ${file}` });
    }
  }

  // Check SOUL.md for duplicated headers from other files
  const soulPath = join(soulDir, 'SOUL.md');
  if (existsSync(soulPath)) {
    try {
      const soulContent = readFileSync(soulPath, 'utf-8');
      for (const header of SOUL_DUPLICATE_HEADERS) {
        if (soulContent.includes(header)) {
          issues.push({
            file: 'SOUL.md',
            severity: 'warning',
            message: `Contains duplicated section "${header}" — this belongs in MOTIVATIONS.md or GOALS.md`,
          });
        }
      }
    } catch {
      // Cannot read — already caught by missing file check
    }
  }

  // Check MOTIVATIONS.md for stale placeholders
  const motivationsPath = join(soulDir, 'MOTIVATIONS.md');
  if (existsSync(motivationsPath)) {
    try {
      const content = readFileSync(motivationsPath, 'utf-8').toLowerCase();
      for (const placeholder of STALE_PLACEHOLDERS) {
        if (content.includes(placeholder)) {
          issues.push({
            file: 'MOTIVATIONS.md',
            severity: 'warning',
            message: `Contains stale placeholder: "${placeholder}"`,
          });
        }
      }
    } catch {
      // Cannot read
    }
  }

  // Check memory/ directory exists
  const memoryDir = join(soulDir, 'memory');
  if (!existsSync(memoryDir)) {
    issues.push({ file: 'memory/', severity: 'warning', message: 'Missing memory/ directory' });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

function readCooldownTimestamp(soulDir: string): number | null {
  const filepath = join(soulDir, COOLDOWN_FILE);
  try {
    const content = readFileSync(filepath, 'utf-8').trim();
    const ts = Number(content);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

function writeCooldownTimestamp(soulDir: string): void {
  const filepath = join(soulDir, COOLDOWN_FILE);
  writeFileSync(filepath, String(Date.now()), 'utf-8');
}

function isCooldownActive(soulDir: string, cooldownMs: number): boolean {
  const lastCheck = readCooldownTimestamp(soulDir);
  if (lastCheck === null) return false;
  return Date.now() - lastCheck < cooldownMs;
}

// ---------------------------------------------------------------------------
// Memory Consolidation
// ---------------------------------------------------------------------------

/**
 * Detect daily logs older than today that haven't been consolidated yet.
 * Returns the list of date filenames (e.g. ['2026-02-18.md', '2026-02-19.md']).
 */
export function getUnconsolidatedLogs(soulDir: string): string[] {
  const memoryDir = join(soulDir, 'memory');
  if (!existsSync(memoryDir)) return [];

  const today = new Date().toISOString().slice(0, 10);

  try {
    return readdirSync(memoryDir)
      .filter((f) => {
        if (!f.endsWith('.md')) return false;
        if (f === 'legacy.md') return false;
        const dateStr = f.replace('.md', '');
        // Must be a valid date pattern and older than today
        return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr < today;
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Build the prompt for Claude CLI to consolidate memory.
 */
function buildConsolidationPrompt(
  soulDir: string,
  existingMemory: string | null,
  dailyLogContents: Array<{ date: string; content: string }>,
): string {
  const parts = [
    'You are a memory consolidation agent for an AI bot.',
    'Your job is to merge daily memory logs into a single unified MEMORY.md file.',
    '',
    '## Instructions',
    '1. Merge the daily facts into the existing MEMORY.md structure (or create a new one if it doesn\'t exist).',
    '2. Deduplicate: if the same fact appears across multiple days, keep only one instance.',
    '3. Remove noise:',
    '   - Lines containing "[agent-loop] (no response from executor)" or similar agent-loop noise',
    '   - Lines containing "[agent-loop] (no response)" ',
    '   - Duplicate initialization entries',
    '   - Empty or meaningless entries',
    '4. Organize by natural categories that emerge from the content (e.g., IDENTIDADES, RELACIONES, LOGÍSTICA, COMUNICACIÓN, etc.).',
    '   Each bot has its own personality — let the categories reflect the content naturally.',
    '5. Preserve timestamps on recent or important facts (last 2-3 days).',
    '6. Keep the language consistent with the existing content.',
    '7. Be concise — this is a consolidated summary, not a raw dump.',
    '8. Keep ALL factual information about real people, preferences, relationships.',
    '9. The file should start with a metadata header:',
    '   ```',
    '   <!-- last-consolidated: YYYY-MM-DD -->',
    '   ```',
    '',
  ];

  if (existingMemory) {
    parts.push(
      '## Existing MEMORY.md',
      '```',
      existingMemory,
      '```',
      '',
    );
  }

  parts.push('## Daily Logs to Merge');
  for (const { date, content } of dailyLogContents) {
    parts.push(`### ${date}`, '```', content, '```', '');
  }

  parts.push(
    '## Output',
    'Output ONLY the new MEMORY.md content. No preamble, no explanation, just the file content.',
    'Start with the <!-- last-consolidated: YYYY-MM-DD --> comment using today\'s date.',
  );

  return parts.join('\n');
}

/**
 * Run memory consolidation: merge old daily logs into MEMORY.md, archive processed logs.
 */
async function consolidateMemory(opts: {
  soulDir: string;
  claudePath: string;
  timeout: number;
  logger: Logger;
}): Promise<{ merged: number; archived: number }> {
  const { soulDir, claudePath, timeout, logger } = opts;
  const memoryDir = join(soulDir, 'memory');

  const oldLogs = getUnconsolidatedLogs(soulDir);
  if (oldLogs.length === 0) {
    logger.debug('Memory consolidation: no old daily logs to consolidate');
    return { merged: 0, archived: 0 };
  }

  // Read existing MEMORY.md (or fall back to legacy.md for first-time migration)
  let existingMemory: string | null = null;
  const memoryMdPath = join(soulDir, 'MEMORY.md');
  const legacyPath = join(memoryDir, 'legacy.md');

  if (existsSync(memoryMdPath)) {
    try {
      const content = readFileSync(memoryMdPath, 'utf-8').trim();
      if (content) existingMemory = content;
    } catch { /* ignore */ }
  }

  // Fall back to legacy.md for first-time migration
  if (!existingMemory && existsSync(legacyPath)) {
    try {
      const content = readFileSync(legacyPath, 'utf-8').trim();
      if (content) existingMemory = content;
    } catch { /* ignore */ }
  }

  // Read daily log contents
  const dailyLogContents: Array<{ date: string; content: string }> = [];
  for (const file of oldLogs) {
    try {
      const content = readFileSync(join(memoryDir, file), 'utf-8').trim();
      if (content) {
        dailyLogContents.push({ date: file.replace('.md', ''), content });
      }
    } catch { /* skip unreadable */ }
  }

  if (dailyLogContents.length === 0) {
    logger.debug('Memory consolidation: daily logs were empty, nothing to merge');
    return { merged: 0, archived: 0 };
  }

  const prompt = buildConsolidationPrompt(soulDir, existingMemory, dailyLogContents);

  logger.info(
    { logCount: dailyLogContents.length, hasExisting: !!existingMemory },
    'Memory consolidation: running Claude CLI',
  );

  // Spawn Claude CLI for consolidation (no file editing — just prompt-mode output)
  const env = { ...process.env };
  delete env.CLAUDECODE;
  env.TERM = 'dumb';

  const proc = Bun.spawn([claudePath, '-p', prompt, '--output-format', 'text'], {
    cwd: resolve('.'),
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

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
        'Memory consolidation: Claude CLI failed',
      );
      return { merged: 0, archived: 0 };
    }

    const output = stdout.trim();
    if (!output) {
      logger.warn('Memory consolidation: Claude CLI produced no output');
      return { merged: 0, archived: 0 };
    }

    // Backup existing MEMORY.md before overwriting
    if (existsSync(memoryMdPath)) {
      backupSoulFile(memoryMdPath, logger);
    }

    // Write new MEMORY.md
    writeFileSync(memoryMdPath, output, 'utf-8');
    logger.info({ outputLen: output.length }, 'Memory consolidation: MEMORY.md written');

    // Archive processed daily logs
    const archiveDir = join(memoryDir, 'archive');
    if (!existsSync(archiveDir)) {
      mkdirSync(archiveDir, { recursive: true });
    }

    let archived = 0;
    for (const file of oldLogs) {
      const src = join(memoryDir, file);
      const dest = join(archiveDir, file);
      try {
        renameSync(src, dest);
        archived++;
      } catch (err) {
        logger.warn({ err, file }, 'Memory consolidation: failed to archive daily log');
      }
    }

    logger.info(
      { merged: dailyLogContents.length, archived },
      'Memory consolidation: complete',
    );

    return { merged: dailyLogContents.length, archived };
  } catch (err) {
    clearTimeout(timer);
    logger.warn({ err }, 'Memory consolidation: error during Claude CLI execution');
    return { merged: 0, archived: 0 };
  }
}

// ---------------------------------------------------------------------------
// Soul Quality Review (Claude CLI with --allowedTools)
// ---------------------------------------------------------------------------

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

  // Include lint issues if any
  if (lintIssues.length > 0) {
    parts.push('## Structural Issues Found (fix these first)');
    for (const issue of lintIssues) {
      parts.push(`- [${issue.severity}] ${issue.file}: ${issue.message}`);
    }
    parts.push('');
  }

  // Include file contents
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

async function runQualityReview(opts: {
  soulDir: string;
  claudePath: string;
  timeout: number;
  lintIssues: SoulLintIssue[];
  logger: Logger;
}): Promise<string> {
  const { soulDir, claudePath, timeout, lintIssues, logger } = opts;

  // Read all soul files
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

  // Backup files before Claude edits them
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

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Run startup soul health check: lint + Claude CLI quality review + memory consolidation.
 * Designed to run as a non-blocking background task.
 */
export async function runStartupSoulCheck(opts: StartupSoulCheckOptions): Promise<void> {
  const {
    botId,
    soulDir,
    cooldownMs,
    claudePath,
    timeout,
    logger,
    consolidateMemory: shouldConsolidate = true,
  } = opts;

  // Check cooldown
  if (isCooldownActive(soulDir, cooldownMs)) {
    logger.debug({ botId }, 'Soul health check: skipping (cooldown)');
    return;
  }

  logger.info({ botId, soulDir }, 'Soul health check: starting');

  // Step 1: Structural lint (instant, no LLM)
  const issues = lintSoulDirectory(soulDir);
  logger.info(
    { botId, issueCount: issues.length, issues },
    'Soul health check: lint complete',
  );

  // Step 2: Memory consolidation FIRST (faster, higher impact)
  // Step 3: Quality review SECOND (slower, spawns Claude CLI with tools)
  // Run concurrently since they operate on different files.
  const tasks: Array<Promise<void>> = [];

  if (shouldConsolidate) {
    tasks.push(
      consolidateMemory({ soulDir, claudePath, timeout, logger })
        .then((result) => {
          logger.info(
            { botId, merged: result.merged, archived: result.archived },
            'Soul health check: memory consolidation complete',
          );
        })
        .catch((err) => {
          logger.warn({ botId, err }, 'Soul health check: memory consolidation failed (non-fatal)');
        }),
    );
  }

  tasks.push(
    runQualityReview({
      soulDir,
      claudePath,
      timeout,
      lintIssues: issues,
      logger,
    })
      .then((reviewResult) => {
        logger.info({ botId, review: reviewResult.slice(0, 500) }, 'Soul health check: quality review complete');
      })
      .catch((err) => {
        logger.warn({ botId, err }, 'Soul health check: quality review failed (non-fatal)');
      }),
  );

  await Promise.allSettled(tasks);

  // Write cooldown timestamp
  writeCooldownTimestamp(soulDir);
  logger.info({ botId }, 'Soul health check: complete');
}
