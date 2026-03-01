import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';

export interface ToolAuditEntry {
  timestamp: string;
  botId: string;
  chatId: number;
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  result: string;
  durationMs: number;
  retryAttempts: number;
}

/**
 * Persists tool execution audit entries to daily JSONL files.
 * Path: {dataDir}/{botId}/YYYY-MM-DD.jsonl
 */
export class ToolAuditLog {
  constructor(
    private dataDir: string,
    private logger: Logger
  ) {}

  /** Append a tool audit entry to the daily JSONL file. */
  append(entry: ToolAuditEntry): void {
    try {
      const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
      const botDir = join(this.dataDir, entry.botId);
      mkdirSync(botDir, { recursive: true });
      const filePath = join(botDir, `${date}.jsonl`);
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch (err) {
      this.logger.warn({ err, botId: entry.botId }, 'ToolAuditLog: failed to append entry');
    }
  }

  /** Read all entries for a bot on a given date. */
  getEntries(botId: string, date: string): ToolAuditEntry[] {
    const filePath = join(this.dataDir, botId, `${date}.jsonl`);
    if (!existsSync(filePath)) return [];

    const entries: ToolAuditEntry[] = [];
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        this.logger.warn(
          { botId, line: line.slice(0, 100) },
          'ToolAuditLog: skipping malformed line'
        );
      }
    }
    return entries;
  }

  /** Remove all audit log files for a bot. Returns true if the directory existed. */
  clearForBot(botId: string): boolean {
    const botDir = join(this.dataDir, botId);
    if (!existsSync(botDir)) return false;
    rmSync(botDir, { recursive: true });
    return true;
  }

  /** List available dates for a bot (sorted newest first). */
  getAvailableDates(botId: string): string[] {
    const botDir = join(this.dataDir, botId);
    if (!existsSync(botDir)) return [];

    return readdirSync(botDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''))
      .sort()
      .reverse();
  }
}
