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
}

/**
 * AgentScheduler manages per-bot scheduling, sleep, and concurrency.
 */
export class AgentScheduler {
  private sleepControllers = new Set<AbortController>();
  private botSchedules = new Map<string, BotSchedule>();
  private botLoops = new Map<string, Promise<void>>();
  private runningBotIds = new Set<string>();
  private concurrencyRunning = 0;
  private concurrencyQueue: Array<() => void> = [];
  private enabled = false;
  private loopPromise: Promise<void> | null = null;
  private lastRunAt: number | null = null;
  private lastResults: AgentLoopResult[] = [];

  constructor(
    private ctx: BotContext,
    private runOneBotFn: (botId: string, botConfig: BotConfig, opts?: { suppressSideEffects?: boolean }) => Promise<AgentLoopResult>,
  ) {}

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
    this.botSchedules.clear();
    this.botLoops.clear();
  }

  wakeUp(): void {
    for (const c of this.sleepControllers) c.abort();
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
      });
    }
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
    while (this.enabled) {
      this.syncSchedules();
      this.syncBotLoops();
      if (!this.enabled) break;
      await this.interruptibleSleep(5_000);
    }
    this.ctx.logger.info('Agent loop: run loop stopped');
  }

  private async runBotLoop(botId: string, botConfig: BotConfig): Promise<void> {
    const botLogger = this.ctx.getBotLogger(botId);
    const isContinuous = this.isContinuousBot(botId);
    const mode = isContinuous ? 'continuous' : 'periodic';

    botLogger.info({ botId, mode }, 'Bot loop started');

    while (this.enabled && this.ctx.runningBots.has(botId)) {
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

      if (!this.enabled || !this.ctx.runningBots.has(botId)) break;

      const sleepMs = isContinuous
        ? (botConfig.agentLoop?.continuousPauseMs ?? 5_000)
        : this.computeBotSleepMs(botId, result);
      await this.interruptibleSleep(sleepMs);
    }

    this.botLoops.delete(botId);
    botLogger.info({ botId, mode }, 'Bot loop stopped');
  }
}
