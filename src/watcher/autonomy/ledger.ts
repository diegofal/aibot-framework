/**
 * Autonomy rung 0, C4: the change ledger (`docs/plans/watcher-autonomy-plan.md`).
 * Every approved proposal is applied here, by code, and becomes a
 * `ChangeRecord` in `<watcherDir>/self/changes.jsonl` (append-only, last line
 * per id wins, readers never throw) with the live values right before and
 * right after. `apply` refuses when a live value is no longer what the
 * proposal saw. `revert` (the operator) writes the before-values back only
 * while the live values are still the ones it applied. `checkGuards` (hourly)
 * reads each live change's guard metric inside its window and, on a breach,
 * rolls it back by code; a rollback that cannot write, or that would clobber
 * a value someone changed since, is `revert-failed` and keeps its
 * before-values for the operator. Every outcome is a watcher log row. Never
 * throws.
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
  'applied',
  'reverted',
  'rolled-back',
  'revert-failed',
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
  /** After live values changed (apply, revert, rollback). A throw is logged, never propagated. */
  onApplied?: (change: ChangeRecord, event: LedgerEvent) => void;
  logger?: { warn: (obj: object, msg: string) => void };
}

/** 500: the live values changed but the record of it could not be stored; `error` says what is live. */
export type LedgerResult =
  | { ok: true; change: ChangeRecord }
  | { ok: false; status: 403 | 404 | 409 | 500; error: string };

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
  async apply(
    proposal: Proposal
  ): Promise<{ ok: true; change: ChangeRecord } | { ok: false; error: string; live?: true }> {
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
    try {
      await this.deps.access.write(after);
    } catch (err) {
      return { ok: false, error: `Could not write the change: ${errText(err)}` };
    }
    const nowMs = this.now();
    const change: ChangeRecord = {
      id: newId('c'),
      proposalId: proposal.id,
      before,
      after,
      guard: { ...proposal.guard },
      appliedAt: new Date(nowMs).toISOString(),
      guardUntil: new Date(nowMs + proposal.guard.windowHours * HOUR_MS).toISOString(),
      status: 'applied',
    };
    if (!this.store(change)) {
      // Without a record it could never be reverted: undo it now.
      try {
        await this.deps.access.write(before);
      } catch (err) {
        this.deps.logger?.warn(
          { err, proposalId: proposal.id },
          'Autonomy: could not undo an unrecorded change'
        );
        const error = `I applied it but could not record it, and undoing it failed (${errText(err)}): the new values are live with no change record (${describe(before, after)}). Set them back by hand`;
        this.say('autonomy:apply-unrecorded', `${error}.`);
        return { ok: false, error, live: true };
      }
      return { ok: false, error: 'Could not record the change, so I undid it: nothing changed' };
    }
    const g = change.guard;
    this.say(
      'autonomy:applied',
      `I applied "${proposal.title}" as change ${change.id}: ${describe(before, after)}. I watch ${g.metric} (${g.direction === 'max' ? 'at most' : 'at least'} ${g.bound}) until ${change.guardUntil}.`
    );
    this.notify(change, 'applied');
    return { ok: true, change };
  }

  /** The operator undoes a change. Refused when the live values are no longer the applied ones. */
  async revert(id: string, opts: { actor: 'operator' }): Promise<LedgerResult> {
    if (opts?.actor !== 'operator') {
      return { ok: false, status: 403, error: 'Only the operator can revert a change' };
    }
    const change = this.get(id);
    if (!change) return { ok: false, status: 404, error: 'No such change' };
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
    try {
      await this.deps.access.write(change.before);
    } catch (err) {
      return {
        ok: false,
        status: 409,
        error: `Could not write the old values back: ${errText(err)}`,
      };
    }
    const ended: ChangeRecord = {
      ...change,
      status: 'reverted',
      endedAt: new Date(this.now()).toISOString(),
      endReason: 'Reverted by the operator',
    };
    if (!this.store(ended)) {
      // A revert the ledger does not know about would leave a record that
      // says applied over restored values: put the change back instead.
      const failed = await this.reapply(change);
      const error =
        failed === undefined
          ? `Could not record the revert, so I put change ${change.id} back: it is still applied. Try again`
          : `I wrote the old values back but could not record the revert, and putting the change back failed (${failed}): the old values are live while change ${change.id} still shows as applied`;
      this.say('autonomy:revert-unrecorded', `${error}.`);
      return { ok: false, status: 500, error };
    }
    this.say(
      'autonomy:reverted',
      `You reverted change ${change.id}: ${describe(change.after, change.before)}.`
    );
    this.notify(ended, 'reverted');
    return { ok: true, change: ended };
  }

  /** Roll back every live change whose guard breached inside its window. Returns the rolled-back ones. */
  async checkGuards(nowMs: number = this.now()): Promise<ChangeRecord[]> {
    const rolled: ChangeRecord[] = [];
    const read = this.deps.guards;
    if (!read) return rolled;
    for (const change of this.all()) {
      try {
        if (change.status !== 'applied') continue;
        const since = Date.parse(change.appliedAt);
        if (!(nowMs >= since && nowMs <= Date.parse(change.guardUntil))) continue;
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
        const ended = await this.rollBack(change, why, nowMs);
        if (ended?.status === 'rolled-back') rolled.push(ended);
      } catch (err) {
        this.deps.logger?.warn({ err, changeId: change.id }, 'Autonomy: guard check failed');
      }
    }
    return rolled;
  }

  private async rollBack(
    change: ChangeRecord,
    why: string,
    nowMs: number
  ): Promise<ChangeRecord | undefined> {
    const endedAt = new Date(nowMs).toISOString();
    const moved = this.movedSinceApply(change);
    if (moved) {
      const failed: ChangeRecord = {
        ...change,
        status: 'revert-failed',
        endedAt,
        endReason: `${why}, but ${moved} changed since it was applied, so I left it; the old values are kept for you`,
      };
      this.storeFailed(failed);
      return failed;
    }
    try {
      await this.deps.access.write(change.before);
    } catch (err) {
      const failed: ChangeRecord = {
        ...change,
        status: 'revert-failed',
        endedAt,
        endReason: `${why}; writing the old values back failed (${errText(err)}); they are kept for you`,
      };
      this.storeFailed(failed);
      return failed;
    }
    const ended: ChangeRecord = { ...change, status: 'rolled-back', endedAt, endReason: why };
    if (!this.store(ended)) {
      // Same as revert: never leave restored values under an "applied" record.
      const failed = await this.reapply(change);
      this.say(
        'autonomy:rollback-unrecorded',
        failed === undefined
          ? `I rolled back change ${change.id} because ${why}, but could not record it, so I put the change back; it is still applied and I try again at the next check.`
          : `I rolled back change ${change.id} because ${why}, but could not record it, and putting the change back failed (${failed}): the old values are live while the change still shows as applied.`
      );
      return undefined;
    }
    this.say(
      'autonomy:rolled-back',
      `I rolled back change ${change.id} because ${why}: ${describe(change.after, change.before)}.`
    );
    this.notify(ended, 'rolled-back');
    return ended;
  }

  /** Write a change's after-values again. The error text, or undefined when it worked. */
  private async reapply(change: ChangeRecord): Promise<string | undefined> {
    try {
      await this.deps.access.write(change.after);
      return undefined;
    } catch (err) {
      this.deps.logger?.warn({ err, changeId: change.id }, 'Autonomy: could not put a change back');
      return errText(err);
    }
  }

  /** A `revert-failed` record and its row; the row says so when even the record could not be stored. */
  private storeFailed(failed: ChangeRecord): void {
    const stored = this.store(failed);
    this.say(
      'autonomy:revert-failed',
      stored
        ? `I could not roll back change ${failed.id}: ${failed.endReason}.`
        : `I could not roll back change ${failed.id}: ${failed.endReason}. I could not record this either: the change still shows as applied.`
    );
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
 * back in the file while the live config gets the expanded value. A watcher value is
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
