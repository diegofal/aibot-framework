/**
 * Inline approval store for conversation-mode tool confirmations.
 *
 * When an LLM tries to call a tool with `confirm` permission in conversation mode,
 * the tool call is intercepted, stored here, and a synthetic result is returned.
 * The user's next message is classified as approve/deny/unrelated and the pending
 * tool call is resolved accordingly.
 *
 * Persisted to disk so approvals survive server restarts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PendingInlineApproval {
  toolName: string;
  args: Record<string, unknown>;
  createdAt: number;
  botId: string;
  sessionKey: string;
}

const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

export class InlineApprovalStore {
  private pending = new Map<string, PendingInlineApproval>();
  private filePath: string | null;

  constructor(dataDir?: string) {
    if (dataDir) {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      this.filePath = join(dataDir, 'inline-approvals.json');
      this.loadFromDisk();
    } else {
      this.filePath = null;
    }
  }

  setPending(sessionKey: string, approval: PendingInlineApproval): void {
    this.pending.set(sessionKey, approval);
    this.persistToDisk();
  }

  getPending(sessionKey: string): PendingInlineApproval | undefined {
    const entry = this.pending.get(sessionKey);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > EXPIRY_MS) {
      this.pending.delete(sessionKey);
      this.persistToDisk();
      return undefined;
    }
    return entry;
  }

  consumePending(sessionKey: string): PendingInlineApproval | undefined {
    const entry = this.getPending(sessionKey);
    if (entry) {
      this.pending.delete(sessionKey);
      this.persistToDisk();
    }
    return entry;
  }

  clearPending(sessionKey: string): void {
    this.pending.delete(sessionKey);
    this.persistToDisk();
  }

  hasPending(sessionKey: string): boolean {
    return this.getPending(sessionKey) !== undefined;
  }

  private loadFromDisk(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const entries: PendingInlineApproval[] = JSON.parse(raw);
      const now = Date.now();
      for (const entry of entries) {
        if (now - entry.createdAt <= EXPIRY_MS) {
          this.pending.set(entry.sessionKey, entry);
        }
      }
    } catch {
      // Corrupted file — start fresh
    }
  }

  private persistToDisk(): void {
    if (!this.filePath) return;
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const entries = Array.from(this.pending.values());
      writeFileSync(this.filePath, JSON.stringify(entries, null, 2), 'utf-8');
    } catch {
      // Best-effort — don't crash on write failure
    }
  }
}

// ─── Approval response classifier ───

const APPROVE_PATTERNS =
  /^(s[ií]|yes|ok|okay|dale|go|go ahead|hacelo|adelante|sure|do it|proceed|confirm|aprobado|approve|hac[ée]lo|ejecut[aá]|run it|yeah|yep|yea|claro|por supuesto|obvio|mándale|mandále|meta|metele|dale que sí)$/i;
const DENY_PATTERNS =
  /^(no|cancel|nope|para|stop|don'?t|deny|denied|reject|rechaz|abort|cancelar|nah|nel|ni|ni en pedo|olvidate|olvídate)$/i;

/**
 * Classify user response as approve, deny, or unrelated.
 * Conservative: only clear yes/no keywords count. Everything else is 'unrelated'.
 */
export function classifyApprovalResponse(text: string): 'approve' | 'deny' | 'unrelated' {
  const trimmed = text
    .trim()
    .replace(/[.!?,;]+$/, '')
    .trim();
  if (!trimmed) return 'unrelated';
  if (APPROVE_PATTERNS.test(trimmed)) return 'approve';
  if (DENY_PATTERNS.test(trimmed)) return 'deny';
  return 'unrelated';
}

// ─── Human-readable tool call description ───

/**
 * Build a readable description of a tool call for the synthetic result message.
 */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const argSummary = Object.entries(args)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => {
      const val =
        typeof v === 'string' ? (v.length > 80 ? `${v.slice(0, 80)}…` : v) : JSON.stringify(v);
      return `${k}: ${val}`;
    })
    .join(', ');

  return argSummary ? `${name}(${argSummary})` : name;
}
