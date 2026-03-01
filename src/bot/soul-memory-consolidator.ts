import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { localDateStr } from '../date-utils';
import type { Logger } from '../logger';
import { backupSoulFile } from '../soul';

/**
 * Detect daily logs older than today that haven't been consolidated yet.
 * Returns the list of date filenames (e.g. ['2026-02-18.md', '2026-02-19.md']).
 */
export function getUnconsolidatedLogs(soulDir: string): string[] {
  const memoryDir = join(soulDir, 'memory');
  if (!existsSync(memoryDir)) return [];

  const today = localDateStr();

  try {
    return readdirSync(memoryDir)
      .filter((f) => {
        if (!f.endsWith('.md')) return false;
        if (f === 'legacy.md') return false;
        const dateStr = f.replace('.md', '');
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
  dailyLogContents: Array<{ date: string; content: string }>
): string {
  const parts = [
    'You are a memory consolidation agent for an AI bot.',
    'Your job is to merge daily memory logs into a single unified MEMORY.md file.',
    '',
    '## Instructions',
    "1. Merge the daily facts into the existing MEMORY.md structure (or create a new one if it doesn't exist).",
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
    parts.push('## Existing MEMORY.md', '```', existingMemory, '```', '');
  }

  parts.push('## Daily Logs to Merge');
  for (const { date, content } of dailyLogContents) {
    parts.push(`### ${date}`, '```', content, '```', '');
  }

  parts.push(
    '## Output',
    'Output ONLY the new MEMORY.md content. No preamble, no explanation, just the file content.',
    "Start with the <!-- last-consolidated: YYYY-MM-DD --> comment using today's date."
  );

  return parts.join('\n');
}

/**
 * Run memory consolidation: merge old daily logs into MEMORY.md, archive processed logs.
 */
export async function consolidateMemory(opts: {
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
    } catch {
      /* ignore */
    }
  }

  if (!existingMemory && existsSync(legacyPath)) {
    try {
      const content = readFileSync(legacyPath, 'utf-8').trim();
      if (content) existingMemory = content;
    } catch {
      /* ignore */
    }
  }

  // Read daily log contents
  const dailyLogContents: Array<{ date: string; content: string }> = [];
  for (const file of oldLogs) {
    try {
      const content = readFileSync(join(memoryDir, file), 'utf-8').trim();
      if (content) {
        dailyLogContents.push({ date: file.replace('.md', ''), content });
      }
    } catch {
      /* skip unreadable */
    }
  }

  if (dailyLogContents.length === 0) {
    logger.debug('Memory consolidation: daily logs were empty, nothing to merge');
    return { merged: 0, archived: 0 };
  }

  const prompt = buildConsolidationPrompt(soulDir, existingMemory, dailyLogContents);

  logger.info(
    { logCount: dailyLogContents.length, hasExisting: !!existingMemory },
    'Memory consolidation: running Claude CLI'
  );

  const env = { ...process.env };
  env.CLAUDECODE = undefined;
  env.TERM = 'dumb';

  const proc = Bun.spawn([claudePath, '-p', prompt, '--output-format', 'text'], {
    cwd: resolve('.'),
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
        { exitCode, stderr: stderr.slice(0, 500) },
        'Memory consolidation: Claude CLI failed'
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

    logger.info({ merged: dailyLogContents.length, archived }, 'Memory consolidation: complete');

    return { merged: dailyLogContents.length, archived };
  } catch (err) {
    clearTimeout(timer);
    logger.warn({ err }, 'Memory consolidation: error during Claude CLI execution');
    return { merged: 0, archived: 0 };
  }
}
