/**
 * Inline approval store for conversation-mode tool confirmations.
 *
 * When an LLM tries to call a tool with `confirm` permission in conversation mode,
 * the tool call is intercepted, stored here, and a synthetic result is returned.
 * The user's next message is classified as approve/deny/unrelated and the pending
 * tool call is resolved accordingly.
 *
 * In-memory only — pending approvals are ephemeral (1 turn). If the bot restarts,
 * they are lost, which is correct behavior.
 */

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

  setPending(sessionKey: string, approval: PendingInlineApproval): void {
    this.pending.set(sessionKey, approval);
  }

  getPending(sessionKey: string): PendingInlineApproval | undefined {
    const entry = this.pending.get(sessionKey);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > EXPIRY_MS) {
      this.pending.delete(sessionKey);
      return undefined;
    }
    return entry;
  }

  consumePending(sessionKey: string): PendingInlineApproval | undefined {
    const entry = this.getPending(sessionKey);
    if (entry) this.pending.delete(sessionKey);
    return entry;
  }

  clearPending(sessionKey: string): void {
    this.pending.delete(sessionKey);
  }

  hasPending(sessionKey: string): boolean {
    return this.getPending(sessionKey) !== undefined;
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
