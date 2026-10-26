/**
 * Autonomy rung 0, C4: the change ledger (`docs/plans/watcher-autonomy-plan.md`).
 * Every approved proposal is applied here, by code, and becomes a
 * `ChangeRecord` in `<watcherDir>/self/changes.jsonl` (append-only, last line
 * per id wins, readers never throw) with the live values right before and
 * right after.
 *
 * Write-ahead, no compensation: no config value is ever written before an
 * intent record says what is about to be written. Apply appends `applying`,
 * writes the after-values, appends `applied`. Revert (the operator) and
 * rollback (a breached guard, hourly) append `reverting` with its `cause`,
 * write the before-values, append `reverted` / `rolled-back`. Nothing ever
 * writes old values back on behalf of a record that failed to store: a record
 * left `applying` or `reverting` is settled by `recover` (every tick, and at
 * construction through `createAutonomy`) from the live values alone —
 * `applying` with the after-values live → `applied`, with the before-values →
 * `apply-failed`; `reverting` with the before-values live → finished, with the
 * after-values → the before-values written and finished (whatever
 * `guardUntil` says: a rollback intent is never abandoned); anything else →
 * `revert-failed` with what was `found`, for the operator, and nothing
 * written over someone else's edit. Every outcome is a watcher log row.
 * Never throws.
 *
 * A before-value that was an env reference in the file (`raw`, such as
 * `${CADENCE}`) goes back to the file as written, and live as the reference
 * expanded with the current environment (`expandEnvReferences`, what
 * `loadConfig` does); a reference whose variable is no longer set is not
 * written and the change goes to the operator.
 *
 * Values go through a `ValueAccess`; `createConfigAccess` is the real one:
 * the live `Config` plus the config files on disk.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Config,
  WatcherConfigSchema,
  botsPathFromConfigPath,
  expandEnvReferences,
  patchConfigFile,
  writeJsonFileAtomic,
} from '../../config';
import { parseDurationMs } from '../../core/duration';
import { type GuardReader, breaches } from './guards';
import { BOT_CADENCE, TUNABLES } from './locked';
import {
  type AutonomyLog,
  appendJsonLine,
  autonomyDir,
  canonicalJson,
  newId,
  readJsonLines,
} from './proposals';
import type { ChangeRecord, ChangeStatus, Proposal } from './types';

const HOUR_MS = 3_600_000;

/** One value to write; with an own `raw`, the persisted file gets `raw` and the live config `value`. */
export type ValueWrite = { path: string; value: unknown; raw?: unknown };

/** Reads and writes config values by dotted path. */
export interface ValueAccess {
  read(path: string): unknown;
  /**
   * The value persisted for `path` when it is not the live one but expands to
   * it (an env reference such as `${CADENCE}`); undefined otherwise.
   */
  readPersisted?(path: string): { value: unknown } | undefined;
  /** All or nothing as far as the implementation can; throws on failure. `undefined` removes the key. */
  write(values: ValueWrite[]): Promise<void>;
}

/** `undefined` and `null` are the same value (a missing key); otherwise canonical JSON equality. */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function changesFile(watcherDir: string): string {
  return join(autonomyDir(watcherDir), 'changes.jsonl');
}

const CHANGE_STATUSES: ReadonlySet<string> = new Set<ChangeStatus>([
  'applying',
  'applied',
  'apply-failed',
  'reverting',
  'reverted',
  'rolled-back',
  'revert-failed',
  'accepted',
]);

/** Recorded and not settled: `recover` finishes it from the live values. */
export const INTERMEDIATE_STATUSES: ReadonlySet<ChangeStatus> = new Set<ChangeStatus>([
  'applying',
  'reverting',
]);

function validChange(v: unknown): v is ChangeRecord {
  const c = v as Partial<ChangeRecord> | null;
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.id === 'string' &&
    typeof c.proposalId === 'string' &&
    Array.isArray(c.before) &&
    Array.isArray(c.after) &&
    typeof c.appliedAt === 'string' &&
    typeof c.guardUntil === 'string' &&
    !!c.guard &&
    CHANGE_STATUSES.has(c.status as string)
  );
}

export function readChanges(watcherDir: string): ChangeRecord[] {
  return readJsonLines(changesFile(watcherDir), validChange);
}

export type LedgerEvent = 'applied' | 'reverted' | 'rolled-back';

export interface LedgerDeps {
  watcherDir: string;
  access: ValueAccess;
  guards?: GuardReader;
  log?: AutonomyLog;
  now?: () => number;
  /** After this ledger wrote live values (apply, revert, rollback). A throw is logged, never propagated. */
  onApplied?: (change: ChangeRecord, event: LedgerEvent) => void;
  logger?: { warn: (obj: object, msg: string) => void };
}

/** 500: an intent is recorded and not settled (values may be live); `error` says what is live. */
export type LedgerResult =
  | { ok: true; change: ChangeRecord }
  | { ok: false; status: 403 | 404 | 409 | 500; error: string };

/** `live: true`: an intent is recorded and not settled, values may be live: never "not applied" (500). */
export type ApplyResult =
  | { ok: true; change: ChangeRecord }
  | { ok: false; error: string; live?: true };

function show(v: unknown): string {
  if (v === undefined || v === null) return '(unset)';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const fmt = (n: number): string => String(Number(n.toFixed(4)));

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

type Entry = ChangeRecord['before'][number];
type Live = Array<{ path: string; value: unknown }>;

/** `${NAME}` references in a raw value, at any depth. */
function envNames(raw: unknown, out: string[] = []): string[] {
  if (typeof raw === 'string') {
    for (const m of raw.matchAll(/\$\{([^}]+)\}/g)) out.push(m[1]);
  } else if (Array.isArray(raw)) {
    for (const v of raw) envNames(v, out);
  } else if (raw && typeof raw === 'object') {
    for (const v of Object.values(raw)) envNames(v, out);
  }
  return out;
}

/** What a raw file value is live today: `loadConfig`'s expansion. Throws when a variable is not set. */
function expandNow(path: string, raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  const missing = envNames(raw).filter((n) => process.env[n] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${path} goes back to ${show(raw)}, but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set, so I did not write it`
    );
  }
  return expandEnvReferences(raw);
}

/** The writes that put the before-values back: raw references to the file, their current expansion live. */
function restoreWrites(before: readonly Entry[]): ValueWrite[] {
  return before.map((b) =>
    Object.hasOwn(b, 'raw')
      ? { path: b.path, value: expandNow(b.path, b.raw), raw: clone(b.raw) }
      : { path: b.path, value: clone(b.value) }
  );
}

/** Is `live` the before-value: the one recorded, or (for a raw reference) what it expands to now? */
function isBefore(b: Entry, live: unknown): boolean {
  if (sameValue(live, b.value)) return true;
  if (!Object.hasOwn(b, 'raw')) return false;
  try {
    return sameValue(live, expandNow(b.path, b.raw));
  } catch {
    return false;
  }
}

export class ChangeLedger {
  private readonly now: () => number;

  constructor(private readonly deps: LedgerDeps) {
    this.now = deps.now ?? Date.now;
  }

  all(): ChangeRecord[] {
    return readChanges(this.deps.watcherDir);
  }

  get(id: string): ChangeRecord | undefined {
    return this.all().find((c) => c.id === id);
  }

  /** Apply an approved proposal. The caller (`ProposalStore.approve`) checked actor, hash and lock. */
  async apply(proposal: Proposal): Promise<ApplyResult> {
    const before: ChangeRecord['before'] = [];
    for (const c of proposal.changes) {
      let live: unknown;
      try {
        live = this.deps.access.read(c.path);
      } catch (err) {
        return { ok: false, error: `Could not read ${c.path}: ${errText(err)}` };
      }
      if (!sameValue(live, c.from)) {
        return {
          ok: false,
          error: `${c.path} changed since it was proposed: it is now ${show(live)}, the proposal saw ${show(c.from)}`,
        };
      }
      let persisted: { value: unknown } | undefined;
      try {
        persisted = this.deps.access.readPersisted?.(c.path);
      } catch {
        persisted = undefined;
      }
      before.push({
        path: c.path,
        value: clone(live),
        ...(persisted ? { raw: clone(persisted.value) ?? null } : {}),
      });
    }
    const after = proposal.changes.map((c) => ({ path: c.path, value: clone(c.to) }));
    const nowMs = this.now();
    const intent: ChangeRecord = {
      id: newId('c'),
      proposalId: proposal.id,
      title: proposal.title,
      before,
      after,
      guard: { ...proposal.guard },
      appliedAt: new Date(nowMs).toISOString(),
      guardUntil: new Date(nowMs + proposal.guard.windowHours * HOUR_MS).toISOString(),
      status: 'applying',
    };
    if (!this.store(intent)) {
      return {
        ok: false,
        error: 'Could not record the change, so I did not apply it: nothing changed',
      };
    }
    try {
      await this.deps.access.write(after);
    } catch (err) {
      return this.applyWriteFailed(intent, errText(err));
    }
    const done: ChangeRecord = { ...intent, status: 'applied' };
    if (!this.store(done)) {
      const error = `I applied it as change ${intent.id} (${describe(before, after)}), but could not record that it finished. It is live; the next check records it from the live values, and it can be reverted then`;
      this.say('autonomy:apply-unsettled', `${error}.`);
      this.notify(intent, 'applied');
      return { ok: false, error, live: true };
    }
    const g = done.guard;
    this.say(
      'autonomy:applied',
      `I applied "${proposal.title}" as change ${done.id}: ${describe(before, after)}. I watch ${g.metric} (${g.direction === 'max' ? 'at most' : 'at least'} ${g.bound}) until ${done.guardUntil}.`
    );
    this.notify(done, 'applied');
    return { ok: true, change: done };
  }

  /** The after-value write threw: what is live decides, nothing is written back. */
  private applyWriteFailed(intent: ChangeRecord, error: string): ApplyResult {
    const settled = this.settleApplying(intent, this.now(), error);
    if (settled?.status === 'applied') {
      this.notify(settled, 'applied');
      return { ok: true, change: settled };
    }
    if (settled?.status === 'apply-failed') {
      return { ok: false, error: `Could not write the change: ${error}. Nothing changed` };
    }
    if (settled?.status === 'revert-failed') {
      return {
        ok: false,
        live: true,
        error: `Writing the change failed (${error}) and the live values are neither the old nor the new ones (${describeLive(settled.found)}). Change ${intent.id} keeps both for you; set them by hand`,
      };
    }
    const unsettled = `Writing the change failed (${error}) and I could not record the outcome; the next check settles change ${intent.id} from the live values`;
    this.say('autonomy:apply-unsettled', `${unsettled}.`);
    return { ok: false, live: true, error: unsettled };
  }

  /** The operator undoes a change. Refused when the live values are no longer the applied ones. */
  async revert(id: string, opts: { actor: 'operator' }): Promise<LedgerResult> {
    if (opts?.actor !== 'operator') {
      return { ok: false, status: 403, error: 'Only the operator can revert a change' };
    }
    const change = this.get(id);
    if (!change) return { ok: false, status: 404, error: 'No such change' };
    if (INTERMEDIATE_STATUSES.has(change.status)) {
      return {
        ok: false,
        status: 409,
        error: `The change is still settling (${change.status}); the next check finishes it`,
      };
    }
    if (change.status !== 'applied' && change.status !== 'revert-failed') {
      return { ok: false, status: 409, error: `The change is ${change.status}` };
    }
    const moved = this.movedSinceApply(change);
    if (moved) {
      return {
        ok: false,
        status: 409,
        error: `${moved} changed since the change was applied; I left it as it is`,
      };
    }
    const intent: ChangeRecord = {
      ...change,
      status: 'reverting',
      cause: 'operator',
      endReason: 'Reverted by the operator',
      guardReading: undefined,
      endedAt: undefined,
      found: undefined,
    };
    if (!this.store(intent)) {
      return {
        ok: false,
        status: 409,
        error: `Could not record the revert, so I did not start it: change ${change.id} is still ${change.status}`,
      };
    }
    const outcome = await this.runRevert(intent, this.now());
    if (outcome.kind === 'done') {
      return { ok: true, change: outcome.change };
    }
    if (outcome.kind === 'failed') {
      return { ok: false, status: 409, error: outcome.change.endReason ?? 'The revert failed' };
    }
    const error =
      outcome.kind === 'unsettled-written'
        ? `I wrote the old values back but could not record that the revert finished; they are live, and the next check records change ${change.id} as reverted`
        : `The revert of change ${change.id} failed and I could not record the outcome; the next check settles it from the live values`;
    this.say('autonomy:revert-unsettled', `${error}.`);
    return { ok: false, status: 500, error };
  }

  /**
   * Roll back every live change whose guard breached inside its window, and
   * retry every rollback whose write failed (`revert-failed`, `cause: guard`,
   * the after-values still live) while its guard still breaches, inside or
   * past its window: a rollback once decided is never abandoned. An operator
   * revert whose write failed with the after-values still live stays under
   * its guard inside its window: a breach rolls it back (`cause: guard`).
   * Never over a hand edit (`movedSinceApply`). Returns the rolled-back ones.
   */
  async checkGuards(nowMs: number = this.now()): Promise<ChangeRecord[]> {
    const rolled: ChangeRecord[] = [];
    const read = this.deps.guards;
    if (!read) return rolled;
    for (const change of this.all()) {
      try {
        const retry = this.isRollbackRetry(change);
        const guarded = change.status === 'applied' || this.isFailedOperatorRevert(change);
        if (!guarded && !retry) continue;
        const since = Date.parse(change.appliedAt);
        if (nowMs < since) continue;
        if (!retry && nowMs > Date.parse(change.guardUntil)) continue;
        let reading: number | undefined;
        try {
          reading = await read(change.guard.metric, { sinceMs: since, nowMs });
        } catch (err) {
          this.deps.logger?.warn({ err, changeId: change.id }, 'Autonomy: a guard reader threw');
          continue;
        }
        if (typeof reading !== 'number' || !Number.isFinite(reading)) continue;
        if (!breaches(change.guard, reading)) continue;
        const g = change.guard;
        const why = `${g.metric} read ${fmt(reading)}, past its ${g.direction === 'max' ? 'maximum' : 'minimum'} of ${g.bound}`;
        const ended = await this.rollBack(change, why, reading, nowMs);
        if (ended?.status === 'rolled-back') rolled.push(ended);
      } catch (err) {
        this.deps.logger?.warn({ err, changeId: change.id }, 'Autonomy: guard check failed');
      }
    }
    return rolled;
  }

  /** A rollback that failed writing while the after-values stay live: the guard's to retry. */
  private isRollbackRetry(change: ChangeRecord): boolean {
    return (
      change.status === 'revert-failed' &&
      change.cause === 'guard' &&
      this.movedSinceApply(change) === undefined
    );
  }

  /** An operator revert whose write failed while the after-values stay live: still under its guard, inside its window. */
  private isFailedOperatorRevert(change: ChangeRecord): boolean {
    return (
      change.status === 'revert-failed' &&
      change.cause !== 'guard' &&
      this.movedSinceApply(change) === undefined
    );
  }

  /**
   * The operator accepts the live values of a `revert-failed` change that
   * are not the after-values (a hand edit, a third value a settlement found):
   * it ends `accepted` with what is live now in `found`. Nothing is written.
   * Refused while the after-values are all live: Revert is the action then.
   */
  async accept(id: string, opts: { actor: 'operator' }): Promise<LedgerResult> {
    if (opts?.actor !== 'operator') {
      return { ok: false, status: 403, error: 'Only the operator can accept a change' };
    }
    const change = this.get(id);
    if (!change) return { ok: false, status: 404, error: 'No such change' };
    if (change.status !== 'revert-failed') {
      return {
        ok: false,
        status: 409,
        error: `The change is ${change.status}; only a change that needs you can be accepted as it is`,
      };
    }
    const live = this.readLive(change);
    if (!live) {
      return {
        ok: false,
        status: 409,
        error: 'I could not read the live values, so I did not record them',
      };
    }
    if (this.movedSinceApply(change) === undefined) {
      return {
        ok: false,
        status: 409,
        error: 'The new values are still live: revert the change instead',
      };
    }
    const accepted: ChangeRecord = {
      ...change,
      status: 'accepted',
      endedAt: new Date(this.now()).toISOString(),
      endReason: `You accepted the live values as they are (${describeLive(live)})`,
      found: live,
    };
    if (!this.store(accepted)) {
      return {
        ok: false,
        status: 409,
        error: `Could not record your decision: change ${change.id} still needs you`,
      };
    }
    this.say(
      'autonomy:accepted',
      `You accepted the live values of change ${change.id} as they are: ${describeLive(live)}. I keep its old values on record and change nothing.`
    );
    return { ok: true, change: accepted };
  }

  /** The values live now for every path a change touches; undefined when one cannot be read. */
  liveValues(change: ChangeRecord): Array<{ path: string; value: unknown }> | undefined {
    return this.readLive(change);
  }

  /**
   * Settle every record left `applying` or `reverting` (a record that could
   * not be stored, a process that died between the steps), from the live
   * values. `reverting` is finished whatever `guardUntil` says. Never throws.
   */
  async recover(nowMs: number = this.now()): Promise<void> {
    for (const change of this.all()) {
      try {
        if (change.status === 'applying') {
          if (!this.settleApplying(change, nowMs)) this.sayUnrecorded(change);
        } else if (change.status === 'reverting') {
          const outcome = await this.runRevert(change, nowMs, { recovering: true });
          if (outcome.kind.startsWith('unsettled')) this.sayUnrecorded(change);
        }
      } catch (err) {
        this.deps.logger?.warn({ err, changeId: change.id }, 'Autonomy: recovery failed');
      }
    }
  }

  private async rollBack(
    change: ChangeRecord,
    why: string,
    reading: number,
    nowMs: number
  ): Promise<ChangeRecord | undefined> {
    const moved = this.movedSinceApply(change);
    if (moved) {
      const failed = this.needsOperator(
        { ...change, cause: 'guard', guardReading: reading },
        nowMs,
        this.readLive(change),
        `${why}, but ${moved} changed since it was applied, so I left it; the old values are kept for you`,
        'autonomy:revert-failed'
      );
      if (!failed) {
        this.say(
          'autonomy:revert-failed',
          `I could not roll back change ${change.id}: ${why}, but ${moved} changed since it was applied. I could not record this either: the change still shows as applied.`
        );
      }
      return failed;
    }
    const intent: ChangeRecord = {
      ...change,
      status: 'reverting',
      cause: 'guard',
      guardReading: reading,
      endReason: why,
      endedAt: undefined,
      found: undefined,
    };
    if (!this.store(intent)) {
      this.say(
        'autonomy:rollback-unrecorded',
        `I would roll back change ${change.id} because ${why}, but could not record it, so I changed nothing; it is still ${change.status} and I try again at the next check ${
          this.isRollbackRetry(change) ? 'while its guard breaches' : 'while its window lasts'
        }.`
      );
      return undefined;
    }
    const outcome = await this.runRevert(intent, nowMs);
    if (outcome.kind === 'done' || outcome.kind === 'failed') return outcome.change;
    this.say(
      'autonomy:rollback-unsettled',
      outcome.kind === 'unsettled-written'
        ? `I rolled back change ${change.id} because ${why}: the old values are live, but I could not record that it finished. The next check records it, whatever its window says.`
        : `I tried to roll back change ${change.id} because ${why}, the write failed and I could not record the outcome; the next check settles it from the live values.`
    );
    return undefined;
  }

  /**
   * Carry out a recorded `reverting` intent. Live = before → finished. Live =
   * after (or each path one or the other) → the before-values are written,
   * then finished; a write that fails is settled from the live values again
   * (no second write). Anything else → the operator, nothing written.
   */
  private async runRevert(
    intent: ChangeRecord,
    nowMs: number,
    opts: { recovering?: boolean } = {}
  ): Promise<
    { kind: 'done' | 'failed'; change: ChangeRecord } | { kind: 'unsettled-written' | 'unsettled' }
  > {
    const live = this.readLive(intent);
    if (live && intent.before.every((b) => isBefore(b, liveAt(live, b.path)))) {
      const done = this.finishRevert(intent, nowMs, opts.recovering === true);
      return done ? { kind: 'done', change: done } : { kind: 'unsettled-written' };
    }
    const ours =
      live &&
      intent.before.every((b) => {
        const a = intent.after.find((x) => x.path === b.path);
        return (
          isBefore(b, liveAt(live, b.path)) || (!!a && sameValue(liveAt(live, a.path), a.value))
        );
      });
    if (!ours) {
      const failed = this.needsOperator(
        intent,
        nowMs,
        live,
        `${intentWhy(intent)}, but the live values are neither the old nor the new ones, so I left them; both are kept for you`,
        'autonomy:needs-operator'
      );
      return failed ? { kind: 'failed', change: failed } : { kind: 'unsettled' };
    }
    let error: string | undefined;
    try {
      await this.deps.access.write(restoreWrites(intent.before));
    } catch (err) {
      error = errText(err);
    }
    if (error === undefined) {
      const done = this.finishRevert(intent, nowMs, opts.recovering === true);
      this.notify(done ?? intent, intent.cause === 'guard' ? 'rolled-back' : 'reverted');
      return done ? { kind: 'done', change: done } : { kind: 'unsettled-written' };
    }
    const after = this.readLive(intent);
    if (after && intent.before.every((b) => isBefore(b, liveAt(after, b.path)))) {
      const done = this.finishRevert(intent, nowMs, opts.recovering === true);
      return done ? { kind: 'done', change: done } : { kind: 'unsettled-written' };
    }
    const failed = this.needsOperator(
      intent,
      nowMs,
      after,
      `${intentWhy(intent)}; writing the old values back failed (${error}); they are kept for you`,
      'autonomy:revert-failed'
    );
    return failed ? { kind: 'failed', change: failed } : { kind: 'unsettled' };
  }

  /** The terminal record of a revert intent whose before-values are live, and its row. */
  private finishRevert(
    intent: ChangeRecord,
    nowMs: number,
    recovering: boolean
  ): ChangeRecord | undefined {
    const guard = intent.cause === 'guard';
    const done: ChangeRecord = {
      ...intent,
      status: guard ? 'rolled-back' : 'reverted',
      endedAt: new Date(nowMs).toISOString(),
      endReason:
        intent.endReason ?? (guard ? 'Rolled back by its guard' : 'Reverted by the operator'),
      found: undefined,
    };
    if (!this.store(done)) return undefined;
    const values = describe(intent.after, intent.before);
    if (guard) {
      this.say(
        'autonomy:rolled-back',
        recovering
          ? `I finished rolling back change ${intent.id} because ${done.endReason}: ${values}.`
          : `I rolled back change ${intent.id} because ${done.endReason}: ${values}.`
      );
    } else {
      this.say(
        'autonomy:reverted',
        recovering
          ? `I finished your revert of change ${intent.id}: ${values}.`
          : `You reverted change ${intent.id}: ${values}.`
      );
    }
    return done;
  }

  /** Settle an `applying` intent from the live values. Undefined when the outcome could not be stored. */
  private settleApplying(
    intent: ChangeRecord,
    nowMs: number,
    error?: string
  ): ChangeRecord | undefined {
    const live = this.readLive(intent);
    if (live && intent.after.every((a) => sameValue(liveAt(live, a.path), a.value))) {
      const done: ChangeRecord = { ...intent, status: 'applied' };
      if (!this.store(done)) return undefined;
      this.say(
        'autonomy:applied',
        `I recorded change ${intent.id} as applied: its new values are live (${describe(intent.before, intent.after)}). I watch ${intent.guard.metric} until ${intent.guardUntil}.`
      );
      return done;
    }
    const before =
      live &&
      intent.after.every((a) => {
        const b = intent.before.find((x) => x.path === a.path);
        return !!b && isBefore(b, liveAt(live, b.path));
      });
    if (before) {
      const failed: ChangeRecord = {
        ...intent,
        status: 'apply-failed',
        endedAt: new Date(nowMs).toISOString(),
        endReason: error
          ? `Writing the change failed (${error}); nothing changed`
          : 'The change never reached the live config; nothing changed',
      };
      if (!this.store(failed)) return undefined;
      this.say(
        'autonomy:apply-failed',
        `I could not apply change ${intent.id}: ${failed.endReason}.`
      );
      return failed;
    }
    return this.needsOperator(
      intent,
      nowMs,
      live,
      `${error ? `Writing the change failed (${error}) and the` : 'The'} live values are neither the old nor the new ones, so I left them; both are kept for you`,
      'autonomy:needs-operator'
    );
  }

  /** `revert-failed` with what was found live, and its row. Never writes a value. */
  private needsOperator(
    change: ChangeRecord,
    nowMs: number,
    live: Live | undefined,
    reason: string,
    op: 'autonomy:needs-operator' | 'autonomy:revert-failed'
  ): ChangeRecord | undefined {
    const failed: ChangeRecord = {
      ...change,
      status: 'revert-failed',
      endedAt: new Date(nowMs).toISOString(),
      endReason: reason,
      ...(live ? { found: live } : {}),
    };
    if (!this.store(failed)) return undefined;
    this.say(
      op,
      op === 'autonomy:needs-operator'
        ? `Change ${change.id} needs you: ${reason} (live ${describeLive(live)}).`
        : `I could not ${change.cause === 'operator' ? 'revert' : 'roll back'} change ${change.id}: ${reason}.`
    );
    return failed;
  }

  private sayUnrecorded(change: ChangeRecord): void {
    this.say(
      'autonomy:settle-unrecorded',
      `I could not record how change ${change.id} (${change.status}) settled; I try again at the next check.`
    );
  }

  /** The live value of every path a change touches, in `before` order; undefined when one cannot be read. */
  private readLive(change: ChangeRecord): Live | undefined {
    const out: Live = [];
    for (const b of change.before) {
      try {
        out.push({ path: b.path, value: clone(this.deps.access.read(b.path)) });
      } catch {
        return undefined;
      }
    }
    return out;
  }

  /** The first path whose live value is no longer the applied one, if any. */
  private movedSinceApply(change: ChangeRecord): string | undefined {
    for (const a of change.after) {
      let live: unknown;
      try {
        live = this.deps.access.read(a.path);
      } catch {
        return a.path;
      }
      if (!sameValue(live, a.value)) return a.path;
    }
    return undefined;
  }

  private store(change: ChangeRecord): boolean {
    try {
      appendJsonLine(changesFile(this.deps.watcherDir), change, autonomyDir(this.deps.watcherDir));
      return true;
    } catch (err) {
      this.deps.logger?.warn(
        { err, changeId: change.id },
        'Autonomy: could not store a change record'
      );
      return false;
    }
  }

  private notify(change: ChangeRecord, event: LedgerEvent): void {
    try {
      this.deps.onApplied?.(change, event);
    } catch (err) {
      this.deps.logger?.warn({ err, changeId: change.id }, 'Autonomy: onApplied threw');
    }
  }

  private say(op: string, text: string): void {
    try {
      this.deps.log?.say('broadcast', op, text, { source: 'autonomy' });
    } catch {
      // a log that throws never breaks a change
    }
  }
}

function describe(
  from: ReadonlyArray<{ path: string; value: unknown }>,
  to: ReadonlyArray<{ path: string; value: unknown }>
): string {
  return to
    .map((t) => {
      const f = from.find((x) => x.path === t.path);
      return `${t.path} ${show(f?.value)} → ${show(t.value)}`;
    })
    .join('; ');
}

/** What a revert intent was for, as the start of a sentence. */
function intentWhy(intent: ChangeRecord): string {
  if (intent.cause === 'guard') return intent.endReason ?? 'Its guard breached';
  return 'You asked to revert it';
}

const liveAt = (live: Live, path: string): unknown => live.find((l) => l.path === path)?.value;

function describeLive(live: Live | undefined): string {
  if (!live) return 'unreadable';
  return live.map((l) => `${l.path} ${show(l.value)}`).join('; ');
}

// ── the real value access: live config + config files ───────────────────

const TUNABLE_PATHS: ReadonlySet<string> = new Set(TUNABLES.map((t) => t.path));

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** `obj` with `value` at `keys` (copies every object on the way; `undefined` deletes). */
function withValue(obj: unknown, keys: readonly string[], value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isObj(obj) ? { ...obj } : {};
  const [head, ...rest] = keys;
  if (rest.length === 0) {
    if (value === undefined || value === null) delete out[head];
    else out[head] = clone(value);
    return out;
  }
  out[head] = withValue(out[head], rest, value);
  return out;
}

function getOwn(obj: unknown, keys: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!isObj(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

type Target = { kind: 'watcher'; keys: string[] } | { kind: 'bot'; botId: string };

/** Only allowlisted paths are reachable at all: the writer refuses anything else. */
function targetOf(path: string): Target | undefined {
  if (TUNABLE_PATHS.has(path)) return { kind: 'watcher', keys: path.split('.').slice(1) };
  const m = BOT_CADENCE.pattern.exec(path);
  if (m) return { kind: 'bot', botId: m[1] };
  return undefined;
}

export interface ConfigAccessDeps {
  /** The live config every module reads. */
  config: Config;
  /** The config file the process loaded; absent → changes are live only. */
  configPath?: string;
}

/**
 * Values in the live `Config` and persisted to disk. `readPersisted` reads
 * the raw file value when it expands to the live one but is not it (an env
 * reference: `agentLoop.every: "${CADENCE}"`; a watcher tunable cannot be one,
 * `WatcherConfigSchema` takes numbers only), and a write with `raw` puts that
 * back in the file while the live config gets `value` (the ledger passes the
 * reference expanded with the current environment, `restoreWrites`; a bot
 * cadence going live must be a duration the agent loop parses). A watcher value is
 * written into config.json raw (its `${VAR}` references untouched, validated
 * with `WatcherConfigSchema` as `loadConfig` would see it, through
 * `patchConfigFile`); a bot's `agentLoop.every` into bots.json raw (never
 * `persistBots`, which would write the env-expanded secrets of every bot),
 * or into config.json's inline `bots` when there is no bots.json. Disk
 * first, then the live config: a failed write leaves both untouched. The
 * live watcher tier objects are replaced, never mutated (they may be shared
 * with `WATCHER_DEFAULTS`).
 */
export function createConfigAccess(deps: ConfigAccessDeps): ValueAccess {
  const { config } = deps;
  const bot = (id: string) => (config.bots ?? []).find((b) => b.id === id);
  const read = (path: string): unknown => {
    const t = targetOf(path);
    if (!t) return undefined;
    if (t.kind === 'watcher') return getOwn(config.watcher, t.keys);
    return getOwn(bot(t.botId)?.agentLoop, ['every']);
  };
  return {
    read,
    readPersisted(path) {
      const t = targetOf(path);
      if (!t || !deps.configPath) return undefined;
      let raw: unknown;
      try {
        raw =
          t.kind === 'watcher'
            ? getOwn(readJsonObject(deps.configPath).watcher, t.keys)
            : persistedBotEvery(deps.configPath, t.botId);
      } catch {
        return undefined;
      }
      const live = read(path);
      if (sameValue(raw, live) || !sameValue(expandEnvReferences(raw), live)) return undefined;
      return { value: raw };
    },
    async write(values) {
      const watcherValues: Array<{ keys: string[]; value: unknown; file: unknown }> = [];
      const botValues: Array<{ botId: string; value: unknown; file: unknown }> = [];
      for (const v of values) {
        const t = targetOf(v.path);
        if (!t) throw new Error(`${v.path} is not a tunable`);
        const file = Object.hasOwn(v, 'raw') ? v.raw : v.value;
        if (t.kind === 'watcher') watcherValues.push({ keys: t.keys, value: v.value, file });
        else {
          if (!bot(t.botId)) throw new Error(`No bot "${t.botId}" in the live config`);
          validateCadence(v.path, v.value);
          botValues.push({ botId: t.botId, value: v.value, file });
        }
      }
      // The live watcher block it would become must validate before anything is written.
      let nextWatcher: unknown = config.watcher;
      for (const w of watcherValues) nextWatcher = withValue(nextWatcher, w.keys, w.value);
      if (watcherValues.length > 0) validateWatcher(nextWatcher);

      if (deps.configPath) {
        const configPath = deps.configPath;
        if (watcherValues.length > 0) {
          patchConfigFile(configPath, (raw) => {
            let watcher: unknown = raw.watcher;
            for (const w of watcherValues) watcher = withValue(watcher, w.keys, w.file);
            validateWatcher(expandEnvReferences(watcher));
            raw.watcher = watcher;
          });
        }
        if (botValues.length > 0) persistBotCadence(configPath, botValues);
      }

      if (watcherValues.length > 0) config.watcher = nextWatcher as Config['watcher'];
      for (const b of botValues) {
        const live = bot(b.botId);
        if (!live) continue;
        live.agentLoop = withValue(live.agentLoop, ['every'], b.value) as typeof live.agentLoop;
      }
    },
  };
}

/** A live cadence is absent or a duration the agent loop parses (a restored `${VAR}` expansion included). */
function validateCadence(path: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string')
    throw new Error(`${path} must be a duration like "6h", got ${show(value)}`);
  try {
    parseDurationMs(value);
  } catch {
    throw new Error(`${path} must be a duration like "6h", got ${show(value)}`);
  }
}

function validateWatcher(watcher: unknown): void {
  const check = WatcherConfigSchema.safeParse(watcher);
  if (!check.success) {
    throw new Error(
      `the watcher config would not validate: ${check.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`
    );
  }
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  return isObj(parsed) ? parsed : {};
}

/** A bot's raw `agentLoop.every` from bots.json, or config.json's inline `bots` when there is none. */
function persistedBotEvery(configPath: string, botId: string): unknown {
  const botsPath = botsPathFromConfigPath(configPath);
  const bots: unknown = existsSync(botsPath)
    ? JSON.parse(readFileSync(botsPath, 'utf-8'))
    : readJsonObject(configPath).bots;
  if (!Array.isArray(bots)) return undefined;
  const b = bots.find((x) => isObj(x) && x.id === botId);
  return getOwn(b, ['agentLoop', 'every']);
}

function persistBotCadence(
  configPath: string,
  values: Array<{ botId: string; file: unknown }>
): void {
  const patch = (bots: unknown): unknown[] => {
    if (!Array.isArray(bots)) throw new Error('the bots file is not an array');
    const next = bots.map((b) => (isObj(b) ? { ...b } : b));
    for (const v of values) {
      const i = next.findIndex((b) => isObj(b) && b.id === v.botId);
      if (i < 0) throw new Error(`No bot "${v.botId}" in the bots file`);
      const b = next[i] as Record<string, unknown>;
      b.agentLoop = withValue(b.agentLoop, ['every'], v.file);
    }
    return next;
  };
  const botsPath = botsPathFromConfigPath(configPath);
  if (existsSync(botsPath)) {
    const next = patch(JSON.parse(readFileSync(botsPath, 'utf-8')));
    writeJsonFileAtomic(botsPath, next);
    return;
  }
  patchConfigFile(configPath, (raw) => {
    raw.bots = patch(raw.bots);
  });
}
