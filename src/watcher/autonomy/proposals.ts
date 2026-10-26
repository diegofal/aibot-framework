/**
 * Autonomy rung 0: the approval queue (`docs/plans/watcher-autonomy-plan.md`,
 * C2, C3, C7). `parseProposal` validates a submission's structure and checks
 * every change against the allowlist (`locked.ts`); a locked path or an
 * out-of-range value makes it `rejected-locked`: stored for audit, never
 * pending, never shown. `ProposalStore` keeps `<watcherDir>/self/proposals.jsonl`
 * (append-only, last line per id wins, readers never throw), shows at most
 * `maxPending` (≤ 3) at once and queues the rest FIFO, expires a pending one
 * `approvalTtlHours` after it became pending, and dedupes an identical open
 * proposal by its content hash.
 *
 * `approve` and `reject` are the only state changes a person can make, one
 * proposal at a time (there is no bulk approve), and only the operator can
 * make them: the actor is checked at runtime, and an approval names the
 * content hash the operator saw. Every transition is one watcher log row
 * (`autonomy:*`), written by code.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WatcherLogExtra } from '../log';
import type { WatcherPhase } from '../types';
import { isGuardMetric } from './guards';
import { type LockContext, checkTunableChange } from './locked';
import {
  type ChangeRecord,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  type Proposal,
  type ProposalChange,
  type ProposalInput,
  type ProposalKind,
} from './types';

/** Structural limits of a proposal. */
export const PROPOSAL_LIMITS = Object.freeze({
  title: 120,
  /** rationale, predicted.effect, rollback, a rejection note. */
  text: 1000,
  supportMin: 1,
  supportMax: 20,
  supportIdChars: 200,
  changesMin: 1,
  changesMax: 5,
  windowHoursMin: 1,
  windowHoursMax: 336,
});

/** No setting can show more than this many proposals at once (C3, approval fatigue). */
export const MAX_PENDING_CEILING = 3;

const HOUR_MS = 3_600_000;

/** The subset of `WatcherLog` the autonomy modules write through. */
export interface AutonomyLog {
  say(phase: WatcherPhase, op: string, text: string, extra?: WatcherLogExtra): unknown;
}

/** Where every autonomy record lives: `<watcherDir>/self/`. */
export function autonomyDir(watcherDir: string): string {
  return join(watcherDir, 'self');
}

export function proposalsFile(watcherDir: string): string {
  return join(autonomyDir(watcherDir), 'proposals.jsonl');
}

/** Append one JSON line (creates the dir). Throws on a disk error: callers decide. */
export function appendJsonLine(path: string, value: unknown, dir: string): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf-8');
}

/** Every record in a JSONL file, last line per id wins, in first-seen order. Never throws. */
export function readJsonLines<T extends { id: string }>(
  path: string,
  valid: (v: unknown) => v is T
): T[] {
  const byId = new Map<string, T>();
  try {
    if (!existsSync(path)) return [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const v: unknown = JSON.parse(line);
        if (valid(v)) byId.set(v.id, v);
      } catch {
        // a malformed line is skipped
      }
    }
  } catch {
    return [];
  }
  return [...byId.values()];
}

function validProposal(v: unknown): v is Proposal {
  const p = v as Partial<Proposal> | null;
  return (
    !!p &&
    typeof p === 'object' &&
    typeof p.id === 'string' &&
    typeof p.contentHash === 'string' &&
    typeof p.createdAt === 'string' &&
    typeof p.title === 'string' &&
    Array.isArray(p.changes) &&
    (PROPOSAL_STATUSES as readonly string[]).includes(p.status as string)
  );
}

export function readProposals(watcherDir: string): Proposal[] {
  return readJsonLines(proposalsFile(watcherDir), validProposal);
}

// ── parsing ─────────────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true; input: ProposalInput }
  /** Well-formed, but touches a locked path or an out-of-range value: stored for audit. */
  | { ok: false; locked: true; input: ProposalInput; note: string }
  /** Not a well-formed proposal: nothing to store. */
  | { ok: false; locked: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} must be a non-empty string`);
  if (v.length > max) throw new Error(`${field} is longer than ${max} characters`);
  return v;
}

function optNum(v: unknown, field: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${field} must be a number`);
  return v;
}

/** A JSON-safe copy (drops functions, undefined object keys); throws on cycles. */
function jsonValue(v: unknown): unknown {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}

function structure(raw: unknown): ProposalInput {
  if (!isObj(raw)) throw new Error('a proposal must be an object');
  const kind = raw.kind;
  if (!(PROPOSAL_KINDS as readonly unknown[]).includes(kind)) {
    throw new Error(`kind must be one of ${PROPOSAL_KINDS.join(', ')}`);
  }
  const title = str(raw.title, 'title', PROPOSAL_LIMITS.title);
  const rationale = str(raw.rationale, 'rationale', PROPOSAL_LIMITS.text);
  const rollback = str(raw.rollback, 'rollback', PROPOSAL_LIMITS.text);
  if (raw.proposedBy !== 'watcher' && raw.proposedBy !== 'test') {
    throw new Error('proposedBy must be watcher or test');
  }
  const support = raw.support;
  if (
    !Array.isArray(support) ||
    support.length < PROPOSAL_LIMITS.supportMin ||
    support.length > PROPOSAL_LIMITS.supportMax
  ) {
    throw new Error(
      `support must list ${PROPOSAL_LIMITS.supportMin} to ${PROPOSAL_LIMITS.supportMax} record ids`
    );
  }
  const supportIds = support.map((s, i) => str(s, `support[${i}]`, PROPOSAL_LIMITS.supportIdChars));
  const changes = raw.changes;
  if (
    !Array.isArray(changes) ||
    changes.length < PROPOSAL_LIMITS.changesMin ||
    changes.length > PROPOSAL_LIMITS.changesMax
  ) {
    throw new Error(
      `changes must list ${PROPOSAL_LIMITS.changesMin} to ${PROPOSAL_LIMITS.changesMax} changes`
    );
  }
  const seen = new Set<string>();
  const cleanChanges: ProposalChange[] = changes.map((c, i) => {
    if (!isObj(c) || typeof c.path !== 'string') throw new Error(`changes[${i}] needs a path`);
    if (seen.has(c.path)) throw new Error(`changes name ${c.path} twice`);
    seen.add(c.path);
    return { path: c.path, from: jsonValue(c.from), to: jsonValue(c.to) };
  });
  const predicted = raw.predicted;
  if (!isObj(predicted)) throw new Error('predicted must be an object');
  const effect = str(predicted.effect, 'predicted.effect', PROPOSAL_LIMITS.text);
  const saving = optNum(predicted.savingUsdPerWeek, 'predicted.savingUsdPerWeek');
  const cost = optNum(predicted.costUsdPerWeek, 'predicted.costUsdPerWeek');
  const guard = raw.guard;
  if (!isObj(guard)) throw new Error('guard must be an object');
  if (!isGuardMetric(guard.metric))
    throw new Error(`guard.metric ${String(guard.metric)} is unknown`);
  if (guard.direction !== 'min' && guard.direction !== 'max') {
    throw new Error('guard.direction must be min or max');
  }
  const bound = optNum(guard.bound, 'guard.bound');
  if (bound === undefined) throw new Error('guard.bound must be a number');
  const windowHours = optNum(guard.windowHours, 'guard.windowHours');
  if (
    windowHours === undefined ||
    windowHours < PROPOSAL_LIMITS.windowHoursMin ||
    windowHours > PROPOSAL_LIMITS.windowHoursMax
  ) {
    throw new Error(
      `guard.windowHours must be ${PROPOSAL_LIMITS.windowHoursMin} to ${PROPOSAL_LIMITS.windowHoursMax}`
    );
  }
  return {
    kind: kind as ProposalKind,
    title,
    rationale,
    support: supportIds,
    changes: cleanChanges,
    predicted: {
      effect,
      ...(saving !== undefined ? { savingUsdPerWeek: saving } : {}),
      ...(cost !== undefined ? { costUsdPerWeek: cost } : {}),
    },
    guard: { metric: guard.metric, direction: guard.direction, bound, windowHours },
    rollback,
    proposedBy: raw.proposedBy,
  };
}

/** The lock check alone, over a well-formed input (also re-run at approval). */
export function lockNote(input: ProposalInput, ctx: LockContext): string | undefined {
  if (input.kind === 'prompt-section') {
    return 'prompt-section proposals are not available in rung 0';
  }
  for (const change of input.changes) {
    const check = checkTunableChange(change, ctx);
    if (!check.ok) return check.note;
    if (check.family !== input.kind) {
      return `${change.path} is a ${check.family} path; a ${input.kind} proposal cannot change it`;
    }
  }
  return undefined;
}

/** Validate a submission. Never throws. */
export function parseProposal(raw: unknown, ctx: LockContext): ParseResult {
  let input: ProposalInput;
  try {
    input = structure(raw);
  } catch (err) {
    return { ok: false, locked: false, error: err instanceof Error ? err.message : String(err) };
  }
  const note = lockNote(input, ctx);
  if (note) return { ok: false, locked: true, input, note };
  return { ok: true, input };
}

// ── hashing ─────────────────────────────────────────────────────────────

/** JSON with object keys sorted at every level; `undefined` keys dropped. */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const INPUT_FIELDS = [
  'kind',
  'title',
  'rationale',
  'support',
  'changes',
  'predicted',
  'guard',
  'rollback',
  'proposedBy',
] as const satisfies ReadonlyArray<keyof ProposalInput>;

/** sha256 hex of the canonical JSON of the `ProposalInput` fields (nothing the store adds). */
export function proposalHash(input: ProposalInput): string {
  const picked: Record<string, unknown> = {};
  for (const k of INPUT_FIELDS) picked[k] = input[k];
  return createHash('sha256').update(canonicalJson(picked)).digest('hex');
}

// ── the store ───────────────────────────────────────────────────────────

export type SubmitResult =
  | { ok: true; proposal: Proposal; deduped?: true }
  | { ok: false; error: string; proposal?: Proposal };

export type DecisionResult =
  | { ok: true; proposal: Proposal; change?: ChangeRecord }
  | { ok: false; status: 403 | 404 | 409; error: string };

export type ApplyFn = (
  proposal: Proposal
) => Promise<{ ok: true; change: ChangeRecord } | { ok: false; error: string }>;

export interface ProposalStoreDeps {
  watcherDir: string;
  log?: AutonomyLog;
  now?: () => number;
  /** Read live on every call. `maxPending` is clamped to 1..3 whatever it says. */
  settings: () => { maxPending: number; approvalTtlHours: number };
  lockContext: () => LockContext;
  /** The change ledger's apply. */
  apply: ApplyFn;
  logger?: { warn: (obj: object, msg: string) => void };
}

const OPEN: ReadonlySet<string> = new Set(['queued', 'pending']);

export class ProposalStore {
  private readonly now: () => number;

  constructor(private readonly deps: ProposalStoreDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Every proposal, oldest first, after expiry and promotion. */
  all(): Proposal[] {
    this.refresh();
    return readProposals(this.deps.watcherDir);
  }

  /** What the operator can review: pending only, oldest first. */
  reviewable(): Proposal[] {
    return this.all().filter((p) => p.status === 'pending');
  }

  get(id: string): Proposal | undefined {
    this.refresh();
    return readProposals(this.deps.watcherDir).find((p) => p.id === id);
  }

  submit(raw: unknown): SubmitResult {
    const parsed = parseProposal(raw, this.deps.lockContext());
    const at = new Date(this.now()).toISOString();
    if (!parsed.ok && !parsed.locked) {
      this.say('integrate', 'autonomy:invalid', `I refused a malformed proposal: ${parsed.error}.`);
      return { ok: false, error: parsed.error };
    }
    const input = parsed.input;
    const contentHash = proposalHash(input);
    if (!parsed.ok) {
      const proposal: Proposal = {
        ...input,
        id: newId('p'),
        contentHash,
        status: 'rejected-locked',
        createdAt: at,
        note: parsed.note,
      };
      if (!this.write(proposal)) return { ok: false, error: 'Could not store the proposal' };
      this.say(
        'integrate',
        'autonomy:rejected-locked',
        `I refused my own proposal "${input.title}": ${parsed.note}. It was never shown for review.`
      );
      return { ok: false, error: parsed.note, proposal };
    }
    this.refresh();
    const existing = readProposals(this.deps.watcherDir);
    const dup = existing.find((p) => p.contentHash === contentHash && OPEN.has(p.status));
    if (dup) return { ok: true, proposal: dup, deduped: true };
    const pendingNow = existing.filter((p) => p.status === 'pending').length;
    const proposal: Proposal = {
      ...input,
      id: newId('p'),
      contentHash,
      status: 'queued',
      createdAt: at,
    };
    if (pendingNow < this.maxPending()) this.makePending(proposal, this.now());
    if (!this.write(proposal)) return { ok: false, error: 'Could not store the proposal' };
    this.say(
      'integrate',
      'autonomy:proposed',
      proposal.status === 'pending'
        ? `I proposed "${input.title}". It waits for your review until ${proposal.expiresAt}.`
        : `I proposed "${input.title}". ${pendingNow} proposals already wait for review, so it is queued until one is decided.`
    );
    return { ok: true, proposal };
  }

  /**
   * The operator approves one pending proposal, naming the hash they saw.
   * The ledger applies it; an apply failure leaves it pending with a note.
   */
  async approve(
    id: string,
    opts: { contentHash: string; actor: 'operator' }
  ): Promise<DecisionResult> {
    if (opts?.actor !== 'operator') {
      return { ok: false, status: 403, error: 'Only the operator can approve a proposal' };
    }
    const p = this.get(id);
    if (!p) return { ok: false, status: 404, error: 'No such proposal' };
    if (p.status !== 'pending') {
      return { ok: false, status: 409, error: `The proposal is ${p.status}, not pending` };
    }
    if (p.expiresAt && Date.parse(p.expiresAt) <= this.now()) {
      return { ok: false, status: 409, error: 'The proposal expired' };
    }
    if (typeof opts.contentHash !== 'string' || opts.contentHash !== p.contentHash) {
      return {
        ok: false,
        status: 409,
        error: 'The proposal is not the one you reviewed (content hash mismatch)',
      };
    }
    // The stored content must still hash to what was approved, and still pass the lock.
    if (proposalHash(p) !== p.contentHash) {
      return { ok: false, status: 409, error: 'The stored proposal does not match its hash' };
    }
    const note = lockNote(p, this.deps.lockContext());
    if (note) return this.applyFailed(p, `It can no longer be applied: ${note}`);
    let applied: Awaited<ReturnType<ApplyFn>>;
    try {
      applied = await this.deps.apply(p);
    } catch (err) {
      applied = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!applied.ok) return this.applyFailed(p, applied.error);
    const decided: Proposal = {
      ...p,
      status: 'approved',
      decidedAt: new Date(this.now()).toISOString(),
      decidedBy: 'operator',
      changeId: applied.change.id,
      note: undefined,
    };
    this.write(decided);
    this.say(
      'integrate',
      'autonomy:approved',
      `You approved "${p.title}". I applied it as change ${applied.change.id}.`
    );
    this.refresh();
    return { ok: true, proposal: decided, change: applied.change };
  }

  /** The operator rejects one pending proposal. */
  async reject(id: string, opts: { actor: 'operator'; note?: string }): Promise<DecisionResult> {
    if (opts?.actor !== 'operator') {
      return { ok: false, status: 403, error: 'Only the operator can reject a proposal' };
    }
    const p = this.get(id);
    if (!p) return { ok: false, status: 404, error: 'No such proposal' };
    if (p.status !== 'pending') {
      return { ok: false, status: 409, error: `The proposal is ${p.status}, not pending` };
    }
    const note =
      typeof opts.note === 'string' && opts.note.trim()
        ? opts.note.trim().slice(0, PROPOSAL_LIMITS.text)
        : undefined;
    const decided: Proposal = {
      ...p,
      status: 'rejected',
      decidedAt: new Date(this.now()).toISOString(),
      decidedBy: 'operator',
      note,
    };
    if (!this.write(decided)) {
      return { ok: false, status: 409, error: 'Could not store the decision' };
    }
    this.say('integrate', 'autonomy:rejected', `You rejected "${p.title}".`);
    this.refresh();
    return { ok: true, proposal: decided };
  }

  /** Expire pending proposals past `expiresAt`, then promote queued ones FIFO into free slots. */
  refresh(nowMs: number = this.now()): void {
    const all = readProposals(this.deps.watcherDir);
    let pending = 0;
    for (const p of all) {
      if (p.status !== 'pending') continue;
      if (p.expiresAt && Date.parse(p.expiresAt) <= nowMs) {
        const expired: Proposal = { ...p, status: 'expired' };
        if (this.write(expired)) {
          this.say(
            'integrate',
            'autonomy:expired',
            `My proposal "${p.title}" expired: nobody decided on it within its review window.`
          );
        }
      } else {
        pending++;
      }
    }
    const free = this.maxPending() - pending;
    if (free <= 0) return;
    const queued = all
      .filter((p) => p.status === 'queued')
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const q of queued.slice(0, free)) {
      const next: Proposal = { ...q };
      this.makePending(next, nowMs);
      if (this.write(next)) {
        this.say(
          'integrate',
          'autonomy:promoted',
          `A review slot freed, so my proposal "${q.title}" now waits for you until ${next.expiresAt}.`
        );
      }
    }
  }

  private applyFailed(p: Proposal, error: string): DecisionResult {
    const note = error.slice(0, PROPOSAL_LIMITS.text);
    this.write({ ...p, note });
    this.say(
      'integrate',
      'autonomy:apply-failed',
      `You approved "${p.title}" but I could not apply it: ${note}. It is still pending.`
    );
    return { ok: false, status: 409, error };
  }

  private makePending(p: Proposal, nowMs: number): void {
    const ttl = Math.max(1, this.deps.settings().approvalTtlHours) * HOUR_MS;
    p.status = 'pending';
    p.pendingAt = new Date(nowMs).toISOString();
    p.expiresAt = new Date(nowMs + ttl).toISOString();
  }

  private maxPending(): number {
    const n = Math.floor(this.deps.settings().maxPending);
    return Number.isFinite(n) ? Math.min(MAX_PENDING_CEILING, Math.max(1, n)) : 1;
  }

  private write(p: Proposal): boolean {
    try {
      appendJsonLine(proposalsFile(this.deps.watcherDir), p, autonomyDir(this.deps.watcherDir));
      return true;
    } catch (err) {
      this.deps.logger?.warn({ err, proposalId: p.id }, 'Autonomy: could not store a proposal');
      return false;
    }
  }

  private say(phase: WatcherPhase, op: string, text: string): void {
    try {
      this.deps.log?.say(phase, op, text, { source: 'autonomy' });
    } catch {
      // a log that throws never breaks a decision
    }
  }
}

export function newId(prefix: 'p' | 'c'): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}
