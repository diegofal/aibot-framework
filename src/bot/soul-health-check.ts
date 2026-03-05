import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';
import type { OllamaClient } from '../ollama';
import { lintSoulDirectory } from './soul-lint';
import { consolidateMemory } from './soul-memory-consolidator';
import { runQualityReview } from './soul-quality-reviewer';

// Backward-compat re-exports
export { lintSoulDirectory, type SoulLintIssue } from './soul-lint';
export { getUnconsolidatedLogs } from './soul-memory-consolidator';

export interface StartupSoulCheckOptions {
  botId: string;
  soulDir: string;
  cooldownMs: number;
  claudePath: string;
  timeout: number;
  logger: Logger;
  consolidateMemory?: boolean;
  llmBackend?: 'ollama' | 'claude-cli';
  model?: string;
  ollamaClient?: OllamaClient;
}

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

const COOLDOWN_FILE = '.last-health-check';

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
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Run startup soul health check: lint + LLM quality review + memory consolidation.
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
    llmBackend = 'claude-cli',
    model,
    ollamaClient,
  } = opts;

  if (isCooldownActive(soulDir, cooldownMs)) {
    logger.debug({ botId }, 'Soul health check: skipping (cooldown)');
    return;
  }

  logger.info({ botId, soulDir, llmBackend }, 'Soul health check: starting');

  // Step 1: Structural lint (instant, no LLM)
  const issues = lintSoulDirectory(soulDir);
  logger.info({ botId, issueCount: issues.length, issues }, 'Soul health check: lint complete');

  // Steps 2 & 3: Memory consolidation + quality review (run concurrently)
  const tasks: Array<Promise<void>> = [];

  if (shouldConsolidate) {
    tasks.push(
      consolidateMemory({ soulDir, claudePath, timeout, logger, llmBackend, model, ollamaClient })
        .then((result) => {
          logger.info(
            { botId, merged: result.merged, archived: result.archived },
            'Soul health check: memory consolidation complete'
          );
        })
        .catch((err) => {
          logger.warn({ botId, err }, 'Soul health check: memory consolidation failed (non-fatal)');
        })
    );
  }

  tasks.push(
    runQualityReview({
      soulDir,
      claudePath,
      timeout,
      lintIssues: issues,
      logger,
      llmBackend,
      model,
      ollamaClient,
    })
      .then((reviewResult) => {
        logger.info(
          { botId, review: reviewResult.slice(0, 500) },
          'Soul health check: quality review complete'
        );
      })
      .catch((err) => {
        logger.warn({ botId, err }, 'Soul health check: quality review failed (non-fatal)');
      })
  );

  await Promise.allSettled(tasks);

  writeCooldownTimestamp(soulDir);
  logger.info({ botId }, 'Soul health check: complete');
}
