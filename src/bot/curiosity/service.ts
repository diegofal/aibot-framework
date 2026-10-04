/**
 * CuriosityService — the single entry point the agent loop, BotManager and
 * the web routes use to reach a bot's curiosity state. Resolves the soul dir
 * and config per bot through injected callbacks so it stays testable.
 */
import type { CuriosityConfig } from '../../config';
import { type FrontierVerdict, evaluateFrontierItem, resolveCuriosity } from './config';
import { type TopicConcentration, computeTopicConcentration } from './cycle';
import { addDirective } from './directives';
import { MIN_DIRECTIVE_CHARS } from './extractor';
import { setFrontierSignal } from './knowledge-map';
import { CuriosityStore } from './store';
import { applySignal } from './taste';
import type {
  Direction,
  DirectiveSource,
  Dispatch,
  DispatchSignal,
  FrontierItem,
  KnowledgeMap,
  NavigatorState,
  ResolvedCuriosity,
  TasteProfile,
} from './types';

export interface CuriosityInputs {
  global: CuriosityConfig | undefined;
  bot: CuriosityConfig | undefined;
  curiosityTrait?: number;
}

export interface CuriosityServiceDeps {
  getSoulDir: (botId: string) => string | null;
  getCuriosityInputs: (botId: string) => CuriosityInputs | null;
  now?: () => string;
}

export interface CuriositySnapshot {
  botId: string;
  config: ResolvedCuriosity;
  map: KnowledgeMap;
  navigator: NavigatorState;
  taste: TasteProfile;
  dispatches: Dispatch[];
  concentration: TopicConcentration;
  frontier: Array<{ item: FrontierItem; verdict: FrontierVerdict }>;
}

export class CuriosityService {
  private now: () => string;
  /** Per-bot promise chain: begin/finish of one bot never interleave. */
  private locks = new Map<string, Promise<unknown>>();
  /** Background navigator runs in flight, one per bot. */
  private navigators = new Map<string, Promise<void>>();

  constructor(private deps: CuriosityServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** Run `fn` after every earlier exclusive task of this bot settled. */
  async runExclusive<T>(botId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(botId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(botId, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(botId) === settled) this.locks.delete(botId);
    }
  }

  /**
   * Start a background navigator run unless one is already in flight for
   * this bot. Returns false when it did not start. The task must not throw.
   */
  startNavigator(botId: string, task: () => Promise<void>): boolean {
    if (this.navigators.has(botId)) return false;
    const run = task()
      .catch(() => undefined)
      .finally(() => this.navigators.delete(botId));
    this.navigators.set(botId, run);
    return true;
  }

  /** Resolves when the bot's background navigator (if any) has finished. */
  async waitForNavigator(botId: string): Promise<void> {
    await this.navigators.get(botId);
  }

  storeFor(botId: string): CuriosityStore | null {
    const dir = this.deps.getSoulDir(botId);
    return dir ? new CuriosityStore(dir) : null;
  }

  resolve(botId: string): ResolvedCuriosity | null {
    const inputs = this.deps.getCuriosityInputs(botId);
    if (!inputs) return null;
    return resolveCuriosity(inputs.global, inputs.bot, inputs.curiosityTrait);
  }

  snapshot(botId: string, opts: { dispatchLimit?: number } = {}): CuriositySnapshot | null {
    const store = this.storeFor(botId);
    const config = this.resolve(botId);
    if (!store || !config) return null;
    const map = store.loadMap();
    const navigator = store.loadNavigator();
    return {
      botId,
      config,
      map,
      navigator,
      taste: store.loadTaste(config.dispatch.baseIntervalHours),
      dispatches: store.listDispatches(opts.dispatchLimit ?? 20),
      concentration: computeTopicConcentration(navigator.cycleLog, config.topicWindow),
      frontier: map.frontier.map((item) => ({
        item,
        verdict: evaluateFrontierItem(item, config.limits),
      })),
    };
  }

  /**
   * Operator verdict on a dispatch: stored on the dispatch, taught to the
   * taste model, and — for proposals — applied to the frontier item it asks
   * about ('up'/'more' approve, 'down' drops).
   */
  signalDispatch(botId: string, dispatchId: string, signal: DispatchSignal): Dispatch | null {
    const store = this.storeFor(botId);
    const config = this.resolve(botId);
    if (!store || !config) return null;
    const existing = store.getDispatch(dispatchId);
    if (!existing) return null;
    const now = this.now();
    const updated = store.updateDispatch(dispatchId, { signal, signalAt: now });
    if (!updated) return null;
    // Repeat clicks must not compound the cadence or the counts.
    if (existing.signal === signal) return updated;
    if (updated.interest && signal !== 'down') {
      const map = store.loadMap();
      if (!map.interests.includes(updated.interest)) {
        map.interests = [...map.interests, updated.interest].slice(-12);
        store.saveMap(map);
      }
    }
    store.saveTaste(
      applySignal(
        store.loadTaste(config.dispatch.baseIntervalHours),
        updated,
        signal,
        config.dispatch,
        now
      )
    );
    if (updated.frontierId) {
      const next = setFrontierSignal(
        store.loadMap(),
        updated.frontierId,
        signal === 'down' ? 'down' : 'up'
      );
      if (next) store.saveMap(next);
    }
    return updated;
  }

  signalFrontier(botId: string, frontierId: string, signal: 'up' | 'down'): FrontierItem | null {
    const store = this.storeFor(botId);
    if (!store) return null;
    const next = setFrontierSignal(store.loadMap(), frontierId, signal);
    if (!next) return null;
    store.saveMap(next);
    return next.frontier.find((f) => f.id === frontierId) ?? null;
  }

  signalDirection(botId: string, signal: 'up' | 'down'): Direction | null {
    const store = this.storeFor(botId);
    if (!store) return null;
    const nav = store.loadNavigator();
    if (!nav.direction) return null;
    nav.direction = { ...nav.direction, operatorSignal: signal };
    store.saveNavigator(nav);
    return nav.direction;
  }

  recordDirective(botId: string, text: string, source: DirectiveSource): void {
    if (!this.resolve(botId)?.enabled) return;
    const store = this.storeFor(botId);
    if (!store) return;
    store.saveNavigator(
      addDirective(store.loadNavigator(), { text, source, receivedAt: this.now() })
    );
  }

  /**
   * A message the operator sent the bot (operator Telegram chat or the
   * authenticated dashboard thread). Only these steer; public users never do.
   */
  recordOperatorMessage(botId: string, text: string): boolean {
    const t = text.trim();
    if (t.length < MIN_DIRECTIVE_CHARS || !this.resolve(botId)?.enabled) return false;
    this.recordDirective(botId, t, 'message');
    return true;
  }
}
