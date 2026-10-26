/**
 * Autonomy rung 0, C2 (`docs/plans/watcher-autonomy-plan.md`): what a
 * proposal may touch. An **allowlist**, not a denylist: `TUNABLES` (watcher
 * thresholds) and `BOT_CADENCE` (a bot's `agentLoop.every`) are the only
 * proposable paths, each inside a range set here, in code. Every other path
 * — every `enabled` flag, caps and budgets, models and backends,
 * `watcher.autonomy.*`, `operator.*`, tools, a bot's other fields — is
 * locked: `checkTunableChange` refuses it and the parser stores the proposal
 * as `rejected-locked`. Nothing in config can widen this list; a new
 * tunable is a code change made by the operator.
 */
import { parseDurationMs } from '../../core/duration';
import { isTenantBot } from '../../tenant/tenant-scoping';

export interface NumericTunable {
  path: string;
  min: number;
  max: number;
  /** The config field is an integer (`z.number().int()`): a fraction is refused, never rounded. */
  integer: boolean;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The watcher tunables (kind `threshold`). Ranges are inclusive. */
export const TUNABLES: readonly NumericTunable[] = Object.freeze([
  { path: 'watcher.notice.salienceBar', min: 0.1, max: 2, integer: false },
  { path: 'watcher.notice.wakeSalience', min: 0.5, max: 5, integer: false },
  { path: 'watcher.notice.maxWaitMs', min: 300_000, max: 21_600_000, integer: true },
  { path: 'watcher.integrate.wakeSalience', min: 1, max: 10, integer: false },
  { path: 'watcher.integrate.minItems', min: 1, max: 20, integer: true },
  { path: 'watcher.integrate.agendaMax', min: 0, max: 20, integer: true },
  { path: 'watcher.integrate.agendaFloorMs', min: 1_800_000, max: 86_400_000, integer: true },
  { path: 'watcher.integrate.heartbeatMs', min: 900_000, max: 86_400_000, integer: true },
  { path: 'watcher.fastLane.minBots', min: 2, max: 5, integer: true },
  { path: 'watcher.forget.threshold', min: 0.05, max: 0.4, integer: false },
]);

/**
 * The fleet-cadence family (kind `fleet-cadence`): `bots.<botId>.agentLoop.every`,
 * a duration string the agent loop parses (`parseDurationMs`), 1 h to 7 d.
 * The bot must exist in the live config and must not be a tenant bot.
 */
export const BOT_CADENCE = Object.freeze({
  pattern: /^bots\.([A-Za-z0-9_-]+)\.agentLoop\.every$/,
  minMs: HOUR_MS,
  maxMs: 7 * DAY_MS,
});

/**
 * Paths that must never be proposable. Used only by tests to assert that
 * none of them passes `checkTunableChange`: the allowlist is what enforces
 * it, this list is the proof.
 */
export const LOCKED_EXAMPLES: readonly string[] = Object.freeze([
  // every switch
  'watcher.enabled',
  'watcher.notice.enabled',
  'watcher.integrate.enabled',
  'watcher.fastLane.enabled',
  'watcher.consolidate.enabled',
  'watcher.consolidate.preview',
  // caps and budgets
  'watcher.notice.maxPerDay',
  'watcher.integrate.maxPerDay',
  'watcher.integrate.maxTokensPerDay',
  'watcher.fastLane.maxPerDay',
  'watcher.consolidate.maxClusters',
  'watcher.graph.maxNeurons',
  'watcher.graph.targetNeurons',
  'watcher.forget.graceDays',
  // models and backends
  'watcher.notice.model',
  'watcher.notice.backend',
  'watcher.integrate.model',
  // its own controls
  'watcher.autonomy',
  'watcher.autonomy.monthlyCeilingUsd',
  'watcher.autonomy.proposals.enabled',
  'watcher.autonomy.proposals.maxPending',
  'watcher.autonomy.proposals.approvalTtlHours',
  // whole blocks and odd shapes
  'watcher',
  'watcher.notice',
  'watcher.notice.salienceBar.extra',
  'watcher.notice.__proto__',
  '__proto__.polluted',
  'constructor.prototype.x',
  '',
  // the operator
  'operator.telegramChatId',
  'operator.borrowFleetTelegram',
  'operator.proactiveDailyCap',
  'operator.notifyOnAsk',
  // bots: everything but agentLoop.every
  'bots',
  'bots.b1',
  'bots.b1.enabled',
  'bots.b1.token',
  'bots.b1.llmBackend',
  'bots.b1.model',
  'bots.b1.disabledTools',
  'bots.b1.agentLoop',
  'bots.b1.agentLoop.plannerBackend',
  'bots.b1.agentLoop.enforceToolPermissions',
  'bots.b1.agentLoop.curiosity.enabled',
  'bots.b1.agentLoop.every.x',
  'bots.*.agentLoop.every',
  'bots.__proto__.agentLoop.every',
  'bots.tb.agentLoop.every',
  'bots.ghost.agentLoop.every',
  // the rest of the instance
  'tools.exec',
  'claudeCli.maxConcurrent',
  'claudeCli.crossBackendFallback',
  'workers.enabled',
  'multiTenant.enabled',
  'paths.data',
  'integrations.httpApis',
  'karma.rewards.toolError',
  'agentLoop.every',
]);

export type PathFamily = 'threshold' | 'fleet-cadence';

/** What the lock needs from the live config. */
export interface LockContext {
  config: {
    bots?: ReadonlyArray<{ id: string; tenantId?: string }>;
    multiTenant?: { enabled?: boolean };
  };
}

export type TunableCheck = { ok: true; family: PathFamily } | { ok: false; note: string };

const TUNABLE_BY_PATH = new Map(TUNABLES.map((t) => [t.path, t]));

function show(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s.length > 60 ? `${s.slice(0, 57)}...` : s;
  } catch {
    return String(value);
  }
}

/** True when `path` is a path a proposal may name (value not checked). */
export function isTunablePath(path: string, ctx: LockContext): boolean {
  if (TUNABLE_BY_PATH.has(path)) return true;
  return botCadenceTarget(path, ctx).ok;
}

function botCadenceTarget(
  path: string,
  ctx: LockContext
): { ok: true; botId: string } | { ok: false; note: string } {
  const m = BOT_CADENCE.pattern.exec(path);
  if (!m) return { ok: false, note: `${path || '(empty path)'} is locked: it is not a tunable` };
  const botId = m[1];
  const bot = (ctx.config.bots ?? []).find((b) => b.id === botId);
  if (!bot) return { ok: false, note: `${path} is locked: no bot "${botId}" in the live config` };
  if (isTenantBot(bot, ctx.config)) {
    return { ok: false, note: `${path} is locked: "${botId}" is a tenant bot` };
  }
  return { ok: true, botId };
}

/**
 * Whether one change may be proposed: the path is in the allowlist and the
 * new value is inside its range. Never throws.
 */
export function checkTunableChange(
  change: { path: unknown; to: unknown },
  ctx: LockContext
): TunableCheck {
  const path = typeof change.path === 'string' ? change.path : '';
  const tunable = TUNABLE_BY_PATH.get(path);
  if (tunable) {
    const v = change.to;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, note: `${path} must be a number, got ${show(v)}` };
    }
    if (tunable.integer && !Number.isInteger(v)) {
      return { ok: false, note: `${path} must be a whole number, got ${v}` };
    }
    if (v < tunable.min || v > tunable.max) {
      return {
        ok: false,
        note: `${path} = ${v} is out of its range [${tunable.min}, ${tunable.max}]`,
      };
    }
    return { ok: true, family: 'threshold' };
  }
  const target = botCadenceTarget(path, ctx);
  if (!target.ok) return target;
  const v = change.to;
  if (typeof v !== 'string') {
    return { ok: false, note: `${path} must be a duration like "6h", got ${show(v)}` };
  }
  let ms: number;
  try {
    ms = parseDurationMs(v);
  } catch {
    return { ok: false, note: `${path} must be a duration like "6h", got ${show(v)}` };
  }
  if (ms < BOT_CADENCE.minMs || ms > BOT_CADENCE.maxMs) {
    return { ok: false, note: `${path} = ${v} is out of its range [1h, 7d]` };
  }
  return { ok: true, family: 'fleet-cadence' };
}
