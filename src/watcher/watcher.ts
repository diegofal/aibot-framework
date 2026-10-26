/**
 * The watcher: one always-on workspace per fleet (phase 1: tier 0 sensing,
 * birth, the log, the graph). Same process as the bots; constructed in
 * `src/index.ts` only when `config.watcher.enabled`. Every change it makes is
 * re-emitted as a `WatcherEvent` (`event`, and under its own type name) for
 * `/ws/watcher`. Nothing throws out of `start()` or `stop()`: a failing stage
 * is a log row and `state().lastError`. Phase 2: tier 1 noticing (`notice.ts`)
 * on a timer that starts only once birth (or the wake resync) is done and only
 * with `notice.enabled`; every LLM call goes through `instrumented` (daily
 * budget + fleet breaker, query log under `__watcher__`). O2: passes wake on
 * salience, not on a cadence (`wakeNotice` on `salience:crossed` and on each
 * check for the age ceiling, `wakeIntegrate` on each integrate check); every
 * pass row carries its `trigger`. O3: `stakes()` (`stakes.ts`) turns
 * interoception into policy for both (wake lines, sleeping tiers, held
 * questions, "## Something is wrong").
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SelfStateInput } from '../bot/agent-loop-prompts';
import type { HumanInboundEvent } from '../bot/agent-loop-utils';
import type { LlmQueryEntry } from '../bot/llm-query-log';
import type { ChannelStatus } from '../bot/telegram-errors';
import type { ToolAuditEntry } from '../bot/tool-audit-log';
import { toolTarget } from '../bot/tool-executor';
import type { WatcherBroadcastSource, WatcherSelfStateSource } from '../bot/types';
import type { UserDirectory } from '../bot/user-directory';
import type { ChannelKind } from '../channel/types';
import type { Config } from '../config';
import { type CliSemaphoreStats, getClaudeCliStats } from '../core/cli-semaphore';
import type { Logger } from '../logger';
import type { OllamaClient } from '../ollama';
import { backupSoulFile } from '../soul';
import { resolveBotPaths, resolveStatsDirs } from '../stats/paths';
import { readAgentCycles } from '../stats/readers/agent-cycles';
import { readToolEntries } from '../stats/readers/tool-audit';
import { isTenantBot } from '../tenant/tenant-scoping';
import type { ProactiveThrottle } from '../tools/send-proactive-message';
import {
  type BirthDeps,
  type LinkResult,
  beginBirth,
  continueBirth,
  linkMissing,
  readBirthRecord,
  relayout,
  runResync,
} from './birth';
import {
  type Broadcast,
  type BroadcastDelivery,
  type BroadcastSignal,
  Broadcaster,
  writeWatcherGoal,
} from './broadcast';
import { DailyBudget, type WatcherTier } from './budget';
import { WorkingBuffer } from './buffer';
import { tierSwitches } from './config-file';
import { type ConsolidateOutcome, runConsolidation } from './consolidate';
import { FAST_LANE_DEFAULTS, FAST_LANE_TOOL_WINDOW_MS, runFastLane } from './fast-lane';
import { Graph, type GraphChange } from './graph';
import { type ImportanceContext, planForgetting } from './importance';
import { type IntegrateOutcome, Integrator } from './integrate';
import {
  INTROSPECTION_LOG_ROWS,
  type IntrospectionOutcome,
  type IntrospectionRow,
  IntrospectionSampler,
  type IntrospectionTrigger,
  readIntrospection,
  runIntrospection,
} from './introspection';
import {
  type InstrumentOptions,
  type InstrumentedClient,
  type WatcherTierClient,
  createWatcherClients,
  instrumented,
} from './llm';
import { WatcherLog } from './log';
import { maintenanceDue, readLastMaintainAt, writeLastMaintainAt } from './maintain-state';
import {
  narrateForgot,
  narrateIntrospection,
  narrateResumeBirth,
  narrateRewake,
  narrateSleep,
} from './narration';
import { type NoticeOutcome, Noticer, readNoticeLastRun, writeNoticeLastRun } from './notice';
import {
  type GroundTruthDeps,
  type GroundTruthTool,
  applyServed,
  duePredictions,
  resolvePredictions,
  watcherLogLines,
} from './outcomes';
import { bufferFile, maintainStateFile, noticeStateFile, watcherDir, watcherLogDir } from './paths';
import { WatcherPresence } from './presence';
import {
  type Attention,
  type Interoception,
  attention,
  fleetFocusTexts,
  interoception,
  lastOperatorMs,
} from './self-model';
import { type SenderInfo, Sense, WATCHER_BOT_ID, inboundSender } from './sense';
import {
  KarmaTrend,
  STAKE_PHASE,
  type StakeRule,
  type Stakes,
  newlyFired,
  stakes,
  stakesFor,
} from './stakes';
import {
  type BirthRecord,
  type LinkStatus,
  type Neuron,
  type NeuronKind,
  type PassTrigger,
  WATCHER_DEFAULTS,
  type WatcherConfig,
  type WatcherEvent,
  type WatcherEventType,
  type WatcherLogRow,
  type WatcherPhase,
  type WatcherState,
} from './types';

const DAY_MS = 86_400_000;

/** What one daily maintenance run did (`maintainNow`, `POST /api/watcher/maintain`). */
export interface MaintainResult {
  /** Neurons forgotten (archived by importance). */
  forgotten: number;
  /**
   * The embed-and-link backfill, when it settled at once; null when it did not
   * run (birth unfinished, asleep) or is still running (`linking`).
   */
  link: LinkResult | null;
  /** The backfill is still running: maintenance never waits on an embed. */
  linking: boolean;
  /** When it completed; also written to `maintain.json`. */
  at: string;
}
/** Throttle of the `watcher:state` a sense batch republishes ("last tick"). */
export const SENSE_STATE_EVERY_MS = 5_000;
/** How often the notice timer asks whether a pass should wake (`wakeNotice`: the age ceiling, the min gap). */
export const NOTICE_CHECK_MS = 30_000;
/** `stakes()` is recomputed at most this often (it reads every bot's karma), unless the operator wrote. */
export const STAKES_EVERY_MS = 30_000;
/** How often the integrate timer asks whether a pass is due (`Integrator.due`). */
export const INTEGRATE_CHECK_MS = 60_000;
/** Outcomes (served broadcasts, due predictions) are checked at most this often. */
export const OUTCOMES_EVERY_MS = 10 * 60_000;
/** How often the introspection sampler asks whether a sample is due. */
export const INTROSPECT_CHECK_MS = 60_000;
/**
 * How long `stop()` waits for birth and in-flight passes after aborting their
 * model calls, before it compacts and persists anyway (shutdown must fit the
 * container's grace period; `WatcherDeps.stopTimeoutMs` overrides it).
 */
export const WATCHER_STOP_TIMEOUT_MS = 5_000;
/** Neuron kinds the operator can 👍/👎 (contradictions: confirm or dismiss). */
export const SIGNAL_KINDS: readonly NeuronKind[] = ['insight', 'contradiction', 'prediction'];
/** O10: the forgetting defaults when the config predates them. */
const FORGET_DEFAULTS = { threshold: 0.15, graceDays: 7, maxPerRun: 200 };
const TARGET_NEURONS_DEFAULT = 8000;
/** A `forget:archive` row names at most this many neurons (the lowest). */
const FORGET_ROW_IDS = 100;
const CONSOLIDATE_DEFAULTS = {
  enabled: false,
  preview: true,
  hour: 4,
  minCluster: 6,
  maxClusters: 10,
  minCoverage: 0.5,
};
/** How often the nightly consolidation checks the hour and the fleet. */
export const CONSOLIDATE_CHECK_MS = 10 * 60_000;

/** `YYYY-MM-DD` in local time (consolidation runs at a local hour, once a local night). */
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `<dir>/consolidate.json`: the local night consolidation last started. */
function readConsolidateNight(dir: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'consolidate.json'), 'utf-8')) as {
      night?: unknown;
    };
    return typeof raw.night === 'string' ? raw.night : undefined;
  } catch {
    return undefined;
  }
}

function writeConsolidateNight(
  dir: string,
  night: string,
  at: string,
  logger: Pick<Logger, 'warn'>
): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'consolidate.json'), JSON.stringify({ night, at }), 'utf-8');
  } catch (err) {
    logger.warn({ err }, 'Watcher: could not write consolidate.json');
  }
}

/** `<dir>/taste.json`: the operator's signals, per neuron kind and per broadcast kind. */
export interface WatcherTaste {
  updatedAt: string;
  neurons: Record<string, { up: number; down: number }>;
  broadcasts: Record<string, { up: number; down: number }>;
}

/** The fleet breaker as the watcher uses it (`BackendCircuitBreaker`). */
export interface WatcherBreaker {
  isOpen(backend: string): boolean;
  recordFailure(backend: string, error: unknown): unknown;
  recordSuccess(backend: string): void;
}

type Listenable = Pick<EventEmitter, 'on' | 'off'>;

export interface WatcherDeps {
  config: () => Config;
  logger: Logger;
  activityStream: Listenable;
  hooks: Listenable;
  /** Phase 1 reads channel states and contacts; later phases widen this. */
  botManager: {
    getChannelState(botId: string): ChannelStatus | undefined;
    getUserDirectory(): Pick<UserDirectory, 'list' | 'findByChannel'>;
  };
  /** One embedding (OllamaClient.embed bound to `soul.search.embeddingModel`); absent → no `related` edges. */
  embed?: (text: string) => Promise<number[]>;
  now?: () => number;
  readCycles?: BirthDeps['readCycles'];
  /** Tier clients (`createWatcherClients`); without `notice` there is no noticing. */
  llm?: Partial<Record<WatcherTier, WatcherTierClient>>;
  /** The shared LLM query log; every watcher call is one entry under `__watcher__`. */
  queryLog?: { append(entry: LlmQueryEntry): void };
  /** The fleet circuit breaker (`BotContext.circuitBreaker`). */
  breaker?: WatcherBreaker;
  /** Phase 3: the entry points broadcasts use (wake, directive, goal, question). */
  broadcastDelivery?: BroadcastDelivery;
  /**
   * Phase 4: overrides the interoceptive record the integrate prompt shows as
   * "## How I am". Without it the watcher composes its own (`interoception()`)
   * from its budget, buffer and integrator plus the readers below.
   */
  interoception?: () => Record<string, unknown>;
  /** Phase 4: current karma of every enabled bot (fleet karma for "How I am"). */
  karmaScores?: () => number[];
  /** Phase 4: the Claude CLI semaphore (`getClaudeCliStats`). */
  semaphore?: () => CliSemaphoreStats;
  /** Phase 4: the running agent-loop cycle of a bot (`AgentLoop.runningCycle`). */
  runningCycle?: (
    botId: string
  ) => { cycleId: string; plan?: string; goalId?: string; goalTitle?: string } | undefined;
  /** Phase 4: randomness of the daily introspection sampler (tests). */
  random?: () => number;
  /** Bound of `stop()`'s wait for in-flight work (default `WATCHER_STOP_TIMEOUT_MS`). */
  stopTimeoutMs?: number;
  /** O1 fast lane: tool names a bot used in `[sinceMs, nowMs]` (the tool audit). */
  toolsUsed?: (botId: string, sinceMs: number, nowMs: number) => string[];
  /** The tool audit of a bot in `[sinceMs, nowMs]`, as the prediction judge reads it (ground truth). */
  toolCalls?: (botId: string, sinceMs: number, nowMs: number) => GroundTruthTool[];
  /**
   * O10: true while no agent-loop cycle runs (`BotManager.getAgentLoopState`);
   * consolidation runs only then. Absent = never quiet (never consolidates).
   */
  fleetQuiet?: () => boolean;
}

export class Watcher extends EventEmitter implements WatcherSelfStateSource {
  readonly graph: Graph;
  readonly log: WatcherLog;
  private readonly workingBuffer = new WorkingBuffer();
  readonly dir: string;
  /** Daily LLM budget, shared by every tier. */
  readonly budget: DailyBudget;
  private readonly sense: Sense;
  private readonly logger: Logger;
  private readonly now: () => number;
  private running = false;
  private stopping = false;
  private phase: WatcherPhase = 'sleep';
  private lastError?: string;
  private background: Promise<unknown> = Promise.resolve();
  /**
   * The `linkMissing` run in flight (start backfill or daily maintenance),
   * keyed to the run that started it: a run cancelled by `stop()` is stale and
   * is never reused by a later start.
   */
  private linkRun: {
    promise: Promise<LinkResult | undefined>;
    isCancelled: () => boolean;
  } | null = null;
  /**
   * The daily maintenance run in flight (`maintainNow`): a second caller shares
   * it. Keyed to the run that started it, like `linkRun`: one that `stop()`
   * cancelled (its backfill embed may never settle) is never shared.
   */
  private maintainRun: {
    promise: Promise<MaintainResult | undefined>;
    isCancelled: () => boolean;
  } | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private noticeTimer: ReturnType<typeof setInterval> | null = null;
  private lastSenseStateAt = 0;
  /** Birth or resync finished in this run: tier timers may run (`applyConfig`). */
  private timersReady = false;
  private senseStateTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeRun: Promise<NoticeOutcome | null> | null = null;
  /** The run signal of `noticeRun` / `integrateRun`: a stopped run's pass is never shared. */
  private noticeRunSignal: AbortSignal | null = null;
  private integrateRunSignal: AbortSignal | null = null;
  private readonly noticer?: Noticer;
  /** Phase 3: broadcasts (always on disk; delivered only through `broadcastDelivery`). */
  readonly broadcaster: Broadcaster;
  private readonly integrator?: Integrator;
  private integrateTimer: ReturnType<typeof setInterval> | null = null;
  private integrateRun: Promise<IntegrateOutcome | null> | null = null;
  private outcomesRun: Promise<void> | null = null;
  private lastOutcomesAt = 0;
  /** Phase 4: what every bot is doing now, from the activity stream (attached while awake). */
  readonly presence = new WatcherPresence();
  private lastOperatorAt: number | null = null;
  /** When this run started (`start`), cleared on stop: the page's "since the watcher woke". */
  private startedAt: string | undefined;
  /** O3: the fleet karma samples behind `fleetKarmaFalling`. */
  private readonly karmaTrend: KarmaTrend;
  /** O3: the stakes rules firing at the last `stakes()` (a rule logs one row when it starts). */
  private firedStakes = new Set<StakeRule>();
  private stakesCache: { at: number; operatorAt: number | null; value: Stakes } | null = null;
  private releaseRun: Promise<void> | null = null;
  private readonly sampler: IntrospectionSampler;
  private introspectTimer: ReturnType<typeof setInterval> | null = null;
  private introspectRun: Promise<IntrospectionOutcome> | null = null;
  /** Aborted by `stop()`: every model call in flight (`instrumented`) is linked to it. */
  private stopCtrl = new AbortController();
  /** O10: the night's consolidation in flight. */
  private consolidateRun: Promise<ConsolidateOutcome | null> | null = null;
  /** O1 fast lane: the UTC day its capped row was written. */
  private readonly fastLaneState: { cappedOn?: string } = {};

  constructor(private readonly deps: WatcherDeps) {
    super();
    this.now = deps.now ?? Date.now;
    this.logger =
      typeof deps.logger.child === 'function'
        ? deps.logger.child({ module: 'watcher' })
        : deps.logger;
    this.dir = watcherDir(deps.config());
    this.graph = new Graph(this.dir, {
      now: this.now,
      maxNeurons: this.cfg().graph.maxNeurons,
      onChange: (c) => this.onGraphChange(c),
      logger: this.logger,
    });
    this.log = new WatcherLog(watcherLogDir(this.dir), {
      now: this.now,
      logger: this.logger,
      onRow: (row) => this.onRow(row),
    });
    this.sense = new Sense({
      graph: this.graph,
      buffer: this.workingBuffer,
      log: this.log,
      config: () => this.cfg(),
      now: this.now,
      botName: (id) => this.botName(id),
      sender: (e) => this.sender(e),
      onItem: (item) => {
        if (item.fromOperator) {
          this.lastOperatorAt = lastOperatorMs([item], this.lastOperatorAt);
          this.karmaTrend.setOperatorAt(this.lastOperatorAt);
          // O3: the operator is here; a question held for them can go out.
          void Promise.resolve().then(() => this.releaseQuestions());
        }
        this.integrator?.observe(item);
      },
      onBatch: () => this.senseStateChanged(),
      // O2 `salience:crossed`: off the publish call, the noticer adds the gap.
      onCrossed: () => void Promise.resolve().then(() => this.wakeNotice()),
      wakeSalience: () =>
        this.cfg().notice.wakeSalience * (this.stakesCache?.value.noticeWakeFactor ?? 1),
      logger: this.logger,
    });
    this.budget = new DailyBudget({
      dir: this.dir,
      now: this.now,
      limits: () => this.cfg(),
      isCircuitOpen: (tier) => {
        const backend = deps.llm?.[tier]?.backend;
        try {
          return !!backend && !!deps.breaker?.isOpen(backend);
        } catch {
          return false;
        }
      },
    });
    const notice = this.tierClient('notice');
    if (notice) {
      this.noticer = new Noticer({
        graph: this.graph,
        buffer: this.workingBuffer,
        log: this.log,
        client: notice,
        budget: this.budget,
        config: () => this.cfg(),
        now: this.now,
        botName: (id) => this.botName(id),
        ...(deps.embed ? { embed: deps.embed } : {}),
        logger: this.logger,
      });
    }
    this.broadcaster = new Broadcaster({
      dir: this.dir,
      now: this.now,
      delivery: deps.broadcastDelivery ?? {},
      log: this.log,
      botName: (id) => this.botName(id),
      isTenantBot: (id) => this.isTenantBot(id),
      logger: this.logger,
    });
    const integrate = this.tierClient('integrate');
    if (integrate) {
      this.integrator = new Integrator({
        dir: this.dir,
        graph: this.graph,
        log: this.log,
        client: integrate,
        budget: this.budget,
        config: () => this.cfg(),
        now: this.now,
        bots: () =>
          (this.deps.config().bots ?? [])
            .filter((b) => b.enabled !== false && !this.isTenantBot(b.id))
            .map((b) => ({ id: b.id, name: this.botName(b.id) })),
        botName: (id) => this.botName(id),
        broadcaster: this.broadcaster,
        ...(deps.embed ? { embed: deps.embed } : {}),
        interoception:
          deps.interoception ?? (() => this.interoception() as unknown as Record<string, unknown>),
        attention: () => this.attention(),
        logger: this.logger,
      });
    }
    this.karmaTrend = new KarmaTrend(join(this.dir, 'stakes.json'));
    this.lastOperatorAt = this.karmaTrend.operatorAt();
    this.sampler = new IntrospectionSampler({
      dir: this.dir,
      now: this.now,
      ...(deps.random ? { random: deps.random } : {}),
    });
  }

  /**
   * A bot of a customer tenant (`isTenantBot` in `src/tenant/tenant-scoping.ts`,
   * the same rule as `fleet_memory_search`; the admin tenant's bots are not):
   * never a broadcast target nor in the integrate prompt's bot list.
   */
  private isTenantBot(botId: string): boolean {
    const config = this.deps.config();
    return isTenantBot(
      config.bots?.find((b) => b.id === botId),
      config
    );
  }

  /** A tier's client wrapped with budget, breaker and query log (phase 3 asks for `integrate`). */
  tierClient(
    tier: WatcherTier,
    caller?: InstrumentOptions['caller']
  ): InstrumentedClient | undefined {
    const client = this.deps.llm?.[tier];
    if (!client) return undefined;
    const opts: InstrumentOptions = {
      tier,
      caller: caller ?? (tier === 'notice' ? 'watcher:notice' : 'watcher:integrate'),
      budget: this.budget,
      now: this.now,
      ...(this.deps.queryLog ? { queryLog: this.deps.queryLog } : {}),
      ...(this.deps.breaker ? { breaker: this.deps.breaker } : {}),
      signal: () => this.stopCtrl.signal,
    };
    return instrumented(client, opts);
  }

  /**
   * The working buffer. Sensing runs off the bots' publish call (`Sense`
   * batches it); every read here senses what is queued first, so a reader
   * always sees everything published so far.
   */
  get buffer(): WorkingBuffer {
    this.sense?.flush();
    return this.workingBuffer;
  }

  /** True while the notice timer runs (after birth, with `notice.enabled`). */
  get noticing(): boolean {
    return this.noticeTimer !== null;
  }

  /** What `fleet_memory_search` reads: the graph while the watcher runs. */
  fleetMemory(): { graph: Graph; embed?: (text: string) => Promise<number[]> } | undefined {
    if (!this.running) return undefined;
    return { graph: this.graph, ...(this.deps.embed ? { embed: this.deps.embed } : {}) };
  }

  /**
   * One notice pass now (`wakeNotice` calls it with what woke it; anything
   * else is `manual`). Null when noticing is off or there is no notice
   * client. Never throws.
   */
  noticeNow(trigger: PassTrigger = 'manual'): Promise<NoticeOutcome | null> {
    const noticer = this.noticer;
    if (!noticer || !this.cfg().notice.enabled || !this.running) return Promise.resolve(null);
    if (this.noticeRun && !this.noticeRunSignal?.aborted) return this.noticeRun;
    this.sense.flush();
    const drivenBy = stakesFor('notice', this.stakes());
    this.setPhase('notice');
    // Same per-run cancellation as birth: a pass a stop left behind (waiting
    // on an embedding that cannot be aborted) writes nothing more, never feeds
    // the next run's integrator and never moves the next run's phase.
    const signal = this.stopCtrl.signal;
    const isCancelled = () => signal.aborted;
    const run: Promise<NoticeOutcome | null> = noticer
      .run({ isCancelled, trigger, ...(drivenBy.length ? { drivenBy } : {}) })
      .then(async (outcome) => {
        if (!isCancelled()) {
          this.integrator?.observeNotice(outcome);
          await this.fastLane(outcome, isCancelled);
        }
        return outcome;
      })
      .catch((err): NoticeOutcome | null => {
        if (!isCancelled()) this.fail(err);
        return null;
      })
      .finally(() => {
        this.persistNoticeLastRun();
        if (this.noticeRun === run) {
          this.noticeRun = null;
          this.noticeRunSignal = null;
        }
        if (this.running && !this.stopping && !isCancelled()) this.setPhase('sense');
      });
    this.noticeRun = run;
    this.noticeRunSignal = signal;
    return run;
  }

  /** Keep when the last notice pass ran (a restart keeps the age ceiling). */
  private persistNoticeLastRun(): void {
    if (this.noticer && this.noticer.lastRunAt > 0) {
      writeNoticeLastRun(noticeStateFile(this.dir), this.noticer.lastRunAt);
    }
  }

  /**
   * O1: what a notice pass created or recognised that two bots support goes to the related
   * third bots at once, as directives (`fast-lane.ts`). Never throws.
   */
  private async fastLane(outcome: NoticeOutcome, isCancelled: () => boolean): Promise<void> {
    if (outcome.status !== 'noticed') return;
    // Created and recognised: a pattern a later pass recognised from another
    // bot qualifies then (the broadcaster's per-bot dedupe prevents resends).
    const neurons = [...outcome.created, ...outcome.recognised];
    if (neurons.length === 0) return;
    const toolsUsed = this.deps.toolsUsed;
    await runFastLane(
      {
        graph: this.graph,
        broadcaster: this.broadcaster,
        log: this.log,
        config: () => this.cfg().fastLane ?? FAST_LANE_DEFAULTS,
        bots: () =>
          (this.deps.config().bots ?? [])
            .filter((b) => b.enabled !== false && !this.isTenantBot(b.id))
            .map((b) => b.id),
        ...(toolsUsed
          ? {
              toolsUsed: (botId: string) => {
                const nowMs = this.now();
                return toolsUsed(botId, nowMs - FAST_LANE_TOOL_WINDOW_MS, nowMs);
              },
            }
          : {}),
        botName: (id) => this.botName(id),
        now: this.now,
        isCancelled,
        state: this.fastLaneState,
        logger: this.logger,
      },
      neurons
    );
  }

  /** True while the integrate timer runs (after birth, with `integrate.enabled`). */
  get integrating(): boolean {
    return this.integrateTimer !== null;
  }

  /**
   * One integrate pass now (`wakeIntegrate` calls it with what woke it;
   * anything else is `manual`), shaped by the stakes (held questions, "## Something
   * is wrong", `drivenBy`). Null when integration is off or there is no
   * integrate client. One in flight; phase `integrate`, back to `sense`.
   * Never throws.
   */
  integrateNow(trigger: PassTrigger = 'manual'): Promise<IntegrateOutcome | null> {
    const integrator = this.integrator;
    if (!integrator || !this.cfg().integrate.enabled || !this.running) {
      return Promise.resolve(null);
    }
    if (this.integrateRun && !this.integrateRunSignal?.aborted) return this.integrateRun;
    this.sense.flush();
    const st = this.stakes();
    const drivenBy = stakesFor('integrate', st);
    this.setPhase('integrate');
    // Per-run cancellation, as in `noticeNow`: no write nor broadcast after a stop.
    const signal = this.stopCtrl.signal;
    const isCancelled = () => signal.aborted;
    const run: Promise<IntegrateOutcome | null> = integrator
      .run({
        isCancelled,
        trigger,
        ...(drivenBy.length ? { drivenBy } : {}),
        ...(st.deferQuestions ? { deferQuestions: true } : {}),
        ...(st.somethingWrong ? { somethingWrong: st.somethingWrong } : {}),
      })
      .catch((err): IntegrateOutcome | null => {
        if (!isCancelled()) this.fail(err);
        return null;
      })
      .finally(() => {
        if (this.integrateRun === run) {
          this.integrateRun = null;
          this.integrateRunSignal = null;
        }
        if (this.running && !this.stopping && !isCancelled()) this.setPhase('sense');
      });
    this.integrateRun = run;
    this.integrateRunSignal = signal;
    return run;
  }

  /**
   * Served broadcasts (from the bots' cycle rows) and due predictions (a tier
   * 1 call each, on the notice budget). Only with integration enabled. One in
   * flight; never throws.
   */
  outcomesNow(): Promise<void> {
    if (!this.cfg().integrate.enabled || !this.running) return Promise.resolve();
    if (this.outcomesRun) return this.outcomesRun;
    this.lastOutcomesAt = this.now();
    this.outcomesRun = this.outcomes()
      .catch((err) => this.fail(err))
      .finally(() => {
        this.outcomesRun = null;
      });
    return this.outcomesRun;
  }

  /**
   * Phase 4: what the watcher feels now (fleet karma, breaker, semaphore,
   * today's budget, operator silence, buffer salience, last integration).
   * Every reader may fail; never throws.
   */
  interoception(): Interoception {
    this.sense.flush();
    const backends = [
      ...new Set(
        (['notice', 'integrate'] as const)
          .map((t) => this.deps.llm?.[t]?.backend)
          .filter((b): b is NonNullable<typeof b> => !!b)
      ),
    ];
    const breaker = this.deps.breaker;
    const lastRunAt = this.integrator?.state().lastRunAt;
    return interoception({
      nowMs: this.now(),
      ...(this.deps.karmaScores ? { karmaScores: this.deps.karmaScores } : {}),
      backends,
      ...(breaker ? { isCircuitOpen: (b: string) => breaker.isOpen(b) } : {}),
      ...(this.deps.semaphore ? { semaphore: this.deps.semaphore } : {}),
      budget: { notice: this.budget.used('notice'), integrate: this.budget.used('integrate') },
      lastOperatorAt: this.lastOperatorAt,
      bufferItems: this.buffer.items(),
      ...(lastRunAt ? { lastIntegrateAt: lastRunAt } : {}),
    });
  }

  /**
   * O3: the stakes now (`stakes.ts`) from interoception, today's budget and
   * the karma trend; recomputed at most every `STAKES_EVERY_MS` unless the
   * operator wrote since. A rule that starts firing logs one `stakes:<rule>`
   * row (`drivenBy: [rule]`). Never throws.
   */
  stakes(): Stakes {
    const nowMs = this.now();
    const c = this.stakesCache;
    if (c && nowMs - c.at < STAKES_EVERY_MS && c.operatorAt === this.lastOperatorAt) return c.value;
    let value: Stakes;
    try {
      const intero = this.interoception();
      this.karmaTrend.record(nowMs, intero.fleetKarmaAvg);
      const cfg = this.cfg();
      value = stakes({
        interoception: intero,
        budget: { notice: this.budget.used('notice'), integrate: this.budget.used('integrate') },
        limits: cfg,
        backends: {
          ...(this.deps.llm?.notice ? { notice: this.deps.llm.notice.backend } : {}),
          ...(this.deps.llm?.integrate ? { integrate: this.deps.llm.integrate.backend } : {}),
        },
        karmaPeak: this.karmaTrend.peak(nowMs),
      });
    } catch (err) {
      this.logger.warn({ err }, 'Watcher: could not compute the stakes');
      value = stakes({
        interoception: { breakerOpen: [], operatorSilenceHours: null, fleetKarmaAvg: null },
        budget: {
          notice: { calls: 0, tokens: 0, costUsd: 0 },
          integrate: { calls: 0, tokens: 0, costUsd: 0 },
        },
        limits: this.cfg(),
        backends: {},
      });
    }
    for (const rule of newlyFired(this.firedStakes, value)) {
      // `operatorPresent` has an effect only with held questions: its row is
      // the release row (`integrate:question-released`), not one per message.
      if (rule === 'operatorPresent') continue;
      this.log.say(STAKE_PHASE[rule], `stakes:${rule}`, value.notes[rule] ?? rule, {
        drivenBy: [rule],
      });
    }
    this.firedStakes = new Set(value.fired);
    this.stakesCache = { at: nowMs, operatorAt: this.lastOperatorAt, value };
    return value;
  }

  /**
   * O2: run a notice pass if one should wake now (`Noticer.wake` with the
   * stakes' wake line; asleep while its breaker is open). Called on
   * `salience:crossed` and on every notice check. Returns the trigger, or null.
   */
  wakeNotice(): PassTrigger | null {
    if (!this.noticeTimer || !this.running || this.stopping) return null;
    const noticer = this.noticer;
    if (!noticer || !this.cfg().notice.enabled || this.noticeRun) return null;
    const st = this.stakes();
    if (st.asleep.notice) return null;
    const trigger = noticer.wake({
      wakeSalience: this.cfg().notice.wakeSalience * st.noticeWakeFactor,
    });
    if (trigger) void this.noticeNow(trigger);
    return trigger;
  }

  /**
   * O2: run an integrate pass if one should wake now (`Integrator.wake` with
   * the stakes' wake line; asleep while its breaker is open), and send held
   * questions when the operator is here. Called on every integrate check.
   */
  wakeIntegrate(): PassTrigger | null {
    if (!this.integrateTimer || !this.running || this.stopping) return null;
    const integrator = this.integrator;
    if (!integrator || !this.cfg().integrate.enabled) return null;
    const st = this.stakes();
    if (st.releaseQuestions) void this.releaseQuestions();
    if (st.asleep.integrate || this.integrateRun) return null;
    const trigger = integrator.wake({
      wakeSalience: this.cfg().integrate.wakeSalience * st.integrateWakeFactor,
    });
    if (trigger) void this.integrateNow(trigger);
    return trigger;
  }

  /**
   * O3: send the questions integrate held while the operator was silent, if
   * the operator is here now (`operatorPresent`). One in flight; never throws.
   */
  releaseQuestions(): Promise<void> {
    const integrator = this.integrator;
    if (!integrator || !this.running || this.stopping) return Promise.resolve();
    if (this.releaseRun) return this.releaseRun;
    if (integrator.deferredQuestions().length === 0) return Promise.resolve();
    if (!this.stakes().releaseQuestions) return Promise.resolve();
    const signal = this.stopCtrl.signal;
    this.releaseRun = integrator
      .releaseQuestions({ isCancelled: () => signal.aborted })
      .then(() => undefined)
      .catch((err) => this.fail(err))
      .finally(() => {
        this.releaseRun = null;
      });
    return this.releaseRun;
  }

  /** Phase 4: the phase, the top buffer (and pending) items, and the last pass's focus. */
  attention(): Attention {
    const st = this.integrator?.state();
    return attention({
      phase: this.phase,
      items: [...this.buffer.items(), ...(st?.pending.items ?? [])],
      graph: this.graph,
      attending: st?.attending ?? [],
      ...(st?.attendingAt ? { attendingAt: st.attendingAt } : {}),
      botName: (id) => this.botName(id),
    });
  }

  /**
   * Phase 4: "## Your current state" for a bot (its presence as the watcher
   * sees it, its running cycle, the fleet's focus). Undefined while asleep.
   */
  selfStateFor(botId: string): SelfStateInput | undefined {
    if (!this.running) return undefined;
    let cycle: SelfStateInput['cycle'];
    try {
      cycle = this.deps.runningCycle?.(botId);
    } catch {
      cycle = undefined;
    }
    let fleetFocus: string[] = [];
    try {
      fleetFocus = fleetFocusTexts(this.attention());
    } catch {
      fleetFocus = [];
    }
    return { presence: this.presence.get(botId), ...(cycle ? { cycle } : {}), fleetFocus };
  }

  /**
   * Phase 4: ask the watcher's own model what it is doing and score it
   * (`introspection.ts`), on the notice tier (budget, breaker, query log as
   * `watcher:introspect`). One in flight; never throws.
   */
  introspect(
    trigger: IntrospectionTrigger = 'manual'
  ): Promise<IntrospectionOutcome | { status: 'unavailable'; reason: string }> {
    if (!this.running) {
      return Promise.resolve({ status: 'unavailable', reason: 'The watcher is asleep' });
    }
    const client = this.tierClient('notice', 'watcher:introspect');
    if (!client) {
      return Promise.resolve({ status: 'unavailable', reason: 'The watcher has no notice model' });
    }
    if (this.introspectRun) return this.introspectRun;
    this.introspectRun = runIntrospection({
      client,
      attention: () => this.attention(),
      running: this.running,
      logRows: () => this.log.recent(INTROSPECTION_LOG_ROWS).reverse(),
      drivenBy: () => this.integrator?.drivenBy() ?? [],
      dir: this.dir,
      now: this.now,
      trigger,
      logger: this.logger,
    })
      .then((out) => {
        if (out.status === 'scored') {
          this.log.say(
            this.phase,
            'introspect',
            narrateIntrospection({ trigger, score: out.record.score, parsed: out.record.parsed }),
            {
              model: out.record.model,
              tokens: out.record.tokens,
              ...(out.record.costUsd !== undefined ? { costUsd: out.record.costUsd } : {}),
              durationMs: out.record.durationMs,
              source: 'watcher:introspect',
            }
          );
        }
        return out;
      })
      .finally(() => {
        this.introspectRun = null;
      });
    return this.introspectRun;
  }

  /** Phase 4: `introspection.jsonl` (every subject), newest first. */
  introspection(limit?: number): IntrospectionRow[] {
    return readIntrospection(this.dir, limit);
  }

  /** What the last integrate pass said it attends to (neuron ids; phase 4 reads it). */
  attending(): string[] {
    return this.integrator?.attending() ?? [];
  }

  /** 👍/👎 on an insight, contradiction or prediction; undefined for other kinds or unknown ids. */
  signalNeuron(id: string, signal: BroadcastSignal): Neuron | undefined {
    const n = this.graph.get(id);
    if (!n || !SIGNAL_KINDS.includes(n.kind)) return undefined;
    const next = this.graph.patchMeta(id, {
      signal,
      signalAt: new Date(this.now()).toISOString(),
    });
    this.writeTaste();
    return next;
  }

  signalBroadcast(id: string, signal: BroadcastSignal): Broadcast | undefined {
    const b = this.broadcaster.signal(id, signal);
    if (b) this.writeTaste();
    return b;
  }

  /** The operator's signals counted from the records (also written to `taste.json`). */
  taste(): WatcherTaste {
    const count = (into: WatcherTaste['neurons'], key: string, s: string | undefined) => {
      if (s !== 'up' && s !== 'down') return;
      into[key] ??= { up: 0, down: 0 };
      into[key][s] += 1;
    };
    const taste: WatcherTaste = {
      updatedAt: new Date(this.now()).toISOString(),
      neurons: {},
      broadcasts: {},
    };
    for (const n of this.graph.list()) {
      if (SIGNAL_KINDS.includes(n.kind)) count(taste.neurons, n.kind, n.meta?.signal);
    }
    for (const b of this.broadcaster.list()) count(taste.broadcasts, b.kind, b.signal);
    return taste;
  }

  /**
   * Writes the wake row and returns; birth or resync continue in the background.
   * A start that throws leaves the watcher asleep (`running: false`, the error
   * in `lastError`), so a later start can try again.
   */
  async start(): Promise<WatcherState> {
    if (this.running) return this.state();
    // A birth or resync that a stop (or a failed start) abandoned is already
    // cancelled through its own run signal and drops every write once its
    // in-flight embedding settles. Give it the stop bound to wind down, never
    // longer: an embedding that never answers must not hang the next start.
    await this.waitBounded(this.background);
    if (this.running) return this.state();
    this.running = true;
    this.startedAt = new Date(this.now()).toISOString();
    this.stopping = false;
    this.lastError = undefined;
    // A fresh signal per run: the abandoned run keeps its aborted one forever.
    if (this.stopCtrl.signal.aborted) this.stopCtrl = new AbortController();
    try {
      this.graph.load();
      this.buffer.restore(bufferFile(this.dir));
      // The age ceiling counts from the last pass: the one before the restart,
      // or (none recorded) from the items themselves.
      if (this.noticer) this.noticer.lastRunAt = readNoticeLastRun(noticeStateFile(this.dir)) ?? 0;
      this.lastOperatorAt = lastOperatorMs(
        [...this.buffer.items(), ...(this.integrator?.state().pending.items ?? [])],
        this.lastOperatorAt ?? this.karmaTrend.operatorAt()
      );
      this.karmaTrend.setOperatorAt(this.lastOperatorAt);
      this.presence.attach(this.deps.activityStream as never);
      const record = readBirthRecord(this.dir);
      const deps = this.birthDeps();
      if (!record || !record.done.includes('wake')) {
        this.setPhase('birth');
        const fresh = beginBirth(deps);
        this.background = this.runBackground(deps, () =>
          continueBirth(deps, fresh).then(() => undefined)
        );
      } else if (!record.finishedAt) {
        this.setPhase('birth');
        this.log.say('birth', 'wake', narrateResumeBirth(record.stage));
        this.background = this.runBackground(deps, () =>
          continueBirth(deps, record).then(() => undefined)
        );
      } else {
        const last = this.log.lastRow();
        this.log.say(
          'sleep',
          'wake',
          narrateRewake({
            neurons: this.graph.liveCount(),
            ...(last ? { lastAwakeMs: Date.parse(last.ts) } : {}),
            nowMs: this.now(),
          })
        );
        this.setPhase('birth');
        // Resync, then `sense` and the tier timers, and only then the backfill:
        // a graph born `no-embeddings` (or neurons sensed since) gets its
        // vectors now that an embedder may work, but an embedder that is down
        // never holds the phase nor the timers.
        const resync = this.runBackground(deps, () => runResync(deps).then(() => undefined));
        const backfilled = resync.then(() => this.backfill(deps));
        // The daily timer counts from this start: a maintenance a day overdue
        // (or never recorded) runs once now, after the backfill kick-off.
        const overdue = maintenanceDue(readLastMaintainAt(maintainStateFile(this.dir)), this.now());
        this.background = overdue
          ? Promise.all([backfilled, resync.then(() => this.maintainAtStart(deps))])
          : backfilled;
      }
      this.sense.attach(this.deps.activityStream, this.deps.hooks);
      this.startTimers();
    } catch (err) {
      this.fail(err);
      this.abandonStart();
    }
    return this.state();
  }

  /** Undo a start that threw: nothing attached, no timers, background birth cancelled. */
  private abandonStart(): void {
    this.stopping = true;
    this.stopCtrl.abort();
    try {
      this.sense.detach();
      this.presence.detach();
    } catch {
      // detaching what never attached
    }
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.clearSenseStateTimer();
    this.timersReady = false;
    this.stopNoticeTimer();
    this.stopIntegrateTimer();
    this.stopIntrospectTimer();
    this.running = false;
    this.setPhase('sleep');
  }

  async stop(): Promise<WatcherState> {
    if (!this.running) return this.state();
    this.stopping = true;
    // Abort every model call in flight: shutdown never waits on the CLI timeout.
    this.stopCtrl.abort();
    try {
      this.sense.detach();
      this.sense.flush();
      this.presence.detach();
      for (const t of this.timers) clearInterval(t);
      this.timers = [];
      this.clearSenseStateTimer();
      this.timersReady = false;
      this.stopNoticeTimer();
      this.stopIntegrateTimer();
      this.stopIntrospectTimer();
      await this.settleInFlight();
      this.integrator?.persist();
      this.sense.tick();
      this.graph.compact();
      this.buffer.persist(bufferFile(this.dir));
      this.persistNoticeLastRun();
      this.log.say('sleep', 'sleep', narrateSleep({ neurons: this.graph.liveCount() }));
    } catch (err) {
      this.fail(err);
    }
    this.running = false;
    this.stopping = false;
    this.setPhase('sleep');
    return this.state();
  }

  /**
   * Wait for birth, the passes and a release of held questions in flight, at
   * most `stopTimeoutMs`: their model calls are already aborted; what cannot
   * be (an embedding) is left behind so stop can compact and persist.
   */
  private async settleInFlight(): Promise<void> {
    const work = [
      this.background,
      this.noticeRun,
      this.integrateRun,
      this.outcomesRun,
      this.introspectRun,
      this.releaseRun,
      this.consolidateRun,
    ].filter((p): p is Promise<never> => !!p);
    if (!(await this.waitBounded(Promise.allSettled(work)))) {
      this.logger.warn(
        { boundMs: this.deps.stopTimeoutMs ?? WATCHER_STOP_TIMEOUT_MS },
        'Watcher: in-flight work did not stop in time'
      );
    }
  }

  /** Wait for `work` at most `stopTimeoutMs`; true when it settled in time. Never throws. */
  private async waitBounded(work: Promise<unknown>): Promise<boolean> {
    const bound = this.deps.stopTimeoutMs ?? WATCHER_STOP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), bound);
    });
    try {
      const outcome = await Promise.race([
        work.then(
          () => 'done' as const,
          () => 'done' as const
        ),
        timeout,
      ]);
      return outcome === 'done';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Resolves when birth or resync (and the start backfill after it) is done. */
  idle(): Promise<void> {
    return this.background.then(() => undefined);
  }

  readBirth(): BirthRecord | null {
    return readBirthRecord(this.dir);
  }

  state(): WatcherState {
    this.sense?.flush();
    const record = readBirthRecord(this.dir);
    return {
      running: this.running,
      ...(record?.finishedAt ? { bornAt: record.finishedAt } : {}),
      phase: this.phase,
      ...(this.sense.lastTickAt ? { lastTickAt: this.sense.lastTickAt } : {}),
      ...(this.running && this.startedAt ? { startedAt: this.startedAt } : {}),
      counts: this.graph.counts(),
      archived: this.graph.size() - this.graph.liveCount(),
      edges: this.graph.edgeCount(),
      linkStatus: this.linkStatus(record),
      timers: { notice: !!this.noticeTimer, integrate: !!this.integrateTimer },
      tiers: tierSwitches(this.cfg()),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.integrator ? { attending: this.integrator.attending() } : {}),
      ...(this.integrator?.state().attendingAt
        ? { attendingAt: this.integrator.state().attendingAt }
        : {}),
    };
  }

  // ── internals ──

  private cfg(): WatcherConfig {
    return (this.deps.config().watcher as WatcherConfig | undefined) ?? WATCHER_DEFAULTS;
  }

  private birthDeps(): BirthDeps {
    const signal = this.stopCtrl.signal;
    let directory: BirthDeps['userDirectory'];
    try {
      directory = this.deps.botManager.getUserDirectory();
    } catch {
      directory = undefined;
    }
    return {
      config: this.deps.config(),
      graph: this.graph,
      log: this.log,
      dir: this.dir,
      now: this.now,
      logger: this.logger,
      channelState: (id) => this.deps.botManager.getChannelState(id),
      ...(directory ? { userDirectory: directory } : {}),
      ...(this.deps.embed ? { embed: this.deps.embed } : {}),
      ...(this.deps.readCycles ? { readCycles: this.deps.readCycles } : {}),
      // Bound to this run's signal, not to `stopping`: stop clears `stopping`
      // when it returns, which would un-cancel a birth it left behind.
      isCancelled: () => signal.aborted,
    };
  }

  private runBackground(deps: BirthDeps, work: () => Promise<void>): Promise<void> {
    return work()
      .catch((err) => {
        if (!deps.isCancelled?.()) this.fail(err);
      })
      .finally(() => {
        // A run that was cancelled never moves the phase nor starts timers:
        // the watcher is asleep, or a newer run owns them.
        if (this.running && !this.stopping && !deps.isCancelled?.()) {
          this.timersReady = true;
          this.setPhase('sense');
          this.startNoticeTimer();
          this.startIntegrateTimer();
          this.startIntrospectTimer();
        }
      });
  }

  /**
   * Embed and link the live neurons without a vector (`linkMissing`), at most
   * one run at a time. Never throws; a cancelled run does nothing.
   * Resolves to the result, or undefined when nothing ran.
   */
  private async backfill(deps: BirthDeps): Promise<LinkResult | undefined> {
    const current = this.linkRun;
    if (current && !current.isCancelled()) return current.promise;
    // A run a previous stop() left behind is cancelled: it drops its probe
    // answer and stops (`linkMissing` honours `isCancelled`), so this run
    // starts its own at once.
    if (!this.running || this.stopping || deps.isCancelled?.()) return undefined;
    const isCancelled = () => deps.isCancelled?.() ?? false;
    const statusBefore = this.linkStatus(readBirthRecord(this.dir));
    const entry = {
      isCancelled,
      promise: linkMissing(deps)
        .then((res) => {
          // An idle watcher publishes nothing else: an open dashboard would
          // keep the old embedding status until the next event.
          if (
            !isCancelled() &&
            this.running &&
            !this.stopping &&
            this.linkStatus(readBirthRecord(this.dir)) !== statusBefore
          ) {
            this.publish('watcher:state', this.state());
          }
          return res;
        })
        .catch((err) => {
          if (!isCancelled()) this.logger.warn({ err }, 'Watcher: linking the unembedded failed');
          return undefined;
        })
        .finally(() => {
          if (this.linkRun === entry) this.linkRun = null;
        }),
    };
    this.linkRun = entry;
    return entry.promise;
  }

  /**
   * Re-read `notice.enabled` / `integrate.enabled` (the live config changed,
   * `POST /api/watcher/config`): start or stop the tier timers without a
   * restart. Before birth/resync is done nothing starts (it starts them when
   * it ends). Publishes the state, which carries the new `tiers`, so every
   * open dashboard tab redraws its tier controls. Never throws.
   */
  applyConfig(): void {
    try {
      if (this.running && !this.stopping && this.timersReady) {
        const cfg = this.cfg();
        if (cfg.notice.enabled) {
          this.startNoticeTimer();
          this.startIntrospectTimer();
        } else {
          this.stopNoticeTimer();
          this.stopIntrospectTimer();
        }
        if (cfg.integrate.enabled) this.startIntegrateTimer();
        else this.stopIntegrateTimer();
      }
      this.publish('watcher:state', this.state());
    } catch (err) {
      this.logger.warn({ err }, 'Watcher: could not apply the config change');
    }
  }

  /** Begins only after birth or resync; checks `notice.enabled` on every tick too. */
  private startNoticeTimer(): void {
    if (this.noticeTimer || !this.noticer || !this.cfg().notice.enabled) return;
    const timer = setInterval(() => {
      if (!this.running || this.stopping) return;
      // O2: the age ceiling and a crossing the min gap held back; sensing
      // wakes notice itself (`salience:crossed`).
      this.wakeNotice();
    }, NOTICE_CHECK_MS);
    (timer as { unref?: () => void }).unref?.();
    this.noticeTimer = timer;
  }

  private stopNoticeTimer(): void {
    if (this.noticeTimer) clearInterval(this.noticeTimer);
    this.noticeTimer = null;
  }

  /** Begins only after birth or resync, with an integrate client and `integrate.enabled`. */
  private startIntegrateTimer(): void {
    if (this.integrateTimer || !this.integrator || !this.cfg().integrate.enabled) return;
    const timer = setInterval(() => {
      if (!this.running || this.stopping || !this.cfg().integrate.enabled) return;
      if (this.now() - this.lastOutcomesAt >= OUTCOMES_EVERY_MS) void this.outcomesNow();
      this.wakeIntegrate();
    }, INTEGRATE_CHECK_MS);
    (timer as { unref?: () => void }).unref?.();
    this.integrateTimer = timer;
  }

  private stopIntegrateTimer(): void {
    if (this.integrateTimer) clearInterval(this.integrateTimer);
    this.integrateTimer = null;
  }

  /** Three self-questions a day at random times, on the notice tier and only with `notice.enabled`. */
  private startIntrospectTimer(): void {
    if (this.introspectTimer || !this.deps.llm?.notice || !this.cfg().notice.enabled) return;
    const timer = setInterval(() => this.sampleTick(), INTROSPECT_CHECK_MS);
    (timer as { unref?: () => void }).unref?.();
    this.introspectTimer = timer;
  }

  /** One check of the daily sampler (the timer calls it); a due sample is taken once. */
  sampleTick(): boolean {
    if (!this.running || this.stopping || !this.cfg().notice.enabled) return false;
    if (this.introspectRun || !this.sampler.due()) return false;
    this.sampler.markDone();
    void this.introspect('sample');
    return true;
  }

  private stopIntrospectTimer(): void {
    if (this.introspectTimer) clearInterval(this.introspectTimer);
    this.introspectTimer = null;
  }

  private async outcomes(): Promise<void> {
    const read = this.deps.readCycles;
    if (read) {
      const nowMs = this.now();
      const since = nowMs - 2 * DAY_MS;
      const bots = new Set(
        this.broadcaster
          .list()
          .filter((b) => !b.servedByCycle && Date.parse(b.createdAt) >= since)
          .map((b) => b.botId)
      );
      const rows = [...bots].flatMap((botId) => {
        try {
          return read(botId, since, nowMs);
        } catch {
          return [];
        }
      });
      if (rows.length) applyServed(this.broadcaster, rows);
    }
    const notice = this.tierClient('notice');
    if (!notice || duePredictions(this.graph, this.now()).length === 0) return;
    await resolvePredictions({
      graph: this.graph,
      client: notice,
      log: this.log,
      now: this.now,
      events: (from, to) => watcherLogLines(this.log, from, to),
      groundTruth: this.groundTruth(),
      logger: this.logger,
    });
  }

  /** What the prediction judge reads as ground truth: every configured bot's tool audit and cycle log. */
  groundTruth(): GroundTruthDeps {
    const readCycles = this.deps.readCycles;
    const toolCalls = this.deps.toolCalls;
    return {
      bots: () =>
        (this.deps.config().bots ?? []).map((b) => ({
          id: b.id,
          name: this.botName(b.id),
          ...(b.name ? { aliases: [b.name] } : {}),
        })),
      ...(toolCalls ? { tools: toolCalls } : {}),
      ...(readCycles ? { cycles: (botId, from, to) => readCycles(botId, from, to) } : {}),
    };
  }

  private writeTaste(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, 'taste.json'), JSON.stringify(this.taste(), null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn({ err }, 'Watcher: could not write taste.json');
    }
  }

  private startTimers(): void {
    const every = this.cfg().log.senseSummaryEveryMs;
    const summary = setInterval(() => this.sense.tick(), every);
    const daily = setInterval(() => void this.maintainNow(), DAY_MS);
    const nightly = setInterval(() => this.consolidateTick(), CONSOLIDATE_CHECK_MS);
    for (const t of [summary, daily, nightly]) (t as { unref?: () => void }).unref?.();
    this.timers = [summary, daily, nightly];
  }

  /**
   * O10: one check of the nightly consolidation (the timer calls it). Starts
   * a run when consolidation and noticing are on, it is `consolidate.hour`
   * local, tonight has not run yet (`consolidate.json`) and the fleet is quiet.
   * True when it started one.
   */
  consolidateTick(): boolean {
    if (!this.running || this.stopping || this.consolidateRun) return false;
    const cfg = this.cfg();
    const c = cfg.consolidate ?? CONSOLIDATE_DEFAULTS;
    if (!c.enabled || !cfg.notice.enabled || !this.deps.llm?.notice) return false;
    const at = new Date(this.now());
    if (at.getHours() !== c.hour) return false;
    const night = localDate(at);
    if (readConsolidateNight(this.dir) === night) return false;
    if (!this.isFleetQuiet()) return false;
    writeConsolidateNight(this.dir, night, at.toISOString(), this.logger);
    void this.consolidateNow();
    return true;
  }

  /** Resolves when the consolidation in flight (if any) has finished. */
  consolidationIdle(): Promise<unknown> {
    return this.consolidateRun ?? Promise.resolve();
  }

  private isFleetQuiet(): boolean {
    try {
      return this.deps.fleetQuiet?.() === true;
    } catch {
      return false;
    }
  }

  /**
   * O10: consolidate now (`consolidate.ts`), on the notice tier (its budget,
   * breaker and query log, caller `watcher:consolidate`), in preview unless
   * `consolidate.preview` is false. Null when consolidation is off (the
   * default), the watcher sleeps, noticing is off or there is no notice client; a busy
   * fleet stops it before any call. Never throws.
   */
  consolidateNow(): Promise<ConsolidateOutcome | null> {
    if (this.consolidateRun) return this.consolidateRun;
    const cfg = this.cfg();
    const client = this.tierClient('notice', 'watcher:consolidate');
    const c = cfg.consolidate ?? CONSOLIDATE_DEFAULTS;
    if (!c.enabled || !client || !cfg.notice.enabled || !this.running || this.stopping) {
      return Promise.resolve(null);
    }
    const signal = this.stopCtrl.signal;
    const run = runConsolidation({
      graph: this.graph,
      log: this.log,
      client,
      importance: () => this.importanceContext(),
      threshold: (cfg.forget ?? FORGET_DEFAULTS).threshold,
      minCluster: c.minCluster,
      maxClusters: c.maxClusters,
      minCoverage: c.minCoverage ?? CONSOLIDATE_DEFAULTS.minCoverage,
      bots: () =>
        (this.deps.config().bots ?? []).map((b) => ({ id: b.id, name: this.botName(b.id) })),
      botName: (id) => this.botName(id),
      isQuiet: () => this.isFleetQuiet(),
      // An older config without the flag previews: merging is opted into.
      preview: c.preview ?? true,
      isCancelled: () => signal.aborted,
      logger: this.logger,
    })
      .catch((err) => {
        this.logger.warn({ err }, 'Watcher: consolidation failed');
        return null;
      })
      .finally(() => {
        if (this.consolidateRun === run) this.consolidateRun = null;
      });
    this.consolidateRun = run;
    return run;
  }

  /**
   * Daily: forget by importance (`forgetNow`, O10; it replaced the
   * `archiveAfterDays` age rule), kick the embed-and-link backfill
   * (`linkMissing`, deduped through `linkRun`), recompute the layout, record
   * `lastMaintainAt`. Never throws; the backfill is skipped while birth is
   * still running (its own link stage does it). Never awaits the backfill: an
   * embed that never answers would keep this run in flight, every later daily
   * run would share it and forgetting would never run again. The backfill is
   * reported only when it settled at once (`link`), else `linking: true`; one
   * that embeds later relays out itself. A run that `stop()` cancelled before
   * it got there neither relays out nor persists positions.
   */
  maintainNow(): Promise<MaintainResult | undefined> {
    const current = this.maintainRun;
    if (current && !current.isCancelled()) return current.promise;
    // Cancelled by the stop of the run that started it: a run started while
    // asleep has no stop to cancel it (and no backfill to hang on).
    const signal = this.stopCtrl.signal;
    const live = this.running && !this.stopping;
    const entry = {
      isCancelled: () => live && signal.aborted,
      promise: this.runMaintenance().finally(() => {
        if (this.maintainRun === entry) this.maintainRun = null;
      }),
    };
    this.maintainRun = entry;
    return entry.promise;
  }

  /**
   * A maintenance run is in flight (`POST /api/watcher/maintain` answers 409).
   * One a stop() cancelled is not: its leftover embed must not block the next.
   */
  maintenanceInFlight(): boolean {
    return !!this.maintainRun && !this.maintainRun.isCancelled();
  }

  /** The start's overdue maintenance: skipped when the run it belongs to was stopped. */
  private async maintainAtStart(deps: BirthDeps): Promise<void> {
    if (!this.running || this.stopping || deps.isCancelled?.()) return;
    await this.maintainNow();
  }

  private async runMaintenance(): Promise<MaintainResult | undefined> {
    try {
      const forgotten = this.forgetNow();
      let linked: LinkResult | undefined;
      let linking = false;
      if (readBirthRecord(this.dir)?.finishedAt && this.running && !this.stopping) {
        const deps = this.birthDeps();
        const run = this.backfill(deps);
        // One macrotask of grace: a backfill with nothing to wait on settles
        // in it; a pending embed is left running and never holds this run.
        const pending = Symbol('pending');
        const first = await Promise.race([
          run,
          new Promise<typeof pending>((r) => setTimeout(() => r(pending), 0)),
        ]);
        if (first === pending) linking = true;
        else linked = first;
        if (linked?.cancelled || deps.isCancelled?.()) return undefined;
      }
      // linkMissing relays out when it embedded: one layout broadcast, not two.
      if (!linked?.relaidOut) relayout(this.graph);
      const at = new Date(this.now()).toISOString();
      writeLastMaintainAt(maintainStateFile(this.dir), at);
      return { forgotten, link: linked ?? null, linking, at };
    } catch (err) {
      this.logger.warn({ err }, 'Watcher: daily maintenance failed');
      return undefined;
    }
  }

  /** O10: what importance reads besides the neuron (the graph, the grace, the served broadcasts). */
  importanceContext(): ImportanceContext {
    const servedInsights = new Set<string>();
    try {
      for (const b of this.broadcaster.list()) if (b.servedByCycle) servedInsights.add(b.insightId);
    } catch {
      // no broadcasts readable: nothing is protected by one
    }
    return {
      nowMs: this.now(),
      graph: this.graph,
      graceDays: (this.cfg().forget ?? FORGET_DEFAULTS).graceDays,
      servedInsights,
    };
  }

  /**
   * O10 forgetting: archive live neurons below `forget.threshold`, older than
   * the grace and not protected, lowest importance first: at most
   * `forget.maxPerRun` a run below `graph.targetNeurons`, and above it as many
   * as it takes to reach the target (`planForgetting`). Each keeps its score text
   * in `meta.archivedReason`; one `forget:archive` row per batch. Returns how
   * many it archived.
   */
  forgetNow(): number {
    const cfg = this.cfg();
    const forget = cfg.forget ?? FORGET_DEFAULTS;
    const target = cfg.graph.targetNeurons ?? TARGET_NEURONS_DEFAULT;
    const plan = planForgetting(this.graph.list(), this.importanceContext(), {
      threshold: forget.threshold,
      target,
      maxPerRun: forget.maxPerRun ?? FORGET_DEFAULTS.maxPerRun,
    });
    if (plan.archive.length === 0) return 0;
    for (const { neuron, score } of plan.archive) {
      this.graph.archive(neuron.id, {
        archivedReason: score.reason,
        archivedImportance: score.score.toFixed(2),
      });
    }
    this.log.say(
      'sleep',
      'forget:archive',
      narrateForgot({
        archived: plan.archive.length,
        lowest: plan.archive.slice(0, 3).map((a) => a.score.score),
        live: this.graph.liveCount(),
        target,
      }),
      { neuronIds: plan.archive.slice(0, FORGET_ROW_IDS).map((a) => a.neuron.id) }
    );
    return plan.archive.length;
  }

  private linkStatus(record: BirthRecord | null): LinkStatus {
    if (record?.linkStatus && record.linkStatus !== 'pending') return record.linkStatus;
    if (this.graph.embeddedIds().length > 0) return 'ok';
    return record?.finishedAt ? 'no-embeddings' : 'pending';
  }

  private botName(id: string): string {
    return (
      this.graph.findByKey(`bot:${id}`)?.meta?.name ??
      this.deps.config().bots.find((b) => b.id === id)?.name ??
      id
    );
  }

  private sender(e: HumanInboundEvent): SenderInfo {
    const address = e.userId ?? e.chatId;
    let contact: ReturnType<UserDirectory['findByChannel']>;
    try {
      contact = this.deps.botManager
        .getUserDirectory()
        .findByChannel(e.botId, e.channelKind as ChannelKind, address);
    } catch {
      contact = undefined;
    }
    return inboundSender(e, { contact });
  }

  /**
   * A sense batch moved `lastTickAt`: republish the state so the header's
   * "last tick" follows sensing, not only phase changes (notice passes). At
   * most once per `SENSE_STATE_EVERY_MS`, with a trailing publish.
   */
  private senseStateChanged(): void {
    if (!this.running || this.stopping) return;
    const since = this.now() - this.lastSenseStateAt;
    if (since >= SENSE_STATE_EVERY_MS) {
      this.lastSenseStateAt = this.now();
      this.publish('watcher:state', this.state());
      return;
    }
    if (this.senseStateTimer) return;
    this.senseStateTimer = setTimeout(() => {
      this.senseStateTimer = undefined;
      if (!this.running || this.stopping) return;
      this.lastSenseStateAt = this.now();
      this.publish('watcher:state', this.state());
    }, SENSE_STATE_EVERY_MS - since);
    (this.senseStateTimer as { unref?: () => void }).unref?.();
  }

  private clearSenseStateTimer(): void {
    if (this.senseStateTimer) clearTimeout(this.senseStateTimer);
    this.senseStateTimer = undefined;
  }

  private setPhase(phase: WatcherPhase): void {
    this.phase = phase;
    this.publish('watcher:state', this.state());
  }

  private fail(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    this.logger.warn({ err }, 'Watcher: background work failed');
  }

  private onRow(row: WatcherLogRow): void {
    if (row.op.endsWith(':failed')) this.lastError = row.text;
    this.publish('watcher:log', row);
  }

  private onGraphChange(change: GraphChange): void {
    if (change.type === 'neuron') this.publish('watcher:neuron', change.neuron);
    else if (change.type === 'edge') this.publish('watcher:edge', change.edge);
    else if (change.type === 'layout')
      this.publish('watcher:layout', { positions: change.positions });
    else this.publish('watcher:activate', change.activation);
  }

  private publish(type: WatcherEventType, data: unknown): void {
    const event: WatcherEvent = { type, ts: new Date(this.now()).toISOString(), data };
    try {
      this.emit(type, event);
      this.emit('event', event);
    } catch (err) {
      this.logger.warn({ err, type }, 'Watcher: an event listener threw');
    }
  }
}

/** What `createFleetWatcher` reads from the bot manager. */
export interface FleetWatcherSource {
  getActivityStream(): Listenable;
  getHooks(): Listenable;
  getChannelState(botId: string): ChannelStatus | undefined;
  getUserDirectory(): Pick<UserDirectory, 'list' | 'findByChannel'>;
  getOllamaClient(): { embed(text: string, model: string): Promise<{ embedding: number[] }> };
  /** Phase 2: query log, breaker and tool registry (optional so older fakes still fit). */
  getLlmQueryLog?(): { append(entry: LlmQueryEntry): void };
  getCircuitBreaker?(): WatcherBreaker | undefined;
  getToolRegistry?(): {
    setFleetMemory(source: () => ReturnType<Watcher['fleetMemory']>): void;
    /** The fleet's proactive throttle a question broadcast counts against (as `__watcher__`). */
    getProactiveThrottle?(): Pick<ProactiveThrottle, 'check' | 'record'>;
  };
  /** A question broadcast's Telegram route for the bot it concerns (own, else borrowed). */
  getOperatorTelegramRoute?(botId: string): TelegramRoute | undefined;
  /** Where a question broadcast is audited (under `__watcher__`: Work → Sent to you). */
  getToolAuditLog?(): { append(entry: ToolAuditEntry): void };
  /** Phase 3: the entry points broadcasts use (optional so older fakes still fit). */
  requestImmediateAgentRun?(botId: string, opts?: { feedback?: boolean }): void;
  getCuriosityService?(): {
    recordDirective(botId: string, text: string, source: 'watcher'): void;
  };
  setWatcherBroadcasts?(source: WatcherBroadcastSource | undefined): void;
  /** Phase 4: fleet karma, the running cycle, and where "## Your current state" is published. */
  getKarmaService?(): { getAllScores(botIds: string[]): Array<{ current: number }> } | undefined;
  getRunningCycle?(
    botId: string
  ): { cycleId: string; plan?: string; goalId?: string; goalTitle?: string } | undefined;
  setWatcherSelfState?(source: WatcherSelfStateSource | undefined): void;
  /** O10: whether an agent-loop cycle runs now (`BotManager.getAgentLoopState`). */
  getAgentLoopState?(): { running: boolean; sleeping: boolean; draining?: boolean };
}

/**
 * O10: the fleet is quiet when no agent-loop cycle executes (every loop
 * sleeping between cycles, or the loop not started) and it is not draining.
 * Unknown state is not quiet.
 */
export function fleetQuietFrom(
  state: { running?: boolean; sleeping?: boolean; draining?: boolean } | undefined
): boolean {
  if (!state || typeof state.running !== 'boolean') return false;
  return !state.running && state.draining !== true;
}

/** A question broadcast reaches the operator with this prefix, through the bot it concerns. */
export const WATCHER_QUESTION_PREFIX = 'Fleet watcher: ';

interface TelegramRoute {
  api: { sendMessage: (chatId: number, text: string) => Promise<unknown> };
}

export interface WatcherQuestionDeps {
  /** The fleet's proactive throttle; the watcher is its own sender (`__watcher__`). */
  throttle: Pick<ProactiveThrottle, 'check' | 'record'>;
  operatorChatId: () => number | undefined;
  /** The bot's Telegram route to the operator; undefined = the dashboard is the channel. */
  telegram: (botId: string) => TelegramRoute | undefined;
  audit?: (entry: ToolAuditEntry) => void;
  now?: () => number;
  logger: Pick<Logger, 'warn'>;
}

/**
 * Ask the operator a question broadcast's text, without the bot's executor (so
 * no karma, no use of the bot's own cooldown, nothing in its audit): the shared
 * proactive throttle keyed `__watcher__` (the fleet cap is shared), the bot's
 * Telegram route (none, or no `operator.telegramChatId` = kept for the
 * dashboard, like `send_proactive_message`),
 * and one tool-audit row under `__watcher__` that `/api/proactive` lists in
 * Work → Sent to you. A refusal is audited as `policy` and reported as
 * `deferred` (nothing was attempted: the broadcaster keeps it out of the bot's
 * daily cap and lets it be retried after the cooldown); only a delivery that
 * landed is counted against the throttle. Never throws.
 */
export async function deliverWatcherQuestion(
  deps: WatcherQuestionDeps,
  botId: string,
  text: string
): Promise<{ ok: boolean; detail: string; deferred?: boolean }> {
  const now = deps.now ?? Date.now;
  const started = now();
  const message = `${WATCHER_QUESTION_PREFIX}${text}`;
  const finish = (ok: boolean, detail: string, failureKind?: 'policy') => {
    try {
      deps.audit?.({
        timestamp: new Date(started).toISOString(),
        botId: WATCHER_BOT_ID,
        chatId: 0,
        toolName: 'send_proactive_message',
        args: { chatId: 'operator', message, aboutBot: botId },
        success: ok,
        result: detail.slice(0, 500),
        durationMs: Math.max(0, now() - started),
        retryAttempts: 0,
        ...(failureKind ? { failureKind } : {}),
      });
    } catch (err) {
      deps.logger.warn({ err }, 'Watcher: could not audit a question broadcast');
    }
    return { ok, detail };
  };
  const gate = deps.throttle.check(WATCHER_BOT_ID);
  if (!gate.allowed) return { ...finish(false, gate.reason, 'policy'), deferred: true };
  const chatId = deps.operatorChatId();
  // No operator Telegram chat is the same case as no route: the dashboard is
  // the channel, so the question has landed (Work → Sent to you). Reporting a
  // failure would make it retryable, and every retry would use one of the
  // bot's daily broadcasts, capping the other kinds for nothing. The rule for
  // the cap stays the one in broadcast.ts: a real failure (throttle, Telegram
  // error) still counts.
  const hasChat = chatId !== undefined && chatId !== null && Number.isFinite(Number(chatId));
  let route: TelegramRoute | undefined;
  if (hasChat) {
    try {
      route = deps.telegram(botId);
    } catch {
      route = undefined;
    }
  }
  if (!route) {
    deps.throttle.record(WATCHER_BOT_ID);
    return finish(
      true,
      hasChat
        ? 'Not sent by Telegram: no Telegram connection for this bot. The operator sees it in the dashboard (Work → Sent to you).'
        : 'Not sent by Telegram: the operator has no Telegram chat configured (operator.telegramChatId). The operator sees it in the dashboard (Work → Sent to you).'
    );
  }
  try {
    await route.api.sendMessage(Number(chatId), message);
  } catch (err) {
    return finish(false, `Failed to send: ${err instanceof Error ? err.message : String(err)}`);
  }
  deps.throttle.record(WATCHER_BOT_ID);
  return finish(true, `Message sent to the operator (chat ${chatId})`);
}

/**
 * The four broadcast entry points over the bot manager: wake =
 * `requestImmediateAgentRun(botId, { feedback: false })`; directive =
 * `CuriosityService.recordDirective(…, 'watcher')`; goal = `writeWatcherGoal`
 * on the bot's GOALS.md (same soul-dir resolution as `startBot`); question =
 * `deliverWatcherQuestion` (the shared proactive throttle as `__watcher__`, the
 * bot's Telegram route, an audit row for Work → Sent to you; never the bot's
 * executor, so never its karma or cooldown).
 */
export function fleetBroadcastDelivery(
  config: Config,
  manager: FleetWatcherSource,
  logger: Logger
): BroadcastDelivery {
  return {
    wake: (botId) => {
      if (!manager.requestImmediateAgentRun) throw new Error('wake is not available');
      manager.requestImmediateAgentRun(botId, { feedback: false });
    },
    directive: (botId, text) => {
      const curiosity = manager.getCuriosityService?.();
      if (!curiosity) throw new Error('directives are not available');
      curiosity.recordDirective(botId, text, 'watcher');
    },
    goal: (botId, text, reason) => {
      const bot = config.bots.find((b) => b.id === botId);
      if (!bot) throw new Error(`unknown bot ${botId}`);
      const { soulDir } = resolveBotPaths(config, bot);
      writeWatcherGoal(join(soulDir, 'GOALS.md'), text, reason, {
        backup: (p) => backupSoulFile(p, logger),
      });
    },
    question: async (botId, text) => {
      const throttle = manager.getToolRegistry?.().getProactiveThrottle?.();
      if (!throttle) return { ok: false, detail: 'proactive messages are not available' };
      const audit = manager.getToolAuditLog?.();
      return deliverWatcherQuestion(
        {
          throttle,
          operatorChatId: () => config.operator?.telegramChatId,
          telegram: (id) => manager.getOperatorTelegramRoute?.(id),
          ...(audit ? { audit: (e: ToolAuditEntry) => audit.append(e) } : {}),
          logger,
        },
        botId,
        text
      );
    },
  };
}

/**
 * The fleet's tool audit of a bot in a window, as the prediction judge reads
 * it (tool, ok or failed with its kind, target). A reader that throws = none.
 */
export function fleetToolCalls(
  config: Config
): (botId: string, sinceMs: number, nowMs: number) => GroundTruthTool[] {
  return (botId, since, now) => {
    try {
      return readToolEntries(resolveStatsDirs(config).toolAudit, botId, since, now).map((e) => {
        const target = toolTarget(e.args);
        return {
          ts: e.timestamp,
          tool: e.toolName,
          success: e.success,
          ...(e.failureKind ? { failureKind: e.failureKind } : {}),
          ...(target ? { target } : {}),
        };
      });
    } catch {
      return [];
    }
  };
}

/**
 * The fleet's watcher, or undefined when `watcher.enabled` is off (then nothing
 * new runs). Embeds with the shared Ollama client and `soul.search.embeddingModel`;
 * without a model there is no `embed` and the graph links nothing.
 */
export function createFleetWatcher(
  config: Config,
  logger: Logger,
  manager: FleetWatcherSource
): Watcher | undefined {
  if (!config.watcher?.enabled) return undefined;
  const model = (config.soul as { search?: { embeddingModel?: string } } | undefined)?.search
    ?.embeddingModel;
  const ollama = manager.getOllamaClient();
  const breaker = manager.getCircuitBreaker?.();
  const queryLog = manager.getLlmQueryLog?.();
  const watcher = new Watcher({
    config: () => config,
    logger,
    activityStream: manager.getActivityStream(),
    hooks: manager.getHooks(),
    botManager: manager,
    ...(model
      ? { embed: async (text: string) => (await ollama.embed(text, model)).embedding }
      : {}),
    llm: createWatcherClients(config, { logger, ollama: ollama as OllamaClient }),
    ...(queryLog ? { queryLog } : {}),
    ...(breaker ? { breaker } : {}),
    readCycles: (botId, since, now) => {
      try {
        return readAgentCycles(resolveStatsDirs(config).agentCycles, botId, since, now);
      } catch {
        return [];
      }
    },
    broadcastDelivery: fleetBroadcastDelivery(config, manager, logger),
    karmaScores: () => {
      const karma = manager.getKarmaService?.();
      if (!karma) return [];
      const ids = (config.bots ?? []).filter((b) => b.enabled !== false).map((b) => b.id);
      return karma.getAllScores(ids).map((s) => s.current);
    },
    semaphore: getClaudeCliStats,
    toolCalls: fleetToolCalls(config),
    toolsUsed: (botId, since, now) => {
      try {
        const entries = readToolEntries(resolveStatsDirs(config).toolAudit, botId, since, now);
        return [...new Set(entries.map((e) => e.toolName))];
      } catch {
        return [];
      }
    },
    ...(manager.getRunningCycle
      ? { runningCycle: (botId: string) => manager.getRunningCycle?.(botId) }
      : {}),
    ...(manager.getAgentLoopState
      ? { fleetQuiet: () => fleetQuietFrom(manager.getAgentLoopState?.()) }
      : {}),
  });
  try {
    manager.getToolRegistry?.().setFleetMemory(() => watcher.fleetMemory());
  } catch (err) {
    logger.warn({ err }, 'Watcher: could not register fleet_memory_search');
  }
  try {
    manager.setWatcherBroadcasts?.(watcher.broadcaster);
  } catch (err) {
    logger.warn({ err }, 'Watcher: could not publish broadcasts to the agent loop');
  }
  try {
    manager.setWatcherSelfState?.(watcher);
  } catch (err) {
    logger.warn({ err }, 'Watcher: could not publish the self-state to the bots');
  }
  return watcher;
}
