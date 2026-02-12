import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
   * Create soul directory and empty MEMORY.md if missing
   */
  async initialize(): Promise<void> {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      this.logger.info({ dir: this.dir }, 'Created soul directory');
    }

    const memoryPath = join(this.dir, 'MEMORY.md');
    if (!existsSync(memoryPath)) {
      writeFileSync(memoryPath, '', 'utf-8');
      this.logger.debug('Created empty MEMORY.md');
    }
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
   * When searchEnabled is true, MEMORY.md is omitted (the LLM searches via tools instead).
   * Returns null if no soul files were loaded (caller should fall back).
   */
  composeSystemPrompt(searchEnabled = false): string | null {
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

    // 3. Memory — only stuff into prompt when search is disabled (backward compat)
    if (!searchEnabled) {
      const memory = this.readFile('MEMORY.md');
      if (memory) {
        const truncated = memory.length > this.config.memoryMaxChars
          ? '...\n' + memory.slice(-this.config.memoryMaxChars)
          : memory;
        sections.push(`## Memory\n\nThings you should remember:\n${truncated}`);
      }
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
   * Append a fact to MEMORY.md
   */
  appendMemory(fact: string): void {
    const memoryPath = join(this.dir, 'MEMORY.md');
    const existing = this.readFile('MEMORY.md') ?? '';
    let newContent = existing ? `${existing}\n- ${fact}` : `- ${fact}`;

    // Prune oldest lines when memory exceeds the limit
    if (newContent.length > this.config.memoryMaxChars) {
      const lines = newContent.split('\n');
      while (lines.length > 1 && lines.join('\n').length > this.config.memoryMaxChars) {
        lines.shift();
      }
      newContent = lines.join('\n');
      this.logger.info('Memory pruned: removed oldest entries to stay within limit');
    }

    writeFileSync(memoryPath, newContent, 'utf-8');
    this.logger.info({ fact }, 'Memory appended');
  }

  /**
   * Clear all memory
   */
  clearMemory(): void {
    const memoryPath = join(this.dir, 'MEMORY.md');
    writeFileSync(memoryPath, '', 'utf-8');
    this.logger.info('Memory cleared');
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
