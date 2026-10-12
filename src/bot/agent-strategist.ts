import type { BotConfig } from '../config';
import type { LLMClient, TokenUsage } from '../core/llm-client';
import { localDateStr } from '../date-utils';
import { closeGoalTasks } from '../goals/goal-closure';
import type { TaskStore } from '../goals/task-store';
import type { Logger } from '../logger';
import { parseGoals, resolveGoalRef, resolveParentGoalId, serializeGoals } from '../tools/goals';
import type { WorkerPoolApi } from '../workers/types';
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
  /** One short sentence: why this change (stated at decision time; optional). */
  reason?: string;
  /** For add: the existing goal (title or id) the new one serves (optional). */
  parent?: string;
  /** For add: the initial breakdown, written to the task store as agent tasks (optional). */
  tasks?: string[];
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
  /** One short reason per adjusted trait, as the strategist stated it (optional). */
  trait_reasons?: Record<string, string>;
  /** Title or id of the active goal the deliverable serves (record only). */
  serves_goal?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const shortText = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 300) : undefined;

/**
 * `trait_adjustments` (numbers, or `{ delta, reason }`) and `trait_reasons`
 * (one short reason per trait). Non-numeric deltas are dropped; reasons are
 * optional so outputs written before they were asked for still parse.
 */
export function parseTraitAdjustments(
  rawAdjustments: unknown,
  rawReasons: unknown
): { adjustments?: Record<string, number>; reasons?: Record<string, string> } {
  if (!isPlainObject(rawAdjustments)) return {};
  const adjustments: Record<string, number> = {};
  const reasons: Record<string, string> = {};
  const given = isPlainObject(rawReasons) ? rawReasons : {};
  for (const [trait, value] of Object.entries(rawAdjustments)) {
    const delta = isPlainObject(value) ? value.delta : value;
    if (typeof delta !== 'number' || !Number.isFinite(delta)) continue;
    adjustments[trait] = delta;
    const reason =
      shortText(given[trait]) ?? (isPlainObject(value) ? shortText(value.reason) : undefined);
    if (reason) reasons[trait] = reason;
  }
  return {
    adjustments,
    ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
  };
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
      const { adjustments: traitAdj, reasons: traitReasons } = parseTraitAdjustments(
        parsed.trait_adjustments,
        parsed.trait_reasons
      );

      return {
        goal_operations: Array.isArray(parsed.goal_operations) ? parsed.goal_operations : [],
        single_deliverable: deliverable,
        alignment_confidence: alignmentConfidence,
        focus: deliverable,
        reflection: String(parsed.reflection),
        next_strategy_in: parsed.next_strategy_in ? String(parsed.next_strategy_in) : undefined,
        trait_adjustments: traitAdj,
        ...(traitReasons ? { trait_reasons: traitReasons } : {}),
        ...(typeof parsed.serves_goal === 'string' && parsed.serves_goal.trim()
          ? { serves_goal: parsed.serves_goal.trim() }
          : {}),
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
  maxRetries = 1,
  options: { skipAlignmentRetry?: boolean } = {}
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
      // Exploration cycles skip this gate: a temperature-0 re-roll would
      // swap the divergent idea for the most predictable one.
      if (
        !options.skipAlignmentRetry &&
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
    /** Curiosity DNA block (src/bot/curiosity/runner.ts) */
    curiosityBlock?: string;
  },
  /**
   * Client + model to run on. The agent loop passes the planner-backend
   * selection so the strategist honours `agentLoop.plannerBackend` and never
   * goes through the bot client's silent cross-backend fallback. Defaults to
   * the bot client for callers that predate the option.
   */
  llm?: { client: LLMClient; model: string },
  /** Exploration cycles: keep the first answer even when alignment is low. */
  options: { skipAlignmentRetry?: boolean; cycleId?: string } = {}
): Promise<StrategistResultWithUsage | null> {
  const llmClient = llm?.client ?? ctx.getLLMClient(botId);
  const model = llm?.model ?? ctx.getActiveModel(botId);

  const sevenDaysAgo = localDateStr(new Date(Date.now() - 7 * 86_400_000));
  const recentMemory = soulContext.soulLoader.readDailyLogsSince(sevenDaysAgo);

  botLogger.info({ botId }, 'Agent loop: running strategist');

  const input = buildStrategistPrompt({
    identity: soulContext.identity,
    soul: soulContext.soul,
    motivations: soulContext.motivations,
    goals: soulContext.goals,
    tasks: soulContext.soulLoader.readTasks?.(),
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
    curiosityBlock: soulContext.curiosityBlock,
  });

  const result = await runStrategistWithRetry(llmClient, input, model, botLogger, 1, options);
  if (!result) {
    botLogger.warn(
      { botId },
      'Agent loop: strategist returned unparseable output, continuing without'
    );
    return null;
  }

  if (result.goal_operations?.length > 0) {
    applyGoalOperations(botId, result.goal_operations, botLogger, soulContext.soulLoader, {
      cycleId: options.cycleId,
      workerPool: ctx.workerPool,
    });
  }
  // The deliverable is a task only when it names the goal it serves; otherwise
  // it stays the free-text focus (lastFocus) as before.
  const deliverableTask = applyStrategistDeliverable(soulContext.soulLoader, result, {
    cycleId: options.cycleId,
    onError: (err) => botLogger.warn({ err, botId }, 'Strategist: deliverable task not written'),
  });
  if (deliverableTask)
    botLogger.debug({ botId, taskId: deliverableTask }, 'Strategist: deliverable task');

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
  soulLoader: ReturnType<BotContext['getSoulLoader']>,
  writeOpts: {
    actor?: 'strategist' | 'curiosity';
    cycleId?: string;
    /** Workers of a goal this completes or removes are stopped (C21). */
    workerPool?: Pick<WorkerPoolApi, 'list' | 'stop'> | null;
  } = {}
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
  /** Goals this write closes (completed or removed): their workers stop. */
  const closedIds: string[] = [];
  /** Added goal title → its initial tasks. */
  const breakdowns: Array<{ title: string; tasks: string[] }> = [];
  /** Stated reason per goal touched, keyed by lower-cased title (goal-events matches on it). */
  const reasons: Record<string, string> = {};
  const noteReason = (title: string, op: GoalOperation) => {
    const reason = shortText(op.reason);
    if (reason) reasons[title.trim().toLowerCase()] = reason;
  };

  for (const op of operations) {
    switch (op.action) {
      case 'add': {
        const parent = resolveParentGoalId(active, completed, op.parent);
        active.push({
          text: op.goal,
          status: 'pending',
          priority: op.priority ?? 'medium',
          notes: op.notes,
          source: `strategist:${localDateStr()}`,
          ...(parent ? { parent } : {}),
        });
        noteReason(op.goal, op);
        const tasks = cleanTaskList(op.tasks);
        if (tasks.length > 0) breakdowns.push({ title: op.goal, tasks });
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
        noteReason(goal.text, op);
        if (goal.id) closedIds.push(goal.id);
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
        noteReason(found.text, op);
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
        noteReason(removed.text, op);
        if (removed.id) closedIds.push(removed.id);
        logger.debug({ goal: removed.text }, 'Strategist: removed goal');
        break;
      }
      default:
        logger.debug({ action: op.action }, 'Strategist: unknown goal operation, skipping');
    }
  }

  soulLoader.writeGoals(serializeGoals(active, completed), {
    actor: writeOpts.actor ?? 'strategist',
    cycleId: writeOpts.cycleId,
    ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
  });
  logger.debug({ botId, goalCount: active.length + completed.length }, 'Goals written back');

  const store = taskStoreOf(soulLoader);
  if (!store) return;
  const onError = (err: unknown) => logger.warn({ err, botId }, 'Strategist: task store warning');
  if (breakdowns.length > 0) {
    // Ids are assigned by the write; find the new goals by title.
    const fresh = parseGoals(soulLoader.readGoals?.() ?? null).active;
    for (const { title, tasks } of breakdowns) {
      const goal = fresh.find((g) => g.text.trim() === title.trim());
      if (!goal?.id) continue;
      for (const text of tasks) {
        try {
          const r = store.apply([{ op: 'add', goalId: goal.id, text }], {
            actor: 'agent',
            ...(writeOpts.cycleId ? { cycleId: writeOpts.cycleId } : {}),
          });
          if (!r.ok) logger.debug({ botId, reason: r.reason, text }, 'Strategist: task not added');
        } catch (err) {
          onError(err);
        }
      }
    }
  }
  if (closedIds.length > 0) {
    const closed = closeGoalTasks({
      botId,
      goalIds: closedIds,
      store,
      pool: writeOpts.workerPool,
      cycleId: writeOpts.cycleId,
      onError,
    });
    if (closed.stopped.length + closed.released.length > 0)
      logger.info({ botId, ...closed }, 'Closed goals: workers stopped, claims released');
  }
}

/** At most 12 non-empty task texts (the store caps open tasks per goal at 12). */
function cleanTaskList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 12);
}

function taskStoreOf(soulLoader: unknown): TaskStore | null {
  const get = (soulLoader as { getTaskStore?: () => TaskStore }).getTaskStore;
  if (typeof get !== 'function') return null;
  try {
    return get.call(soulLoader);
  } catch {
    return null;
  }
}

/**
 * The strategist's deliverable as a task on the goal `serves_goal` names (C21).
 * Null when it names no active goal (the deliverable stays free-text focus) or
 * the store refuses; the store's add dedupes against the goal's open tasks, so
 * a repeat returns the existing task id. Never throws.
 */
export function applyStrategistDeliverable(
  soulLoader: unknown,
  result: Pick<StrategistResult, 'single_deliverable' | 'focus' | 'serves_goal'>,
  opts: { cycleId?: string; onError?: (err: unknown) => void }
): string | null {
  const text = String(result.single_deliverable || result.focus || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || !result.serves_goal) return null;
  try {
    const store = taskStoreOf(soulLoader);
    if (!store) return null;
    const read = (soulLoader as { readGoals?: () => string | null }).readGoals;
    const goalsMd = typeof read === 'function' ? read.call(soulLoader) : null;
    const goal = resolveGoalRef(result.serves_goal, parseGoals(goalsMd).active);
    if (!goal?.id) return null;
    const r = store.apply([{ op: 'add', goalId: goal.id, text }], {
      actor: 'agent',
      ...(opts.cycleId ? { cycleId: opts.cycleId } : {}),
    });
    return r.ok ? (r.results[0]?.id ?? null) : null;
  } catch (err) {
    opts.onError?.(err);
    return null;
  }
}
