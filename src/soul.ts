import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, copyFileSync, unlinkSync, renameSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { SoulConfig } from './config';
import type { Logger } from './logger';

// Patterns to redact from memory facts before writing
const SENSITIVE_PATTERNS = [
  /\bapi[_-]?key\s*[=:]\s*\S+/gi,
  /\bmm_[a-f0-9]{40,}/gi,
  /\bagent[_-]?id\s*[=:]\s*[a-f0-9-]{36}/gi,
  /\bMOLT-[A-F0-9]{16,}/gi,
  /\b(?:auth[_-]?token|secret|password)\s*[=:]\s*\S+/gi,
  /\+\d{10,15}/g,
];

/**
 * Redact sensitive patterns from a memory fact.
 * Returns the sanitized string, or null if the entire fact was credential content.
 */
function sanitizeFact(fact: string): string | null {
  let sanitized = fact;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  // If the fact is mostly redacted (more than half the non-whitespace content), skip it entirely
  const originalChars = fact.replace(/\s/g, '').length;
  const redactedChars = (sanitized.match(/\[REDACTED\]/g) || []).length * 10; // rough estimate
  if (originalChars > 0 && redactedChars > originalChars / 2) {
    return null;
  }
  return sanitized;
}

/**
 * Back up a soul file before overwriting it.
 * Creates a `.versions/` subdirectory and copies the file with a timestamp.
 * Uses `.bak` extension to prevent the memory indexer (which watches *.md) from indexing backups.
 * Prunes oldest versions beyond maxVersions per filename.
 */
export function backupSoulFile(filepath: string, logger: Logger, maxVersions = 10): void {
  if (!existsSync(filepath)) return;

  const dir = dirname(filepath);
  const name = basename(filepath);
  const versionsDir = join(dir, '.versions');

  if (!existsSync(versionsDir)) {
    mkdirSync(versionsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  const backupName = `${name}.${timestamp}.bak`;
  const backupPath = join(versionsDir, backupName);

  try {
    copyFileSync(filepath, backupPath);
    logger.debug({ filepath, backupPath }, 'Soul file backed up');
  } catch (err) {
    logger.warn({ err, filepath }, 'Failed to back up soul file');
    return;
  }

  // Prune old versions for this filename
  try {
    const prefix = `${name}.`;
    const versions = readdirSync(versionsDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.bak'))
      .sort(); // lexicographic = chronological for ISO timestamps

    if (versions.length > maxVersions) {
      const toDelete = versions.slice(0, versions.length - maxVersions);
      for (const old of toDelete) {
        unlinkSync(join(versionsDir, old));
      }
      logger.debug({ pruned: toDelete.length, file: name }, 'Pruned old soul file versions');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to prune soul file versions');
  }
}

export class SoulLoader {
  private dir: string;
  private versioningEnabled: boolean;
  private maxVersions: number;

  constructor(
    private config: SoulConfig,
    private logger: Logger
  ) {
    this.dir = config.dir;
    this.versioningEnabled = config.versioning?.enabled ?? true;
    this.maxVersions = config.versioning?.maxVersionsPerFile ?? 10;
  }

  /**
   * Create soul directory, memory/ subdirectory, and migrate MEMORY.md → legacy.md
   */
  async initialize(): Promise<void> {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      this.logger.info({ dir: this.dir }, 'Created soul directory');
    }

    // Create daily memory logs directory
    const memoryDir = join(this.dir, 'memory');
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
      this.logger.debug('Created memory/ directory for daily logs');
    }

    // One-time migration: MEMORY.md → memory/legacy.md
    this.migrateMemoryToLegacy();
  }

  /**
   * Migrate MEMORY.md content to memory/legacy.md (one-time, idempotent).
   * After migration, MEMORY.md is cleared. legacy.md gets auto-indexed by the file watcher.
   */
  private migrateMemoryToLegacy(): void {
    const memoryPath = join(this.dir, 'MEMORY.md');
    const legacyPath = join(this.dir, 'memory', 'legacy.md');

    // Skip if legacy.md already exists (migration already done)
    if (existsSync(legacyPath)) {
      return;
    }

    // Skip if MEMORY.md doesn't exist or is empty
    if (!existsSync(memoryPath)) {
      return;
    }

    const content = readFileSync(memoryPath, 'utf-8').trim();
    if (!content) {
      return;
    }

    // Copy content to legacy.md and clear MEMORY.md
    writeFileSync(legacyPath, content, 'utf-8');
    writeFileSync(memoryPath, '', 'utf-8');
    this.logger.info('Migrated MEMORY.md → memory/legacy.md');
  }

  /**
   * Read a soul file, returning null if missing or empty
   */
  private readFile(filename: string): string | null {
    const filepath = join(this.dir, filename);
    try {
      const content = readFileSync(filepath, 'utf-8').trim();
      return content || null;
    } catch {
      return null;
    }
  }

  /**
   * Compose layered system prompt from soul files.
   * Daily logs (today + yesterday) are always included.
   * Older daily logs and legacy.md are surfaced via memory_search.
   * Returns null if no soul files were loaded (caller should fall back).
   */
  composeSystemPrompt(): string | null {
    if (!this.config.enabled) {
      return null;
    }

    const sections: string[] = [];

    // 1. Identity
    const identity = this.readFile('IDENTITY.md');
    if (identity) {
      const parsed = this.parseIdentity(identity);
      if (parsed) {
        sections.push(parsed);
      }
    }

    // 2. Soul / personality
    const soul = this.readFile('SOUL.md');
    if (soul) {
      sections.push(soul);
    }

    // 3. Motivations / inner drives
    const motivations = this.readFile('MOTIVATIONS.md');
    if (motivations) {
      sections.push(`## Your Inner Motivations\n\n${motivations}`);
    }

    // 4. Legacy memory (core biographical data — always present)
    const legacyPath = join(this.dir, 'memory', 'legacy.md');
    try {
      const legacy = readFileSync(legacyPath, 'utf-8').trim();
      if (legacy) {
        sections.push(`## Core Memory\n\n${legacy}`);
      }
    } catch {
      // No legacy file
    }

    // 5. Daily memory logs (today + yesterday)
    const dailyLogs = this.readRecentDailyLogs();
    if (dailyLogs) {
      sections.push(dailyLogs);
    }

    if (sections.length === 0) {
      return null;
    }

    return sections.join('\n\n');
  }

  /**
   * Parse IDENTITY.md key: value lines into an identity block
   */
  private parseIdentity(raw: string): string | null {
    const fields: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const match = line.match(/^(\w+)\s*:\s*(.+)$/);
      if (match) {
        fields[match[1].toLowerCase()] = match[2].trim();
      }
    }

    if (Object.keys(fields).length === 0) {
      return null;
    }

    const parts: string[] = [];
    if (fields.name) {
      parts.push(`Your name is ${fields.name}.`);
    }
    if (fields.emoji) {
      parts.push(`Your emoji is ${fields.emoji}.`);
    }
    if (fields.vibe) {
      parts.push(`Your vibe: ${fields.vibe}.`);
    }

    return parts.length > 0 ? parts.join(' ') : null;
  }

  /**
   * Append a fact to the daily memory log (config/soul/memory/YYYY-MM-DD.md)
   */
  appendDailyMemory(fact: string): void {
    const sanitized = sanitizeFact(fact);
    if (!sanitized) {
      this.logger.warn({ fact: fact.slice(0, 80) }, 'Daily memory skipped: credential content detected');
      return;
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = now.toTimeString().slice(0, 5);  // HH:MM
    const logPath = join(this.dir, 'memory', `${dateStr}.md`);
    appendFileSync(logPath, `- [${timeStr}] ${sanitized}\n`, 'utf-8');
    this.logger.info({ date: dateStr, fact: sanitized.slice(0, 80) }, 'Daily memory appended');
  }

  /**
   * Read today's and yesterday's daily log files for inclusion in the system prompt
   */
  readRecentDailyLogs(): string {
    const memoryDir = join(this.dir, 'memory');
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);

    const sections: string[] = [];

    for (const dateStr of [yesterday, today]) {
      const logPath = join(memoryDir, `${dateStr}.md`);
      try {
        const content = readFileSync(logPath, 'utf-8').trim();
        if (content) {
          sections.push(`### ${dateStr}\n${content}`);
        }
      } catch {
        // File doesn't exist — skip
      }
    }

    if (sections.length === 0) {
      return '';
    }

    return `## Recent Memory\n\n${sections.join('\n\n')}`;
  }

  /**
   * Dump all memory contents ordered newest-first.
   * Returns: daily logs (newest date first) + legacy.md if present
   */
  dumpMemory(): string {
    const parts: string[] = [];

    // Daily logs — sorted newest first (exclude legacy.md, shown separately)
    const memoryDir = join(this.dir, 'memory');
    try {
      const files = readdirSync(memoryDir)
        .filter((f) => f.endsWith('.md') && f !== 'legacy.md')
        .sort()
        .reverse(); // newest date first

      for (const file of files) {
        const content = readFileSync(join(memoryDir, file), 'utf-8').trim();
        if (content) {
          const date = file.replace('.md', '');
          parts.push(`📅 ${date}\n${content}`);
        }
      }
    } catch {
      // No memory dir yet
    }

    // Legacy memory (migrated from old MEMORY.md)
    const legacyPath = join(this.dir, 'memory', 'legacy.md');
    try {
      const legacy = readFileSync(legacyPath, 'utf-8').trim();
      if (legacy) {
        parts.push(`📜 Legacy\n${legacy}`);
      }
    } catch {
      // No legacy file
    }

    return parts.length > 0 ? parts.join('\n\n---\n\n') : 'No hay nada en memoria.';
  }

  /**
   * Read MOTIVATIONS.md content
   */
  readMotivations(): string | null {
    return this.readFile('MOTIVATIONS.md');
  }

  /**
   * Write MOTIVATIONS.md content
   */
  writeMotivations(content: string): void {
    const motivationsPath = join(this.dir, 'MOTIVATIONS.md');
    if (this.versioningEnabled) {
      backupSoulFile(motivationsPath, this.logger, this.maxVersions);
    }
    writeFileSync(motivationsPath, content, 'utf-8');
    this.logger.info('Motivations updated');
  }

  /**
   * Read SOUL.md content (public accessor)
   */
  readSoul(): string | null {
    return this.readFile('SOUL.md');
  }

  /**
   * Read IDENTITY.md content (public accessor)
   */
  readIdentity(): string | null {
    return this.readFile('IDENTITY.md');
  }

  /**
   * Read all daily memory logs from sinceDate onwards (YYYY-MM-DD).
   * Returns concatenated log content, newest first.
   */
  readDailyLogsSince(sinceDate: string): string {
    const memoryDir = join(this.dir, 'memory');
    const parts: string[] = [];

    try {
      const files = readdirSync(memoryDir)
        .filter((f) => f.endsWith('.md') && f !== 'legacy.md')
        .filter((f) => f.replace('.md', '') >= sinceDate)
        .sort()
        .reverse();

      for (const file of files) {
        const content = readFileSync(join(memoryDir, file), 'utf-8').trim();
        if (content) {
          const date = file.replace('.md', '');
          parts.push(`### ${date}\n${content}`);
        }
      }
    } catch {
      // No memory dir yet
    }

    return parts.join('\n\n');
  }

  /**
   * Overwrite SOUL.md with new content
   */
  writeSoul(content: string): void {
    const soulPath = join(this.dir, 'SOUL.md');
    if (this.versioningEnabled) {
      backupSoulFile(soulPath, this.logger, this.maxVersions);
    }
    writeFileSync(soulPath, content, 'utf-8');
    this.logger.info('Soul updated');
  }

  /**
   * Merge partial identity fields into IDENTITY.md
   */
  writeIdentity(fields: { name?: string; emoji?: string; vibe?: string }): void {
    const identityPath = join(this.dir, 'IDENTITY.md');
    if (this.versioningEnabled) {
      backupSoulFile(identityPath, this.logger, this.maxVersions);
    }

    // Read and parse existing fields
    const existing: Record<string, string> = {};
    const raw = this.readFile('IDENTITY.md');
    if (raw) {
      for (const line of raw.split('\n')) {
        const match = line.match(/^(\w+)\s*:\s*(.+)$/);
        if (match) {
          existing[match[1].toLowerCase()] = match[2].trim();
        }
      }
    }

    // Merge changed fields
    if (fields.name !== undefined) existing.name = fields.name;
    if (fields.emoji !== undefined) existing.emoji = fields.emoji;
    if (fields.vibe !== undefined) existing.vibe = fields.vibe;

    // Write back as key: value lines
    const lines = Object.entries(existing).map(([k, v]) => `${k}: ${v}`);
    writeFileSync(identityPath, lines.join('\n') + '\n', 'utf-8');
    this.logger.info({ fields: Object.keys(fields) }, 'Identity updated');
  }
}

/**
 * Migrate old flat soul layout (files at root) to per-bot subdirectory.
 * Detects IDENTITY.md at root level and moves soul files into {root}/{defaultBotId}/.
 * Idempotent — skips if target already exists.
 */
export function migrateSoulRootToPerBot(rootDir: string, defaultBotId: string, logger: Logger): void {
  const targetDir = join(rootDir, defaultBotId);
  const identityAtRoot = join(rootDir, 'IDENTITY.md');

  // Already migrated or nothing to migrate
  if (existsSync(join(targetDir, 'IDENTITY.md')) || !existsSync(identityAtRoot)) {
    return;
  }

  logger.info({ rootDir, defaultBotId }, 'Migrating soul root to per-bot layout');
  mkdirSync(targetDir, { recursive: true });

  // Files/dirs to move
  const toMove = ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md', 'memory', '.versions'];

  for (const name of toMove) {
    const src = join(rootDir, name);
    if (!existsSync(src)) continue;

    // Skip if it's a bot subdirectory (has its own IDENTITY.md)
    try {
      const stat = statSync(src);
      if (stat.isDirectory() && existsSync(join(src, 'IDENTITY.md'))) {
        continue;
      }
    } catch {
      // stat failed, skip
      continue;
    }

    const dest = join(targetDir, name);
    try {
      renameSync(src, dest);
      logger.info({ from: src, to: dest }, 'Migrated soul file');
    } catch (err) {
      logger.warn({ err, from: src, to: dest }, 'Failed to migrate soul file');
    }
  }

  logger.info({ targetDir }, 'Soul root migration complete');
}
