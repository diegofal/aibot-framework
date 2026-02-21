import { resolve } from 'node:path';
import type { Logger } from './logger';

export interface ClaudeGenerateOptions {
  claudePath?: string;
  timeout?: number;
  maxLength?: number;
  systemPrompt?: string;
}

const DEFAULT_CLAUDE_PATH = 'claude';
const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_LENGTH = 50_000;

/**
 * Spawn Claude CLI in prompt mode and return the text output.
 * Throws on timeout, non-zero exit, or empty output so callers can fall back.
 */
export async function claudeGenerate(
  prompt: string,
  opts: ClaudeGenerateOptions & { logger: Logger },
): Promise<string> {
  const claudePath = opts.claudePath || DEFAULT_CLAUDE_PATH;
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;

  // Clear CLAUDECODE env to avoid nested session detection (same as improve.ts)
  const env = { ...process.env };
  delete env.CLAUDECODE;
  env.TERM = 'dumb';

  const args = [claudePath, '-p', prompt, '--output-format', 'text'];
  if (opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  const proc = Bun.spawn(args, {
    cwd: resolve('.'),
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

  const timer = setTimeout(() => {
    try { proc.kill(); } catch {}
  }, timeout);

  const startTime = Date.now();

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (exitCode !== 0) {
      const durationMs = Date.now() - startTime;
      const isTimeout = exitCode === 143 || exitCode === 137; // SIGTERM or SIGKILL
      const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;

      opts.logger.warn({
        exitCode,
        durationMs,
        isTimeout,
        stdoutLen: stdout.length,
        stderrLen: stderr.length,
        stdoutPreview: stdout.slice(0, 500) || '(empty)',
        stderrPreview: stderr.slice(0, 500) || '(empty)',
      }, 'Claude CLI failed');

      throw new Error(`Claude CLI exited with code ${exitCode}: ${detail}`);
    }

    let output = stdout.trim();
    if (!output) {
      throw new Error('Claude CLI produced no output');
    }

    if (output.length > maxLength) {
      output = output.slice(0, maxLength);
    }

    opts.logger.info({ durationMs: Date.now() - startTime, outputLen: output.length }, 'Claude CLI completed');

    return output;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
