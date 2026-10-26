/**
 * Autonomy rung 0 (`docs/plans/watcher-autonomy-plan.md`): the approval queue
 * and the change ledger behind one API. `createAutonomy` builds both over
 * `<watcherDir>/self/`; `startAutonomyTimers` runs `tick` hourly (expiry,
 * promotion of queued proposals, guard checks and auto-rollback).
 *
 * `createAutonomy` settles any change record a previous run left `applying` or
 * `reverting` before its first call (`ready`), and every `tick` does the same
 * first (`ChangeLedger.recover`, write-ahead: nothing is ever compensated).
 *
 * `submit` is code-only: no route submits a proposal (rung 0 has no producer
 * besides tests). `approve` / `reject` / `revert` / `accept` take `actor:
 * 'operator'`, which only the admin dashboard routes pass
 * (`src/web/routes/watcher.ts`). Every call that changes state runs one at a
 * time (a single queue), so an approval and a guard rollback never
 * interleave. `list` writes nothing and never waits on that queue (it backs
 * `GET /proposals` and every Needs You poll): it shows expiry and a lost
 * approval as they read now (`ProposalStore.view`), and the tick or the next
 * decision stores them.
 */
import type { Config } from '../../config';
import { resolveStatsDirs } from '../../stats/paths';
import { isTenantBot } from '../../tenant/tenant-scoping';
import { WATCHER_DEFAULTS, type WatcherConfig } from '../types';
import { type GuardReader, createGuardReader } from './guards';
import {
  ChangeLedger,
  INTERMEDIATE_STATUSES,
  type LedgerEvent,
  type LedgerResult,
  type ValueAccess,
  createConfigAccess,
} from './ledger';
import {
  type AutonomyLog,
  type DecisionResult,
  MAX_PENDING_CEILING,
  ProposalStore,
  type SubmitResult,
} from './proposals';
import type { ChangeRecord, Proposal, ProposalsResponse } from './types';

export type { AutonomyLog, DecisionResult, SubmitResult } from './proposals';
export type { LedgerEvent, LedgerResult, ValueAccess } from './ledger';
export type { GuardReader } from './guards';

/** How much decided history `list` returns: decided proposals, and ended changes (live, settling and revert-failed ones are always listed). */
export const LIST_HISTORY_LIMIT = 50;
export const AUTONOMY_TICK_MS = 3_600_000;

export interface CreateAutonomyOptions {
  watcherDir: string;
  /** The live config (read on every call: the `enabled` switch, caps, bots). */
  config: Config;
  /** The config file the process loaded; absent → applied values are live only. */
  configPath?: string;
  /** The watcher's log (`Watcher.log`): every autonomy transition is a row. */
  log?: AutonomyLog;
  now?: () => number;
  /** After live values changed: `applied`, `reverted` or `rolled-back`. */
  onApplied?: (change: ChangeRecord, event: LedgerEvent) => void;
  /** Guard metric reader; default reads budget files and the cycle log. */
  guards?: GuardReader;
  /** Value reader/writer; default the live config + config files (`createConfigAccess`). */
  access?: ValueAccess;
  logger?: { warn: (obj: object, msg: string) => void };
}

export interface AutonomyApi {
  /** `watcher.autonomy.proposals.enabled`, live. */
  enabled(): boolean;
  /**
   * `GET /api/watcher/proposals`: reviewable and decided proposals (never
   * queued or rejected-locked) and changes. Read-only. Every change carries
   * its proposal's title; a `revert-failed` one also the values `live` now.
   */
  list(): ProposalsResponse;
  /** Code-only. Refused while proposals are off. */
  submit(input: unknown): Promise<SubmitResult>;
  approve(id: string, opts: { contentHash: string; actor: 'operator' }): Promise<DecisionResult>;
  reject(id: string, opts: { actor: 'operator'; note?: string }): Promise<DecisionResult>;
  revert(changeId: string, opts: { actor: 'operator' }): Promise<LedgerResult>;
  /** The operator accepts the live values of a `revert-failed` change that are not its new ones (`ChangeLedger.accept`). */
  accept(changeId: string, opts: { actor: 'operator' }): Promise<LedgerResult>;
  /** Settling of intermediate change records, expiry, promotion, guard checks. Never throws. */
  tick(nowMs?: number): Promise<void>;
  /** Resolves once the construction-time recovery of intermediate change records is done. */
  ready(): Promise<void>;
}

function proposalSettings(config: Config) {
  const w = (config.watcher as WatcherConfig | undefined) ?? WATCHER_DEFAULTS;
  const p = w.autonomy?.proposals ?? WATCHER_DEFAULTS.autonomy?.proposals;
  return {
    enabled: p?.enabled === true,
    maxPending: Math.min(MAX_PENDING_CEILING, Math.max(1, Math.floor(p?.maxPending ?? 3))),
    approvalTtlHours: p?.approvalTtlHours ?? 72,
  };
}

export function createAutonomy(opts: CreateAutonomyOptions): AutonomyApi {
  const now = opts.now ?? Date.now;
  const { config } = opts;
  const guards =
    opts.guards ??
    createGuardReader({
      watcherDir: opts.watcherDir,
      cyclesDir: resolveStatsDirs(config).agentCycles,
      botIds: () => (config.bots ?? []).filter((b) => !isTenantBot(b, config)).map((b) => b.id),
    });
  const ledger = new ChangeLedger({
    watcherDir: opts.watcherDir,
    access: opts.access ?? createConfigAccess({ config, configPath: opts.configPath }),
    guards,
    log: opts.log,
    now,
    onApplied: opts.onApplied,
    logger: opts.logger,
  });
  const store = new ProposalStore({
    watcherDir: opts.watcherDir,
    log: opts.log,
    now,
    settings: () => proposalSettings(config),
    lockContext: () => ({ config }),
    apply: (p) => ledger.apply(p),
    // An apply-failed change never went live: its proposal can be approved again.
    changeFor: (proposalId) => changeIn(ledger.all(), proposalId),
    logger: opts.logger,
  });

  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const enabled = () => proposalSettings(config).enabled;
  // Before anything else runs: settle what a previous run left half done.
  const recovered = exclusive(async () => {
    try {
      await ledger.recover(now());
    } catch (err) {
      opts.logger?.warn({ err }, 'Autonomy: recovery failed');
    }
  });

  return {
    enabled,
    list() {
      const s = proposalSettings(config);
      if (!s.enabled)
        return { enabled: false, proposals: [], changes: [], maxPending: s.maxPending };
      // One read of the ledger for the whole list.
      const ledgerAll = ledger.all();
      const all = store.view(now(), (proposalId) => changeIn(ledgerAll, proposalId));
      const pending = all.filter((p) => p.status === 'pending');
      const decided = all
        .filter(
          (p) => p.status !== 'pending' && p.status !== 'queued' && p.status !== 'rejected-locked'
        )
        .sort(newestFirst((p: Proposal) => p.decidedAt ?? p.pendingAt ?? p.createdAt))
        .slice(0, LIST_HISTORY_LIMIT);
      // A change that is live, still settling or needs the operator is never cut by the history limit.
      const byApplied = ledgerAll.sort(newestFirst((c: ChangeRecord) => c.appliedAt));
      const open = (c: ChangeRecord) =>
        c.status === 'applied' ||
        c.status === 'revert-failed' ||
        INTERMEDIATE_STATUSES.has(c.status);
      const kept = new Set([
        ...byApplied.filter(open),
        ...byApplied.filter((c) => !open(c)).slice(0, LIST_HISTORY_LIMIT),
      ]);
      const titles = new Map(all.map((p) => [p.id, p.title]));
      const changes = byApplied
        .filter((c) => kept.has(c))
        .map((c) => {
          const title = c.title ?? titles.get(c.proposalId);
          const live = c.status === 'revert-failed' ? ledger.liveValues(c) : undefined;
          return { ...c, ...(title ? { title } : {}), ...(live ? { live } : {}) };
        });
      return {
        enabled: true,
        proposals: [...pending, ...decided],
        changes,
        maxPending: s.maxPending,
      };
    },
    submit: (input) =>
      exclusive(() =>
        enabled() ? store.submit(input) : { ok: false as const, error: 'Proposals are off' }
      ),
    approve: (id, o) => exclusive(() => store.approve(id, o)),
    reject: (id, o) => exclusive(() => store.reject(id, o)),
    revert: (id, o) => exclusive(() => ledger.revert(id, o)),
    accept: (id, o) => exclusive(() => ledger.accept(id, o)),
    tick: (nowMs) =>
      exclusive(async () => {
        const at = nowMs ?? now();
        try {
          await ledger.recover(at);
        } catch (err) {
          opts.logger?.warn({ err }, 'Autonomy: recovery failed');
        }
        try {
          store.refresh(at);
        } catch (err) {
          opts.logger?.warn({ err }, 'Autonomy: proposal refresh failed');
        }
        try {
          await ledger.checkGuards(at);
        } catch (err) {
          opts.logger?.warn({ err }, 'Autonomy: guard check failed');
        }
      }),
    ready: () => recovered,
  };
}

/** A proposal's recorded change. An apply-failed change never went live: its proposal can be approved again. */
function changeIn(changes: ChangeRecord[], proposalId: string): ChangeRecord | undefined {
  return changes.find((c) => c.proposalId === proposalId && c.status !== 'apply-failed');
}

function newestFirst<T>(at: (x: T) => string) {
  return (a: T, b: T) => (Date.parse(at(b)) || 0) - (Date.parse(at(a)) || 0);
}

export interface AutonomyTimers {
  stop(): void;
}

/** Hourly `tick` (timer `unref`: it never keeps the process alive). `stop` is idempotent. */
export function startAutonomyTimers(
  api: AutonomyApi,
  opts: { everyMs?: number; logger?: { warn: (obj: object, msg: string) => void } } = {}
): AutonomyTimers {
  let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    api.tick().catch((err) => opts.logger?.warn({ err }, 'Autonomy: tick failed'));
  }, opts.everyMs ?? AUTONOMY_TICK_MS);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
