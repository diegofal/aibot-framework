import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
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
import type { ThreadMessage } from '../types/thread';
import type { ProductionEntry, ProductionEvaluation, SummaryData, TreeNode } from './types';

export class ProductionsService {
  private baseDir: string;

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
    const dir = botConfig?.productions?.dir ?? join(this.baseDir, botId);
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
      const filePath = entry.path.startsWith('/') ? entry.path : join(dir, entry.path);
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch (err) {
        this.logger.warn({ err, filePath }, 'Failed to delete production file');
      }
    }

    entries.splice(idx, 1);
    const updated =
      entries.length > 0 ? `${entries.map((e) => JSON.stringify(e)).join('\n')}\n` : '';
    writeFileSync(changelogPath, updated, 'utf-8');

    this.logger.info({ botId, id }, 'Production deleted');
    return true;
  }

  updateContent(botId: string, id: string, content: string): boolean {
    const entry = this.getEntry(botId, id);
    if (!entry) return false;

    const dir = this.resolveDir(botId);
    const filePath = entry.trackOnly
      ? resolve(entry.path)
      : entry.path.startsWith('/')
        ? entry.path
        : join(dir, entry.path);

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
    const filePath = entry.path.startsWith('/') ? entry.path : join(dir, entry.path);

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
    avgRating: number | null;
  } {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) {
      return { total: 0, approved: 0, rejected: 0, unreviewed: 0, avgRating: null };
    }

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries: ProductionEntry[] = this.parseJsonlLines(lines);

    let approved = 0;
    let rejected = 0;
    let unreviewed = 0;
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
    }

    return {
      total: entries.length,
      approved,
      rejected,
      unreviewed,
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

  /** Files/dirs excluded from INDEX.md generation */
  private static readonly INDEX_EXCLUDES = new Set([
    'changelog.jsonl',
    'summary.json',
    'INDEX.md',
    '.gitignore',
    'node_modules',
    'venv',
    '.vercel',
    '.git',
  ]);

  /** Files/dirs excluded from tree display (INDEX.md is shown in tree but excluded from index generation) */
  private static readonly TREE_EXCLUDES = new Set([
    'changelog.jsonl',
    'summary.json',
    '.gitignore',
    'node_modules',
    'venv',
    '.vercel',
    '.git',
  ]);

  /**
   * Rebuild the auto-generated INDEX.md for a production directory.
   * Scans all files, groups by subdirectory, and uses changelog descriptions.
   */
  rebuildIndex(botId: string): void {
    const dir = this.resolveDir(botId);

    // Load changelog for description lookup (newest first per path)
    const descMap = new Map<string, string>();
    const changelogPath = join(dir, 'changelog.jsonl');
    if (existsSync(changelogPath)) {
      const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry: ProductionEntry = JSON.parse(line);
          // Keep newest description per path (later lines = newer)
          descMap.set(entry.path, entry.description);
        } catch {
          /* skip malformed lines */
        }
      }
    }

    // Scan directory recursively
    interface FileInfo {
      relativePath: string;
      name: string;
      dir: string; // relative dir ('' for root)
      size: number;
      created: Date;
      isArchived: boolean;
    }

    const files: FileInfo[] = [];
    let dirCount = 0;

    const walk = (current: string, relPrefix: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(current);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (ProductionsService.INDEX_EXCLUDES.has(entry)) continue;
        const fullPath = join(current, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          dirCount++;
          walk(fullPath, relPrefix ? `${relPrefix}/${entry}` : entry);
        } else {
          files.push({
            relativePath: relPrefix ? `${relPrefix}/${entry}` : entry,
            name: entry,
            dir: relPrefix,
            size: stat.size,
            created: stat.birthtime,
            isArchived: relPrefix === 'archived' || relPrefix.startsWith('archived/'),
          });
        }
      }
    };

    walk(dir, '');

    // Group files by directory
    const groups = new Map<string, FileInfo[]>();
    for (const f of files) {
      const key = f.dir || 'root';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)?.push(f);
    }

    // Sort groups: root first, then archived last, rest alphabetical
    const sortedKeys = [...groups.keys()].sort((a, b) => {
      if (a === 'root') return -1;
      if (b === 'root') return 1;
      if (a === 'archived' || a.startsWith('archived/')) return 1;
      if (b === 'archived' || b.startsWith('archived/')) return -1;
      return a.localeCompare(b);
    });

    // Build INDEX.md
    const lines: string[] = [
      `# Production Index — ${botId}`,
      `**Last updated:** ${new Date().toISOString()}`,
      `**Files:** ${files.length} | **Directories:** ${dirCount}`,
      '',
    ];

    // Insert cached plan section from summary.json
    const summaryData = this.readSummary(botId);
    if (summaryData?.plan) {
      lines.push('## Strategy & Plan', '', summaryData.plan, '');
    }

    for (const key of sortedKeys) {
      const group = groups.get(key)!;
      group.sort((a, b) => a.name.localeCompare(b.name));

      const heading = key === 'root' ? '## Root' : `## ${key}/`;
      lines.push(heading, '');

      if (key === 'archived' || key.startsWith('archived/')) {
        // Archived files get a different table format
        lines.push('| File | Archived From | Reason | Original Date |');
        lines.push('|------|---------------|--------|---------------|');
        for (const f of group) {
          // Look up archive entry in changelog
          const desc = descMap.get(f.relativePath) ?? '';
          const archiveEntry = this.findArchiveEntry(botId, f.relativePath);
          const from = archiveEntry?.archivedFrom ?? '—';
          const reason = archiveEntry?.archiveReason ?? (desc || '—');
          const date = f.created.toISOString().slice(0, 10);
          lines.push(`| ${f.name} | ${from} | ${reason} | ${date} |`);
        }
      } else {
        lines.push('| File | Description | Created | Size |');
        lines.push('|------|-------------|---------|------|');
        for (const f of group) {
          const desc = this.getFileDescription(f.relativePath, descMap, join(dir, f.relativePath));
          const date = f.created.toISOString().slice(0, 10);
          const size = this.formatSize(f.size);
          lines.push(`| ${f.name} | ${desc} | ${date} | ${size} |`);
        }
      }
      lines.push('');
    }

    const indexPath = join(dir, 'INDEX.md');
    writeFileSync(indexPath, lines.join('\n'), 'utf-8');
  }

  /**
   * Archive a production file by moving it to archived/ with a reason.
   */
  archiveFile(botId: string, relativePath: string, reason: string): boolean {
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

    // Log the archive action
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

    this.logger.info({ botId, from: relativePath, reason }, 'File archived');
    return true;
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
