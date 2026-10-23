/**
 * The watcher: one always-on workspace per fleet (phase 1: tier 0 sensing,
 * birth, the log, the graph). Same process as the bots; constructed in
 * `src/index.ts` only when `config.watcher.enabled`. Every change it makes is
 * re-emitted as a `WatcherEvent` (`event`, and under its own type name) for
 * `/ws/watcher`. Nothing throws out of `start()` or `stop()`: a failing stage
 * is a log row and `state().lastError`. No LLM calls in this phase.
 */
import { EventEmitter } from 'node:events';
import type { HumanInboundEvent } from '../bot/agent-loop-utils';
import type { ChannelStatus } from '../bot/telegram-errors';
import type { UserDirectory } from '../bot/user-directory';
import type { ChannelKind } from '../channel/types';
import type { Config } from '../config';
import type { Logger } from '../logger';
import {
  type BirthDeps,
  beginBirth,
  continueBirth,
  readBirthRecord,
  relayout,
  runResync,
} from './birth';
import { WorkingBuffer } from './buffer';
import { Graph, type GraphChange } from './graph';
import { WatcherLog } from './log';
import { narrateResumeBirth, narrateRewake, narrateSleep } from './narration';
import { bufferFile, watcherDir, watcherLogDir } from './paths';
import { type SenderInfo, Sense } from './sense';
import {
  type BirthRecord,
  type LinkStatus,
  WATCHER_DEFAULTS,
  type WatcherConfig,
  type WatcherEvent,
  type WatcherEventType,
  type WatcherLogRow,
  type WatcherPhase,
  type WatcherState,
} from './types';

const DAY_MS = 86_400_000;

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
}

export class Watcher extends EventEmitter {
  readonly graph: Graph;
  readonly log: WatcherLog;
  readonly buffer = new WorkingBuffer();
  readonly dir: string;
  private readonly sense: Sense;
  private readonly logger: Logger;
  private readonly now: () => number;
  private running = false;
  private stopping = false;
  private phase: WatcherPhase = 'sleep';
  private lastError?: string;
  private background: Promise<void> = Promise.resolve();
  private timers: ReturnType<typeof setInterval>[] = [];

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
      buffer: this.buffer,
      log: this.log,
      config: () => this.cfg(),
      now: this.now,
      botName: (id) => this.botName(id),
      sender: (e) => this.sender(e),
      logger: this.logger,
    });
  }

  /** Writes the wake row and returns; birth or resync continue in the background. */
  async start(): Promise<WatcherState> {
    if (this.running) return this.state();
    this.running = true;
    this.stopping = false;
    this.lastError = undefined;
    try {
      this.graph.load();
      this.buffer.restore(bufferFile(this.dir));
      const record = readBirthRecord(this.dir);
      const deps = this.birthDeps();
      if (!record || !record.done.includes('wake')) {
        this.setPhase('birth');
        const fresh = beginBirth(deps);
        this.background = this.runBackground(() =>
          continueBirth(deps, fresh).then(() => undefined)
        );
      } else if (!record.finishedAt) {
        this.setPhase('birth');
        this.log.say('birth', 'wake', narrateResumeBirth(record.stage));
        this.background = this.runBackground(() =>
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
        this.background = this.runBackground(() => runResync(deps).then(() => undefined));
      }
      this.sense.attach(this.deps.activityStream, this.deps.hooks);
      this.startTimers();
    } catch (err) {
      this.fail(err);
    }
    return this.state();
  }

  async stop(): Promise<WatcherState> {
    if (!this.running) return this.state();
    this.stopping = true;
    try {
      this.sense.detach();
      for (const t of this.timers) clearInterval(t);
      this.timers = [];
      await this.background;
      this.sense.tick();
      this.graph.compact();
      this.buffer.persist(bufferFile(this.dir));
      this.log.say('sleep', 'sleep', narrateSleep({ neurons: this.graph.liveCount() }));
    } catch (err) {
      this.fail(err);
    }
    this.running = false;
    this.stopping = false;
    this.setPhase('sleep');
    return this.state();
  }

  /** Resolves when birth or resync (whatever runs in the background) is done. */
  idle(): Promise<void> {
    return this.background;
  }

  readBirth(): BirthRecord | null {
    return readBirthRecord(this.dir);
  }

  state(): WatcherState {
    const record = readBirthRecord(this.dir);
    return {
      running: this.running,
      ...(record?.finishedAt ? { bornAt: record.finishedAt } : {}),
      phase: this.phase,
      ...(this.sense.lastTickAt ? { lastTickAt: this.sense.lastTickAt } : {}),
      counts: this.graph.counts(),
      edges: this.graph.edgeCount(),
      linkStatus: this.linkStatus(record),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  // ── internals ──

  private cfg(): WatcherConfig {
    return (this.deps.config().watcher as WatcherConfig | undefined) ?? WATCHER_DEFAULTS;
  }

  private birthDeps(): BirthDeps {
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
      isCancelled: () => this.stopping,
    };
  }

  private runBackground(work: () => Promise<void>): Promise<void> {
    return work()
      .catch((err) => this.fail(err))
      .finally(() => {
        if (this.running && !this.stopping) this.setPhase('sense');
      });
  }

  private startTimers(): void {
    const every = this.cfg().log.senseSummaryEveryMs;
    const summary = setInterval(() => this.sense.tick(), every);
    const daily = setInterval(() => this.maintain(), DAY_MS);
    for (const t of [summary, daily]) (t as { unref?: () => void }).unref?.();
    this.timers = [summary, daily];
  }

  /** Daily: archive what has not fired within `archiveAfterDays`, recompute the layout. */
  private maintain(): void {
    try {
      this.graph.archiveInactive(this.cfg().graph.archiveAfterDays * DAY_MS);
      relayout(this.graph);
    } catch (err) {
      this.logger.warn({ err }, 'Watcher: daily maintenance failed');
    }
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
    const opChat = this.deps.config().operator?.telegramChatId;
    let contact: ReturnType<UserDirectory['findByChannel']>;
    try {
      contact = this.deps.botManager
        .getUserDirectory()
        .findByChannel(e.botId, e.channelKind as ChannelKind, address);
    } catch {
      contact = undefined;
    }
    const isOperator =
      contact?.metadata?.role === 'operator' ||
      (e.channelKind === 'telegram' && opChat !== undefined && String(opChat) === String(address));
    return {
      isOperator,
      ...(contact?.displayName
        ? { name: contact.displayName }
        : isOperator
          ? { name: 'the operator' }
          : {}),
    };
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
  return new Watcher({
    config: () => config,
    logger,
    activityStream: manager.getActivityStream(),
    hooks: manager.getHooks(),
    botManager: manager,
    ...(model
      ? { embed: async (text: string) => (await ollama.embed(text, model)).embedding }
      : {}),
  });
}
