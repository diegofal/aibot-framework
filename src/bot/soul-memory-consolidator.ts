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
import type { OllamaClient } from '../ollama';
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

export interface ConsolidateMemoryOptions {
  soulDir: string;
  logger: Logger;
  llmBackend?: 'ollama' | 'claude-cli';
  claudePath?: string;
  claudeModel?: string;
  timeout?: number;
  ollamaClient?: OllamaClient;
  model?: string;
}

async function generateConsolidation(
  prompt: string,
  opts: ConsolidateMemoryOptions
): Promise<{ output: string | null; error?: string }> {
  const backend = opts.llmBackend ?? 'claude-cli';
  if (backend === 'ollama') {
    if (!opts.ollamaClient) {
      return { output: null, error: 'ollama client not available' };
    }
    try {
      const llmResult = await opts.ollamaClient.generate(prompt, { model: opts.model });
      return { output: llmResult.text.trim() || null };
    } catch (err) {
      return { output: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Claude CLI path
  const claudePath = opts.claudePath ?? 'claude';
  const timeout = opts.timeout ?? 300_000;

  const env = { ...process.env };
  env.CLAUDECODE = undefined;
  env.TERM = 'dumb';

  const claudeArgs = [claudePath, '-p', prompt, '--output-format', 'text'];
  if (opts.claudeModel) {
    claudeArgs.push('--model', opts.claudeModel);
  }

  const proc = Bun.spawn(claudeArgs, {
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
      return {
        output: null,
        error: `Claude CLI exit code ${exitCode}: ${stdout.slice(0, 200) || stderr.slice(0, 200)}`,
      };
    }

    return { output: stdout.trim() || null };
  } catch (err) {
    clearTimeout(timer);
    return { output: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run memory consolidation: merge old daily logs into MEMORY.md, archive processed logs.
 */
export async function consolidateMemory(
  opts: ConsolidateMemoryOptions
): Promise<{ merged: number; archived: number }> {
  const { soulDir, logger } = opts;
  const backend = opts.llmBackend ?? 'claude-cli';
  const memoryDir = join(soulDir, 'memory');

  const oldLogs = getUnconsolidatedLogs(soulDir);
  if (oldLogs.length === 0) {
    logger.debug('Memory consolidation: no old daily logs to consolidate');
    return { merged: 0, archived: 0 };
  }

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
    { logCount: dailyLogContents.length, hasExisting: !!existingMemory, backend },
    'Memory consolidation: running LLM'
  );

  const { output, error } = await generateConsolidation(prompt, opts);

  if (error || !output) {
    logger.warn({ error }, 'Memory consolidation: LLM failed');
    return { merged: 0, archived: 0 };
  }

  // Validate output before overwriting
  if (!output.includes('<!-- last-consolidated:')) {
    logger.warn(
      { outputLen: output.length },
      'Memory consolidation: output missing <!-- last-consolidated: --> header, rejecting'
    );
    return { merged: 0, archived: 0 };
  }

  if (existingMemory) {
    const ratio = output.length / existingMemory.length;
    if (ratio < 0.5) {
      logger.warn(
        { outputLen: output.length, existingLen: existingMemory.length, ratio: ratio.toFixed(2) },
        'Memory consolidation: output is <50% of existing MEMORY.md size, rejecting to prevent data loss'
      );
      return { merged: 0, archived: 0 };
    }
  }

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
}
