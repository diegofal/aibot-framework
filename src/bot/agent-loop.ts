import { type BotConfig, resolveAgentConfig } from '../config';
import type { ChatMessage } from '../ollama';
import type { Logger } from '../logger';
import type { BotContext } from './types';
import type { SystemPromptBuilder } from './system-prompt-builder';
import type { ToolRegistry } from './tool-registry';
import { buildPlannerPrompt, buildContinuousPlannerPrompt, buildExecutorPrompt, buildStrategistPrompt } from './agent-loop-prompts';
import type { PlannerResult, ContinuousPlannerResult } from './agent-loop-prompts';
import { parseGoals, serializeGoals } from '../tools/goals';
import { sendLongMessage } from './telegram-utils';
import { ToolExecutor, type ToolExecutionRecord } from './tool-executor';

interface GoalOperation {
  action: 'add' | 'complete' | 'update' | 'remove';
  goal: string;
  priority?: string;
  status?: string;
  notes?: string;
  outcome?: string;
}

interface StrategistResult {
  goal_operations: GoalOperation[];
  focus: string;
  reflection: string;
  next_strategy_in?: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  result: string;
}

export interface AgentLoopResult {
  botId: string;
  botName: string;
  status: 'completed' | 'skipped' | 'error';
  summary: string;
  durationMs: number;
  plannerReasoning: string;
  plan: string[];
  toolCalls: ToolCallRecord[];
  priority?: 'high' | 'medium' | 'low';
  strategistRan: boolean;
  strategistReflection?: string;
  focus?: string;
}

interface ExecuteLoopDetail {
  summary: string;
  plannerReasoning: string;
  plan: string[];
  toolCalls: ToolCallRecord[];
  priority?: 'high' | 'medium' | 'low';
  strategistRan: boolean;
  strategistReflection?: string;
  focus?: string;
}

interface BotSchedule {
  nextRunAt: number;
  lastRunAt: number | null;
  lastResult: AgentLoopResult | null;
  nextCheckIn: string | null;
  strategistCycleCount: number;
  lastStrategistAt: number | null;
  lastFocus: string | null;
  continuousCycleCount: number;
}

export interface BotScheduleInfo {
  botId: string;
  botName: string;
  mode: 'periodic' | 'continuous';
  nextRunAt: number | null;
  lastRunAt: number | null;
  nextCheckIn: string | null;
  lastStatus: 'completed' | 'skipped' | 'error' | null;
  lastStrategistAt: number | null;
  lastFocus: string | null;
  strategistCyclesUntilNext: number;
  continuousCycleCount: number;
}

export interface AgentLoopState {
  running: boolean;
  sleeping: boolean;
  lastRunAt: number | null;
  lastResults: AgentLoopResult[];
  nextRunAt: number | null;
  botSchedules: BotScheduleInfo[];
}

export function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * multipliers[unit];
}

export class AgentLoop {
  private enabled = false;
  private runningBotIds = new Set<string>();
  private sleepControllers = new Set<AbortController>();
  private loopPromise: Promise<void> | null = null;
  private lastRunAt: number | null = null;
  private lastResults: AgentLoopResult[] = [];
  private botSchedules = new Map<string, BotSchedule>();
  private botLoops = new Map<string, Promise<void>>();

  constructor(
    private ctx: BotContext,
    private systemPromptBuilder: SystemPromptBuilder,
    private toolRegistry: ToolRegistry,
  ) {}

  /** Start the continuous run loop */
  start(): void {
    if (!this.ctx.config.agentLoop.enabled) {
      this.ctx.logger.info('Agent loop disabled, not starting');
      return;
    }
    if (this.enabled) return;
    this.enabled = true;
    this.loopPromise = this.runLoop();
  }

  /** Stop the run loop */
  stop(): void {
    this.enabled = false;
    for (const c of this.sleepControllers) c.abort();
    this.botSchedules.clear();
    this.botLoops.clear();
  }

  /** Interrupt current sleep so the loop re-evaluates immediately */
  wakeUp(): void {
    for (const c of this.sleepControllers) c.abort();
  }

  /** Manual trigger — runs immediately for all periodic bots in parallel */
  async runNow(): Promise<AgentLoopResult[]> {
    const promises: Promise<AgentLoopResult>[] = [];
    for (const botId of this.ctx.runningBots) {
      if (this.runningBotIds.has(botId)) continue;
      const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
      if (!botConfig) continue;
      if (this.isContinuousBot(botId)) continue;

      this.runningBotIds.add(botId);
      promises.push(
        this.executeSingleBot(botId, botConfig)
          .then((result) => {
            this.updateBotSchedule(botId, botConfig, result);
            return result;
          })
          .finally(() => this.runningBotIds.delete(botId)),
      );
    }

    const settled = await Promise.allSettled(promises);
    const results = settled
      .filter((r): r is PromiseFulfilledResult<AgentLoopResult> => r.status === 'fulfilled')
      .map((r) => r.value);

    this.lastRunAt = Date.now();
    this.lastResults = results;
    this.wakeUp();
    return results;
  }

  /** Run for a single bot */
  async runOne(botId: string): Promise<AgentLoopResult> {
    const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      return { botId, botName: botId, status: 'error', summary: `Bot config not found: ${botId}`, durationMs: 0, plannerReasoning: '', plan: [], toolCalls: [], strategistRan: false };
    }
    if (!this.ctx.runningBots.has(botId)) {
      return { botId, botName: botConfig.name, status: 'skipped', summary: 'Bot not running', durationMs: 0, plannerReasoning: '', plan: [], toolCalls: [], strategistRan: false };
    }
    if (this.runningBotIds.has(botId)) {
      return { botId, botName: botConfig.name, status: 'skipped', summary: 'Bot already running', durationMs: 0, plannerReasoning: '', plan: [], toolCalls: [], strategistRan: false };
    }
    this.runningBotIds.add(botId);
    try {
      const result = await this.executeSingleBot(botId, botConfig);
      this.updateBotSchedule(botId, botConfig, result);
      this.wakeUp();
      return result;
    } finally {
      this.runningBotIds.delete(botId);
    }
  }

  /** Get current state (for API) */
  getState(): AgentLoopState {
    const schedules: BotScheduleInfo[] = [];
    let earliestRunAt: number | null = null;

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
        strategistCyclesUntilNext: this.computeCyclesUntilStrategist(botId, sched),
        continuousCycleCount: sched.continuousCycleCount,
      });
      if (mode !== 'continuous' && (earliestRunAt === null || sched.nextRunAt < earliestRunAt)) {
        earliestRunAt = sched.nextRunAt;
      }
    }

    return {
      running: this.runningBotIds.size > 0,
      sleeping: this.sleepControllers.size > 0,
      lastRunAt: this.lastRunAt,
      lastResults: [...this.lastResults],
      nextRunAt: earliestRunAt,
      botSchedules: schedules,
    };
  }

  private async runLoop(): Promise<void> {
    this.ctx.logger.info('Agent loop: run loop started');

    while (this.enabled) {
      this.syncSchedules();
      this.syncBotLoops();

      if (!this.enabled) break;
      // Poll periodically to pick up new/stopped bots
      await this.interruptibleSleep(5_000);
    }

    this.ctx.logger.info('Agent loop: run loop stopped');
  }

  /** Sync the schedules map with the current set of running bots */
  private syncSchedules(): void {
    const now = Date.now();
    // Add new bots (first run immediately)
    for (const botId of this.ctx.runningBots) {
      if (!this.botSchedules.has(botId)) {
        this.botSchedules.set(botId, {
          nextRunAt: now,
          lastRunAt: null,
          lastResult: null,
          nextCheckIn: null,
          strategistCycleCount: 0,
          lastStrategistAt: null,
          lastFocus: null,
          continuousCycleCount: 0,
        });
        this.ctx.logger.debug({ botId }, 'Agent loop: added new bot to schedule');
      }
    }
    // Remove stopped bots
    for (const botId of this.botSchedules.keys()) {
      if (!this.ctx.runningBots.has(botId)) {
        this.botSchedules.delete(botId);
        this.ctx.logger.debug({ botId }, 'Agent loop: removed stopped bot from schedule');
      }
    }
  }

  /** Update a bot's schedule after execution */
  private updateBotSchedule(botId: string, botConfig: BotConfig, result: AgentLoopResult): void {
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
      // Strategist tracking
      if (result.strategistRan) {
        schedule.strategistCycleCount = 0;
        schedule.lastStrategistAt = now;
        schedule.lastFocus = result.focus ?? null;
      } else {
        schedule.strategistCycleCount++;
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
      });
    }
  }

  /** Compute per-bot sleep from config — no longer uses planner-suggested intervals */
  private computeBotSleepMs(botId: string, result: AgentLoopResult): number {
    const globalConfig = this.ctx.config.agentLoop;
    const botEvery = this.ctx.config.bots.find((b) => b.id === botId)?.agentLoop?.every;

    if (result.status === 'error') {
      const normalMs = parseDurationMs(botEvery ?? globalConfig.every);
      return Math.max(normalMs, 5 * 60_000);
    }

    return parseDurationMs(botEvery ?? globalConfig.every);
  }

  private interruptibleSleep(ms: number): Promise<void> {
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

  /** Check if a bot is configured for continuous mode */
  private isContinuousBot(botId: string): boolean {
    return this.getBotMode(botId) === 'continuous';
  }

  /** Get the mode for a bot */
  private getBotMode(botId: string): 'periodic' | 'continuous' {
    const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
    return botConfig?.agentLoop?.mode ?? 'periodic';
  }

  /** Start/stop independent bot loops to match current running bots */
  private syncBotLoops(): void {
    // Start loops for new bots
    for (const botId of this.ctx.runningBots) {
      if (this.botLoops.has(botId)) continue;

      const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
      if (!botConfig) continue;

      const promise = this.runBotLoop(botId, botConfig);
      this.botLoops.set(botId, promise);
    }

    // Remove entries for stopped bots (their loops will exit on their own)
    for (const botId of this.botLoops.keys()) {
      if (!this.ctx.runningBots.has(botId)) {
        this.botLoops.delete(botId);
      }
    }
  }

  /** Run a single bot in its own independent async loop */
  private async runBotLoop(botId: string, botConfig: BotConfig): Promise<void> {
    const botLogger = this.ctx.getBotLogger(botId);
    const isContinuous = this.isContinuousBot(botId);
    const mode = isContinuous ? 'continuous' : 'periodic';

    botLogger.info({ botId, mode }, 'Bot loop started');

    while (this.enabled && this.ctx.runningBots.has(botId)) {
      if (this.runningBotIds.has(botId)) {
        // Another execution is in progress (manual trigger), wait
        await this.interruptibleSleep(1_000);
        continue;
      }

      this.runningBotIds.add(botId);
      let result: AgentLoopResult;
      try {
        result = await this.executeSingleBot(botId, botConfig);
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
      }

      if (!this.enabled || !this.ctx.runningBots.has(botId)) break;

      // Sleep between cycles
      const sleepMs = isContinuous
        ? (botConfig.agentLoop?.continuousPauseMs ?? 5_000)
        : this.computeBotSleepMs(botId, result);
      await this.interruptibleSleep(sleepMs);
    }

    this.botLoops.delete(botId);
    botLogger.info({ botId, mode }, 'Bot loop stopped');
  }

  private async executeSingleBot(botId: string, botConfig: BotConfig): Promise<AgentLoopResult> {
    const startMs = Date.now();
    const botLogger = this.ctx.getBotLogger(botId);
    const globalConfig = this.ctx.config.agentLoop;
    const botOverride = botConfig.agentLoop;

    botLogger.info({ botId }, 'Agent loop starting for bot');

    try {
      const detail = await Promise.race([
        this.executeLoop(botId, botConfig, botLogger),
        new Promise<ExecuteLoopDetail>((_, reject) => {
          setTimeout(
            () => reject(new Error(`Agent loop timed out after ${globalConfig.maxDurationMs}ms`)),
            globalConfig.maxDurationMs,
          );
        }),
      ]);

      const durationMs = Date.now() - startMs;
      const isContinuous = this.isContinuousBot(botId);

      // Log to daily memory
      // For continuous bots, throttle: only log every N cycles
      const schedule = this.botSchedules.get(botId);
      const memoryEvery = botConfig.agentLoop?.continuousMemoryEvery ?? 5;
      const shouldLog = !isContinuous || ((schedule?.continuousCycleCount ?? 0) + 1) % memoryEvery === 0;
      if (shouldLog) {
        this.logToMemory(botId, detail.summary);
      }

      // Send report if configured
      if (botOverride?.reportChatId) {
        await this.sendReport(botId, botOverride.reportChatId, detail.summary);
      }

      botLogger.info({ botId, durationMs, priority: detail.priority }, 'Agent loop completed for bot');
      return {
        botId,
        botName: botConfig.name,
        status: 'completed',
        summary: detail.summary,
        durationMs,
        plannerReasoning: detail.plannerReasoning,
        plan: detail.plan,
        toolCalls: detail.toolCalls,
        priority: detail.priority,
        strategistRan: detail.strategistRan,
        strategistReflection: detail.strategistReflection,
        focus: detail.focus,
      };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const errorMsg = `Agent loop error: ${err instanceof Error ? err.message : String(err)}`;
      botLogger.error({ botId, error: errorMsg }, 'Agent loop failed for bot');

      this.logToMemory(botId, `[ERROR] ${errorMsg}`);

      if (botOverride?.reportChatId) {
        await this.sendReport(botId, botOverride.reportChatId, errorMsg).catch(() => {});
      }

      return { botId, botName: botConfig.name, status: 'error', summary: errorMsg, durationMs, plannerReasoning: '', plan: [], toolCalls: [], strategistRan: false };
    }
  }

  private async executeLoop(
    botId: string,
    botConfig: BotConfig,
    botLogger: Logger,
  ): Promise<ExecuteLoopDetail> {
    const globalConfig = this.ctx.config.agentLoop;
    const botOverride = botConfig.agentLoop;
    const soulLoader = this.ctx.getSoulLoader(botId);
    const llmClient = this.ctx.getLLMClient(botId);
    const model = this.ctx.getActiveModel(botId);

    // Gather context
    const identity = soulLoader.readIdentity() || '(no identity)';
    const soul = soulLoader.readSoul() || '(no soul)';
    const motivations = soulLoader.readMotivations() || '(no motivations)';
    let goals = soulLoader.readGoals?.() || '';
    const recentMemory = soulLoader.readRecentDailyLogs();
    const datetime = new Date().toISOString();

    // Phase 0: Strategist (conditional)
    let strategistRan = false;
    let strategistReflection: string | undefined;
    let focus: string | undefined;

    if (this.shouldRunStrategist(botId, botConfig)) {
      const strategistResult = await this.runStrategist(botId, botConfig, botLogger, {
        identity, soul, motivations, goals, datetime, soulLoader,
      });
      if (strategistResult) {
        strategistRan = true;
        strategistReflection = strategistResult.reflection;
        focus = strategistResult.focus;
        // Re-read goals since strategist may have modified them
        goals = soulLoader.readGoals?.() || '';
      }
    }

    // If strategist didn't run this cycle, use lastFocus from schedule
    if (!focus) {
      const schedule = this.botSchedules.get(botId);
      if (schedule?.lastFocus) focus = schedule.lastFocus;
    }

    // Check for answered questions from previous cycles
    const answeredQuestions = this.ctx.askHumanStore.consumeAnswersForBot(botId);
    const pendingQuestions = this.ctx.askHumanStore.getPendingForBot(botId);

    if (answeredQuestions.length > 0) {
      botLogger.info(
        { botId, count: answeredQuestions.length },
        'Agent loop: injecting answered questions into planner',
      );
    }

    // Get available tools (respecting disabled tools from both global and per-bot)
    const allDisabled = new Set([
      ...(botConfig.disabledTools ?? []),
      ...(globalConfig.disabledTools ?? []),
      ...(botOverride?.disabledTools ?? []),
    ]);
    const baseDefs = this.toolRegistry.getDefinitionsForBot(botId);
    const defs = baseDefs.filter(
      (d) => !allDisabled.has(d.function.name),
    );
    const availableToolNames = defs.map((d) => d.function.name);

    // Phase 1: Planner
    const isContinuous = this.isContinuousBot(botId);
    botLogger.info({ botId, toolCount: defs.length, focus, mode: isContinuous ? 'continuous' : 'periodic' }, 'Agent loop: running planner');

    const hasCreateTool = availableToolNames.includes('create_tool');

    let plan: string[];
    let plannerReasoning: string;
    let priority: 'high' | 'medium' | 'low' | undefined;

    if (isContinuous) {
      // Continuous mode: always produces a plan
      const lastCycleSummary = this.botSchedules.get(botId)?.lastResult?.summary;
      const continuousInput = buildContinuousPlannerPrompt({
        identity,
        soul,
        motivations,
        goals,
        recentMemory,
        datetime,
        availableTools: availableToolNames,
        hasCreateTool,
        focus,
        lastCycleSummary: lastCycleSummary || undefined,
        answeredQuestions: answeredQuestions.map((q) => ({ question: q.question, answer: q.answer })),
        pendingQuestions: pendingQuestions.map((q) => ({ question: q.question })),
      });

      const continuousResult = await this.runContinuousPlannerWithRetry(
        llmClient,
        continuousInput,
        model,
        botLogger,
      );

      plan = continuousResult.plan;
      plannerReasoning = continuousResult.reasoning;
      priority = continuousResult.priority;
    } else {
      // Periodic mode: always produces a plan (no skip gate)
      const plannerInput = buildPlannerPrompt({
        identity,
        soul,
        motivations,
        goals,
        recentMemory,
        datetime,
        availableTools: availableToolNames,
        hasCreateTool,
        focus,
        answeredQuestions: answeredQuestions.map((q) => ({ question: q.question, answer: q.answer })),
        pendingQuestions: pendingQuestions.map((q) => ({ question: q.question })),
      });

      const plannerResult = await this.runPlannerWithRetry(
        llmClient,
        plannerInput,
        model,
        botLogger,
      );

      plan = plannerResult.plan;
      plannerReasoning = plannerResult.reasoning;
      priority = plannerResult.priority;
    }

    if (plan.length === 0) {
      return { summary: 'Planner produced no plan steps.', plannerReasoning, plan: [], toolCalls: [], priority, strategistRan, strategistReflection, focus };
    }

    botLogger.info(
      { botId, planSteps: plan.length, reasoning: plannerReasoning },
      'Agent loop: executing plan',
    );

    // Phase 2: Executor
    const executorSystem = this.systemPromptBuilder.build({
      mode: 'autonomous',
      botId,
      botConfig,
      isGroup: false,
    });

    const agentConfig = resolveAgentConfig(this.ctx.config, botConfig);
    const executorUserPrompt = buildExecutorPrompt({
      plan,
      identity,
      soul,
      motivations,
      goals,
      datetime,
      hasCreateTool,
      workDir: agentConfig.workDir,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: executorSystem },
      { role: 'user', content: executorUserPrompt },
    ];

    // Build a tool executor that respects the agent loop's disabled tools
    const toolCallLog: ToolExecutionRecord[] = [];
    const executor = new ToolExecutor(this.ctx, {
      botId,
      chatId: botOverride?.reportChatId ?? 0,
      disabledTools: allDisabled,
      enableLogging: true,
    });

    const response = await llmClient.chat(messages, {
      model,
      temperature: 0.7,
      tools: defs,
      toolExecutor: executor.createCallback(),
      maxToolRounds: globalConfig.maxToolRounds,
    });

    // Extract logged tool calls
    toolCallLog.push(...executor.getExecutionLog());

    return {
      summary: response || '(no response from executor)',
      plannerReasoning,
      plan,
      toolCalls: toolCallLog,
      priority,
      strategistRan,
      strategistReflection,
      focus,
    };
  }

  private shouldRunStrategist(botId: string, botConfig: BotConfig): boolean {
    const globalConfig = this.ctx.config.agentLoop.strategist;
    const botOverride = botConfig.agentLoop?.strategist;

    // Check if enabled
    const enabled = botOverride?.enabled ?? globalConfig.enabled;
    if (!enabled) return false;

    const schedule = this.botSchedules.get(botId);
    if (!schedule) return true; // First run — run strategist

    const everyCycles = botOverride?.everyCycles ?? globalConfig.everyCycles;
    const minInterval = botOverride?.minInterval ?? globalConfig.minInterval;

    // AND condition: both must be met
    const cyclesMet = schedule.strategistCycleCount >= everyCycles;
    const intervalMet = schedule.lastStrategistAt === null ||
      (Date.now() - schedule.lastStrategistAt) >= parseDurationMs(minInterval);

    return cyclesMet && intervalMet;
  }

  private async runStrategist(
    botId: string,
    botConfig: BotConfig,
    botLogger: Logger,
    soulContext: {
      identity: string;
      soul: string;
      motivations: string;
      goals: string;
      datetime: string;
      soulLoader: ReturnType<BotContext['getSoulLoader']>;
    },
  ): Promise<StrategistResult | null> {
    const llmClient = this.ctx.getLLMClient(botId);
    const model = this.ctx.getActiveModel(botId);

    // Get 7-day memory for strategic review
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const recentMemory = soulContext.soulLoader.readDailyLogsSince(sevenDaysAgo);

    botLogger.info({ botId }, 'Agent loop: running strategist');

    const input = buildStrategistPrompt({
      identity: soulContext.identity,
      soul: soulContext.soul,
      motivations: soulContext.motivations,
      goals: soulContext.goals,
      recentMemory,
      datetime: soulContext.datetime,
    });

    const result = await this.runStrategistWithRetry(llmClient, input, model, botLogger);
    if (!result) {
      botLogger.warn({ botId }, 'Agent loop: strategist returned unparseable output, continuing without');
      return null;
    }

    // Apply goal operations
    if (result.goal_operations?.length > 0) {
      this.applyGoalOperations(botId, result.goal_operations, botLogger, soulContext.soulLoader);
    }

    // Log strategist reflection to memory
    const reflectionEntry = `[strategist] Focus: ${result.focus}\nReflection: ${result.reflection}`;
    this.logToMemory(botId, reflectionEntry);

    botLogger.info(
      { botId, focus: result.focus, goalOps: result.goal_operations?.length ?? 0 },
      'Agent loop: strategist completed',
    );

    return result;
  }

  private async runStrategistWithRetry(
    llmClient: import('../core/llm-client').LLMClient,
    input: { system: string; prompt: string },
    model: string,
    logger: Logger,
    maxRetries = 1,
  ): Promise<StrategistResult | null> {
    const temperatures = [0.4, 0];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const raw = await llmClient.generate(input.prompt, {
        system: input.system,
        model,
        temperature: temperatures[attempt] ?? 0,
      });

      const result = this.parseStrategistResult(raw, logger);
      if (result) {
        if (attempt > 0) {
          logger.info({ attempt }, 'Agent loop: strategist succeeded on retry');
        }
        return result;
      }

      if (attempt < maxRetries) {
        logger.warn({ attempt, raw: raw.slice(0, 200) }, 'Agent loop: strategist failed to parse, retrying with temperature 0');
      }
    }

    return null;
  }

  private parseStrategistResult(raw: string, logger: Logger): StrategistResult | null {
    let cleaned = raw.trim();

    // Strip markdown fences
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    // Extract JSON if surrounded by prose
    if (!cleaned.startsWith('{')) {
      const match = cleaned.match(/\{[\s\S]*"focus"[\s\S]*\}/);
      if (match) cleaned = match[0];
    }

    try {
      const parsed = JSON.parse(cleaned);
      if (!parsed.focus || !parsed.reflection) {
        logger.warn({ raw: raw.slice(0, 300) }, 'Agent loop: strategist result missing required fields');
        return null;
      }
      return {
        goal_operations: Array.isArray(parsed.goal_operations) ? parsed.goal_operations : [],
        focus: String(parsed.focus),
        reflection: String(parsed.reflection),
        next_strategy_in: parsed.next_strategy_in ? String(parsed.next_strategy_in) : undefined,
      };
    } catch {
      logger.warn({ raw: raw.slice(0, 500) }, 'Agent loop: failed to parse strategist JSON');
      return null;
    }
  }

  private applyGoalOperations(
    botId: string,
    operations: GoalOperation[],
    logger: Logger,
    soulLoader: ReturnType<BotContext['getSoulLoader']>,
  ): void {
    const content = soulLoader.readGoals?.() ?? null;
    const { active, completed } = parseGoals(content);

    for (const op of operations) {
      switch (op.action) {
        case 'add': {
          active.push({
            text: op.goal,
            status: 'pending',
            priority: op.priority ?? 'medium',
            notes: op.notes,
          });
          logger.debug({ goal: op.goal }, 'Strategist: added goal');
          break;
        }
        case 'complete': {
          const lower = op.goal.toLowerCase();
          const idx = active.findIndex((g) => g.text.toLowerCase().includes(lower));
          if (idx === -1) {
            logger.debug({ goal: op.goal }, 'Strategist: goal to complete not found, skipping');
            break;
          }
          const [goal] = active.splice(idx, 1);
          goal.status = 'completed';
          goal.completed = new Date().toISOString().slice(0, 10);
          if (op.outcome) goal.outcome = op.outcome;
          completed.push(goal);
          logger.debug({ goal: goal.text }, 'Strategist: completed goal');
          break;
        }
        case 'update': {
          const lower = op.goal.toLowerCase();
          const found = active.find((g) => g.text.toLowerCase().includes(lower));
          if (!found) {
            logger.debug({ goal: op.goal }, 'Strategist: goal to update not found, skipping');
            break;
          }
          if (op.status) found.status = op.status;
          if (op.priority) found.priority = op.priority;
          if (op.notes) found.notes = op.notes;
          logger.debug({ goal: found.text }, 'Strategist: updated goal');
          break;
        }
        case 'remove': {
          const lower = op.goal.toLowerCase();
          const idx = active.findIndex((g) => g.text.toLowerCase().includes(lower));
          if (idx === -1) {
            logger.debug({ goal: op.goal }, 'Strategist: goal to remove not found, skipping');
            break;
          }
          const [removed] = active.splice(idx, 1);
          logger.debug({ goal: removed.text }, 'Strategist: removed goal');
          break;
        }
        default:
          logger.debug({ action: op.action }, 'Strategist: unknown goal operation, skipping');
      }
    }

    soulLoader.writeGoals(serializeGoals(active, completed));
  }

  private computeCyclesUntilStrategist(botId: string, schedule: BotSchedule): number {
    const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
    const globalConfig = this.ctx.config.agentLoop.strategist;
    const botOverride = botConfig?.agentLoop?.strategist;
    const everyCycles = botOverride?.everyCycles ?? globalConfig.everyCycles;
    return Math.max(0, everyCycles - schedule.strategistCycleCount);
  }

  private async runPlannerWithRetry(
    llmClient: import('../core/llm-client').LLMClient,
    plannerInput: { system: string; prompt: string },
    model: string,
    botLogger: Logger,
    maxRetries = 1,
  ): Promise<PlannerResult> {
    const temperatures = [0.3, 0];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const plannerRaw = await llmClient.generate(plannerInput.prompt, {
        system: plannerInput.system,
        model,
        temperature: temperatures[attempt] ?? 0,
      });

      const result = this.parsePlannerResult(plannerRaw, botLogger);
      if (result) {
        if (attempt > 0) {
          botLogger.info({ attempt }, 'Agent loop: planner succeeded on retry');
        }
        return result;
      }

      if (attempt < maxRetries) {
        botLogger.warn({ attempt, raw: plannerRaw.slice(0, 200) }, 'Agent loop: planner failed to parse, retrying with temperature 0');
      }
    }

    // All retries exhausted — always produce a plan
    return {
      reasoning: 'Failed to parse planner output after retries',
      plan: ['Review current goals and update status'],
      priority: 'low',
    };
  }

  private parsePlannerResult(raw: string, logger: Logger): PlannerResult | null {
    let cleaned = raw.trim();

    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    if (!cleaned.startsWith('{')) {
      const match = cleaned.match(/\{[\s\S]*"plan"[\s\S]*\}/);
      if (match) cleaned = match[0];
    }

    try {
      const parsed = JSON.parse(cleaned);
      if (!parsed.reasoning || !Array.isArray(parsed.plan) || parsed.plan.length === 0) {
        logger.warn({ raw: raw.slice(0, 300) }, 'Agent loop: planner result missing required fields');
        return null;
      }
      return {
        reasoning: String(parsed.reasoning),
        plan: parsed.plan.map(String),
        priority: ['high', 'medium', 'low'].includes(parsed.priority) ? parsed.priority : 'medium',
      };
    } catch {
      logger.warn({ raw: raw.slice(0, 500) }, 'Agent loop: failed to parse planner JSON');
      return null;
    }
  }

  private async runContinuousPlannerWithRetry(
    llmClient: import('../core/llm-client').LLMClient,
    plannerInput: { system: string; prompt: string },
    model: string,
    botLogger: Logger,
    maxRetries = 1,
  ): Promise<ContinuousPlannerResult> {
    const temperatures = [0.3, 0];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const raw = await llmClient.generate(plannerInput.prompt, {
        system: plannerInput.system,
        model,
        temperature: temperatures[attempt] ?? 0,
      });

      const result = this.parseContinuousPlannerResult(raw, botLogger);
      if (result) {
        if (attempt > 0) {
          botLogger.info({ attempt }, 'Agent loop: continuous planner succeeded on retry');
        }
        return result;
      }

      if (attempt < maxRetries) {
        botLogger.warn({ attempt, raw: raw.slice(0, 200) }, 'Agent loop: continuous planner failed to parse, retrying with temperature 0');
      }
    }

    // Fallback: return a generic plan
    return {
      reasoning: 'Failed to parse continuous planner output after retries',
      plan: ['Review current goals and update status'],
      priority: 'low',
    };
  }

  private parseContinuousPlannerResult(raw: string, logger: Logger): ContinuousPlannerResult | null {
    let cleaned = raw.trim();

    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    if (!cleaned.startsWith('{')) {
      const match = cleaned.match(/\{[\s\S]*"plan"[\s\S]*\}/);
      if (match) cleaned = match[0];
    }

    try {
      const parsed = JSON.parse(cleaned);
      if (!parsed.reasoning || !Array.isArray(parsed.plan) || parsed.plan.length === 0) {
        logger.warn({ raw: raw.slice(0, 300) }, 'Agent loop: continuous planner result missing required fields');
        return null;
      }
      return {
        reasoning: String(parsed.reasoning),
        plan: parsed.plan.map(String),
        priority: ['high', 'medium', 'low'].includes(parsed.priority) ? parsed.priority : 'medium',
      };
    } catch {
      logger.warn({ raw: raw.slice(0, 500) }, 'Agent loop: failed to parse continuous planner JSON');
      return null;
    }
  }

  private logToMemory(botId: string, summary: string): void {
    try {
      const soulLoader = this.ctx.getSoulLoader(botId);
      const truncated = summary.length > 500 ? summary.slice(0, 500) + '...' : summary;
      soulLoader.appendDailyMemory(`[agent-loop] ${truncated}`);
    } catch (err) {
      this.ctx.logger.warn({ err, botId }, 'Agent loop: failed to log to memory');
    }
  }

  private async sendReport(botId: string, chatId: number, summary: string): Promise<void> {
    const bot = this.ctx.bots.get(botId);
    if (!bot) return;

    const header = `🤖 **Agent Loop Report**\n\n`;
    const report = header + summary;
    try {
      await sendLongMessage((t) => bot.api.sendMessage(chatId, t), report);
    } catch (err) {
      this.ctx.getBotLogger(botId).warn({ err, chatId }, 'Agent loop: failed to send report');
    }
  }
}
