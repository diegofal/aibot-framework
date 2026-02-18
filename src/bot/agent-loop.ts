import type { BotConfig } from '../config';
import type { ChatMessage } from '../ollama';
import type { Logger } from '../logger';
import type { BotContext } from './types';
import type { SystemPromptBuilder } from './system-prompt-builder';
import type { ToolRegistry } from './tool-registry';
import { buildPlannerPrompt, buildExecutorPrompt } from './agent-loop-prompts';
import { sendLongMessage } from './telegram-utils';

interface PlannerResult {
  should_act: boolean;
  reasoning: string;
  plan?: string[];
  skip_reason?: string;
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
}

interface ExecuteLoopDetail {
  summary: string;
  plannerReasoning: string;
  plan: string[];
  toolCalls: ToolCallRecord[];
}

export interface AgentLoopState {
  running: boolean;
  lastRunAt: number | null;
  lastResults: AgentLoopResult[];
  nextRunAt: number | null;
}

function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * multipliers[unit];
}

export class AgentLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: AgentLoopState = { running: false, lastRunAt: null, lastResults: [], nextRunAt: null };

  constructor(
    private ctx: BotContext,
    private systemPromptBuilder: SystemPromptBuilder,
    private toolRegistry: ToolRegistry,
  ) {}

  /** Start the self-rescheduling timer */
  start(): void {
    if (!this.ctx.config.agentLoop.enabled) {
      this.ctx.logger.info('Agent loop disabled, not starting timer');
      return;
    }
    this.ctx.logger.info({ every: this.ctx.config.agentLoop.every }, 'Agent loop timer starting');
    this.scheduleNext();
  }

  /** Stop the timer */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state.nextRunAt = null;
  }

  /** Manual trigger — runs immediately for all bots */
  async runNow(): Promise<AgentLoopResult[]> {
    return this.executeAll();
  }

  /** Run for a single bot */
  async runOne(botId: string): Promise<AgentLoopResult> {
    const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      return { botId, botName: botId, status: 'error', summary: `Bot config not found: ${botId}`, durationMs: 0, plannerReasoning: '', plan: [], toolCalls: [] };
    }
    if (!this.ctx.bots.has(botId)) {
      return { botId, botName: botConfig.name, status: 'skipped', summary: 'Bot not running', durationMs: 0, plannerReasoning: '', plan: [], toolCalls: [] };
    }
    return this.executeSingleBot(botId, botConfig);
  }

  /** Get current state (for API) */
  getState(): AgentLoopState {
    return { ...this.state, lastResults: [...this.state.lastResults] };
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    const intervalMs = parseDurationMs(this.ctx.config.agentLoop.every);
    const nextAt = Date.now() + intervalMs;
    this.state.nextRunAt = nextAt;
    this.timer = setTimeout(() => this.onTimerFire(), intervalMs);
    this.ctx.logger.debug({ nextRunAt: new Date(nextAt).toISOString(), intervalMs }, 'Agent loop: timer scheduled');
  }

  private async onTimerFire(): Promise<void> {
    try {
      await this.executeAll();
    } catch (err) {
      this.ctx.logger.error({ err }, 'Agent loop: timer fire failed');
    }
    if (this.ctx.config.agentLoop.enabled) {
      this.scheduleNext();
    }
  }

  private async executeAll(): Promise<AgentLoopResult[]> {
    if (this.state.running) {
      this.ctx.logger.warn('Agent loop: already running, skipping');
      return this.state.lastResults;
    }
    this.state.running = true;
    this.ctx.logger.info('Agent loop: executing for all running bots');

    const results: AgentLoopResult[] = [];
    try {
      for (const botId of this.ctx.bots.keys()) {
        const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
        if (!botConfig) continue;
        results.push(await this.executeSingleBot(botId, botConfig));
      }
    } finally {
      this.state.running = false;
      this.state.lastRunAt = Date.now();
      this.state.lastResults = results;
    }

    this.ctx.logger.info(
      { botCount: results.length, completed: results.filter(r => r.status === 'completed').length },
      'Agent loop: execution finished',
    );
    return results;
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

      // Log to daily memory
      this.logToMemory(botId, detail.summary);

      // Send report if configured
      if (botOverride?.reportChatId) {
        await this.sendReport(botId, botOverride.reportChatId, detail.summary);
      }

      const isSkip = detail.summary.startsWith('Planner decided not to act');
      botLogger.info({ botId, durationMs }, 'Agent loop completed for bot');
      return {
        botId,
        botName: botConfig.name,
        status: isSkip ? 'skipped' : 'completed',
        summary: detail.summary,
        durationMs,
        plannerReasoning: detail.plannerReasoning,
        plan: detail.plan,
        toolCalls: detail.toolCalls,
      };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const errorMsg = `Agent loop error: ${err instanceof Error ? err.message : String(err)}`;
      botLogger.error({ botId, error: errorMsg }, 'Agent loop failed for bot');

      this.logToMemory(botId, `[ERROR] ${errorMsg}`);

      if (botOverride?.reportChatId) {
        await this.sendReport(botId, botOverride.reportChatId, errorMsg).catch(() => {});
      }

      return { botId, botName: botConfig.name, status: 'error', summary: errorMsg, durationMs, plannerReasoning: '', plan: [], toolCalls: [] };
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
    const goals = soulLoader.readGoals?.() || '';
    const recentMemory = soulLoader.readRecentDailyLogs();
    const datetime = new Date().toISOString();

    // Get available tools (respecting disabled tools from both global and per-bot)
    const allDisabled = new Set([
      ...(botConfig.disabledTools ?? []),
      ...(globalConfig.disabledTools ?? []),
      ...(botOverride?.disabledTools ?? []),
    ]);
    const defs = this.ctx.toolDefinitions.filter(
      (d) => !allDisabled.has(d.function.name),
    );
    const availableToolNames = defs.map((d) => d.function.name);

    // Phase 1: Planner
    botLogger.info({ botId, toolCount: defs.length }, 'Agent loop: running planner');

    const plannerInput = buildPlannerPrompt({
      identity,
      soul,
      motivations,
      goals,
      recentMemory,
      datetime,
      availableTools: availableToolNames,
    });

    // Try planner with normal temperature first, then retry with 0 if parsing fails
    let plannerResult = await this.runPlannerWithRetry(
      llmClient,
      plannerInput,
      model,
      botLogger,
    );

    if (!plannerResult.should_act) {
      const skipMsg = `Planner decided not to act: ${plannerResult.skip_reason || plannerResult.reasoning}`;
      botLogger.info({ botId, reasoning: plannerResult.reasoning }, 'Agent loop: skipping');
      return { summary: skipMsg, plannerReasoning: plannerResult.reasoning, plan: [], toolCalls: [] };
    }

    const plan = plannerResult.plan ?? [];
    if (plan.length === 0) {
      return { summary: 'Planner decided to act but provided no plan steps.', plannerReasoning: plannerResult.reasoning, plan: [], toolCalls: [] };
    }

    botLogger.info(
      { botId, planSteps: plan.length, reasoning: plannerResult.reasoning },
      'Agent loop: executing plan',
    );

    // Phase 2: Executor
    const executorSystem = this.systemPromptBuilder.build({
      mode: 'autonomous',
      botId,
      botConfig,
      isGroup: false,
    });

    const executorUserPrompt = buildExecutorPrompt({
      plan,
      identity,
      soul,
      motivations,
      goals,
      datetime,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: executorSystem },
      { role: 'user', content: executorUserPrompt },
    ];

    // Build a tool executor that respects the agent loop's disabled tools
    const toolCallLog: ToolCallRecord[] = [];
    const executor = this.createAgentLoopExecutor(botId, allDisabled, toolCallLog);

    const response = await llmClient.chat(messages, {
      model,
      temperature: 0.7,
      tools: defs,
      toolExecutor: executor,
      maxToolRounds: globalConfig.maxToolRounds,
    });

    return {
      summary: response || '(no response from executor)',
      plannerReasoning: plannerResult.reasoning,
      plan,
      toolCalls: toolCallLog,
    };
  }

  private createAgentLoopExecutor(
    botId: string,
    disabledTools: Set<string>,
    toolCallLog: ToolCallRecord[],
  ): (name: string, args: Record<string, unknown>) => Promise<import('../tools/types').ToolResult> {
    return async (name, args) => {
      if (disabledTools.has(name)) {
        this.ctx.logger.warn({ tool: name, botId }, 'Disabled tool requested in agent loop');
        const result = { success: false, content: `Tool "${name}" is not available` };
        toolCallLog.push({ name, args, success: false, result: result.content });
        return result;
      }
      const tool = this.ctx.tools.find((t) => t.definition.function.name === name);
      if (!tool) {
        this.ctx.logger.warn({ tool: name }, 'Unknown tool requested in agent loop');
        const result = { success: false, content: `Unknown tool: ${name}` };
        toolCallLog.push({ name, args, success: false, result: result.content });
        return result;
      }
      const reportChatId = this.ctx.config.bots.find((b) => b.id === botId)?.agentLoop?.reportChatId ?? 0;
      const effectiveArgs = { ...args, _chatId: reportChatId, _botId: botId };
      const result = await tool.execute(effectiveArgs, this.ctx.logger);
      toolCallLog.push({ name, args, success: result.success, result: result.content.slice(0, 2000) });
      return result;
    };
  }

  private async runPlannerWithRetry(
    llmClient: import('../core/llm-client').LLMClient,
    plannerInput: { system: string; prompt: string },
    model: string,
    botLogger: Logger,
    maxRetries = 1,
  ): Promise<PlannerResult> {
    const temperatures = [0.3, 0]; // First try normal, then strict if needed

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const plannerRaw = await llmClient.generate(plannerInput.prompt, {
        system: plannerInput.system,
        model,
        temperature: temperatures[attempt] ?? 0,
      });

      const result = this.parsePlannerResult(plannerRaw, botLogger);

      // Success: parsed properly
      if (result.reasoning !== 'Failed to parse planner output') {
        if (attempt > 0) {
          botLogger.info({ attempt }, 'Agent loop: planner succeeded on retry');
        }
        return result;
      }

      // Failed to parse - retry if we have attempts left
      if (attempt < maxRetries) {
        botLogger.warn({ attempt, raw: plannerRaw.slice(0, 200) }, 'Agent loop: planner failed to parse, retrying with temperature 0');
      }
    }

    // All retries exhausted
    return {
      should_act: false,
      reasoning: 'Failed to parse planner output after retries',
      skip_reason: 'planner returned invalid JSON',
    };
  }

  private parsePlannerResult(raw: string, logger: Logger): PlannerResult {
    let cleaned = raw.trim();

    // Strategy 1: strip markdown fences
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    // Strategy 2: if there's prose around JSON, extract the JSON object
    if (!cleaned.startsWith('{')) {
      const match = cleaned.match(/\{[\s\S]*"should_act"[\s\S]*\}/);
      if (match) cleaned = match[0];
    }

    try {
      return JSON.parse(cleaned) as PlannerResult;
    } catch {
      logger.warn({ raw: raw.slice(0, 500) }, 'Agent loop: failed to parse planner JSON');
      return {
        should_act: false,
        reasoning: 'Failed to parse planner output',
        skip_reason: 'planner returned invalid JSON',
      };
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
