import { join } from 'node:path';
import { type BotConfig, resolveAgentConfig } from '../config';
import type { Logger } from '../logger';
import type { ChatMessage } from '../ollama';
import { ClaudeCliLLMClient } from '../core/llm-client';
import type { BotContext } from './types';
import type { SystemPromptBuilder } from './system-prompt-builder';
import { TOOL_CATEGORY_NAMES, type ToolCategory, type ToolRegistry } from './tool-registry';
import { buildPlannerPrompt, buildContinuousPlannerPrompt, buildExecutorPrompt, buildFeedbackProcessorPrompt } from './agent-loop-prompts';
import type { PlannerResult } from './agent-loop-prompts';
import type { AgentFeedback } from './agent-feedback-store';
import { ToolExecutor, type ToolExecutionRecord } from './tool-executor';
import type { KarmaService } from '../karma/service';
import {
  buildRecentActionsDigest,
  isSimilarSummary,
  isRepetitiveAction,
  scanFileTree,
  logToMemory,
  sendReport,
} from './agent-loop-utils';
import {
  resolveRetryConfig,
  executeSingleBotWithRetry as _executeSingleBotWithRetry,
} from './agent-retry-engine';
import { runPlannerWithRetry } from './agent-planner';
import {
  shouldRunStrategist,
  runStrategist,
  type StrategistResult,
} from './agent-strategist';
import { AgentScheduler } from './agent-scheduler';

// Backward-compat re-exports — consumers may import these from agent-loop
export { isRetryableError, computeRetryDelay } from './agent-retry-engine';
export { parseStrategistResult } from './agent-strategist';

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
  priority?: 'high' | 'medium' | 'low' | 'none';
  strategistRan: boolean;
  strategistReflection?: string;
  focus?: string;
  isIdle?: boolean;
  consecutiveIdleCycles?: number;
  retryAttempt?: number;
  /** Tool categories selected by planner for pre-selection */
  selectedToolCategories?: string[];
  /** Number of tool definitions sent to executor after pre-selection */
  executorToolCount?: number;
}

interface ExecuteLoopDetail {
  summary: string;
  plannerReasoning: string;
  plan: string[];
  toolCalls: ToolCallRecord[];
  priority?: 'high' | 'medium' | 'low' | 'none';
  strategistRan: boolean;
  strategistReflection?: string;
  focus?: string;
  selectedToolCategories?: string[];
  executorToolCount?: number;
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
  isIdle: boolean;
  consecutiveIdleCycles: number;
  recentActionsSummary: string[];
  retryCount: number;
  lastErrorMessage: string | null;
  isExecutingLoop: boolean;
}

export interface AgentLoopState {
  running: boolean;
  sleeping: boolean;
  draining: boolean;
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
  private scheduler: AgentScheduler;
  private karmaService: KarmaService | null = null;

  constructor(
    private ctx: BotContext,
    private systemPromptBuilder: SystemPromptBuilder,
    private toolRegistry: ToolRegistry,
  ) {
    this.scheduler = new AgentScheduler(
      ctx,
      (botId, botConfig) => this.executeBotWithRetry(botId, botConfig),
      join(ctx.config.paths.data, 'agent-scheduler'),
    );
  }

  setKarmaService(karmaService: KarmaService): void {
    this.karmaService = karmaService;
  }

  /** Start the continuous run loop */
  start(): void {
    this.scheduler.start();
  }

  /** Stop the run loop */
  stop(): void {
    this.scheduler.stop();
  }

  /** Interrupt current sleep so the loop re-evaluates immediately */
  wakeUp(): void {
    this.scheduler.wakeUp();
  }

  /** Gracefully stop: wait for executing cycles to finish, then stop */
  async gracefulStop(timeoutMs?: number): Promise<void> {
    return this.scheduler.gracefulStop(timeoutMs);
  }

  /** Manual trigger — runs immediately for all periodic bots in parallel */
  async runNow(): Promise<AgentLoopResult[]> {
    const runningBotIds = this.scheduler.getRunningBotIds();
    const promises: Promise<AgentLoopResult>[] = [];
    for (const botId of this.ctx.runningBots) {
      if (runningBotIds.has(botId)) continue;
      const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
      if (!botConfig) continue;
      if (this.scheduler.isContinuousBot(botId)) continue;

      runningBotIds.add(botId);
      promises.push(
        this.executeSingleBot(botId, botConfig)
          .then((result) => {
            this.scheduler.updateBotSchedule(botId, botConfig, result);
            return result;
          })
          .finally(() => runningBotIds.delete(botId)),
      );
    }

    const settled = await Promise.allSettled(promises);
    const results = settled
      .filter((r): r is PromiseFulfilledResult<AgentLoopResult> => r.status === 'fulfilled')
      .map((r) => r.value);

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
    const runningBotIds = this.scheduler.getRunningBotIds();
    if (runningBotIds.has(botId)) {
      return { botId, botName: botConfig.name, status: 'skipped', summary: 'Bot already running', durationMs: 0, plannerReasoning: '', plan: [], toolCalls: [], strategistRan: false };
    }
    runningBotIds.add(botId);
    try {
      const result = await this.executeSingleBot(botId, botConfig);
      this.scheduler.updateBotSchedule(botId, botConfig, result);
      this.wakeUp();
      return result;
    } finally {
      runningBotIds.delete(botId);
    }
  }

  /** Get current state (for API) */
  getState(): AgentLoopState {
    return {
      running: this.scheduler.getRunningBotIds().size > 0,
      sleeping: this.scheduler.isSleeping(),
      draining: this.scheduler.isDraining(),
      lastRunAt: this.scheduler.getLastRunAt(),
      lastResults: this.scheduler.getLastResults(),
      nextRunAt: this.scheduler.getEarliestRunAt(),
      botSchedules: this.scheduler.buildScheduleInfos(),
    };
  }

  /** Retry-wrapped execution — delegates to extracted retry engine */
  private async executeBotWithRetry(botId: string, botConfig: BotConfig): Promise<AgentLoopResult> {
    const retryConfig = resolveRetryConfig(this.ctx.config.agentLoop.retry, botConfig);
    const botLogger = this.ctx.getBotLogger(botId);
    return _executeSingleBotWithRetry(botId, botConfig, retryConfig, botLogger, {
      executeFn: (id, cfg, opts) => this.executeSingleBot(id, cfg, opts),
      getSchedule: (id) => this.scheduler.getSchedule(id),
      sleepFn: (ms) => this.scheduler.interruptibleSleep(ms),
      isEnabled: () => this.scheduler.isEnabled(),
      isBotRunning: (id) => this.ctx.runningBots.has(id),
    });
  }

  private async executeSingleBot(botId: string, botConfig: BotConfig, options?: { suppressSideEffects?: boolean }): Promise<AgentLoopResult> {
    const startMs = Date.now();
    const botLogger = this.ctx.getBotLogger(botId);
    const globalConfig = this.ctx.config.agentLoop;
    const botOverride = botConfig.agentLoop;

    // Track session start time for timeout guard
    const schedule = this.scheduler.getSchedule(botId);
    if (schedule) {
      schedule.sessionStartAt = startMs;
    }

    // Session timeout guard: 80% of hard limit = 240s of 300s
    const SESSION_TIMEOUT_GUARD_MS = globalConfig.maxDurationMs * 0.8;
    let sessionTimeoutWarningEmitted = false;

    const checkSessionTimeout = (operation: string): boolean => {
      const elapsed = Date.now() - startMs;
      if (elapsed >= SESSION_TIMEOUT_GUARD_MS && !sessionTimeoutWarningEmitted) {
        sessionTimeoutWarningEmitted = true;
        botLogger.warn(
          { botId, elapsedMs: elapsed, limitMs: SESSION_TIMEOUT_GUARD_MS, operation },
          'Agent loop: approaching session timeout limit (80%), initiating graceful shutdown'
        );
        return false;
      }
      return true;
    };

    botLogger.info({ botId }, 'Agent loop starting for bot');

    try {
      const startMs = Date.now();

      const remainingTimeMs = (): number => {
        const elapsed = Date.now() - startMs;
        return Math.max(0, globalConfig.maxDurationMs - elapsed);
      };

      const detail = await Promise.race([
        this.executeLoop(botId, botConfig, botLogger, checkSessionTimeout, remainingTimeMs),
        new Promise<ExecuteLoopDetail>((_, reject) => {
          setTimeout(
            () => reject(new Error(`Agent loop timed out after ${globalConfig.maxDurationMs}ms`)),
            globalConfig.maxDurationMs,
          );
        }),
      ]);

      const durationMs = Date.now() - startMs;
      const isContinuous = this.scheduler.isContinuousBot(botId);
      const schedule = this.scheduler.getSchedule(botId);
      const isIdle = detail.plan.length === 0 || detail.priority === 'none';
      const idleSuppression = globalConfig.idleSuppression !== false;

      // Track idle cycles
      if (schedule) {
        if (isIdle) {
          schedule.consecutiveIdleCycles++;
        } else {
          if (schedule.consecutiveIdleCycles > 0) {
            logToMemory(this.ctx, botId, `[agent-loop] Resuming after ${schedule.consecutiveIdleCycles} idle cycles.`);
          }
          schedule.consecutiveIdleCycles = 0;
        }

        // Track recent actions for repetition detection
        if (!isIdle) {
          const toolNames = detail.toolCalls.map((t) => t.name);
          const planSummary = detail.plan.join('; ').slice(0, 200);
          schedule.recentActions.push({
            cycle: (schedule.continuousCycleCount ?? 0) + 1,
            timestamp: Date.now(),
            tools: toolNames,
            planSummary,
          });
          const cutoff = Date.now() - 24 * 3_600_000;
          schedule.recentActions = schedule.recentActions
            .filter((a) => a.timestamp >= cutoff)
            .slice(-20);
        }

        // Track cycles since last ask_human usage
        const usedAskHuman = detail.toolCalls.some((t) => t.name === 'ask_human');
        if (usedAskHuman) {
          schedule.cyclesSinceAskHuman = 0;
        } else if (!isIdle) {
          schedule.cyclesSinceAskHuman++;
        }
      }

      // Karma: track novel vs repetitive actions
      if (this.karmaService && this.ctx.config.karma?.enabled && schedule && !isIdle) {
        const planSummary = detail.plan.join('; ').slice(0, 200);
        const isRepetitive = isRepetitiveAction(schedule.recentActions, planSummary);
        if (isRepetitive) {
          this.karmaService.addEvent(botId, -2, `Repeated action: ${planSummary.slice(0, 80)}`, 'agent-loop');
        } else {
          this.karmaService.addEvent(botId, 1, `Novel action: ${planSummary.slice(0, 80)}`, 'agent-loop');
        }
      }

      // Memory logging with dedup and idle suppression
      if (idleSuppression && isIdle) {
        if (schedule && schedule.consecutiveIdleCycles === 1) {
          logToMemory(this.ctx, botId, '[agent-loop] Idle — no novel action found. Awaiting next trigger.');
        }
      } else {
        const memoryEvery = botConfig.agentLoop?.continuousMemoryEvery ?? 5;
        const shouldLog = !isContinuous || ((schedule?.continuousCycleCount ?? 0) + 1) % memoryEvery === 0;
        if (shouldLog) {
          const shouldDedup = schedule && isSimilarSummary(detail.summary, schedule.lastLoggedSummary ?? '');
          if (!shouldDedup) {
            logToMemory(this.ctx, botId, detail.summary);
            if (schedule) schedule.lastLoggedSummary = detail.summary;
          }
        }
      }

      // Send report if configured
      if (botOverride?.reportChatId) {
        await sendReport(this.ctx, botId, botOverride.reportChatId, detail.summary);
      }

      botLogger.info({ botId, durationMs, priority: detail.priority, isIdle }, 'Agent loop completed for bot');
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
        isIdle,
        consecutiveIdleCycles: schedule?.consecutiveIdleCycles ?? 0,
        selectedToolCategories: detail.selectedToolCategories,
        executorToolCount: detail.executorToolCount,
      };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const errorMsg = `Agent loop error: ${err instanceof Error ? err.message : String(err)}`;
      botLogger.error({ botId, error: errorMsg }, 'Agent loop failed for bot');

      if (!options?.suppressSideEffects) {
        logToMemory(this.ctx, botId, `[ERROR] ${errorMsg}`);

        if (botOverride?.reportChatId) {
          await sendReport(this.ctx, botId, botOverride.reportChatId, errorMsg).catch(() => {});
        }
      }

      return { botId, botName: botConfig.name, status: 'error', summary: errorMsg, durationMs, plannerReasoning: '', plan: [], toolCalls: [], strategistRan: false };
    }
  }

  private async executeLoop(
    botId: string,
    botConfig: BotConfig,
    botLogger: Logger,
    checkTimeout?: (operation: string) => boolean,
    remainingTimeMs?: () => number,
  ): Promise<ExecuteLoopDetail> {
    const globalConfig = this.ctx.config.agentLoop;
    const botOverride = botConfig.agentLoop;
    const soulLoader = this.ctx.getSoulLoader(botId);
    const llmClient = this.ctx.getLLMClient(botId);
    const model = this.ctx.getActiveModel(botId);

    // Helper to wrap async operations with dynamic timeout
    const withTimeout = async <T>(
      operation: () => Promise<T>,
      operationName: string,
      minTimeMs: number = 5000,
    ): Promise<T> => {
      const remaining = remainingTimeMs ? remainingTimeMs() : globalConfig.maxDurationMs;
      const timeoutMs = Math.max(minTimeMs, remaining - 5000);

      return Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`${operationName} timed out after ${timeoutMs}ms (session timeout guard)`));
          }, timeoutMs);
        }),
      ]);
    };

    // Gather context
    let identity = soulLoader.readIdentity() || '(no identity)';
    let soul = soulLoader.readSoul() || '(no soul)';
    let motivations = soulLoader.readMotivations() || '(no motivations)';
    let goals = soulLoader.readGoals?.() || '';
    const recentMemory = soulLoader.readRecentDailyLogs();
    const datetime = new Date().toISOString();

    // Phase -1: Process pending human feedback
    if (checkTimeout && !checkTimeout('before_feedback')) {
      return { summary: 'Session timeout guard triggered before feedback processing', plannerReasoning: '', plan: [], toolCalls: [], priority: 'high', strategistRan: false };
    }
    const pendingFeedback = this.ctx.agentFeedbackStore.getPending(botId);
    if (pendingFeedback.length > 0) {
      await withTimeout(
        () => this.processFeedback(botId, botConfig, botLogger, pendingFeedback, soulLoader),
        'Feedback processing',
        30000,
      );
      identity = soulLoader.readIdentity() || '(no identity)';
      soul = soulLoader.readSoul() || '(no soul)';
      motivations = soulLoader.readMotivations() || '(no motivations)';
      goals = soulLoader.readGoals?.() || '';
    }

    // Phase 0: Strategist (conditional)
    if (checkTimeout && !checkTimeout('before_strategist')) {
      return { summary: 'Session timeout guard triggered before strategist', plannerReasoning: '', plan: [], toolCalls: [], priority: 'high', strategistRan: false };
    }
    let strategistRan = false;
    let strategistReflection: string | undefined;
    let focus: string | undefined;

    const schedule = this.scheduler.getSchedule(botId);
    if (shouldRunStrategist(botId, botConfig, globalConfig.strategist, schedule)) {
      const strategistResult = await withTimeout(
        () => runStrategist(this.ctx, botId, botConfig, botLogger, {
          identity, soul, motivations, goals, datetime, soulLoader,
        }),
        'Strategist',
        60000,
      );
      if (strategistResult) {
        strategistRan = true;
        strategistReflection = strategistResult.reflection;
        focus = strategistResult.focus;
        goals = soulLoader.readGoals?.() || '';
      }
    }

    // If strategist didn't run this cycle, use lastFocus from schedule
    if (!focus) {
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

    // Check for permission decisions from previous cycles
    const resolvedPermissions = this.ctx.askPermissionStore.consumeDecisionsForBot(botId);
    const consumedPermissionIds = resolvedPermissions.map(p => p.id);
    const pendingPermissions = this.ctx.askPermissionStore.getPendingForBot(botId);

    if (resolvedPermissions.length > 0) {
      botLogger.info(
        { botId, count: resolvedPermissions.length },
        'Agent loop: injecting permission decisions into planner',
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
    if (checkTimeout && !checkTimeout('before_planner')) {
      return { summary: 'Session timeout guard triggered before planner', plannerReasoning: '', plan: [], toolCalls: [], priority: 'high', strategistRan, strategistReflection, focus };
    }
    const isContinuous = this.scheduler.isContinuousBot(botId);
    botLogger.info({ botId, toolCount: defs.length, focus, mode: isContinuous ? 'continuous' : 'periodic' }, 'Agent loop: running planner');

    const hasCreateTool = availableToolNames.includes('create_tool');

    let plan: string[];
    let plannerReasoning: string;
    let priority: 'high' | 'medium' | 'low' | 'none' | undefined;
    let selectedToolCategories: string[] | undefined;

    // Tool pre-selection: planner picks categories, executor gets fewer tools
    const toolPreSelectionEnabled = globalConfig.toolPreSelection !== false;
    const toolCategoryList = toolPreSelectionEnabled ? [...TOOL_CATEGORY_NAMES] : undefined;

    // Build recent actions digest and karma block for planner context
    const recentActionsDigest = schedule ? buildRecentActionsDigest(schedule.recentActions) : null;
    const karmaBlock = this.karmaService && this.ctx.config.karma?.enabled
      ? this.karmaService.renderForPrompt(botId)
      : undefined;

    // Build autonomous cycles note if bot hasn't used ask_human recently
    const askHumanCheckInThreshold = globalConfig.askHumanCheckInCycles ?? 5;
    const cyclesSinceAskHuman = schedule?.cyclesSinceAskHuman ?? 0;
    const autonomousCyclesNote = cyclesSinceAskHuman >= askHumanCheckInThreshold
      ? `## Autonomous Run Notice\n\nYou have been running autonomously for ${cyclesSinceAskHuman} cycles without checking in with your human operator. Consider using ask_human to check in — ask for feedback on recent work, confirm priorities, or request direction.`
      : undefined;

    if (isContinuous) {
      const lastCycleSummary = schedule?.lastResult?.summary;
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
        resolvedPermissions: resolvedPermissions.map((p) => ({ action: p.action, resource: p.resource, status: p.status, note: p.note })),
        pendingPermissions: pendingPermissions.map((p) => ({ action: p.action, resource: p.resource })),
        recentActionsDigest: recentActionsDigest || undefined,
        karmaBlock,
        autonomousCyclesNote,
        toolCategoryList,
      });

      const continuousResult = await withTimeout(
        () => runPlannerWithRetry(llmClient, continuousInput, model, botLogger),
        'Continuous planner',
        60000,
      );

      plan = continuousResult.plan;
      plannerReasoning = continuousResult.reasoning;
      priority = continuousResult.priority;
      selectedToolCategories = continuousResult.toolCategories;
    } else {
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
        resolvedPermissions: resolvedPermissions.map((p) => ({ action: p.action, resource: p.resource, status: p.status, note: p.note })),
        pendingPermissions: pendingPermissions.map((p) => ({ action: p.action, resource: p.resource })),
        recentActionsDigest: recentActionsDigest || undefined,
        karmaBlock,
        autonomousCyclesNote,
        toolCategoryList,
      });

      const plannerResult = await withTimeout(
        () => runPlannerWithRetry(llmClient, plannerInput, model, botLogger),
        'Planner',
        60000,
      );

      plan = plannerResult.plan;
      plannerReasoning = plannerResult.reasoning;
      priority = plannerResult.priority;
      selectedToolCategories = plannerResult.toolCategories;
    }

    if (plan.length === 0 || priority === 'none') {
      if (consumedPermissionIds.length > 0) {
        const idleSummary = priority === 'none' ? `Idle: ${plannerReasoning}` : 'Planner produced no plan steps.';
        this.ctx.askPermissionStore.reportExecution(consumedPermissionIds, idleSummary, [], true);
      }
      return { summary: priority === 'none' ? `Idle: ${plannerReasoning}` : 'Planner produced no plan steps.', plannerReasoning, plan: [], toolCalls: [], priority, strategistRan, strategistReflection, focus };
    }

    botLogger.info(
      { botId, planSteps: plan.length, reasoning: plannerReasoning },
      'Agent loop: executing plan',
    );

    // Phase 2: Executor
    if (checkTimeout && !checkTimeout('before_executor')) {
      return { summary: 'Session timeout guard triggered before executor', plannerReasoning, plan: [], toolCalls: [], priority, strategistRan, strategistReflection, focus };
    }

    const executorSystem = this.systemPromptBuilder.build({
      mode: 'autonomous',
      botId,
      botConfig,
      isGroup: false,
    });

    const agentConfig = resolveAgentConfig(this.ctx.config, botConfig);
    const fileTree = scanFileTree(agentConfig.workDir);
    const executorUserPrompt = buildExecutorPrompt({
      plan,
      identity,
      soul,
      motivations,
      goals,
      datetime,
      hasCreateTool,
      workDir: agentConfig.workDir,
      fileTree,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: executorSystem },
      { role: 'user', content: executorUserPrompt },
    ];

    const toolCallLog: ToolExecutionRecord[] = [];
    const executor = new ToolExecutor(this.ctx, {
      botId,
      chatId: botOverride?.reportChatId ?? 0,
      disabledTools: allDisabled,
      enableLogging: true,
      karmaService: this.karmaService ?? undefined,
    });

    // Subscribe to tool:end for audit log persistence
    if (this.ctx.toolAuditLog) {
      const auditLog = this.ctx.toolAuditLog;
      executor.on('tool:end', (event) => {
        auditLog.append({
          timestamp: new Date(event.timestamp).toISOString(),
          botId: event.botId,
          chatId: event.chatId,
          toolName: event.toolName,
          args: event.args,
          success: event.success,
          result: event.result.slice(0, 500),
          durationMs: event.durationMs,
          retryAttempts: event.retryAttempts,
        });
      });
    }

    // Tool pre-selection: narrow executor tools based on planner's category picks
    let executorDefs = defs;
    if (toolPreSelectionEnabled && selectedToolCategories && selectedToolCategories.length > 0) {
      const categoryFiltered = this.toolRegistry.getDefinitionsByCategories(
        selectedToolCategories as ToolCategory[],
        botId,
      );
      // Apply the same allDisabled filter on top of category filtering
      executorDefs = categoryFiltered.filter((d) => !allDisabled.has(d.function.name));
      botLogger.info(
        { botId, selectedCategories: selectedToolCategories, fullToolCount: defs.length, filteredToolCount: executorDefs.length },
        'Agent loop: tool pre-selection active',
      );
    }

    // Per-bot override → global config → default 30. Session timeout guard (80% of maxDurationMs)
    // and per-operation withTimeout already prevent runaway execution.
    const maxToolRounds = botOverride?.maxToolRounds ?? globalConfig.maxToolRounds;
    botLogger.info(
      { botId, maxToolRounds },
      'Agent loop: starting executor phase',
    );

    let response: string;
    try {
      response = await withTimeout(
        () => llmClient.chat(messages, {
          model,
          temperature: 0.7,
          tools: executorDefs,
          toolExecutor: executor.createCallback(),
          maxToolRounds,
        }),
        'Executor phase',
        90000,
      );

      toolCallLog.push(...executor.getExecutionLog());

      // Report successful execution for consumed permissions
      if (consumedPermissionIds.length > 0) {
        const toolCallSummary = toolCallLog.map(t => ({ name: t.name, success: t.success }));
        this.ctx.askPermissionStore.reportExecution(
          consumedPermissionIds,
          response || '(no response from executor)',
          toolCallSummary,
          true,
        );
      }
    } catch (err) {
      toolCallLog.push(...executor.getExecutionLog());

      // Report failed execution for consumed permissions
      if (consumedPermissionIds.length > 0) {
        const toolCallSummary = toolCallLog.map(t => ({ name: t.name, success: t.success }));
        this.ctx.askPermissionStore.reportExecution(
          consumedPermissionIds,
          `Executor failed: ${err instanceof Error ? err.message : String(err)}`,
          toolCallSummary,
          false,
        );
      }
      throw err;
    }

    return {
      summary: response || '(no response from executor)',
      plannerReasoning,
      plan,
      toolCalls: toolCallLog,
      priority,
      strategistRan,
      strategistReflection,
      focus,
      selectedToolCategories,
      executorToolCount: executorDefs.length,
    };
  }

  private async processFeedback(
    botId: string,
    botConfig: BotConfig,
    botLogger: Logger,
    pendingFeedback: AgentFeedback[],
    soulLoader: ReturnType<BotContext['getSoulLoader']>,
  ): Promise<void> {
    const claudePath = this.ctx.config.improve?.claudePath ?? 'claude';
    const claudeTimeout = botConfig.agentLoop?.claudeTimeout ?? this.ctx.config.agentLoop.claudeTimeout;
    const feedbackLLM = new ClaudeCliLLMClient(claudePath, claudeTimeout, botLogger);
    const globalConfig = this.ctx.config.agentLoop;
    const botOverride = botConfig.agentLoop;

    const feedbackToolNames = new Set(['manage_goals', 'update_soul', 'update_identity', 'save_memory']);
    const allDisabled = new Set([
      ...(botConfig.disabledTools ?? []),
      ...(globalConfig.disabledTools ?? []),
      ...(botOverride?.disabledTools ?? []),
    ]);
    const baseDefs = this.toolRegistry.getDefinitionsForBot(botId);
    const defs = baseDefs.filter(
      (d) => feedbackToolNames.has(d.function.name) && !allDisabled.has(d.function.name),
    );

    botLogger.info(
      { botId, count: pendingFeedback.length, tools: defs.map((d) => d.function.name) },
      'Agent loop: processing pending feedback',
    );

    for (const feedback of pendingFeedback) {
      try {
        const identity = soulLoader.readIdentity() || '(no identity)';
        const soul = soulLoader.readSoul() || '(no soul)';
        const motivations = soulLoader.readMotivations() || '(no motivations)';
        const goals = soulLoader.readGoals?.() || '';
        const datetime = new Date().toISOString();

        const { system, userPrompt } = buildFeedbackProcessorPrompt({
          identity,
          soul,
          motivations,
          goals,
          datetime,
          feedbackContent: feedback.content,
          availableTools: defs.map((d) => d.function.name),
        });

        const messages: import('../ollama').ChatMessage[] = [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ];

        const executor = new ToolExecutor(this.ctx, {
          botId,
          chatId: botOverride?.reportChatId ?? 0,
          disabledTools: allDisabled,
          enableLogging: true,
        });

        if (this.ctx.toolAuditLog) {
          const auditLog = this.ctx.toolAuditLog;
          executor.on('tool:end', (event) => {
            auditLog.append({
              timestamp: new Date(event.timestamp).toISOString(),
              botId: event.botId,
              chatId: event.chatId,
              toolName: event.toolName,
              args: event.args,
              success: event.success,
              result: event.result.slice(0, 500),
              durationMs: event.durationMs,
              retryAttempts: event.retryAttempts,
            });
          });
        }

        const response = await feedbackLLM.chat(messages, {
          temperature: 0.5,
          tools: defs,
          toolExecutor: executor.createCallback(),
          maxToolRounds: 5,
        });

        const responseText = response || '(no response)';
        this.ctx.agentFeedbackStore.markApplied(botId, feedback.id, responseText);
        logToMemory(this.ctx, botId, `[feedback] Applied: "${feedback.content}" → ${responseText}`);
        botLogger.info({ botId, feedbackId: feedback.id }, 'Agent loop: feedback processed');
      } catch (err) {
        botLogger.error({ botId, feedbackId: feedback.id, error: err }, 'Agent loop: failed to process feedback');
        this.ctx.agentFeedbackStore.markApplied(
          botId,
          feedback.id,
          `Error processing feedback: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
