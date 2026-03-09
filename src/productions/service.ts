import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { ActivityStream } from '../bot/activity-stream';
import type { Config } from '../config';
import type { KarmaService } from '../karma/service';
import type { Logger } from '../logger';
import type { SoulLoader } from '../soul';
import { parseGoals } from '../tools/goals';
import type { ThreadMessage } from '../types/thread';
import type { CoherenceCheck, ProductionEntry, ProductionEvaluation, SummaryData, TreeNode } from './types';

export class ProductionsService {
  private baseDir: string;
  private lastCleanupAt = new Map<string, number>();

  constructor(
    private config: Config,
    private logger: Logger
  ) {
    this.baseDir = resolve(config.productions.baseDir);
  }

  /** Safely parse JSONL lines, skipping corrupt/non-JSON lines. */
  private parseJsonlLines(lines: string[]): ProductionEntry[] {
    const entries: ProductionEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip corrupt lines (e.g. markdown accidentally written to JSONL)
      }
    }
    return entries;
  }

  resolveDir(botId: string): string {
    const botConfig = this.config.bots.find((b) => b.id === botId);
    // Priority: explicit productions.dir > botConfig.workDir (tenant-resolved) > default
    const dir = botConfig?.productions?.dir ?? botConfig?.workDir ?? join(this.baseDir, botId);
    const resolved = resolve(dir);
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true });
    }
    return resolved;
  }

  isTrackOnly(botId: string): boolean {
    const botConfig = this.config.bots.find((b) => b.id === botId);
    return botConfig?.productions?.trackOnly ?? false;
  }

  isEnabled(botId: string): boolean {
    if (!this.config.productions.enabled) return false;
    const botConfig = this.config.bots.find((b) => b.id === botId);
    return botConfig?.productions?.enabled !== false;
  }

  /**
   * Resolve a production entry's file path and validate it stays within the bot's production dir.
   * Returns null if the path escapes the boundary (path traversal).
   * trackOnly entries are allowed to reference paths outside the production dir.
   */
  private resolveFilePath(dir: string, entry: { path: string; trackOnly?: boolean }): string | null {
    if (entry.trackOnly) return resolve(entry.path);
    const filePath = entry.path.startsWith('/') ? resolve(entry.path) : resolve(join(dir, entry.path));
    if (!filePath.startsWith(dir + '/') && filePath !== dir) return null;
    return filePath;
  }

  rewritePath(botId: string, originalPath: string): string {
    const dir = this.resolveDir(botId);
    // Use the basename to avoid path traversal, but keep relative structure
    const rel = relative(process.cwd(), resolve(originalPath));
    // Replace path separators to create a flat-ish structure
    const safeName = rel.replace(/\.\.\//g, '').replace(/\//g, '__');
    return join(dir, safeName);
  }

  logProduction(entry: Omit<ProductionEntry, 'id'>): ProductionEntry {
    const full: ProductionEntry = { id: randomUUID(), ...entry };
    const dir = this.resolveDir(entry.botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    appendFileSync(changelogPath, `${JSON.stringify(full)}\n`, 'utf-8');
    this.logger.debug({ botId: entry.botId, path: entry.path, id: full.id }, 'Production logged');
    this.rebuildIndex(entry.botId);
    return full;
  }

  getChangelog(
    botId: string,
    opts?: { limit?: number; offset?: number; since?: string; status?: string }
  ): ProductionEntry[] {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return [];

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    let entries: ProductionEntry[] = this.parseJsonlLines(lines);

    if (opts?.since) {
      const sinceDate = new Date(opts.since).getTime();
      entries = entries.filter((e) => new Date(e.timestamp).getTime() >= sinceDate);
    }

    if (opts?.status) {
      if (opts.status === 'unreviewed') {
        entries = entries.filter((e) => !e.evaluation?.status);
      } else {
        entries = entries.filter((e) => e.evaluation?.status === opts.status);
      }
    }

    // Sort newest first
    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 100;
    return entries.slice(offset, offset + limit);
  }

  getEntry(botId: string, id: string): ProductionEntry | null {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return null;

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const entry: ProductionEntry = JSON.parse(line);
      if (entry.id === id) return entry;
    }
    return null;
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
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return null;

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries: ProductionEntry[] = this.parseJsonlLines(lines);

    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return null;

    const evalData: ProductionEvaluation = {
      status: evaluation.status,
      rating: evaluation.rating,
      feedback: evaluation.feedback,
      evaluatedAt: new Date().toISOString(),
    };
    entries[idx].evaluation = evalData;

    // Rewrite the JSONL file
    const updated = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
    writeFileSync(changelogPath, updated, 'utf-8');

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
        reason = `Production rejected: "${entries[idx].path}"`;
        karmaService.addEvent(botId, delta, reason, 'production', { rating: evaluation.rating });
      } else if (evaluation.rating != null) {
        delta = evaluation.rating >= 4 ? (evaluation.rating === 5 ? 10 : 5) : evaluation.rating;
        reason = `Production approved: "${entries[idx].path}" (rating: ${evaluation.rating}/5)`;
        karmaService.addEvent(botId, delta, reason, 'production', { rating: evaluation.rating });
      } else {
        delta = 3;
        reason = `Production approved: "${entries[idx].path}"`;
        karmaService.addEvent(botId, delta, reason, 'production');
      }

      activityStream?.publish({
        type: 'karma:change',
        botId,
        timestamp: Date.now(),
        data: { delta, reason, source: 'production', path: entries[idx].path },
      });
    }

    // Write feedback to bot memory
    if (soulLoader) {
      const memoryLines = [
        '## Production Evaluation',
        `- File: ${entries[idx].path}`,
        `- Status: ${evaluation.status}`,
      ];
      if (evaluation.rating != null) memoryLines.push(`- Rating: ${evaluation.rating}/5`);
      if (evaluation.feedback) memoryLines.push(`- Feedback: "${evaluation.feedback}"`);
      soulLoader.appendDailyMemory(memoryLines.join('\n'));
    }

    return entries[idx];
  }

  setAiResponse(botId: string, id: string, response: string): ProductionEntry | null {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return null;

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries: ProductionEntry[] = this.parseJsonlLines(lines);

    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1 || !entries[idx].evaluation) return null;

    entries[idx].evaluation!.aiResponse = response;
    entries[idx].evaluation!.aiResponseAt = new Date().toISOString();

    const updated = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
    writeFileSync(changelogPath, updated, 'utf-8');

    this.logger.info({ botId, id }, 'AI response saved to production evaluation');
    return entries[idx];
  }

  setCoherenceCheck(
    botId: string,
    id: string,
    result: { coherent: boolean; issues: string[]; explanation?: string }
  ): ProductionEntry | null {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return null;

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries: ProductionEntry[] = this.parseJsonlLines(lines);

    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return null;

    entries[idx].coherenceCheck = {
      coherent: result.coherent,
      issues: result.issues,
      explanation: result.explanation,
      checkedAt: new Date().toISOString(),
    };

    const updated = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
    writeFileSync(changelogPath, updated, 'utf-8');

    this.logger.info({ botId, id, coherent: result.coherent }, 'Coherence check saved to production');
    return entries[idx];
  }

  addThreadMessage(
    botId: string,
    id: string,
    role: 'human' | 'bot',
    content: string
  ): { message: ThreadMessage; entry: ProductionEntry } | null {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return null;

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries: ProductionEntry[] = this.parseJsonlLines(lines);

    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return null;

    // Create evaluation stub if none exists
    if (!entries[idx].evaluation) {
      entries[idx].evaluation = { evaluatedAt: new Date().toISOString() };
    }

    if (!entries[idx].evaluation?.thread) {
      entries[idx].evaluation!.thread = [];
    }

    const msg: ThreadMessage = {
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    entries[idx].evaluation?.thread?.push(msg);

    const updated = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
    writeFileSync(changelogPath, updated, 'utf-8');

    this.logger.debug({ botId, id, role, msgId: msg.id }, 'Thread message added to production');
    return { message: msg, entry: entries[idx] };
  }

  deleteProduction(botId: string, id: string): boolean {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return false;

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries: ProductionEntry[] = this.parseJsonlLines(lines);

    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;

    const entry = entries[idx];

    // Remove the associated file if not trackOnly
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

    entries.splice(idx, 1);
    const updated =
      entries.length > 0 ? `${entries.map((e) => JSON.stringify(e)).join('\n')}\n` : '';
    writeFileSync(changelogPath, updated, 'utf-8');

    this.logger.info({ botId, id }, 'Production deleted');
    return true;
  }

  /**
   * Delete a file or folder by relative path within the bot's productions dir.
   * Also removes any changelog entries referencing that path.
   */
  deleteByPath(botId: string, relativePath: string): { deletedFiles: number; deletedEntries: number } | null {
    // Path traversal protection
    if (relativePath.includes('..') || relativePath.startsWith('/')) {
      this.logger.warn({ botId, path: relativePath }, 'deleteByPath blocked: path traversal');
      return null;
    }

    const dir = this.resolveDir(botId);
    const fullPath = resolve(join(dir, relativePath));

    // Ensure resolved path is within bot dir
    if (!fullPath.startsWith(dir + '/') && fullPath !== dir) {
      this.logger.warn({ botId, path: relativePath }, 'deleteByPath blocked: resolved outside bot dir');
      return null;
    }

    if (!existsSync(fullPath)) {
      return null;
    }

    const stat = statSync(fullPath);
    let deletedFiles = 0;

    if (stat.isDirectory()) {
      // Count files before removing
      const countFiles = (p: string): number => {
        let count = 0;
        for (const entry of readdirSync(p, { withFileTypes: true })) {
          if (entry.isDirectory()) count += countFiles(join(p, entry.name));
          else count++;
        }
        return count;
      };
      deletedFiles = countFiles(fullPath);
      rmSync(fullPath, { recursive: true });
    } else {
      unlinkSync(fullPath);
      deletedFiles = 1;
    }

    // Clean changelog entries matching this path
    const changelogPath = join(dir, 'changelog.jsonl');
    let deletedEntries = 0;
    if (existsSync(changelogPath)) {
      const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
      const entries: ProductionEntry[] = this.parseJsonlLines(lines);
      const prefix = stat.isDirectory() ? `${relativePath}/` : null;
      const remaining = entries.filter((e) => {
        const match = e.path === relativePath || (prefix && e.path.startsWith(prefix));
        if (match) deletedEntries++;
        return !match;
      });
      const updated = remaining.length > 0
        ? `${remaining.map((e) => JSON.stringify(e)).join('\n')}\n`
        : '';
      writeFileSync(changelogPath, updated, 'utf-8');
    }

    this.logger.info({ botId, path: relativePath, deletedFiles, deletedEntries }, 'Production deleted by path');
    return { deletedFiles, deletedEntries };
  }

  updateContent(botId: string, id: string, content: string): boolean {
    const entry = this.getEntry(botId, id);
    if (!entry) return false;

    const dir = this.resolveDir(botId);
    const filePath = this.resolveFilePath(dir, entry);
    if (!filePath) {
      this.logger.warn({ botId, path: entry.path }, 'Production update blocked: path traversal');
      return false;
    }

    try {
      const fileDir = join(filePath, '..');
      if (!existsSync(fileDir)) mkdirSync(fileDir, { recursive: true });
      writeFileSync(filePath, content, 'utf-8');
      return true;
    } catch (err) {
      this.logger.error({ err, filePath }, 'Failed to update production content');
      return false;
    }
  }

  getFileContent(botId: string, id: string): string | null {
    const entry = this.getEntry(botId, id);
    if (!entry) return null;

    const dir = this.resolveDir(botId);
    const filePath = this.resolveFilePath(dir, entry);
    if (!filePath) return null;

    try {
      if (!existsSync(filePath)) return null;
      return readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
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
    if (!existsSync(changelogPath)) {
      return { total: 0, approved: 0, rejected: 0, unreviewed: 0, checked: 0, avgRating: null };
    }

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries: ProductionEntry[] = this.parseJsonlLines(lines);

    let approved = 0;
    let rejected = 0;
    let unreviewed = 0;
    let checked = 0;
    const ratings: number[] = [];

    for (const entry of entries) {
      if (!entry.evaluation?.status) {
        unreviewed++;
      } else if (entry.evaluation.status === 'approved') {
        approved++;
        if (entry.evaluation.rating != null) ratings.push(entry.evaluation.rating);
      } else {
        rejected++;
        if (entry.evaluation.rating != null) ratings.push(entry.evaluation.rating);
      }
      if (entry.coherenceCheck) checked++;
    }

    return {
      total: entries.length,
      approved,
      rejected,
      unreviewed,
      checked,
      avgRating:
        ratings.length > 0
          ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
          : null,
    };
  }

  /**
   * Assess whether content is mostly template/placeholder vs real content.
   * Returns ratio of real content lines and whether it qualifies as a template.
   * Threshold: < 30% real content = template.
   */
  static assessContentQuality(content: string): { ratio: number; isTemplate: boolean } {
    if (!content || content.trim().length === 0) {
      return { ratio: 0, isTemplate: true };
    }

    const lines = content.split('\n');
    let totalLines = 0;
    let emptyOrPlaceholderLines = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue; // skip blank lines entirely

      totalLines++;

      // Detect placeholder/template patterns
      const isPlaceholder =
        // Headings with no content (just a heading)
        /^#{1,6}\s*$/.test(trimmed) ||
        // Empty bullet points
        /^[-*]\s*$/.test(trimmed) ||
        // TBD/TODO/placeholder markers
        /\b(TBD|TODO|FIXME|PLACEHOLDER|\$_{2,}|___+|\.\.\.|N\/A)\b/i.test(trimmed) ||
        // Unchecked checkbox only
        /^[-*]\s*\[\s*\]\s*$/.test(trimmed) ||
        // Lines that are only a heading marker with generic text
        /^#{1,6}\s+(Section|Title|Heading|Overview|Introduction|Summary|Conclusion|Details|Notes)\s*$/i.test(
          trimmed
        ) ||
        // Lines that are just separators
        /^[-=_*]{3,}$/.test(trimmed);

      if (isPlaceholder) {
        emptyOrPlaceholderLines++;
      }
    }

    if (totalLines === 0) {
      return { ratio: 0, isTemplate: true };
    }

    const ratio = (totalLines - emptyOrPlaceholderLines) / totalLines;
    return { ratio: Math.round(ratio * 100) / 100, isTemplate: ratio < 0.3 };
  }

  /**
   * Inject YAML frontmatter with `created_at` into markdown content.
   * Only for `.md` files; skips if content already starts with `---`.
   */
  static injectFrontmatter(content: string, filePath: string, timestamp?: string): string {
    if (!filePath.endsWith('.md')) return content;
    if (content.trimStart().startsWith('---')) return content;
    const ts = timestamp ?? new Date().toISOString();
    return `---\ncreated_at: "${ts}"\n---\n\n${content}`;
  }

  /**
   * Parse `created_at` from YAML frontmatter. Simple regex-based parser.
   * Returns ISO string or null if not found.
   */
  static parseFrontmatter(content: string): string | null {
    if (!content.trimStart().startsWith('---')) return null;
    const endIdx = content.indexOf('---', content.indexOf('---') + 3);
    if (endIdx === -1) return null;
    const frontmatter = content.slice(content.indexOf('---') + 3, endIdx);
    const match = frontmatter.match(/created_at:\s*"?([^"\n]+)"?/);
    return match ? match[1].trim() : null;
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
    // 1) Try YAML frontmatter
    try {
      if (existsSync(absPath) && absPath.endsWith('.md')) {
        const content = readFileSync(absPath, 'utf-8');
        const ts = ProductionsService.parseFrontmatter(content);
        if (ts) {
          const d = new Date(ts);
          if (!Number.isNaN(d.getTime())) return d;
        }
      }
    } catch { /* skip */ }

    // 2) Try changelog timestamp
    const changelogTs = changelogTimestampMap.get(relPath);
    if (changelogTs) {
      const d = new Date(changelogTs);
      if (!Number.isNaN(d.getTime())) return d;
    }

    // 3) Fallback to stat.birthtime
    return birthtime;
  }

  readSummary(botId: string): SummaryData | null {
    const dir = this.resolveDir(botId);
    const summaryPath = join(dir, 'summary.json');
    try {
      if (!existsSync(summaryPath)) return null;
      return JSON.parse(readFileSync(summaryPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  writeSummary(botId: string, data: SummaryData): void {
    const dir = this.resolveDir(botId);
    const summaryPath = join(dir, 'summary.json');
    writeFileSync(summaryPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  getAllEntries(opts?: {
    limit?: number;
    offset?: number;
    status?: string;
    botId?: string;
  }): { entries: ProductionEntry[]; total: number } {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;

    let allEntries: ProductionEntry[] = [];

    if (opts?.botId) {
      allEntries = this.loadRawChangelog(opts.botId);
    } else {
      for (const bot of this.config.bots) {
        if (!this.isEnabled(bot.id)) continue;
        allEntries.push(...this.loadRawChangelog(bot.id));
      }
    }

    // Apply status filter
    if (opts?.status) {
      if (opts.status === 'unreviewed') {
        allEntries = allEntries.filter((e) => !e.evaluation?.status);
      } else {
        allEntries = allEntries.filter((e) => e.evaluation?.status === opts.status);
      }
    }

    // Sort newest first
    allEntries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const total = allEntries.length;
    const entries = allEntries.slice(offset, offset + limit);
    return { entries, total };
  }

  /**
   * Get the next auto-number for files in a given directory.
   * Scans existing files for `^\d{2}_` pattern and returns next number as zero-padded string.
   */
  getNextNumber(botId: string, relativeDir: string): string {
    const dir = this.resolveDir(botId);
    const targetDir = relativeDir ? join(dir, relativeDir) : dir;

    if (!existsSync(targetDir)) {
      return '01';
    }

    let maxNum = 0;
    try {
      const entries = readdirSync(targetDir);
      for (const entry of entries) {
        const match = entry.match(/^(\d{2})_/);
        if (match) {
          const num = Number.parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      }
    } catch {
      return '01';
    }

    return String(maxNum + 1).padStart(2, '0');
  }

  /**
   * Rename a file on disk to prepend the next auto-number.
   * Returns the new relative path. Skips if already numbered or if file is in INDEX_EXCLUDES.
   */
  renumberFile(botId: string, relativePath: string): string {
    const fileName = basename(relativePath);

    // Skip excluded files
    if (ProductionsService.INDEX_EXCLUDES.has(fileName)) return relativePath;

    // Skip if already numbered
    if (/^\d{2}_/.test(fileName)) return relativePath;

    const relDir = dirname(relativePath) === '.' ? '' : dirname(relativePath);
    const nextNum = this.getNextNumber(botId, relDir);
    const numberedName = `${nextNum}_${fileName}`;
    const newRelPath = relDir ? `${relDir}/${numberedName}` : numberedName;

    const dir = this.resolveDir(botId);
    const srcPath = join(dir, relativePath);
    const destPath = join(dir, newRelPath);

    if (!existsSync(srcPath)) return relativePath;

    try {
      renameSync(srcPath, destPath);
      this.logger.debug({ botId, from: relativePath, to: newRelPath }, 'Auto-numbered file');
      return newRelPath;
    } catch (err) {
      this.logger.warn({ err, botId, path: relativePath }, 'Failed to auto-number file');
      return relativePath;
    }
  }

  /**
   * Extract a richer description from file content.
   * Returns "Title -- First sentence" capped at 120 chars.
   */
  static extractDescription(content: string): string {
    if (!content || content.trim().length === 0) return '';

    const lines = content.split('\n');
    let title = '';
    let firstSentence = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Find first heading
      if (!title) {
        const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
        if (headingMatch) {
          title = headingMatch[1].trim();
          continue;
        }
      }

      // Skip metadata lines, bullets, sub-headings, tables, separators
      if (title && !firstSentence) {
        if (/^#{1,6}\s/.test(trimmed)) break; // hit another heading, stop
        if (/^[-*+]\s/.test(trimmed)) continue; // bullet
        if (/^\|/.test(trimmed)) continue; // table
        if (/^[-=_*]{3,}$/.test(trimmed)) continue; // separator
        if (/^>\s/.test(trimmed)) continue; // blockquote
        if (/^```/.test(trimmed)) break; // code block, stop
        if (/^(date|author|tags|category|status):/i.test(trimmed)) continue; // metadata

        // Found a paragraph line — extract first sentence
        const sentenceMatch = trimmed.match(/^(.+?[.!?])\s/);
        firstSentence = sentenceMatch ? sentenceMatch[1] : trimmed;
        break;
      }
    }

    if (!title && !firstSentence) return '';
    if (!firstSentence) return title.slice(0, 120);
    if (!title) return firstSentence.slice(0, 120);

    const combined = `${title} -- ${firstSentence}`;
    return combined.length > 120 ? `${combined.slice(0, 117)}...` : combined;
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

    const issues: string[] = [];

    // Check 1: Too small (< 100 chars of real content)
    const stripped = content.replace(/\s+/g, '');
    if (stripped.length < 100) {
      issues.push('Content too small (less than 100 characters of real content)');
    }

    // Check 2: Template/placeholder ratio
    const quality = ProductionsService.assessContentQuality(content);
    if (quality.isTemplate) {
      issues.push(
        `High placeholder ratio (${Math.round((1 - quality.ratio) * 100)}% placeholder content)`
      );
    }

    // Check 3: Broken structure — many headings, few paragraphs
    const lines = content.split('\n');
    let headingCount = 0;
    let paragraphCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^#{1,6}\s/.test(trimmed)) {
        headingCount++;
      } else if (
        trimmed.length > 20 &&
        !/^[-*+|>]/.test(trimmed) &&
        !/^[-=_*]{3,}$/.test(trimmed)
      ) {
        paragraphCount++;
      }
    }
    if (headingCount >= 4 && paragraphCount < headingCount) {
      issues.push(
        `Broken structure: ${headingCount} headings but only ${paragraphCount} content paragraphs`
      );
    }

    return { coherent: issues.length === 0, issues };
  }

  /** Files/dirs excluded from index.html generation */
  private static readonly INDEX_EXCLUDES = new Set([
    'changelog.jsonl',
    'summary.json',
    'INDEX.md',
    'index.html',
    '.gitignore',
    'node_modules',
    'venv',
    '.vercel',
    '.git',
  ]);

  /** Files/dirs excluded from tree display */
  private static readonly TREE_EXCLUDES = new Set([
    'changelog.jsonl',
    'summary.json',
    '.gitignore',
    'node_modules',
    'venv',
    '.vercel',
    '.git',
  ]);

  /** Format a Date as `YYYY-MM-DD HH:mm` */
  private static formatDatetime(d: Date): string {
    const iso = d.toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }

  /**
   * Read and parse active goals from the bot's GOALS.md soul file.
   * Returns structured goal data for embedding in the production index.
   */
  readActiveGoals(botId: string): Array<{ text: string; status: string; priority: string; notes?: string }> {
    const soulDir = resolve('config/soul', botId);
    const goalsPath = join(soulDir, 'GOALS.md');
    try {
      if (!existsSync(goalsPath)) return [];
      const content = readFileSync(goalsPath, 'utf-8');
      const { active } = parseGoals(content);
      if (active.length > 0) {
        return active.map((g) => ({
          text: g.text,
          status: g.status,
          priority: g.priority,
          notes: g.notes,
        }));
      }

      // Fallback: parse first ## section as bullet list (handles non-standard formats
      // like "## Metas a Corto Plazo" with "- **bold**: description" items)
      return ProductionsService.parseFirstSectionAsBullets(content);
    } catch {
      return [];
    }
  }

  /**
   * Fallback parser for GOALS.md files that don't follow the standard
   * `## Active Goals` + `- [ ] text` format. Extracts items from the
   * first `##` section, handling bold-prefixed bullets.
   */
  private static parseFirstSectionAsBullets(
    content: string,
  ): Array<{ text: string; status: string; priority: string }> {
    const lines = content.split('\n');
    let inFirstSection = false;
    const goals: Array<{ text: string; status: string; priority: string }> = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('## ')) {
        if (inFirstSection) break;
        inFirstSection = true;
        continue;
      }
      if (!inFirstSection) continue;

      // Match "- **bold text**: rest" or "- **bold text**" or plain "- text"
      const boldMatch = trimmed.match(/^- \*\*(.+?)\*\*(?::\s*(.+))?$/);
      if (boldMatch) {
        const desc = boldMatch[2] ? `${boldMatch[1]}: ${boldMatch[2]}` : boldMatch[1];
        goals.push({ text: desc, status: 'pending', priority: 'medium' });
        continue;
      }
      const plainMatch = trimmed.match(/^- (.+)$/);
      if (plainMatch && !plainMatch[1].startsWith('[')) {
        goals.push({ text: plainMatch[1], status: 'pending', priority: 'medium' });
      }
    }
    return goals;
  }

  /**
   * Rebuild the auto-generated index.html for a production directory.
   * Generates a self-contained SPA with sidebar navigation, active goals,
   * and inline file viewer matching the architecture-docs design system.
   * Runs auto-cleanup (throttled) before rebuilding.
   */
  rebuildIndex(botId: string): void {
    this.runCleanup(botId);

    const dir = this.resolveDir(botId);

    const descMap = new Map<string, string>();
    const changelogTimestampMap = new Map<string, string>();
    const changelogPath = join(dir, 'changelog.jsonl');
    if (existsSync(changelogPath)) {
      const rawLines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of rawLines) {
        try {
          const entry: ProductionEntry = JSON.parse(line);
          descMap.set(entry.path, entry.description);
          if (entry.action === 'create' && !changelogTimestampMap.has(entry.path)) {
            changelogTimestampMap.set(entry.path, entry.timestamp);
          }
        } catch { /* skip */ }
      }
    }

    interface FileInfo {
      relativePath: string;
      name: string;
      dir: string;
      size: number;
      created: Date;
      isArchived: boolean;
      description: string;
    }

    const files: FileInfo[] = [];
    let dirCount = 0;

    const walk = (current: string, relPrefix: string): void => {
      let entries: string[];
      try { entries = readdirSync(current); } catch { return; }

      for (const entry of entries) {
        if (ProductionsService.INDEX_EXCLUDES.has(entry)) continue;
        const fullPath = join(current, entry);
        let stat;
        try { stat = statSync(fullPath); } catch { continue; }

        if (stat.isDirectory()) {
          dirCount++;
          walk(fullPath, relPrefix ? `${relPrefix}/${entry}` : entry);
        } else {
          const relPath = relPrefix ? `${relPrefix}/${entry}` : entry;
          const created = ProductionsService.resolveCreatedAt(
            fullPath, relPath, stat.birthtime, changelogTimestampMap
          );
          files.push({
            relativePath: relPath,
            name: entry,
            dir: relPrefix,
            size: stat.size,
            created,
            isArchived: relPrefix === 'archived' || relPrefix.startsWith('archived/'),
            description: this.getFileDescription(relPath, descMap, fullPath),
          });
        }
      }
    };
    walk(dir, '');

    const goals = this.readActiveGoals(botId);
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    const html = this.generateIndexHtml(botId, files, goals, dirCount, totalSize);

    writeFileSync(join(dir, 'index.html'), html, 'utf-8');
  }

  /** Load the vendored marked.min.js for inline embedding. Cached after first read. */
  private static _markedJs: string | null = null;
  private static loadMarkedJs(): string {
    if (ProductionsService._markedJs) return ProductionsService._markedJs;
    try {
      const markedPath = join(dirname(new URL(import.meta.url).pathname), 'marked.min.js');
      ProductionsService._markedJs = readFileSync(markedPath, 'utf-8');
    } catch {
      ProductionsService._markedJs = '/* marked.min.js not found */';
    }
    return ProductionsService._markedJs;
  }

  private static escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private static fileIcon(name: string): string {
    if (name.endsWith('.md')) return '\u{1F4DD}';
    if (name.endsWith('.html')) return '\u{1F310}';
    if (name.endsWith('.json')) return '\u{1F4CB}';
    if (name.endsWith('.csv') || name.endsWith('.tsv')) return '\u{1F4CA}';
    if (name.endsWith('.py') || name.endsWith('.ts') || name.endsWith('.js')) return '\u{1F4BB}';
    return '\u{1F4C4}';
  }

  /**
   * Generate a self-contained index.html SPA for a bot's production directory.
   */
  private generateIndexHtml(
    botId: string,
    files: Array<{
      relativePath: string; name: string; dir: string;
      size: number; created: Date; isArchived: boolean; description: string;
    }>,
    goals: Array<{ text: string; status: string; priority: string; notes?: string }>,
    dirCount: number,
    totalSize: number
  ): string {
    const esc = ProductionsService.escHtml;
    const fmtDate = ProductionsService.formatDatetime;
    const fmtSize = this.formatSize.bind(this);
    const icon = ProductionsService.fileIcon;

    const nonArchived = files.filter((f) => !f.isArchived);
    const archived = files.filter((f) => f.isArchived);

    const groups = new Map<string, typeof files>();
    for (const f of nonArchived) {
      const key = f.dir || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(f);
    }
    const sortedGroupKeys = [...groups.keys()].sort((a, b) => {
      if (a === '') return -1;
      if (b === '') return 1;
      return a.localeCompare(b);
    });

    // Build goals HTML
    let goalsHtml = '';
    if (goals.length > 0) {
      goalsHtml = '<h2>Active Goals</h2>\n<div class="goals-list">\n';
      for (const g of goals) {
        const badgeClass = g.status === 'in_progress' ? 'badge-green'
          : g.status === 'blocked' ? 'badge-high'
          : g.status === 'ready_for_human_review' || g.status === 'ready_for_activation' ? 'badge-yellow'
          : 'badge-dim';
        const prioClass = g.priority === 'high' ? 'badge-high'
          : g.priority === 'low' ? 'badge-low' : 'badge-medium';
        goalsHtml += `<div class="goal-card">
  <div class="goal-text">${esc(g.text)}</div>
  <div class="goal-meta"><span class="badge ${badgeClass}">${esc(g.status)}</span> <span class="badge ${prioClass}">${esc(g.priority)}</span></div>
  ${g.notes ? `<div class="goal-notes">${esc(g.notes)}</div>` : ''}
</div>\n`;
      }
      goalsHtml += '</div>\n';
    } else {
      goalsHtml = '<h2>Active Goals</h2>\n<p class="text-dim">No active goals.</p>\n';
    }

    // Build file table HTML (or empty state)
    let tableHtml = '';
    if (nonArchived.length === 0) {
      tableHtml = `<div style="text-align:center;padding:60px 20px">
  <div style="font-size:48px;margin-bottom:16px">\u{1F4C2}</div>
  <h2 style="border:none;margin:0 0 12px;font-size:20px">No productions yet</h2>
  <p class="text-dim" style="max-width:400px;margin:0 auto">This bot hasn't created any production files yet. Once it starts working on its goals, files will appear here.</p>
</div>\n`;
    } else {
      tableHtml = '<h2>Files</h2>\n';
      tableHtml += '<table><thead><tr><th>File</th><th>Description</th><th>Created</th><th>Size</th></tr></thead><tbody>\n';
      const chronoFiles = [...nonArchived].sort((a, b) => b.created.getTime() - a.created.getTime());
      for (const f of chronoFiles) {
        tableHtml += `<tr>
  <td><a href="/#/productions?bot=${esc(botId)}&amp;file=${esc(f.relativePath)}" class="file-link-inline">${icon(f.name)} ${esc(f.name)}</a></td>
  <td class="text-dim">${esc(f.description)}</td>
  <td class="text-dim">${fmtDate(f.created)}</td>
  <td class="text-dim">${fmtSize(f.size)}</td>
</tr>\n`;
      }
      tableHtml += '</tbody></table>\n';
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Productions — ${esc(botId)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f1117;--bg-card:#181a20;--bg-hover:#1e2028;--border:#2a2d36;--text:#e0e0e6;--text-dim:#8b8d97;--accent:#6c8cff;--accent-hover:#8da8ff;--green:#34d399;--red:#f87171;--orange:#fbbf24;--purple:#a78bfa;--cyan:#22d3ee;--radius:6px;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,sans-serif;--mono:"SF Mono",SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace}
html{scroll-behavior:smooth}
body{font-family:var(--font);font-size:15px;line-height:1.65;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-hover);text-decoration:underline}
.content{max-width:960px;margin:0 auto;padding:40px 40px 80px}
.page-header{margin-bottom:36px;padding-bottom:20px;border-bottom:1px solid var(--border)}
.page-header h1{font-size:28px;font-weight:700;margin-bottom:6px}
.page-header p{color:var(--text-dim);font-size:15px}
h2{font-size:22px;font-weight:600;margin:40px 0 16px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.stat-row{display:flex;gap:16px;margin:24px 0;flex-wrap:wrap}
.stat{flex:1;min-width:100px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center}
.stat .number{font-size:28px;font-weight:700;color:var(--accent)}
.stat .label{font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;margin-top:4px}
table{width:100%;border-collapse:collapse;margin:16px 0;font-size:14px}
thead th{text-align:left;padding:10px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim);border-bottom:2px solid var(--border)}
tbody td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:top}
tbody tr:hover{background:var(--bg-hover)}
.text-dim{color:var(--text-dim)}
.badge{display:inline-block;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}
.badge-high{background:rgba(248,113,113,.15);color:var(--red)}
.badge-medium{background:rgba(251,191,36,.15);color:var(--orange)}
.badge-low{background:rgba(108,140,255,.15);color:var(--accent)}
.badge-green{background:rgba(52,211,153,.15);color:var(--green)}
.badge-yellow{background:rgba(251,191,36,.15);color:var(--orange)}
.badge-dim{background:rgba(148,163,184,.12);color:var(--text-dim)}
.goal-card{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px}
.goal-text{font-size:14px;margin-bottom:8px}
.goal-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.goal-notes{font-size:12px;color:var(--text-dim);line-height:1.5;margin-top:6px}
@media(max-width:600px){
  .content{padding:40px 16px 60px}
  .stat-row{flex-direction:column}
  table{font-size:13px}
  thead th,tbody td{padding:8px}
}
</style>
</head>
<body>
<div class="content">
  <div class="page-header">
    <h1>Productions &mdash; ${esc(botId)}</h1>
    <p>Last updated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
  </div>
  <div class="stat-row">
    <div class="stat"><div class="number">${nonArchived.length}</div><div class="label">Files</div></div>
    <div class="stat"><div class="number">${fmtSize(totalSize)}</div><div class="label">Total Size</div></div>
    ${archived.length > 0 ? `<div class="stat"><div class="number">${archived.length}</div><div class="label">Archived</div></div>` : ''}
  </div>
  ${goalsHtml}
  ${tableHtml}
</div>
</body>
</html>`;
  }

  /**
   * Archive a production file by moving it to archived/ with a reason.
   */
  archiveFile(botId: string, relativePath: string, reason: string, skipRebuild?: boolean): boolean {
    const dir = this.resolveDir(botId);
    const srcPath = join(dir, relativePath);

    if (!existsSync(srcPath)) {
      this.logger.warn({ botId, path: relativePath }, 'Cannot archive: file not found');
      return false;
    }

    // Create archived/ if needed
    const archivedDir = join(dir, 'archived');
    if (!existsSync(archivedDir)) {
      mkdirSync(archivedDir, { recursive: true });
    }

    const fileName = basename(relativePath);
    const destPath = join(archivedDir, fileName);

    try {
      renameSync(srcPath, destPath);
    } catch (err) {
      this.logger.error({ err, botId, path: relativePath }, 'Failed to archive file');
      return false;
    }

    if (skipRebuild) {
      // Log directly to changelog without triggering rebuildIndex
      const dir2 = this.resolveDir(botId);
      const changelogPath = join(dir2, 'changelog.jsonl');
      const entry: ProductionEntry = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        botId,
        tool: 'archive',
        path: `archived/${fileName}`,
        action: 'archive',
        description: reason,
        size: 0,
        trackOnly: false,
        archivedFrom: relativePath,
        archiveReason: reason,
      };
      appendFileSync(changelogPath, `${JSON.stringify(entry)}\n`, 'utf-8');
    } else {
      // Log the archive action (triggers rebuildIndex)
      this.logProduction({
        timestamp: new Date().toISOString(),
        botId,
        tool: 'archive',
        path: `archived/${fileName}`,
        action: 'archive',
        description: reason,
        size: 0,
        trackOnly: false,
        archivedFrom: relativePath,
        archiveReason: reason,
      });
    }

    this.logger.info({ botId, from: relativePath, reason }, 'File archived');
    return true;
  }

  /**
   * Auto-cleanup: archive tiny, incoherent, and duplicate production files.
   * Throttled to run at most once per hour per bot.
   * Only processes files tracked in the changelog (actual productions).
   * Skips files modified less than 60 seconds ago (grace period for just-created files).
   */
  private runCleanup(botId: string): void {
    const now = Date.now();
    const last = this.lastCleanupAt.get(botId) ?? 0;
    if (now - last < 3600_000) return; // 1 hour throttle
    this.lastCleanupAt.set(botId, now);

    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return;

    // Build sets from changelog: tracked paths, approved paths
    const trackedPaths = new Set<string>();
    const approvedPaths = new Set<string>();
    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry: ProductionEntry = JSON.parse(line);
        if (entry.action !== 'archive') {
          trackedPaths.add(entry.path);
        }
        if (entry.evaluation?.status === 'approved') {
          approvedPaths.add(entry.path);
        }
      } catch { /* skip */ }
    }

    // Collect tracked, non-archived, non-excluded files
    interface CleanupFile {
      relativePath: string;
      absPath: string;
      size: number;
    }

    const files: CleanupFile[] = [];
    const walkCleanup = (current: string, relPrefix: string): void => {
      let entries: string[];
      try { entries = readdirSync(current); } catch { return; }
      for (const entry of entries) {
        if (ProductionsService.INDEX_EXCLUDES.has(entry)) continue;
        const fullPath = join(current, entry);
        let stat;
        try { stat = statSync(fullPath); } catch { continue; }
        const relPath = relPrefix ? `${relPrefix}/${entry}` : entry;
        if (stat.isDirectory()) {
          if (entry === 'archived') continue; // skip archived/
          walkCleanup(fullPath, relPath);
        } else {
          // Only process files tracked in changelog
          if (!trackedPaths.has(relPath)) continue;
          // Grace period: skip files modified less than 60s ago
          if (now - stat.mtimeMs < 60_000) continue;
          files.push({ relativePath: relPath, absPath: fullPath, size: stat.size });
        }
      }
    };
    walkCleanup(dir, '');

    let archived = 0;
    const hashMap = new Map<string, string>(); // hash → first relativePath

    for (const f of files) {
      // Skip approved files
      if (approvedPaths.has(f.relativePath)) continue;

      // 1) Tiny files (< 50 bytes)
      if (f.size < 50) {
        this.archiveFile(botId, f.relativePath, 'auto-cleanup: file too small (<50 bytes)', true);
        archived++;
        continue;
      }

      // 2) Duplicate detection (SHA-256)
      try {
        const content = readFileSync(f.absPath);
        const hash = createHash('sha256').update(content).digest('hex');
        if (hashMap.has(hash)) {
          this.archiveFile(
            botId,
            f.relativePath,
            `auto-cleanup: duplicate of ${hashMap.get(hash)}`,
            true
          );
          archived++;
          continue;
        }
        hashMap.set(hash, f.relativePath);
      } catch { /* skip */ }

      // 3) Incoherent .md files
      if (f.absPath.endsWith('.md')) {
        const result = this.checkCoherence(botId, f.relativePath);
        if (!result.coherent) {
          this.archiveFile(
            botId,
            f.relativePath,
            `auto-cleanup: ${result.issues.join('; ')}`,
            true
          );
          archived++;
        }
      }
    }

    if (archived > 0) {
      this.logger.info({ botId, archived }, 'Auto-cleanup completed');
    }
  }

  /** Get description for a file: changelog > rich extract > humanized name */
  private getFileDescription(
    relPath: string,
    descMap: Map<string, string>,
    absPath: string
  ): string {
    // Try changelog description (skip generic "file_write:" descriptions)
    const changelogDesc = descMap.get(relPath);
    if (
      changelogDesc &&
      !changelogDesc.startsWith('file_write:') &&
      !changelogDesc.startsWith('file_edit:')
    ) {
      return changelogDesc.slice(0, 120);
    }

    // Try rich description from markdown/txt file content
    try {
      if (existsSync(absPath) && (absPath.endsWith('.md') || absPath.endsWith('.txt'))) {
        const content = readFileSync(absPath, 'utf-8');
        const desc = ProductionsService.extractDescription(content);
        if (desc) return desc;
      }
    } catch {
      /* skip */
    }

    // Humanize filename (strip number prefix)
    const name = basename(relPath, '.md');
    return name
      .replace(/^\d{2}_/, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .slice(0, 60);
  }

  /** Format file size for display */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  /** Find the archive changelog entry for a given archived path */
  private findArchiveEntry(botId: string, archivedPath: string): ProductionEntry | null {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return null;

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    // Search from end (newest first)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry: ProductionEntry = JSON.parse(lines[i]);
        if (entry.action === 'archive' && entry.path === archivedPath) return entry;
      } catch {
        /* skip */
      }
    }
    return null;
  }

  /**
   * Build a directory tree for a bot's productions folder.
   * Enriches file nodes with changelog metadata (entryId, evaluation, description).
   */
  getDirectoryTree(botId: string): TreeNode[] {
    const dir = this.resolveDir(botId);
    if (!existsSync(dir)) return [];

    // Build a lookup from relative path → newest changelog entry
    const entryMap = new Map<string, ProductionEntry>();
    const changelogPath = join(dir, 'changelog.jsonl');
    if (existsSync(changelogPath)) {
      const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry: ProductionEntry = JSON.parse(line);
          // Normalize: if path is absolute within the dir, make it relative
          let relPath = entry.path;
          if (relPath.startsWith('/')) {
            const rel = relative(dir, relPath);
            if (!rel.startsWith('..')) relPath = rel;
          }
          // Keep newest entry per path (later lines = newer)
          entryMap.set(relPath, entry);
        } catch {
          /* skip malformed lines */
        }
      }
    }

    const walk = (current: string, relPrefix: string): TreeNode[] => {
      let dirEntries: string[];
      try {
        dirEntries = readdirSync(current);
      } catch {
        return [];
      }

      const nodes: TreeNode[] = [];

      for (const name of dirEntries.sort()) {
        if (ProductionsService.TREE_EXCLUDES.has(name)) continue;
        const fullPath = join(current, name);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }

        const relPath = relPrefix ? `${relPrefix}/${name}` : name;

        if (stat.isDirectory()) {
          const children = walk(fullPath, relPath);
          nodes.push({ name, path: relPath, type: 'dir', children });
        } else {
          const node: TreeNode = { name, path: relPath, type: 'file', size: stat.size };
          const entry = entryMap.get(relPath);
          if (entry) {
            node.entryId = entry.id;
            node.description = entry.description;
            if (entry.evaluation) {
              node.evaluation = {
                status: entry.evaluation.status,
                rating: entry.evaluation.rating,
              };
            }
            if (entry.coherenceCheck) {
              node.coherenceCheck = { coherent: entry.coherenceCheck.coherent };
            }
          }
          nodes.push(node);
        }
      }

      return nodes;
    };

    return walk(dir, '');
  }

  /**
   * Read a file by relative path within a bot's productions directory.
   * Validates against path traversal.
   */
  getFileContentByPath(
    botId: string,
    relativePath: string
  ): { content: string; size: number } | null {
    // Path traversal protection
    if (relativePath.includes('..') || relativePath.startsWith('/')) {
      return null;
    }

    const dir = this.resolveDir(botId);
    const fullPath = resolve(join(dir, relativePath));

    // Ensure resolved path is still within the bot dir
    if (!fullPath.startsWith(dir)) {
      return null;
    }

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

  private loadRawChangelog(botId: string): ProductionEntry[] {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return [];

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    return this.parseJsonlLines(lines);
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
