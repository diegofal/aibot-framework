import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig } from '../config';
import type { Logger } from '../logger';
import type { BotContext } from './types';
import type { AgentLoopResult, BotScheduleInfo } from './agent-loop';
import { parseDurationMs } from './agent-loop';
import { computeCyclesUntilStrategist } from './agent-strategist';
import type { RecentAction } from './agent-loop-utils';

export interface BotSchedule {
  nextRunAt: number;
  lastRunAt: number | null;
  lastResult: AgentLoopResult | null;
  nextCheckIn: string | null;
  strategistCycleCount: number;
  lastStrategistAt: number | null;
  lastFocus: string | null;
  continuousCycleCount: number;
  sessionStartAt: number | null;
  recentActions: RecentAction[];
  consecutiveIdleCycles: number;
  lastLoggedSummary: string | null;
  retryCount: number;
  lastErrorMessage: string | null;
  /** Number of consecutive cycles without an ask_human tool call */
  cyclesSinceAskHuman: number;
}

/**
 * AgentScheduler manages per-bot scheduling, sleep, and concurrency.
 */
export class AgentScheduler {
  private sleepControllers = new Set<AbortController>();
  private botSchedules = new Map<string, BotSchedule>();
  private botLoops = new Map<string, Promise<void>>();
  private runningBotIds = new Set<string>();
  private pendingWakeRequests = new Set<string>();
  private concurrencyRunning = 0;
  private concurrencyQueue: Array<() => void> = [];
  private enabled = false;
  private loopPromise: Promise<void> | null = null;
  private lastRunAt: number | null = null;
  private lastResults: AgentLoopResult[] = [];
  private flushDirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private drainingResolve: (() => void) | null = null;
  private static readonly FLUSH_DEBOUNCE_MS = 10_000;

  constructor(
    private ctx: BotContext,
    private runOneBotFn: (botId: string, botConfig: BotConfig, opts?: { suppressSideEffects?: boolean }) => Promise<AgentLoopResult>,
    private dataDir?: string,
  ) {
    if (dataDir) this.loadFromDisk();
  }

  /** Load schedules from disk on startup. Excludes lastResult (verbose, regenerated). */
  loadFromDisk(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'schedules.json');
    if (!existsSync(filePath)) return;

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      for (const [botId, schedule] of Object.entries(raw)) {
        const s = schedule as BotSchedule;
        // Restore without lastResult (verbose, regenerated at runtime)
        this.botSchedules.set(botId, {
          ...s,
          lastResult: null,
        });
      }
      this.ctx.logger.debug({ count: this.botSchedules.size }, 'AgentScheduler: loaded from disk');
    } catch (err) {
      this.ctx.logger.warn({ err }, 'AgentScheduler: failed to load from disk');
    }
  }

  /** Mark dirty and schedule a debounced flush. */
  private schedulePersist(): void {
    if (!this.dataDir) return;
    this.flushDirty = true;
    if (this.flushTimer) return; // already scheduled
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushToDisk();
    }, AgentScheduler.FLUSH_DEBOUNCE_MS);
  }

  /** Write schedules to disk (without lastResult). */
  flushToDisk(): void {
    if (!this.dataDir || !this.flushDirty) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const data: Record<string, Omit<BotSchedule, 'lastResult'>> = {};
      for (const [botId, schedule] of this.botSchedules) {
        const { lastResult, ...rest } = schedule;
        data[botId] = rest;
      }
      writeFileSync(join(this.dataDir, 'schedules.json'), JSON.stringify(data, null, 2), 'utf-8');
      this.flushDirty = false;
    } catch (err) {
      this.ctx.logger.warn({ err }, 'AgentScheduler: failed to flush to disk');
    }
  }

  // --- Getters for AgentLoop to use ---

  getSchedule(botId: string): BotSchedule | undefined {
    return this.botSchedules.get(botId);
  }

  getSchedules(): Map<string, BotSchedule> {
    return this.botSchedules;
  }

  getRunningBotIds(): Set<string> {
    return this.runningBotIds;
  }

  getLastResults(): AgentLoopResult[] {
    return [...this.lastResults];
  }

  getLastRunAt(): number | null {
    return this.lastRunAt;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isSleeping(): boolean {
    return this.sleepControllers.size > 0;
  }

  isDraining(): boolean {
    return this.draining;
  }

  isExecutingLoop(botId: string): boolean {
    return this.runningBotIds.has(botId);
  }

  // --- Lifecycle ---

  start(): void {
    if (!this.ctx.config.agentLoop.enabled) {
      this.ctx.logger.info('Agent loop disabled, not starting');
      return;
    }
    if (this.enabled) return;
    this.enabled = true;
    this.loopPromise = this.runLoop();
  }

  stop(): void {
    this.enabled = false;
    for (const c of this.sleepControllers) c.abort();
    // Flush synchronously before clearing maps
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flushDirty = true;
    this.flushToDisk();
    this.pendingWakeRequests.clear();
    this.botSchedules.clear();
    this.botLoops.clear();
  }

  wakeUp(): void {
    for (const c of this.sleepControllers) c.abort();
  }

  /**
   * Request an immediate agent loop run for a specific bot.
   * - If bot is idle (not currently executing), sets nextRunAt = now and wakes the loop.
   * - If bot is busy (currently executing), queues a pending wake so the bot
   *   skips sleep after the current cycle finishes.
   */
  requestImmediateRun(botId: string): void {
    if (!this.enabled) return;
    if (!this.ctx.runningBots.has(botId)) return;

    if (this.runningBotIds.has(botId)) {
      // Bot is currently executing — queue a pending wake
      this.pendingWakeRequests.add(botId);
      this.ctx.logger.info({ botId }, 'Agent loop: queued pending wake request (bot busy)');
      return;
    }

    // Bot is idle — set nextRunAt to now and wake the loop
    const schedule = this.botSchedules.get(botId);
    if (schedule) {
      schedule.nextRunAt = Date.now();
      this.schedulePersist();
    }
    this.ctx.logger.info({ botId }, 'Agent loop: immediate run triggered (bot idle)');
    this.wakeUp();
  }

  /** Returns true if a pending wake was consumed for the given bot. */
  consumePendingWake(botId: string): boolean {
    return this.pendingWakeRequests.delete(botId);
  }

  /**
   * Gracefully stop all bot loops: sets draining flag, wakes sleeping bots,
   * waits for all executing cycles to finish, then calls stop().
   * Resolves when all loops have exited or after timeoutMs.
   */
  async gracefulStop(timeoutMs = 120_000): Promise<void> {
    if (this.draining) {
      // Already draining — wait for the existing drain to complete
      if (this.drainingResolve) {
        return new Promise<void>((resolve) => {
          const prev = this.drainingResolve;
          this.drainingResolve = () => { prev?.(); resolve(); };
        });
      }
      return;
    }

    this.draining = true;
    this.ctx.logger.info('AgentScheduler: graceful stop initiated — draining');

    // Wake all sleeping bots so they exit their loop guards
    for (const c of this.sleepControllers) c.abort();

    // Also release any queued concurrency waiters so they can exit
    while (this.concurrencyQueue.length > 0) {
      const next = this.concurrencyQueue.shift();
      if (next) next();
    }

    // Wait for all active botLoops to settle (or timeout)
    const loopPromises = [...this.botLoops.values()];
    const settled = new Promise<void>((resolve) => {
      this.drainingResolve = resolve;
      if (loopPromises.length === 0 && this.runningBotIds.size === 0) {
        resolve();
        return;
      }
      Promise.allSettled(loopPromises).then(() => resolve());
    });

    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.ctx.logger.warn({ timeoutMs }, 'AgentScheduler: graceful stop timed out');
        resolve();
      }, timeoutMs);
    });

    await Promise.race([settled, timeout]);

    // Full cleanup
    this.stop();
    this.draining = false;
    this.drainingResolve = null;
    this.ctx.logger.info('AgentScheduler: graceful stop completed');
  }

  // --- Concurrency ---

  async acquireConcurrency(): Promise<void> {
    const limit = this.ctx.config.agentLoop.maxConcurrent;
    if (this.concurrencyRunning < limit) {
      this.concurrencyRunning++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.concurrencyQueue.push(() => {
        this.concurrencyRunning++;
        resolve();
      });
    });
  }

  releaseConcurrency(): void {
    this.concurrencyRunning--;
    const next = this.concurrencyQueue.shift();
    if (next) next();
  }

  // --- Sleep ---

  interruptibleSleep(ms: number): Promise<void> {
    const controller = new AbortController();
    this.sleepControllers.add(controller);
    const { signal } = controller;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }).finally(() => {
      this.sleepControllers.delete(controller);
    });
  }

  // --- Bot mode helpers ---

  isContinuousBot(botId: string): boolean {
    return this.getBotMode(botId) === 'continuous';
  }

  getBotMode(botId: string): 'periodic' | 'continuous' {
    const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
    return botConfig?.agentLoop?.mode ?? 'periodic';
  }

  // --- Schedule management ---

  syncSchedules(): void {
    const now = Date.now();
    for (const botId of this.ctx.runningBots) {
      if (!this.botSchedules.has(botId)) {
        const staggerOffset = this.botSchedules.size * 30_000;
        this.botSchedules.set(botId, {
          nextRunAt: now + staggerOffset,
          lastRunAt: null,
          lastResult: null,
          nextCheckIn: null,
          strategistCycleCount: 0,
          lastStrategistAt: null,
          lastFocus: null,
          continuousCycleCount: 0,
          sessionStartAt: null,
          recentActions: [],
          consecutiveIdleCycles: 0,
          lastLoggedSummary: null,
          retryCount: 0,
          lastErrorMessage: null,
          cyclesSinceAskHuman: 0,
        });
        this.ctx.logger.debug({ botId, staggerOffset }, 'Agent loop: added new bot to schedule');
      }
    }
    for (const botId of this.botSchedules.keys()) {
      if (!this.ctx.runningBots.has(botId)) {
        this.botSchedules.delete(botId);
        this.ctx.logger.debug({ botId }, 'Agent loop: removed stopped bot from schedule');
      }
    }
    this.schedulePersist();
  }

  updateBotSchedule(botId: string, botConfig: BotConfig, result: AgentLoopResult): void {
    const now = Date.now();
    const isContinuous = this.isContinuousBot(botId);
    const sleepMs = isContinuous ? 0 : this.computeBotSleepMs(botId, result);
    const globalConfig = this.ctx.config.agentLoop;
    const botEvery = botConfig.agentLoop?.every;
    const displayCheckIn = botEvery ?? globalConfig.every;
    const schedule = this.botSchedules.get(botId);
    if (schedule) {
      schedule.lastRunAt = now;
      schedule.lastResult = result;
      schedule.nextRunAt = now + sleepMs;
      schedule.nextCheckIn = displayCheckIn;
      if (isContinuous) schedule.continuousCycleCount++;
      if (result.strategistRan) {
        schedule.strategistCycleCount = 0;
        schedule.lastStrategistAt = now;
        schedule.lastFocus = result.focus ?? null;
      } else {
        schedule.strategistCycleCount++;
      }
      if (result.status !== 'error') {
        schedule.retryCount = 0;
        schedule.lastErrorMessage = null;
      }
    } else {
      this.botSchedules.set(botId, {
        nextRunAt: now + sleepMs,
        lastRunAt: now,
        lastResult: result,
        nextCheckIn: displayCheckIn,
        strategistCycleCount: result.strategistRan ? 0 : 1,
        lastStrategistAt: result.strategistRan ? now : null,
        lastFocus: result.focus ?? null,
        continuousCycleCount: isContinuous ? 1 : 0,
        sessionStartAt: null,
        recentActions: [],
        consecutiveIdleCycles: 0,
        lastLoggedSummary: null,
        retryCount: 0,
        lastErrorMessage: null,
        cyclesSinceAskHuman: 0,
      });
    }
    this.schedulePersist();
  }

  computeBotSleepMs(botId: string, result: AgentLoopResult): number {
    const globalConfig = this.ctx.config.agentLoop;
    const botEvery = this.ctx.config.bots.find((b) => b.id === botId)?.agentLoop?.every;
    if (result.status === 'error') {
      const normalMs = parseDurationMs(botEvery ?? globalConfig.every);
      return Math.max(normalMs, 5 * 60_000);
    }
    return parseDurationMs(botEvery ?? globalConfig.every);
  }

  // --- Bot loops ---

  syncBotLoops(): void {
    for (const botId of this.ctx.runningBots) {
      if (this.botLoops.has(botId)) continue;
      const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
      if (!botConfig) continue;
      const promise = this.runBotLoop(botId, botConfig);
      this.botLoops.set(botId, promise);
    }
    for (const botId of this.botLoops.keys()) {
      if (!this.ctx.runningBots.has(botId)) {
        this.botLoops.delete(botId);
      }
    }
  }

  // --- State query ---

  buildScheduleInfos(): BotScheduleInfo[] {
    const schedules: BotScheduleInfo[] = [];
    for (const [botId, sched] of this.botSchedules) {
      const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
      const mode = this.getBotMode(botId);
      schedules.push({
        botId,
        botName: botConfig?.name ?? botId,
        mode,
        nextRunAt: mode === 'continuous' ? null : sched.nextRunAt,
        lastRunAt: sched.lastRunAt,
        nextCheckIn: sched.nextCheckIn,
        lastStatus: sched.lastResult?.status ?? null,
        lastStrategistAt: sched.lastStrategistAt,
        lastFocus: sched.lastFocus,
        strategistCyclesUntilNext: computeCyclesUntilStrategist(
          botConfig, this.ctx.config.agentLoop.strategist, sched,
        ),
        continuousCycleCount: sched.continuousCycleCount,
        isIdle: sched.consecutiveIdleCycles > 0,
        consecutiveIdleCycles: sched.consecutiveIdleCycles,
        recentActionsSummary: sched.recentActions.slice(-5).map((a) => a.planSummary),
        retryCount: sched.retryCount,
        lastErrorMessage: sched.lastErrorMessage,
        isExecutingLoop: this.runningBotIds.has(botId),
      });
    }
    return schedules;
  }

  getEarliestRunAt(): number | null {
    let earliest: number | null = null;
    for (const [botId, sched] of this.botSchedules) {
      const mode = this.getBotMode(botId);
      if (mode !== 'continuous' && (earliest === null || sched.nextRunAt < earliest)) {
        earliest = sched.nextRunAt;
      }
    }
    return earliest;
  }

  // --- Private ---

  private async runLoop(): Promise<void> {
    this.ctx.logger.info('Agent loop: run loop started');
    while (this.enabled && !this.draining) {
      this.syncSchedules();
      this.syncBotLoops();
      if (!this.enabled || this.draining) break;
      await this.interruptibleSleep(5_000);
    }
    this.ctx.logger.info('Agent loop: run loop stopped');
  }

  private async runBotLoop(botId: string, botConfig: BotConfig): Promise<void> {
    const botLogger = this.ctx.getBotLogger(botId);
    const isContinuous = this.isContinuousBot(botId);
    const mode = isContinuous ? 'continuous' : 'periodic';

    botLogger.info({ botId, mode }, 'Bot loop started');

    while (this.enabled && !this.draining && this.ctx.runningBots.has(botId)) {
      if (this.runningBotIds.has(botId)) {
        await this.interruptibleSleep(1_000);
        continue;
      }

      this.runningBotIds.add(botId);
      let result: AgentLoopResult;
      await this.acquireConcurrency();
      try {
        result = await this.runOneBotFn(botId, botConfig);
        this.updateBotSchedule(botId, botConfig, result);
        this.lastResults = [result, ...this.lastResults.filter((r) => r.botId !== botId)];
        this.lastRunAt = Date.now();
      } catch (err) {
        botLogger.error({ botId, error: err }, 'Bot loop: unhandled error');
        const fallbackMs = this.computeBotSleepMs(botId, { status: 'error' } as AgentLoopResult);
        await this.interruptibleSleep(fallbackMs);
        continue;
      } finally {
        this.runningBotIds.delete(botId);
        this.releaseConcurrency();
      }

      if (!this.enabled || this.draining || !this.ctx.runningBots.has(botId)) break;

      // If an immediate run was requested while this bot was executing, skip sleep
      if (this.pendingWakeRequests.delete(botId)) {
        botLogger.info({ botId }, 'Agent loop: consumed pending wake — skipping sleep');
        continue;
      }

      const sleepMs = isContinuous
        ? (botConfig.agentLoop?.continuousPauseMs ?? 5_000)
        : this.computeBotSleepMs(botId, result);
      await this.interruptibleSleep(sleepMs);
    }

    this.botLoops.delete(botId);
    botLogger.info({ botId, mode }, 'Bot loop stopped');
  }
}
