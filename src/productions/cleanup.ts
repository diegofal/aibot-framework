/**
 * Cleanup — auto-cleanup analysis + throttle scheduler.
 *
 * Per docs/architecture-docs/productions-refactor.md §3.2 + §4.1 + §4.2:
 *   - analyzeCleanup(ctx, now) — pure: scans the directory and returns
 *     a list of {path, reason} candidates to archive. No side effects.
 *   - CleanupScheduler — owns the 1-hour throttle (lastCleanupAt) and
 *     exposes runCleanup which throttles analyzeCleanup.
 *
 * Side effects (file moves, JSONL appends) stay on the facade (§4.1).
 * The throttle state and runCleanup move together (§4.2).
 *
 * Consumed by ProductionsService.runCleanup (via the scheduler).
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readEntries } from './changelog';
import { INDEX_EXCLUDES } from './paths';
import type { ProductionEntry } from './types';

/** Result of a cleanup analysis: pairs of (path, reason). */
export interface CleanupCandidate {
  path: string;
  reason: string;
}

/** Callback for coherence checks. The facade owns the real implementation. */
export type CoherenceCheckFn = (relativePath: string) => { coherent: boolean; issues: string[] };

/** Context for analyzeCleanup. */
export interface AnalyzeCleanupContext {
  /** The production directory (absolute path). */
  dir: string;
  /** The current time (ms). Used for the 60s grace period. */
  now: number;
  /** Coherence check callback (facade passes this.checkCoherence). */
  coherenceCheck: CoherenceCheckFn;
}

const ONE_HOUR_MS = 3600_000;
const GRACE_PERIOD_MS = 60_000;
const TINY_FILE_BYTES = 50;

/**
 * Analyze the production directory and return a list of files to archive.
 *
 * Pure: no file moves, no JSONL appends. The facade composes the
 * archive batch.
 *
 * Returns empty array when nothing needs cleanup.
 */
export function analyzeCleanup(ctx: AnalyzeCleanupContext): CleanupCandidate[] {
  const { dir, now, coherenceCheck } = ctx;

  if (!existsSync(dir)) return [];

  // Build sets from the changelog: tracked paths, approved paths.
  const changelogPath = join(dir, 'changelog.jsonl');
  const allEntries = readEntries(changelogPath);

  const trackedPaths = new Set<string>();
  const approvedPaths = new Set<string>();
  for (const entry of allEntries) {
    if (entry.action !== 'archive') {
      trackedPaths.add(entry.path);
    }
    if (entry.evaluation?.status === 'approved') {
      approvedPaths.add(entry.path);
    }
  }

  // Collect tracked, non-archived, non-excluded files.
  interface CleanupFile {
    relativePath: string;
    absPath: string;
    size: number;
  }

  const files: CleanupFile[] = [];
  const walk = (current: string, relPrefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (INDEX_EXCLUDES.has(name)) continue;
      const fullPath = join(current, name);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      const relPath = relPrefix ? `${relPrefix}/${name}` : name;
      if (stat.isDirectory()) {
        if (name === 'archived') continue;
        walk(fullPath, relPath);
      } else {
        if (!trackedPaths.has(relPath)) continue;
        if (now - stat.mtimeMs < GRACE_PERIOD_MS) continue;
        files.push({ relativePath: relPath, absPath: fullPath, size: stat.size });
      }
    }
  };
  walk(dir, '');

  const candidates: CleanupCandidate[] = [];
  const hashMap = new Map<string, string>(); // hash → first relativePath

  for (const f of files) {
    if (approvedPaths.has(f.relativePath)) continue;

    let reason: string | null = null;

    if (f.size < TINY_FILE_BYTES) {
      reason = 'auto-cleanup: file too small (<50 bytes)';
    }

    if (!reason) {
      try {
        const content = readFileSync(f.absPath);
        const hash = createHash('sha256').update(content).digest('hex');
        if (hashMap.has(hash)) {
          reason = `auto-cleanup: duplicate of ${hashMap.get(hash)}`;
        } else {
          hashMap.set(hash, f.relativePath);
        }
      } catch {
        /* skip */
      }
    }

    if (!reason && f.relativePath.endsWith('.md')) {
      const result = coherenceCheck(f.relativePath);
      if (!result.coherent) {
        reason = `auto-cleanup: ${result.issues.join('; ')}`;
      }
    }

    if (reason) candidates.push({ path: f.relativePath, reason });
  }

  return candidates;
}

/**
 * CleanupScheduler — owns the 1-hour throttle per bot.
 *
 * The state and the function are one unit (§4.2); they move together.
 */
export class CleanupScheduler {
  private lastCleanupAt = new Map<string, number>();

  /**
   * Run the cleanup analysis. Returns null when throttled (less than 1
   * hour since the last call for this botId). Returns the analysis
   * otherwise.
   */
  runCleanup(botId: string, ctx: AnalyzeCleanupContext): CleanupCandidate[] | null {
    const now = ctx.now;
    const last = this.lastCleanupAt.get(botId) ?? 0;
    if (now - last < ONE_HOUR_MS) return null;
    this.lastCleanupAt.set(botId, now);
    return analyzeCleanup(ctx);
  }

  /** Reset the throttle for one bot. */
  clear(botId: string): void {
    this.lastCleanupAt.delete(botId);
  }

  /** Reset all throttles. */
  clearAll(): void {
    this.lastCleanupAt.clear();
  }
}
