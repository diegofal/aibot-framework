import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type GoalActor, writeGoalsFile } from './bot/goal-events';
import type { SoulConfig } from './config';
import { localDateStr, localTimeStr } from './date-utils';
import { renderGoalsForPrompt } from './goals/goals-view';
import { type StoredTask, TaskStore } from './goals/task-store';
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
 * Returns the backup path, or null when there was nothing to back up or the copy failed.
 */
export function backupSoulFile(filepath: string, logger: Logger, maxVersions = 10): string | null {
  if (!existsSync(filepath)) return null;

  const dir = dirname(filepath);
  const name = basename(filepath);
  const versionsDir = join(dir, '.versions');

  if (!existsSync(versionsDir)) {
    mkdirSync(versionsDir, { recursive: true });
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, '');
  const backupName = `${name}.${timestamp}.bak`;
  const backupPath = join(versionsDir, backupName);

  try {
    copyFileSync(filepath, backupPath);
    logger.debug({ filepath, backupPath }, 'Soul file backed up');
  } catch (err) {
    logger.warn({ err, filepath }, 'Failed to back up soul file');
    return null;
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
  return backupPath;
}

/**
 * Markdown emphasis and code marks out of a short value: backticks and
 * `**` / `__` anywhere, a single `*` / `_` only at the edges (so
 * `snake_case` keeps its underscores). "** MyFirstMillion Bot" → "MyFirstMillion Bot".
 */
export function stripMarkdownEmphasis(value: string): string {
  return value
    .replace(/`/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/^[\s*_]+|[\s*_]+$/g, '')
    .trim();
}

/**
 * The `name:` field of an IDENTITY.md text, also when written in markdown
 * (`**Name:** X`, `- **name**: X`, a backticked value); null without one.
 * Only the top identity block counts: lines before the first `##` section, or
 * inside leading identity sections (`Identity`, `Identidad`, `Who I am`,
 * `Profile`, `Perfil`, `Core`, `Basics`). Deeper headings under an identity
 * section (`## Identity` → `### Basics`) stay inside it; a heading at the same
 * level or above closes it. A `#` title as the first heading (`# Identity`,
 * `# Atlas`) opens the file; any other level-1 heading (`# Operator`) closes
 * the block. A `name:` bullet under any other section (`## People I serve`,
 * `## Contacts`, `## Operator`) is someone else's name, and so is everything
 * after it. The system prompt (`SoulLoader.parseIdentity`) and
 * `SoulLoader.writeIdentity` use the same block rule.
 */
export function parseIdentityName(raw: string | null | undefined): string | null {
  return parseIdentityField(raw, 'name');
}

const IDENTITY_HEADING =
  /\b(?:identity|identidad|who\s+i\s+am|who\s+am\s+i)\b|^[^\p{L}]*(?:my\s+|mi\s+)?(?:profile|perfil|core|basics)\b/iu;
const OTHER_PEOPLE_HEADING =
  /\b(?:operator|operador|people|personas|contacts?|contactos?|users?|usuarios?|clients?|clientes?|team|equipo|serve|family|familia)\b/i;

/** Whether a section heading opens (or continues) the bot's own identity block. */
export function isIdentityHeading(text: string): boolean {
  return IDENTITY_HEADING.test(text) && !OTHER_PEOPLE_HEADING.test(text);
}

/**
 * A `key:` field (a plain word: `name`, `vibe`) of the top identity block of an
 * IDENTITY.md text, with the block rule and markdown handling of
 * {@link parseIdentityName}; null without one.
 */
export function parseIdentityField(raw: string | null | undefined, key: string): string | null {
  if (!raw) return null;
  const found = locateIdentityField(raw.split('\n'), key);
  return found.value ?? null;
}

/**
 * Where a `key:` field sits in the top identity block of IDENTITY.md lines:
 * `line` (its index) and `value` (markdown stripped) when present, and `end`,
 * the index of the line that closes the block (or `lines.length`). A `#`
 * title as the first heading (`# Identity`, `# Atlas`) opens the file; any
 * other level-1 heading closes the block. The one definition of the block,
 * shared by {@link parseIdentityField} and `SoulLoader.writeIdentity`.
 */
/** `key:` at the start of a line, with list / quote / emphasis marks around the key; `tail` follows the colon. */
function fieldKeyRe(key: string, tail: string): RegExp {
  return new RegExp(`^[\\s>*_-]*(?:\\*\\*|__)?${key}(?:\\*\\*|__)?\\s*:${tail}`, 'i');
}

function locateIdentityField(
  lines: string[],
  key: string
): { line?: number; value?: string; end: number } {
  if (!/^\w+$/.test(key)) return { end: lines.length };
  const keyRe = fieldKeyRe(key, '(.+)$');
  // Level of the identity heading we are inside; 0 = before any section.
  let blockLevel = 0;
  let seenHeading = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const section = /^\s*(#+)\s*(.*)$/.exec(line);
    if (section) {
      const level = section[1].length;
      const text = section[2];
      const first = !seenHeading;
      seenHeading = true;
      if (level === 1) {
        // A title line at the top (`# Identity`, `# <bot name>`) opens the file.
        if (first && !OTHER_PEOPLE_HEADING.test(text)) continue;
        return { end: i };
      }
      if (blockLevel > 0 && level > blockLevel && !OTHER_PEOPLE_HEADING.test(text)) continue;
      if (isIdentityHeading(text)) {
        if (blockLevel === 0 || level < blockLevel) blockLevel = level;
        continue;
      }
      return { end: i };
    }
    const match = keyRe.exec(line);
    if (!match) continue;
    const value = stripMarkdownEmphasis(match[1]);
    if (value) return { line: i, value, end: lines.length };
  }
  return { end: lines.length };
}

/**
 * `line` with its field value replaced by `value`, keeping the key and the
 * markdown around the value (`**Name:** Luna` → `**Name:** Nova`).
 */
function replaceFieldValue(line: string, key: string, value: string): string {
  const colon = fieldKeyRe(key, '').exec(line);
  if (!colon) return line;
  const head = line.slice(0, colon.index + colon[0].length);
  const rest = line.slice(head.length);
  const lead = /^\s*(?:\*\*|__)?\s*/.exec(rest)?.[0] ?? '';
  const marks = lead.trim();
  const tail = marks && rest.trimEnd().endsWith(marks) && rest.trim() !== marks ? marks : '';
  return `${head}${lead || ' '}${value}${tail}`;
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

  /** The soul directory this loader reads and writes. */
  getDir(): string {
    return this.dir;
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
   * Skips if MEMORY.md is a consolidated file (created by soul-health-check).
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

    // Skip if MEMORY.md is a consolidated file (from soul-health-check)
    if (content.includes('<!-- last-consolidated:')) {
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
  composeSystemPrompt(userId?: string, opts: { goals?: boolean } = {}): string | null {
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

    // 4. Goals (with their open tasks). The agent-loop executor carries them in
    // its own prompt, so its system prompt asks for none.
    const goals = opts.goals === false ? '' : this.readGoalsView();
    if (goals) {
      sections.push(`## Goals\n\n${goals}`);
    }

    // 4b. Per-user goals (in addition to shared goals)
    if (userId) {
      const userGoals = this.readUserGoals(userId);
      if (userGoals) {
        sections.push(`## Your Goals (for this user)\n\n${userGoals}`);
      }
    }

    // 6. Consolidated memory (MEMORY.md) or fall back to legacy.md
    const memoryMdPath = join(this.dir, 'MEMORY.md');
    const legacyPath = join(this.dir, 'memory', 'legacy.md');
    let coreMemoryLoaded = false;

    try {
      const memoryMd = readFileSync(memoryMdPath, 'utf-8').trim();
      if (memoryMd) {
        sections.push(`## Core Memory\n\n${memoryMd}`);
        coreMemoryLoaded = true;
      }
    } catch {
      // No MEMORY.md yet
    }

    if (!coreMemoryLoaded) {
      try {
        const legacy = readFileSync(legacyPath, 'utf-8').trim();
        if (legacy) {
          sections.push(`## Core Memory\n\n${legacy}`);
        }
      } catch {
        // No legacy file either
      }
    }

    // 7. Daily memory log (today only — older logs are consolidated into MEMORY.md)
    const dailyLogs = this.readRecentDailyLogs(userId);
    if (dailyLogs) {
      sections.push(dailyLogs);
    }

    if (sections.length === 0) {
      return null;
    }

    return sections.join('\n\n');
  }

  /**
   * The identity sentence of the system prompt from IDENTITY.md's name /
   * emoji / vibe, read with {@link parseIdentityField} (the same block rule as
   * the relay and the watcher).
   */
  private parseIdentity(raw: string): string | null {
    const name = parseIdentityField(raw, 'name');
    const emoji = parseIdentityField(raw, 'emoji');
    const vibe = parseIdentityField(raw, 'vibe');
    const parts: string[] = [];
    if (name) parts.push(`Your name is ${name}.`);
    if (emoji) parts.push(`Your emoji is ${emoji}.`);
    if (vibe) parts.push(`Your vibe: ${vibe}.`);
    return parts.length > 0 ? parts.join(' ') : null;
  }

  /**
   * Append a fact to the daily memory log (config/soul/memory/YYYY-MM-DD.md)
   * When userId is provided, writes to config/soul/memory/users/{userId}/YYYY-MM-DD.md
   */
  appendDailyMemory(fact: string, userId?: string): void {
    const sanitized = sanitizeFact(fact);
    if (!sanitized) {
      this.logger.warn(
        { fact: fact.slice(0, 80) },
        'Daily memory skipped: credential content detected'
      );
      return;
    }

    const now = new Date();
    const dateStr = localDateStr(now);
    const timeStr = localTimeStr(now);
    const memoryDir = userId ? join(this.dir, 'memory', 'users', userId) : join(this.dir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    const logPath = join(memoryDir, `${dateStr}.md`);
    appendFileSync(logPath, `- [${timeStr}] ${sanitized}\n`, 'utf-8');
    this.logger.info(
      { date: dateStr, userId, fact: sanitized.slice(0, 80) },
      'Daily memory appended'
    );
  }

  /**
   * Read today's daily log file for inclusion in the system prompt.
   * Older logs are consolidated into MEMORY.md on startup.
   */
  readRecentDailyLogs(userId?: string): string {
    const memoryDir = join(this.dir, 'memory');
    const today = localDateStr();
    const sections: string[] = [];

    if (userId) {
      // User-isolated mode: only include per-user daily log.
      // The shared bot-level log contains agent loop activity (not user conversations)
      // and must NOT leak into isolated user sessions.
      const userPath = join(memoryDir, 'users', userId, `${today}.md`);
      try {
        const content = readFileSync(userPath, 'utf-8').trim();
        if (content) {
          sections.push(`### ${today}\n${content}`);
        }
      } catch {
        // File doesn't exist — skip
      }
    } else {
      // No user isolation: include the shared bot-level daily log
      const sharedPath = join(memoryDir, `${today}.md`);
      try {
        const content = readFileSync(sharedPath, 'utf-8').trim();
        if (content) {
          sections.push(`### ${today}\n${content}`);
        }
      } catch {
        // File doesn't exist — skip
      }
    }

    return sections.length > 0 ? `## Recent Memory\n\n${sections.join('\n\n')}` : '';
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
        .filter((f) => f.endsWith('.md') && f !== 'legacy.md' && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
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

  /** The `name:` field of IDENTITY.md (the name the bot goes by), or null. */
  readIdentityName(): string | null {
    return parseIdentityName(this.readIdentity());
  }

  /**
   * Read GOALS.md content
   */
  readGoals(): string | null {
    return this.readFile('GOALS.md');
  }

  /** The task store of this soul dir (TASKS.json); the first read migrates legacy task lines. */
  getTaskStore(): TaskStore {
    return new TaskStore(this.dir, {
      backup: this.versioningEnabled
        ? (p) => backupSoulFile(p, this.logger, this.maxVersions)
        : undefined,
      onError: (err) => this.logger.warn({ err }, 'Task store: warning'),
    });
  }

  /** Tasks whose goal still exists. Never throws. */
  readTasks(): StoredTask[] {
    try {
      return this.getTaskStore().listForGoals();
    } catch (err) {
      this.logger.warn({ err }, 'Task store: read failed');
      return [];
    }
  }

  /** Goals plus their open tasks, rendered for a prompt (src/goals/goals-view.ts). */
  readGoalsView(maxChars?: number): string {
    const tasks = this.readTasks();
    return renderGoalsForPrompt({ goalsMd: this.readGoals(), tasks, maxChars });
  }

  /**
   * Write GOALS.md content
   */
  writeGoals(
    content: string,
    opts: {
      actor?: GoalActor;
      cycleId?: string;
      reason?: string;
      reasons?: Record<string, string>;
    } = {}
  ): void {
    const goalsPath = join(this.dir, 'GOALS.md');
    writeGoalsFile(goalsPath, content, {
      actor: opts.actor ?? 'agent',
      cycleId: opts.cycleId,
      reason: opts.reason,
      reasons: opts.reasons,
      backup: this.versioningEnabled
        ? (p) => backupSoulFile(p, this.logger, this.maxVersions)
        : undefined,
      onError: (err) => this.logger.warn({ err }, 'Goal events: failed to append'),
    });
    this.logger.info('Goals updated');
  }

  /**
   * Read per-user goals from memory/users/{userId}/GOALS.md
   */
  readUserGoals(userId: string): string | null {
    const userGoalsPath = join(this.dir, 'memory', 'users', userId, 'GOALS.md');
    try {
      const content = readFileSync(userGoalsPath, 'utf-8').trim();
      return content || null;
    } catch {
      return null;
    }
  }

  /**
   * Write per-user goals to memory/users/{userId}/GOALS.md with versioning
   */
  writeUserGoals(userId: string, content: string): void {
    const userDir = join(this.dir, 'memory', 'users', userId);
    mkdirSync(userDir, { recursive: true });
    const goalsPath = join(userDir, 'GOALS.md');
    if (this.versioningEnabled) {
      backupSoulFile(goalsPath, this.logger, this.maxVersions);
    }
    writeFileSync(goalsPath, content, 'utf-8');
    this.logger.info({ userId }, 'Per-user goals updated');
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

    // Each field is updated in place inside the identity block (the line
    // parseIdentityField reads); a missing one is added at the end of the block.
    const raw = this.readFile('IDENTITY.md');
    const lines = raw ? raw.replace(/\n$/, '').split('\n') : [];
    for (const key of ['name', 'emoji', 'vibe'] as const) {
      const value = fields[key];
      if (value === undefined) continue;
      const found = locateIdentityField(lines, key);
      if (found.line !== undefined) {
        lines[found.line] = replaceFieldValue(lines[found.line], key, value);
        continue;
      }
      // Before the blank lines that separate the block from the next section.
      let at = found.end;
      while (at > 0 && at < lines.length && lines[at - 1].trim() === '') at--;
      lines.splice(at, 0, `${key}: ${value}`);
    }
    writeFileSync(identityPath, `${lines.join('\n')}\n`, 'utf-8');
    this.logger.info({ fields: Object.keys(fields) }, 'Identity updated');
  }
}

/**
 * Migrate old flat soul layout (files at root) to per-bot subdirectory.
 * Detects IDENTITY.md at root level and moves soul files into {root}/{defaultBotId}/.
 * Idempotent — skips if target already exists.
 */
export function migrateSoulRootToPerBot(
  rootDir: string,
  defaultBotId: string,
  logger: Logger
): void {
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

  // Clean up leftover root-level soul files that weren't moved
  // (e.g., MOTIVATIONS.md recreated after a previous migration)
  for (const name of toMove) {
    const src = join(rootDir, name);
    if (!existsSync(src)) continue;
    try {
      const stat = statSync(src);
      if (stat.isFile() && existsSync(join(targetDir, name))) {
        unlinkSync(src);
        logger.info({ file: src }, 'Cleaned up leftover root-level soul file');
      }
    } catch {
      // skip
    }
  }

  logger.info({ targetDir }, 'Soul root migration complete');
}
