import type { BotConfig } from '../config';
import type { LLMClient, TokenUsage } from '../core/llm-client';
import { localDateStr } from '../date-utils';
import type { Logger } from '../logger';
import { parseGoals, serializeGoals } from '../tools/goals';
import { parseDurationMs } from './agent-loop';
import { buildStrategistPrompt } from './agent-loop-prompts';
import { logToMemory } from './agent-loop-utils';
import { parseLLMJson } from './llm-json-parser';
import type { BotContext } from './types';

export interface GoalOperation {
  action: 'add' | 'complete' | 'update' | 'remove';
  goal: string;
  priority?: string;
  status?: string;
  notes?: string;
  outcome?: string;
}

export interface StrategistResult {
  goal_operations: GoalOperation[];
  /** @deprecated Use single_deliverable instead */
  focus?: string;
  /** Single concrete deliverable for this session */
  single_deliverable?: string;
  /** How well the deliverable aligns with the agent's identity/soul (0.0-1.0) */
  alignment_confidence?: number;
  reflection: string;
  next_strategy_in?: string;
  /** Trait adjustments proposed by strategist (max ±0.05 per trait) */
  trait_adjustments?: Record<string, number>;
}

/**
 * Parse a strategist result from raw LLM output.
 */
export function parseStrategistResult(
  raw: string,
  logger: Pick<Logger, 'warn'>
): StrategistResult | null {
  return parseLLMJson<StrategistResult>(raw, logger, {
    extractPattern: /\{[\s\S]*(?:"focus"|"single_deliverable")[\s\S]*\}/,
    validate: (parsed) => {
      if (!(parsed.focus || parsed.single_deliverable) || !parsed.reflection) return null;
      const deliverable = String(parsed.single_deliverable || parsed.focus);
      const rawConfidence = parsed.alignment_confidence;
      const alignmentConfidence =
        typeof rawConfidence === 'number' && rawConfidence >= 0 && rawConfidence <= 1
          ? rawConfidence
          : undefined;
      // Extract trait_adjustments if present
      const traitAdj =
        parsed.trait_adjustments &&
        typeof parsed.trait_adjustments === 'object' &&
        !Array.isArray(parsed.trait_adjustments)
          ? (parsed.trait_adjustments as Record<string, number>)
          : undefined;

      return {
        goal_operations: Array.isArray(parsed.goal_operations) ? parsed.goal_operations : [],
        single_deliverable: deliverable,
        alignment_confidence: alignmentConfidence,
        focus: deliverable,
        reflection: String(parsed.reflection),
        next_strategy_in: parsed.next_strategy_in ? String(parsed.next_strategy_in) : undefined,
        trait_adjustments: traitAdj,
      };
    },
    label: 'strategist',
  });
}

export interface StrategistScheduleInfo {
  strategistCycleCount: number;
  lastStrategistAt: number | null;
}

/**
 * Should the strategist run this cycle?
 */
export function shouldRunStrategist(
  botId: string,
  botConfig: BotConfig,
  globalStrategistConfig: { enabled: boolean; everyCycles: number; minInterval: string },
  schedule?: StrategistScheduleInfo
): boolean {
  const botOverride = botConfig.agentLoop?.strategist;
  const enabled = botOverride?.enabled ?? globalStrategistConfig.enabled;
  if (!enabled) return false;
  if (!schedule) return true; // First run

  const everyCycles = botOverride?.everyCycles ?? globalStrategistConfig.everyCycles;
  const minInterval = botOverride?.minInterval ?? globalStrategistConfig.minInterval;

  const cyclesMet = schedule.strategistCycleCount >= everyCycles;
  const intervalMet =
    schedule.lastStrategistAt === null ||
    Date.now() - schedule.lastStrategistAt >= parseDurationMs(minInterval);

  return cyclesMet && intervalMet;
}

/**
 * Compute cycles remaining until next strategist run.
 */
export function computeCyclesUntilStrategist(
  botConfig: BotConfig | undefined,
  globalStrategistConfig: { everyCycles: number },
  schedule: { strategistCycleCount: number }
): number {
  const botOverride = botConfig?.agentLoop?.strategist;
  const everyCycles = botOverride?.everyCycles ?? globalStrategistConfig.everyCycles;
  return Math.max(0, everyCycles - schedule.strategistCycleCount);
}

/**
 * Run the strategist with retry (temperature 0.4 → 0 on failure).
 */
export interface StrategistResultWithUsage extends StrategistResult {
  usage?: TokenUsage;
}

export async function runStrategistWithRetry(
  llmClient: LLMClient,
  input: { system: string; prompt: string },
  model: string,
  logger: Logger,
  maxRetries = 1
): Promise<StrategistResultWithUsage | null> {
  const temperatures = [0.4, 0];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const llmResult = await llmClient.generate(input.prompt, {
      system: input.system,
      model,
      temperature: temperatures[attempt] ?? 0,
    });
    const raw = llmResult.text;

    const result = parseStrategistResult(raw, logger);
    if (result) {
      // Soul alignment gate: if confidence is below threshold, force retry
      if (
        result.alignment_confidence !== undefined &&
        result.alignment_confidence < 0.6 &&
        attempt < maxRetries
      ) {
        logger.warn(
          {
            attempt,
            confidence: result.alignment_confidence,
            deliverable: result.single_deliverable,
          },
          'Agent loop: strategist alignment confidence too low, retrying with temperature 0'
        );
        continue;
      }
      if (attempt > 0) {
        logger.info({ attempt }, 'Agent loop: strategist succeeded on retry');
      }
      return { ...result, usage: llmResult.usage };
    }

    if (attempt < maxRetries) {
      logger.warn(
        { attempt, raw: raw.slice(0, 200) },
        'Agent loop: strategist failed to parse, retrying with temperature 0'
      );
    } else {
      logger.warn(
        { rawResponse: raw.slice(0, 300) },
        'Agent loop: strategist parse failed on final attempt'
      );
    }
  }

  return null;
}

/**
 * Run the full strategist phase: call LLM, apply goal operations, log to memory.
 */
export async function runStrategist(
  ctx: BotContext,
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
    directives?: string[];
    behavioralState?: string;
    outcomeStats?: string;
    traitState?: string;
    environmentContext?: string;
    crystallizationContext?: string;
    goalPerformance?: string;
    peerInsights?: string;
  }
): Promise<StrategistResultWithUsage | null> {
  const llmClient = ctx.getLLMClient(botId);
  const model = ctx.getActiveModel(botId);

  const sevenDaysAgo = localDateStr(new Date(Date.now() - 7 * 86_400_000));
  const recentMemory = soulContext.soulLoader.readDailyLogsSince(sevenDaysAgo);

  botLogger.info({ botId }, 'Agent loop: running strategist');

  const input = buildStrategistPrompt({
    identity: soulContext.identity,
    soul: soulContext.soul,
    motivations: soulContext.motivations,
    goals: soulContext.goals,
    recentMemory,
    datetime: soulContext.datetime,
    directives: soulContext.directives,
    behavioralState: soulContext.behavioralState,
    outcomeStats: soulContext.outcomeStats,
    traitState: soulContext.traitState,
    environmentContext: soulContext.environmentContext,
    crystallizationContext: soulContext.crystallizationContext,
    goalPerformance: soulContext.goalPerformance,
    peerInsights: soulContext.peerInsights,
  });

  const result = await runStrategistWithRetry(llmClient, input, model, botLogger);
  if (!result) {
    botLogger.warn(
      { botId },
      'Agent loop: strategist returned unparseable output, continuing without'
    );
    return null;
  }

  if (result.goal_operations?.length > 0) {
    applyGoalOperations(botId, result.goal_operations, botLogger, soulContext.soulLoader);
  }

  const deliverable = result.single_deliverable || result.focus;
  const reflectionEntry = `[strategist] Focus: ${deliverable}\nReflection: ${result.reflection}`;
  logToMemory(ctx, botId, reflectionEntry);

  botLogger.info(
    { botId, focus: deliverable, goalOps: result.goal_operations?.length ?? 0 },
    'Agent loop: strategist completed'
  );

  return result;
}

/**
 * Apply goal operations (add, complete, update, remove) to the goals file.
 */
export function applyGoalOperations(
  botId: string,
  operations: GoalOperation[],
  logger: Logger,
  soulLoader: ReturnType<BotContext['getSoulLoader']>
): void {
  logger.info(
    { botId, operationCount: operations.length, types: operations.map((o) => o.action) },
    'Applying goal operations'
  );

  const content = soulLoader.readGoals?.() ?? null;
  if (!content) {
    logger.debug({ botId }, 'No goals file found, starting fresh');
  }
  const { active, completed } = parseGoals(content);

  for (const op of operations) {
    switch (op.action) {
      case 'add': {
        active.push({
          text: op.goal,
          status: 'pending',
          priority: op.priority ?? 'medium',
          notes: op.notes,
          source: `strategist:${localDateStr()}`,
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
        goal.completed = localDateStr();
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
  logger.debug({ botId, goalCount: active.length + completed.length }, 'Goals written back');
}
