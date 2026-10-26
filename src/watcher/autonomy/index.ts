/**
 * Autonomy rung 0 (`docs/plans/watcher-autonomy-plan.md`): the approval queue
 * and the change ledger behind one API. `createAutonomy` builds both over
 * `<watcherDir>/self/`; `startAutonomyTimers` runs `tick` hourly (expiry,
 * promotion of queued proposals, guard checks and auto-rollback).
 *
 * `submit` is code-only: no route submits a proposal (rung 0 has no producer
 * besides tests). `approve` / `reject` / `revert` take `actor: 'operator'`,
 * which only the admin dashboard routes pass (`src/web/routes/watcher.ts`).
 * Every call that changes state runs one at a time (a single queue), so an
 * approval and a guard rollback never interleave.
 */
import type { Config } from '../../config';
import { resolveStatsDirs } from '../../stats/paths';
import { isTenantBot } from '../../tenant/tenant-scoping';
import { WATCHER_DEFAULTS, type WatcherConfig } from '../types';
import { type GuardReader, createGuardReader } from './guards';
import {
  ChangeLedger,
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

/** How much decided history `list` returns. */
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
  /** `GET /api/watcher/proposals`: reviewable and decided proposals (never queued or rejected-locked) and changes. */
  list(): ProposalsResponse;
  /** Code-only. Refused while proposals are off. */
  submit(input: unknown): Promise<SubmitResult>;
  approve(id: string, opts: { contentHash: string; actor: 'operator' }): Promise<DecisionResult>;
  reject(id: string, opts: { actor: 'operator'; note?: string }): Promise<DecisionResult>;
  revert(changeId: string, opts: { actor: 'operator' }): Promise<LedgerResult>;
  /** Expiry, promotion, guard checks. Never throws. */
  tick(nowMs?: number): Promise<void>;
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
    logger: opts.logger,
  });

  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const enabled = () => proposalSettings(config).enabled;

  return {
    enabled,
    list() {
      const s = proposalSettings(config);
      if (!s.enabled)
        return { enabled: false, proposals: [], changes: [], maxPending: s.maxPending };
      const all = store.all();
      const pending = all.filter((p) => p.status === 'pending');
      const decided = all
        .filter(
          (p) => p.status !== 'pending' && p.status !== 'queued' && p.status !== 'rejected-locked'
        )
        .sort(newestFirst((p: Proposal) => p.decidedAt ?? p.pendingAt ?? p.createdAt))
        .slice(0, LIST_HISTORY_LIMIT);
      const changes = ledger
        .all()
        .sort(newestFirst((c: ChangeRecord) => c.appliedAt))
        .slice(0, LIST_HISTORY_LIMIT);
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
    tick: (nowMs) =>
      exclusive(async () => {
        const at = nowMs ?? now();
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
  };
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
