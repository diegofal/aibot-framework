import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';

export type PermissionUrgency = 'low' | 'normal' | 'high';
export type PermissionStatus = 'pending' | 'approved' | 'denied' | 'expired';
export type ExecutionStatus = 'decided' | 'consumed' | 'executed' | 'failed';

export interface PermissionRequest {
  id: string;
  botId: string;
  action: string;
  resource: string;
  description: string;
  urgency: PermissionUrgency;
  status: PermissionStatus;
  createdAt: number;
  timeoutMs: number;
  resolvedAt?: number;
  note?: string;
}

export interface PermissionRequestInfo {
  id: string;
  botId: string;
  action: string;
  resource: string;
  description: string;
  urgency: PermissionUrgency;
  status: 'pending';
  createdAt: number;
  timeoutMs: number;
  remainingMs: number;
}

export interface ResolvedPermission {
  id: string;
  botId: string;
  action: string;
  resource: string;
  description: string;
  status: 'approved' | 'denied';
  resolvedAt: number;
  note?: string;
}

export interface PermissionHistoryEntry extends ResolvedPermission {
  executionStatus: ExecutionStatus;
  consumedAt?: number;
  executedAt?: number;
  executionSummary?: string;
  toolCalls?: Array<{ name: string; success: boolean }>;
}

interface PendingEntry {
  request: PermissionRequest;
  resolve: (decision: 'approved' | 'denied') => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Manages pending permission requests from bots.
 * Mirrors AskHumanStore: queue → dashboard approve/deny → consume on next agent cycle.
 */
export class AskPermissionStore {
  private pending = new Map<string, PendingEntry>();
  /** Resolved decisions waiting to be consumed by the next agent loop cycle */
  private resolved = new Map<string, ResolvedPermission>();
  /** History of decided/consumed/executed permissions (bounded, auto-pruned) */
  private history = new Map<string, PermissionHistoryEntry>();

  private static readonly HISTORY_MAX_ENTRIES = 100;
  private static readonly HISTORY_TTL_MS = 24 * 3_600_000;

  constructor(
    private logger: Logger,
    private dataDir?: string
  ) {
    if (dataDir) this.loadFromDisk();
  }

  /** Load resolved history from disk on startup. Pending entries are NOT persisted. */
  loadFromDisk(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'history.json');
    if (!existsSync(filePath)) return;

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      const now = Date.now();

      // Restore history (prune TTL 24h)
      if (Array.isArray(raw.history)) {
        for (const entry of raw.history) {
          if (now - entry.resolvedAt < AskPermissionStore.HISTORY_TTL_MS) {
            this.history.set(entry.id, entry);
          }
        }
      }

      // Restore resolved decisions (waiting to be consumed)
      if (Array.isArray(raw.resolved)) {
        for (const entry of raw.resolved) {
          this.resolved.set(entry.id, entry);
        }
      }

      this.logger.debug(
        { historyCount: this.history.size, resolvedCount: this.resolved.size },
        'AskPermission: loaded from disk'
      );
    } catch (err) {
      this.logger.warn({ err }, 'AskPermission: failed to load from disk');
    }
  }

  /** Persist history and resolved maps to disk. */
  private persistToDisk(): void {
    if (!this.dataDir) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const data = {
        history: Array.from(this.history.values()),
        resolved: Array.from(this.resolved.values()),
      };
      writeFileSync(join(this.dataDir, 'history.json'), JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn({ err }, 'AskPermission: failed to persist to disk');
    }
  }

  /**
   * Register a permission request. Returns a promise that resolves with 'approved' or 'denied'.
   * Deduplicates: if same (botId, action, resource) is already pending, returns existing ID.
   */
  request(
    botId: string,
    action: string,
    resource: string,
    description: string,
    urgency: PermissionUrgency = 'normal',
    timeoutMs: number = 60 * 60_000
  ): { id: string; promise: Promise<'approved' | 'denied'> } {
    // Dedup check
    const existing = this.findPendingDuplicate(botId, action, resource);
    if (existing) {
      this.logger.debug(
        { id: existing.request.id, botId },
        'AskPermission: duplicate request, returning existing'
      );
      const promise = new Promise<'approved' | 'denied'>((resolve, reject) => {
        const orig = this.pending.get(existing.request.id);
        if (orig) {
          const origResolve = orig.resolve;
          const origReject = orig.reject;
          orig.resolve = (decision) => {
            origResolve(decision);
            resolve(decision);
          };
          orig.reject = (reason) => {
            origReject(reason);
            reject(reason);
          };
        }
      });
      return { id: existing.request.id, promise };
    }

    const id = randomUUID();

    const { promise, resolve, reject } = this.createDeferredPromise<'approved' | 'denied'>();

    const timer = setTimeout(() => {
      const entry = this.pending.get(id);
      if (entry) {
        entry.request.status = 'expired';
        this.cleanup(id);
        reject(new Error('Permission request timed out'));
      }
    }, timeoutMs);

    const request: PermissionRequest = {
      id,
      botId,
      action,
      resource,
      description,
      urgency,
      status: 'pending',
      createdAt: Date.now(),
      timeoutMs,
    };

    this.pending.set(id, { request, resolve, reject, timer });

    this.logger.debug({ id, botId, action, resource }, 'AskPermission: request registered');

    return { id, promise };
  }

  /**
   * Approve a pending request. Returns true if found and approved.
   */
  approveById(id: string, note?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;

    this.logger.info({ id, botId: entry.request.botId }, 'AskPermission: approved');

    entry.request.status = 'approved';
    entry.request.resolvedAt = Date.now();
    if (note) entry.request.note = note;

    const resolved: ResolvedPermission = {
      id,
      botId: entry.request.botId,
      action: entry.request.action,
      resource: entry.request.resource,
      description: entry.request.description,
      status: 'approved',
      resolvedAt: entry.request.resolvedAt,
      note,
    };

    this.resolved.set(id, resolved);
    this.writeHistory(resolved, 'decided');
    this.persistToDisk();

    entry.resolve('approved');
    this.cleanup(id);
    return true;
  }

  /**
   * Deny a pending request. Returns true if found and denied.
   */
  denyById(id: string, note?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;

    this.logger.info({ id, botId: entry.request.botId }, 'AskPermission: denied');

    entry.request.status = 'denied';
    entry.request.resolvedAt = Date.now();
    if (note) entry.request.note = note;

    const resolved: ResolvedPermission = {
      id,
      botId: entry.request.botId,
      action: entry.request.action,
      resource: entry.request.resource,
      description: entry.request.description,
      status: 'denied',
      resolvedAt: entry.request.resolvedAt,
      note,
    };

    this.resolved.set(id, resolved);
    this.writeHistory(resolved, 'decided');
    this.persistToDisk();

    entry.resolve('denied');
    this.cleanup(id);
    return true;
  }

  /**
   * Consume-on-read: returns and deletes all resolved decisions for a bot.
   * Called by the agent loop to inject decisions into the planner prompt.
   */
  consumeDecisionsForBot(botId: string): ResolvedPermission[] {
    const results: ResolvedPermission[] = [];
    for (const [id, entry] of this.resolved) {
      if (entry.botId === botId) {
        results.push(entry);
        this.resolved.delete(id);
        const hist = this.history.get(id);
        if (hist) {
          hist.executionStatus = 'consumed';
          hist.consumedAt = Date.now();
        }
      }
    }
    if (results.length > 0) this.persistToDisk();
    return results;
  }

  /**
   * Get pending (unresolved) requests for a specific bot.
   */
  getPendingForBot(botId: string): PermissionRequestInfo[] {
    const now = Date.now();
    const results: PermissionRequestInfo[] = [];
    for (const entry of this.pending.values()) {
      if (entry.request.botId !== botId) continue;
      const elapsed = now - entry.request.createdAt;
      const remainingMs = Math.max(0, entry.request.timeoutMs - elapsed);
      results.push({
        id: entry.request.id,
        botId: entry.request.botId,
        action: entry.request.action,
        resource: entry.request.resource,
        description: entry.request.description,
        urgency: entry.request.urgency,
        status: 'pending',
        createdAt: entry.request.createdAt,
        timeoutMs: entry.request.timeoutMs,
        remainingMs,
      });
    }
    return results;
  }

  /**
   * Get all pending requests (for dashboard).
   */
  getAll(): PermissionRequestInfo[] {
    const now = Date.now();
    const results: PermissionRequestInfo[] = [];
    for (const entry of this.pending.values()) {
      const elapsed = now - entry.request.createdAt;
      const remainingMs = Math.max(0, entry.request.timeoutMs - elapsed);
      results.push({
        id: entry.request.id,
        botId: entry.request.botId,
        action: entry.request.action,
        resource: entry.request.resource,
        description: entry.request.description,
        urgency: entry.request.urgency,
        status: 'pending',
        createdAt: entry.request.createdAt,
        timeoutMs: entry.request.timeoutMs,
        remainingMs,
      });
    }
    return results;
  }

  /**
   * Get total pending count (for badge polling).
   */
  getPendingCount(): number {
    return this.pending.size;
  }

  /**
   * Check if a duplicate pending request exists for (botId, action, resource).
   */
  hasPendingDuplicate(botId: string, action: string, resource: string): boolean {
    return !!this.findPendingDuplicate(botId, action, resource);
  }

  /**
   * Report execution outcome for consumed permission IDs.
   * Called by agent loop after executor completes.
   */
  reportExecution(
    ids: string[],
    summary: string,
    toolCalls: Array<{ name: string; success: boolean }>,
    success: boolean
  ): void {
    const now = Date.now();
    for (const id of ids) {
      const hist = this.history.get(id);
      if (!hist) continue;
      hist.executionStatus = success ? 'executed' : 'failed';
      hist.executedAt = now;
      hist.executionSummary = summary.slice(0, 500);
      hist.toolCalls = toolCalls;
    }
    this.persistToDisk();
  }

  /**
   * Requeue a failed or stuck-consumed permission back into the resolved queue
   * so the next agent loop cycle picks it up again.
   * Only allowed when executionStatus is 'failed' or 'consumed' and original status was 'approved'.
   */
  requeueById(id: string): boolean {
    const hist = this.history.get(id);
    if (!hist) return false;
    if (hist.status !== 'approved') return false;
    if (hist.executionStatus !== 'failed' && hist.executionStatus !== 'consumed') return false;

    // Re-create a resolved permission from the history entry
    const resolved: ResolvedPermission = {
      id: hist.id,
      botId: hist.botId,
      action: hist.action,
      resource: hist.resource,
      description: hist.description,
      status: 'approved',
      resolvedAt: hist.resolvedAt,
      note: hist.note,
    };
    this.resolved.set(id, resolved);

    // Reset history entry fields
    hist.executionStatus = 'decided';
    hist.consumedAt = undefined;
    hist.executedAt = undefined;
    hist.executionSummary = undefined;
    hist.toolCalls = undefined;

    this.persistToDisk();
    this.logger.info({ id, botId: hist.botId }, 'AskPermission: requeued failed/consumed entry');
    return true;
  }

  /**
   * Get history entries, newest-first. Prunes expired entries on read.
   */
  getHistory(limit = 20): PermissionHistoryEntry[] {
    this.pruneHistory();
    const entries = Array.from(this.history.values());
    entries.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
    return entries.slice(0, limit);
  }

  /**
   * Get a single history entry by ID.
   */
  getHistoryById(id: string): PermissionHistoryEntry | undefined {
    return this.history.get(id);
  }

  private writeHistory(resolved: ResolvedPermission, executionStatus: ExecutionStatus): void {
    this.history.set(resolved.id, { ...resolved, executionStatus });
    this.pruneHistory();
  }

  private pruneHistory(): void {
    const now = Date.now();
    const sizeBefore = this.history.size;
    // TTL prune
    for (const [id, entry] of this.history) {
      if (now - entry.resolvedAt > AskPermissionStore.HISTORY_TTL_MS) {
        this.history.delete(id);
      }
    }
    // Size prune (remove oldest first)
    if (this.history.size > AskPermissionStore.HISTORY_MAX_ENTRIES) {
      const sorted = Array.from(this.history.entries()).sort(
        (a, b) => a[1].resolvedAt - b[1].resolvedAt
      );
      const toRemove = sorted.length - AskPermissionStore.HISTORY_MAX_ENTRIES;
      for (let i = 0; i < toRemove; i++) {
        this.history.delete(sorted[i][0]);
      }
    }
    if (this.history.size !== sizeBefore) this.persistToDisk();
  }

  private findPendingDuplicate(
    botId: string,
    action: string,
    resource: string
  ): PendingEntry | undefined {
    for (const entry of this.pending.values()) {
      if (
        entry.request.botId === botId &&
        entry.request.action === action &&
        entry.request.resource === resource
      ) {
        return entry;
      }
    }
    return undefined;
  }

  private cleanup(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
  }

  private createDeferredPromise<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: Error) => void;
  } {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Clear all pending, resolved, and history entries for a specific bot. */
  clearForBot(botId: string): void {
    // Reject + remove pending requests for this bot
    for (const [id, entry] of this.pending) {
      if (entry.request.botId === botId) {
        clearTimeout(entry.timer);
        entry.reject(new Error('AskPermissionStore cleared for bot reset'));
        this.pending.delete(id);
      }
    }
    // Clear resolved entries for this bot
    for (const [id, entry] of this.resolved) {
      if (entry.botId === botId) this.resolved.delete(id);
    }
    // Clear history entries for this bot
    for (const [id, entry] of this.history) {
      if (entry.botId === botId) this.history.delete(id);
    }
    this.logger.info({ botId }, 'AskPermission: cleared all entries for bot');
    this.persistToDisk();
  }

  /**
   * Dispose all pending requests and clean up timers.
   */
  dispose(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('AskPermissionStore disposed'));
    }
    this.pending.clear();
    this.resolved.clear();
    this.history.clear();
  }
}
