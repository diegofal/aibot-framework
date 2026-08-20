import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { ActivityStream } from '../bot/activity-stream';
import type { Config } from '../config';
import type { KarmaService } from '../karma/service';
import type { Logger } from '../logger';
import type { SoulLoader } from '../soul';
import type { ThreadMessage } from '../types/thread';
import {
  TREE_EXCLUDES,
  assertWithinDir,
  isEnabled as isEnabledPure,
  isTrackOnly as isTrackOnlyPure,
  resolveDir as resolveDirPure,
  resolveFilePath as resolveFilePathPure,
} from './paths';
import {
  assessContentQuality as assessContentQualityPure,
  checkCoherence as checkCoherencePure,
  extractDescription as extractDescriptionPure,
  injectFrontmatter as injectFrontmatterPure,
  parseFrontmatter as parseFrontmatterPure,
  resolveCreatedAt as resolveCreatedAtPure,
} from './frontmatter';
import { readSummary as readSummaryPure, writeSummary as writeSummaryPure } from './summary';
import { readActiveGoals as readActiveGoalsPure, rebuildIndexPure } from './html';
import {
  archiveFile as archiveFilePure,
  countFilesInDir as countFilesInDirPure,
  getFileContent as getFileContentPure,
  getNextNumber as getNextNumberPure,
  renumberFile as renumberFilePure,
  updateContent as updateContentPure,
} from './files';
import {
  append as appendChangelog,
  loadAllEntries,
  loadChangelog,
  loadEntry,
  loadStats,
  readEntries as readEntriesPure,
  removeEntriesByPath,
  removeEntry as removeEntryChangelog,
  updateEntry as updateEntryChangelog,
} from './changelog';
import { CleanupScheduler, CleanupCandidate } from './cleanup';
import { buildEntryMap, walkTree } from './tree';
import type { CoherenceCheck, ProductionEntry, ProductionEvaluation, SummaryData, TreeNode } from './types';

export class ProductionsService {
  private baseDir: string;
  private cleanupScheduler = new CleanupScheduler();

  constructor(
    private config: Config,
    private logger: Logger
  ) {
    this.baseDir = resolve(config.productions.baseDir);
  }

  resolveDir(botId: string): string {
    return resolveDirPure(this.config, botId);
  }

  isTrackOnly(botId: string): boolean {
    return isTrackOnlyPure(this.config, botId);
  }

  isEnabled(botId: string): boolean {
    return isEnabledPure(this.config, botId);
  }

  /**
   * Resolve a production entry's file path and validate it stays within the bot's production dir.
   * Returns null if the path escapes the boundary (path traversal).
   * trackOnly entries are allowed to reference paths outside the production dir.
   */
  private resolveFilePath(dir: string, entry: { path: string; trackOnly?: boolean }): string | null {
    return resolveFilePathPure(dir, entry);
  }

  logProduction(entry: Omit<ProductionEntry, 'id'>): ProductionEntry {
    const full: ProductionEntry = { id: randomUUID(), ...entry };
    appendChangelog(join(this.resolveDir(entry.botId), 'changelog.jsonl'), full);
    this.logger.debug({ botId: entry.botId, path: entry.path, id: full.id }, 'Production logged');
    this.rebuildIndex(entry.botId);
    return full;
  }

  getChangelog(
    botId: string,
    opts?: { limit?: number; offset?: number; since?: string; status?: string }
  ): ProductionEntry[] {
    return loadChangelog(this.resolveDir(botId), opts);
  }

  getEntry(botId: string, id: string): ProductionEntry | null {
    return loadEntry(this.resolveDir(botId), id);
  }

  evaluate(
    botId: string,
    id: string,
    evaluation: { status: 'approved' | 'rejected'; rating?: number; feedback?: string },
    soulLoader?: SoulLoader,
    karmaService?: KarmaService,
    activityStream?: ActivityStream
  ): ProductionEntry | null {
    const dir = this.resolveDir(botId);
    const evalData: ProductionEvaluation = {
      status: evaluation.status,
      rating: evaluation.rating,
      feedback: evaluation.feedback,
      evaluatedAt: new Date().toISOString(),
    };

    const updated = updateEntryChangelog(dir, id, (entry) => {
      entry.evaluation = evalData;
    });
    if (!updated) return null;

    this.logger.info(
      { botId, id, status: evaluation.status, rating: evaluation.rating },
      'Production evaluated'
    );

    // Karma: adjust based on evaluation
    if (karmaService) {
      let delta: number;
      let reason: string;
      if (evaluation.status === 'rejected') {
        delta = -10;
        reason = `Production rejected: "${updated.path}"`;
        karmaService.addEvent(botId, delta, reason, 'production', { rating: evaluation.rating });
      } else if (evaluation.rating != null) {
        delta = evaluation.rating >= 4 ? (evaluation.rating === 5 ? 10 : 5) : evaluation.rating;
        reason = `Production approved: "${updated.path}" (rating: ${evaluation.rating}/5)`;
        karmaService.addEvent(botId, delta, reason, 'production', { rating: evaluation.rating });
      } else {
        delta = 3;
        reason = `Production approved: "${updated.path}"`;
        karmaService.addEvent(botId, delta, reason, 'production');
      }

      activityStream?.publish({
        type: 'karma:change',
        botId,
        timestamp: Date.now(),
        data: { delta, reason, source: 'production', path: updated.path },
      });
    }

    // Write feedback to bot memory
    if (soulLoader) {
      const memoryLines = [
        '## Production Evaluation',
        `- File: ${updated.path}`,
        `- Status: ${evaluation.status}`,
      ];
      if (evaluation.rating != null) memoryLines.push(`- Rating: ${evaluation.rating}/5`);
      if (evaluation.feedback) memoryLines.push(`- Feedback: "${evaluation.feedback}"`);
      soulLoader.appendDailyMemory(memoryLines.join('\n'));
    }

    return updated;
  }

  setAiResponse(botId: string, id: string, response: string): ProductionEntry | null {
    const dir = this.resolveDir(botId);
    const updated = updateEntryChangelog(dir, id, (entry) => {
      if (!entry.evaluation) return;
      entry.evaluation.aiResponse = response;
      entry.evaluation.aiResponseAt = new Date().toISOString();
    });
    if (!updated || !updated.evaluation) return null;

    this.logger.info({ botId, id }, 'AI response saved to production evaluation');
    return updated;
  }

  setCoherenceCheck(
    botId: string,
    id: string,
    result: { coherent: boolean; issues: string[]; explanation?: string }
  ): ProductionEntry | null {
    const dir = this.resolveDir(botId);
    const updated = updateEntryChangelog(dir, id, (entry) => {
      entry.coherenceCheck = {
        coherent: result.coherent,
        issues: result.issues,
        explanation: result.explanation,
        checkedAt: new Date().toISOString(),
      };
    });
    if (!updated) return null;

    this.logger.info({ botId, id, coherent: result.coherent }, 'Coherence check saved to production');
    return updated;
  }

  addThreadMessage(
    botId: string,
    id: string,
    role: 'human' | 'bot',
    content: string
  ): { message: ThreadMessage; entry: ProductionEntry } | null {
    const dir = this.resolveDir(botId);
    const msg: ThreadMessage = {
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString(),
    };

    const updated = updateEntryChangelog(dir, id, (entry) => {
      if (!entry.evaluation) {
        entry.evaluation = { evaluatedAt: new Date().toISOString() };
      }
      if (!entry.evaluation.thread) {
        entry.evaluation.thread = [];
      }
      entry.evaluation.thread.push(msg);
    });
    if (!updated) return null;

    this.logger.info({ botId, id, role, msgId: msg.id }, 'Thread message added to production');
    return { message: msg, entry: updated };
  }

  deleteProduction(botId: string, id: string): boolean {
    const dir = this.resolveDir(botId);
    const entry = loadEntry(dir, id);
    if (!entry) return false;

    // Remove the associated file if not trackOnly (side effect stays on facade — §4.1)
    if (!entry.trackOnly) {
      const filePath = this.resolveFilePath(dir, entry);
      if (!filePath) {
        this.logger.warn({ botId, path: entry.path }, 'Production delete blocked: path traversal');
      } else {
        try {
          if (existsSync(filePath)) unlinkSync(filePath);
        } catch (err) {
          this.logger.warn({ err, filePath }, 'Failed to delete production file');
        }
      }
    }

    const removed = removeEntryChangelog(dir, id);
    if (!removed) return false;

    this.logger.info({ botId, id }, 'Production deleted');
    return true;
  }

  /**
   * Delete a file or folder by relative path within the bot's productions dir.
   * Also removes any changelog entries referencing that path.
   */
  deleteByPath(botId: string, relativePath: string): { deletedFiles: number; deletedEntries: number } | null {
    const dir = this.resolveDir(botId);

    // Path traversal protection: assertWithinDir handles absolute paths,
    // `..` segments, and prefix-sibling bypass.
    if (!assertWithinDir(dir, relativePath)) {
      this.logger.warn({ botId, path: relativePath }, 'deleteByPath blocked: path traversal');
      return null;
    }

    const fullPath = resolve(join(dir, relativePath));

    if (!existsSync(fullPath)) {
      return null;
    }

    const stat = statSync(fullPath);
    let deletedFiles = 0;

    if (stat.isDirectory()) {
      deletedFiles = countFilesInDirPure(fullPath);
      rmSync(fullPath, { recursive: true });
    } else {
      unlinkSync(fullPath);
      deletedFiles = 1;
    }

    // Clean changelog entries matching this path (delegated to changelog.ts).
    const deletedEntries = removeEntriesByPath(dir, relativePath);

    this.logger.info({ botId, path: relativePath, deletedFiles, deletedEntries }, 'Production deleted by path');
    return { deletedFiles, deletedEntries };
  }

  updateContent(botId: string, id: string, content: string): boolean {
    const entry = this.getEntry(botId, id);
    if (!entry) return false;

    const dir = this.resolveDir(botId);
    const ok = updateContentPure({ dir }, entry.path, content);
    if (!ok) {
      this.logger.warn({ botId, path: entry.path }, 'Production update blocked or failed');
    }
    return ok;
  }

  getFileContent(botId: string, id: string): string | null {
    const entry = this.getEntry(botId, id);
    if (!entry) return null;

    const dir = this.resolveDir(botId);
    const result = getFileContentPure({ dir }, entry.path);
    return result?.content ?? null;
  }

  getStats(botId: string): {
    total: number;
    approved: number;
    rejected: number;
    unreviewed: number;
    checked: number;
    avgRating: number | null;
  } {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    const entries = readEntriesPure(changelogPath);
    return loadStats(entries);
  }

  /**
   * Assess whether content is mostly template/placeholder vs real content.
   * Returns ratio of real content lines and whether it qualifies as a template.
   * Threshold: < 30% real content = template.
   */
  static assessContentQuality(content: string): { ratio: number; isTemplate: boolean } {
    return assessContentQualityPure(content);
  }

  /**
   * Inject YAML frontmatter with `created_at` into markdown content.
   * Only for `.md` files; skips if content already starts with `---`.
   */
  static injectFrontmatter(content: string, filePath: string, timestamp?: string): string {
    return injectFrontmatterPure(content, filePath, timestamp);
  }

  /**
   * Parse `created_at` from YAML frontmatter. Simple regex-based parser.
   * Returns ISO string or null if not found.
   */
  static parseFrontmatter(content: string): string | null {
    return parseFrontmatterPure(content);
  }

  /**
   * Resolve the best created_at timestamp for a file.
   * Priority: (1) YAML frontmatter, (2) changelog timestamp, (3) stat.birthtime
   */
  static resolveCreatedAt(
    absPath: string,
    relPath: string,
    birthtime: Date,
    changelogTimestampMap: Map<string, string>
  ): Date {
    return resolveCreatedAtPure(absPath, relPath, birthtime, changelogTimestampMap);
  }

  readSummary(botId: string): SummaryData | null {
    return readSummaryPure(this.resolveDir(botId));
  }

  writeSummary(botId: string, data: SummaryData): void {
    writeSummaryPure(this.resolveDir(botId), data);
  }

  getAllEntries(opts?: {
    limit?: number;
    offset?: number;
    status?: string;
    botId?: string;
    since?: string;
  }): { entries: ProductionEntry[]; total: number } {
    const dirs = opts?.botId
      ? [this.resolveDir(opts.botId)]
      : this.config.bots.filter((b) => this.isEnabled(b.id)).map((b) => this.resolveDir(b.id));

    const all = loadAllEntries(dirs, {
      since: opts?.since,
      status: opts?.status,
      botId: opts?.botId,
    });

    const total = all.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 100;
    return { entries: all.slice(offset, offset + limit), total };
  }

  /**
   * Get the next auto-number for files in a given directory.
   * Scans existing files for `^\d{2}_` pattern and returns next number as zero-padded string.
   */
  getNextNumber(botId: string, relativeDir: string): string {
    const dir = this.resolveDir(botId);
    return getNextNumberPure({ dir }, relativeDir);
  }

  /**
   * Rename a file on disk to prepend the next auto-number.
   * Returns the new relative path. Skips if already numbered or if file is in INDEX_EXCLUDES.
   */
  renumberFile(botId: string, relativePath: string): string {
    const dir = this.resolveDir(botId);
    const previousPath = relativePath;
    const newPath = renumberFilePure({ dir }, relativePath);
    if (newPath !== previousPath) {
      this.logger.debug({ botId, from: previousPath, to: newPath }, 'Auto-numbered file');
    }
    return newPath;
  }

  /**
   * Extract a richer description from file content.
   * Returns "Title -- First sentence" capped at 120 chars.
   */
  static extractDescription(content: string): string {
    return extractDescriptionPure(content);
  }

  /**
   * Check coherence of a production file (heuristic, no LLM).
   * Returns whether the content is coherent and a list of issues found.
   */
  checkCoherence(botId: string, relativePath: string): { coherent: boolean; issues: string[] } {
    const dir = this.resolveDir(botId);
    const fullPath = join(dir, relativePath);

    if (!existsSync(fullPath)) {
      return { coherent: false, issues: ['File not found'] };
    }

    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      return { coherent: false, issues: ['Could not read file'] };
    }

    return checkCoherencePure(content);
  }

  /**
   * Rebuild the auto-generated index.html.
   * Composes: cleanup analysis → archive batch → HTML emit.
   * See docs/architecture-docs/productions-refactor.md §3.2 for the cycle history.
   */
  rebuildIndex(botId: string): void {
    const dir = this.resolveDir(botId);
    const soulDir = resolve('config/soul', botId);

    const candidates = this.runCleanup(botId);
    if (candidates && candidates.length > 0) {
      const archived = this.applyArchiveBatch(dir, botId, candidates);
      if (archived > 0) {
        this.logger.info({ botId, archived }, 'Auto-cleanup completed');
      }
    }

    rebuildIndexPure(botId, dir, soulDir);
  }

  /**
   * Read and parse active goals from the bot's GOALS.md soul file.
   * Thin wrapper around html.ts.readActiveGoals.
   */
  readActiveGoals(botId: string): Array<{ text: string; status: string; priority: string; notes?: string }> {
    return readActiveGoalsPure(resolve('config/soul', botId));
  }

  /**
   * Archive a production file by moving it to archived/ with a reason.
   * Composes: archiveFilePure (move) + appendEntry (persist) + rebuildIndex.
   * See docs/architecture-docs/productions-refactor.md §3.2 for the cycle history.
   */
  archiveFile(botId: string, relativePath: string, reason: string): boolean {
    const dir = this.resolveDir(botId);
    const result = archiveFilePure({ dir }, relativePath, reason);
    if (!result.ok) {
      this.logger.warn({ botId, path: relativePath }, 'Cannot archive: file not found or path invalid');
      return false;
    }

    // Stamp the botId on the entry that the pure function returned.
    const entry: ProductionEntry = { ...result.entry, botId };
    this.appendEntry(dir, entry);
    this.rebuildIndex(botId);
    this.logger.info({ botId, from: relativePath, reason }, 'File archived');
    return true;
  }

  /**
   * Append a single ProductionEntry to the changelog.jsonl file.
   * Used by archiveFile (C3 composition) and runCleanup (batch path).
   */
  private appendEntry(dir: string, entry: ProductionEntry): void {
    appendChangelog(join(dir, 'changelog.jsonl'), entry);
  }

  /**
   * Auto-cleanup analysis. Throttled to once per hour per bot.
   * Returns candidates or null when throttled.
   * Delegates to the CleanupScheduler in cleanup.ts (§4.2 — state and
   * function move together).
   */
  private runCleanup(botId: string): CleanupCandidate[] | null {
    const dir = this.resolveDir(botId);
    return this.cleanupScheduler.runCleanup(botId, {
      dir,
      now: Date.now(),
      coherenceCheck: (relPath) => this.checkCoherence(botId, relPath),
    });
  }

  /**
   * Apply a batch of archive operations. For each candidate, move the
   * file to archived/ and append a JSONL entry. Side effects stay on
   * the facade (§4.1).
   */
  private applyArchiveBatch(dir: string, botId: string, candidates: CleanupCandidate[]): number {
    let archived = 0;
    for (const c of candidates) {
      const result = archiveFilePure({ dir }, c.path, c.reason);
      if (result.ok) {
        this.appendEntry(dir, { ...result.entry, botId });
        archived++;
      }
    }
    return archived;
  }


  /**
   * Build a directory tree for a bot's productions folder.
   * Enriches file nodes with changelog metadata (entryId, evaluation, description).
   * Skips disabled bots and entries with absolute paths.
   */
  getDirectoryTree(botId: string): TreeNode[] {
    if (!this.isEnabled(botId)) return [];
    const dir = this.resolveDir(botId);
    if (!existsSync(dir)) return [];

    return walkTree({ dir, entryMap: buildEntryMap(dir), excludes: TREE_EXCLUDES });
  }

  /**
   * Read a file by relative path within a bot's productions directory.
   * Validates against path traversal.
   */
  getFileContentByPath(
    botId: string,
    relativePath: string
  ): { content: string; size: number } | null {
    const dir = this.resolveDir(botId);

    // Path traversal protection via assertWithinDir.
    if (!assertWithinDir(dir, relativePath)) return null;

    const fullPath = resolve(join(dir, relativePath));

    try {
      if (!existsSync(fullPath)) return null;
      const stat = statSync(fullPath);
      if (!stat.isFile()) return null;
      const content = readFileSync(fullPath, 'utf-8');
      return { content, size: stat.size };
    } catch {
      return null;
    }
  }

  /**
   * Get directory trees for all enabled bots, wrapped as top-level bot directories.
   * Returns TreeNode[] where each root node is a bot folder containing its productions tree.
   */
  getAllDirectoryTrees(): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (const bot of this.config.bots) {
      if (!this.isEnabled(bot.id)) continue;
      const children = this.getDirectoryTree(bot.id);
      // Only include bots that have files (or at least a dir)
      const dir = this.resolveDir(bot.id);
      if (!existsSync(dir)) continue;
      nodes.push({
        name: bot.name || bot.id,
        path: bot.id,
        type: 'dir',
        children,
      });
    }
    return nodes;
  }

  getAllBotStats(): Array<
    { botId: string; name: string } & ReturnType<ProductionsService['getStats']>
  > {
    return this.config.bots
      .filter((b) => this.isEnabled(b.id))
      .map((b) => ({
        botId: b.id,
        name: b.name,
        ...this.getStats(b.id),
      }))
      .filter((s) => s.total > 0 || this.isEnabled(s.botId));
  }
}
