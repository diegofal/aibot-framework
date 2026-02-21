import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger';

export interface AgentFeedback {
  id: string;
  botId: string;
  content: string;
  createdAt: string;
  status: 'pending' | 'applied' | 'dismissed';
  appliedAt?: string;
  response?: string;
}

/**
 * Manages agent-level feedback with JSONL persistence.
 * Feedback is stored in {soulDir}/feedback.jsonl per bot.
 */
export class AgentFeedbackStore {
  /** In-memory cache: botId → feedback entries */
  private entries = new Map<string, AgentFeedback[]>();
  /** botId → soulDir for resolving file paths */
  private soulDirs = new Map<string, string>();

  constructor(private logger: Logger) {}

  /** Load feedback from disk for a bot. Call once per bot on startup. */
  loadFromDisk(botId: string, soulDir: string): void {
    this.soulDirs.set(botId, soulDir);
    const filePath = join(soulDir, 'feedback.jsonl');

    if (!existsSync(filePath)) {
      this.entries.set(botId, []);
      return;
    }

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    const items: AgentFeedback[] = [];
    for (const line of lines) {
      try {
        items.push(JSON.parse(line));
      } catch {
        this.logger.warn({ botId, line: line.slice(0, 100) }, 'AgentFeedback: skipping malformed line');
      }
    }
    this.entries.set(botId, items);
    this.logger.debug({ botId, count: items.length }, 'AgentFeedback: loaded from disk');
  }

  /** Submit new feedback for a bot. Returns the created entry. */
  submit(botId: string, content: string): AgentFeedback {
    const entry: AgentFeedback = {
      id: randomUUID(),
      botId,
      content,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    const items = this.entries.get(botId) ?? [];
    items.push(entry);
    this.entries.set(botId, items);

    // Append to JSONL
    const soulDir = this.soulDirs.get(botId);
    if (soulDir) {
      const filePath = join(soulDir, 'feedback.jsonl');
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
    }

    this.logger.info({ botId, id: entry.id }, 'AgentFeedback: submitted');
    return entry;
  }

  /** Get all pending feedback for a bot. */
  getPending(botId: string): AgentFeedback[] {
    return (this.entries.get(botId) ?? []).filter((e) => e.status === 'pending');
  }

  /** Get all feedback for a bot with optional status filter. */
  getAll(botId: string, opts?: { status?: string; limit?: number; offset?: number }): AgentFeedback[] {
    let items = this.entries.get(botId) ?? [];

    if (opts?.status) {
      items = items.filter((e) => e.status === opts.status);
    }

    // Newest first (reverse of insertion order)
    items = [...items].reverse();

    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 100;
    return items.slice(offset, offset + limit);
  }

  /** Mark feedback as applied with the bot's response. */
  markApplied(botId: string, id: string, response: string): AgentFeedback | null {
    const items = this.entries.get(botId);
    if (!items) return null;

    const entry = items.find((e) => e.id === id);
    if (!entry) return null;

    entry.status = 'applied';
    entry.appliedAt = new Date().toISOString();
    entry.response = response;

    this.rewriteJSONL(botId);
    this.logger.info({ botId, id }, 'AgentFeedback: marked applied');
    return entry;
  }

  /** Dismiss a pending feedback item. */
  dismiss(botId: string, id: string): boolean {
    const items = this.entries.get(botId);
    if (!items) return false;

    const entry = items.find((e) => e.id === id);
    if (!entry || entry.status !== 'pending') return false;

    entry.status = 'dismissed';

    this.rewriteJSONL(botId);
    this.logger.info({ botId, id }, 'AgentFeedback: dismissed');
    return true;
  }

  /** Total pending count across all bots. */
  getPendingCount(): number {
    let count = 0;
    for (const items of this.entries.values()) {
      count += items.filter((e) => e.status === 'pending').length;
    }
    return count;
  }

  /** Get all bot IDs that have been loaded. */
  getBotIds(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Rewrite the JSONL file for a bot from in-memory state. */
  private rewriteJSONL(botId: string): void {
    const soulDir = this.soulDirs.get(botId);
    if (!soulDir) return;

    const items = this.entries.get(botId) ?? [];
    const filePath = join(soulDir, 'feedback.jsonl');
    const content = items.length > 0
      ? items.map((e) => JSON.stringify(e)).join('\n') + '\n'
      : '';
    writeFileSync(filePath, content, 'utf-8');
  }
}
