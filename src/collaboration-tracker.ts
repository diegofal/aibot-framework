import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CollaborationRecord {
  initiatorBotId: string;
  responderBotId: string;
  chatId: number;
  depth: number;
  startedAt: number;
  lastMessageAt: number;
}

/**
 * Prevents infinite loops and rate-limits agent-to-agent conversations.
 */
export class CollaborationTracker {
  /** key: `${chatId}:${botA}:${botB}` (sorted pair) */
  private records: Map<string, CollaborationRecord> = new Map();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private maxRounds: number = 5,
    private cooldownMs: number = 30_000,
    private dataDir?: string,
  ) {
    if (dataDir) this.loadFromDisk();
    // Periodic cleanup every 60 s
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
  }

  /** Load records from disk on startup. Runs sweep() to remove stale entries. */
  loadFromDisk(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'tracker.json');
    if (!existsSync(filePath)) return;

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (raw.records && typeof raw.records === 'object') {
        for (const [key, record] of Object.entries(raw.records)) {
          this.records.set(key, record as CollaborationRecord);
        }
      }
      this.sweep();
    } catch {
      // Ignore corrupt file
    }
  }

  /** Persist records to disk. */
  private persistToDisk(): void {
    if (!this.dataDir) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const data = { records: Object.fromEntries(this.records) };
      writeFileSync(join(this.dataDir, 'tracker.json'), JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Swallow write errors (non-critical)
    }
  }

  private pairKey(botA: string, botB: string, chatId: number): string {
    const sorted = [botA, botB].sort();
    return `${chatId}:${sorted[0]}:${sorted[1]}`;
  }

  shouldAllowResponse(
    fromBotId: string,
    toBotId: string,
    chatId: number,
  ): { allowed: boolean; reason?: string } {
    const key = this.pairKey(fromBotId, toBotId, chatId);
    const record = this.records.get(key);

    if (!record) {
      return { allowed: true };
    }

    // Cooldown: if previous chain hit max depth, block until cooldown expires
    if (record.depth >= this.maxRounds) {
      const elapsed = Date.now() - record.lastMessageAt;
      if (elapsed < this.cooldownMs) {
        return { allowed: false, reason: `cooldown (${Math.ceil((this.cooldownMs - elapsed) / 1000)}s remaining)` };
      }
      // Cooldown expired — reset the record
      this.records.delete(key);
      return { allowed: true };
    }

    return { allowed: true };
  }

  /**
   * Atomic check + record: verifies limits and records the exchange in one step.
   * Use chatId = 0 for internal (tool-based) collaborations.
   */
  checkAndRecord(
    fromBotId: string,
    toBotId: string,
    chatId: number,
  ): { allowed: boolean; reason?: string } {
    const check = this.shouldAllowResponse(fromBotId, toBotId, chatId);
    if (check.allowed) {
      this.recordExchange(fromBotId, toBotId, chatId);
    }
    return check;
  }

  recordExchange(fromBotId: string, toBotId: string, chatId: number): void {
    const key = this.pairKey(fromBotId, toBotId, chatId);
    const existing = this.records.get(key);

    if (existing) {
      existing.depth += 1;
      existing.lastMessageAt = Date.now();
    } else {
      this.records.set(key, {
        initiatorBotId: fromBotId,
        responderBotId: toBotId,
        chatId,
        depth: 1,
        startedAt: Date.now(),
        lastMessageAt: Date.now(),
      });
    }
    this.persistToDisk();
  }

  /** Remove stale records older than 5 minutes past cooldown */
  sweep(): void {
    const sizeBefore = this.records.size;
    const cutoff = Date.now() - this.cooldownMs - 300_000;
    for (const [key, record] of this.records) {
      if (record.lastMessageAt < cutoff) {
        this.records.delete(key);
      }
    }
    if (this.records.size !== sizeBefore) this.persistToDisk();
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
