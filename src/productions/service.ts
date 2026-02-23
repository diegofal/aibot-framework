import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { SoulLoader } from '../soul';
import type { ProductionEntry, ProductionEvaluation, SummaryData } from './types';
import type { ThreadMessage } from '../types/thread';
import type { KarmaService } from '../karma/service';

export class ProductionsService {
  private baseDir: string;

  constructor(
    private config: Config,
    private logger: Logger,
  ) {
    this.baseDir = resolve(config.productions.baseDir);
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
    appendFileSync(changelogPath, JSON.stringify(full) + '\n', 'utf-8');
    this.logger.debug({ botId: entry.botId, path: entry.path, id: full.id }, 'Production logged');
    return full;
  }

  getChangelog(
    botId: string,
    opts?: { limit?: number; offset?: number; since?: string; status?: string },
  ): ProductionEntry[] {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return [];

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    let entries: ProductionEntry[] = lines.map((line) => JSON.parse(line));

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
  ): ProductionEntry | null {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return null;

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries: ProductionEntry[] = lines.map((line) => JSON.parse(line));

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
    const updated = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(changelogPath, updated, 'utf-8');

    this.logger.info(
      { botId, id, status: evaluation.status, rating: evaluation.rating },
      'Production evaluated',
    );

    // Karma: adjust based on evaluation
    if (karmaService) {
      if (evaluation.status === 'rejected') {
        karmaService.addEvent(botId, -10, `Production rejected: "${entries[idx].path}"`, 'production', { rating: evaluation.rating });
      } else if (evaluation.rating != null) {
        const delta = evaluation.rating >= 4 ? (evaluation.rating === 5 ? 10 : 5) : evaluation.rating;
        karmaService.addEvent(botId, delta, `Production approved: "${entries[idx].path}" (rating: ${evaluation.rating}/5)`, 'production', { rating: evaluation.rating });
      } else {
        karmaService.addEvent(botId, 3, `Production approved: "${entries[idx].path}"`, 'production');
      }
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
    const entries: ProductionEntry[] = lines.map((line) => JSON.parse(line));

    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1 || !entries[idx].evaluation) return null;

    entries[idx].evaluation!.aiResponse = response;
    entries[idx].evaluation!.aiResponseAt = new Date().toISOString();

    const updated = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(changelogPath, updated, 'utf-8');

    this.logger.info({ botId, id }, 'AI response saved to production evaluation');
    return entries[idx];
  }

  addThreadMessage(
    botId: string,
    id: string,
    role: 'human' | 'bot',
    content: string,
  ): { message: ThreadMessage; entry: ProductionEntry } | null {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return null;

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries: ProductionEntry[] = lines.map((line) => JSON.parse(line));

    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return null;

    // Create evaluation stub if none exists
    if (!entries[idx].evaluation) {
      entries[idx].evaluation = { evaluatedAt: new Date().toISOString() };
    }

    if (!entries[idx].evaluation!.thread) {
      entries[idx].evaluation!.thread = [];
    }

    const msg: ThreadMessage = {
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    entries[idx].evaluation!.thread!.push(msg);

    const updated = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(changelogPath, updated, 'utf-8');

    this.logger.debug({ botId, id, role, msgId: msg.id }, 'Thread message added to production');
    return { message: msg, entry: entries[idx] };
  }

  deleteProduction(botId: string, id: string): boolean {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return false;

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries: ProductionEntry[] = lines.map((line) => JSON.parse(line));

    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;

    const entry = entries[idx];

    // Remove the associated file if not trackOnly
    if (!entry.trackOnly) {
      const filePath = entry.path.startsWith('/')
        ? entry.path
        : join(dir, entry.path);
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch (err) {
        this.logger.warn({ err, filePath }, 'Failed to delete production file');
      }
    }

    entries.splice(idx, 1);
    const updated = entries.length > 0
      ? entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
      : '';
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
      : (entry.path.startsWith('/') ? entry.path : join(dir, entry.path));

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
    const filePath = entry.path.startsWith('/')
      ? entry.path
      : join(dir, entry.path);

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
    const entries: ProductionEntry[] = lines.map((line) => JSON.parse(line));

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
      avgRating: ratings.length > 0
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
        /^#{1,6}\s+(Section|Title|Heading|Overview|Introduction|Summary|Conclusion|Details|Notes)\s*$/i.test(trimmed) ||
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

  private loadRawChangelog(botId: string): ProductionEntry[] {
    const dir = this.resolveDir(botId);
    const changelogPath = join(dir, 'changelog.jsonl');
    if (!existsSync(changelogPath)) return [];

    const lines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  }

  getAllBotStats(): Array<{ botId: string; name: string } & ReturnType<ProductionsService['getStats']>> {
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
