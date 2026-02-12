import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SoulConfig } from './config';
import type { Logger } from './logger';

export class SoulLoader {
  private dir: string;

  constructor(
    private config: SoulConfig,
    private logger: Logger
  ) {
    this.dir = config.dir;
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

    // 3. Daily memory logs (today + yesterday)
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
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = now.toTimeString().slice(0, 5);  // HH:MM
    const logPath = join(this.dir, 'memory', `${dateStr}.md`);
    appendFileSync(logPath, `- [${timeStr}] ${fact}\n`, 'utf-8');
    this.logger.info({ date: dateStr, fact: fact.slice(0, 80) }, 'Daily memory appended');
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
   * Overwrite SOUL.md with new content
   */
  writeSoul(content: string): void {
    const soulPath = join(this.dir, 'SOUL.md');
    writeFileSync(soulPath, content, 'utf-8');
    this.logger.info('Soul updated');
  }

  /**
   * Merge partial identity fields into IDENTITY.md
   */
  writeIdentity(fields: { name?: string; emoji?: string; vibe?: string }): void {
    const identityPath = join(this.dir, 'IDENTITY.md');

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
