import type { LLMClient, TokenUsage } from '../core/llm-client';
import type { Logger } from '../logger';
import type { ContinuousPlannerResult, PlannerResult } from './agent-loop-prompts';
import { parseLLMJson } from './llm-json-parser';
import { TOOL_CATEGORY_NAMES } from './tool-registry';

export interface PlannerResultWithUsage extends PlannerResult {
  usage?: TokenUsage;
}

/**
 * Parse a planner result (works for both periodic and continuous modes).
 */
const validCategorySet = new Set<string>(TOOL_CATEGORY_NAMES);

export function parsePlannerResult(
  raw: string,
  logger: Pick<Logger, 'warn'>
): PlannerResult | null {
  return parseLLMJson<PlannerResult>(raw, logger, {
    extractPattern: /\{[\s\S]*"plan"[\s\S]*\}/,
    validate: (parsed) => {
      if (!parsed.reasoning || !Array.isArray(parsed.plan)) return null;
      const priority = ['high', 'medium', 'low', 'none'].includes(parsed.priority)
        ? parsed.priority
        : 'medium';
      if (parsed.plan.length === 0 && priority !== 'none') return null;

      // Extract and validate toolCategories
      let toolCategories: string[] | undefined;
      if (Array.isArray(parsed.toolCategories)) {
        const valid = parsed.toolCategories.filter(
          (c: unknown): c is string => typeof c === 'string' && validCategorySet.has(c)
        );
        toolCategories = valid.length > 0 ? valid : undefined;
      }

      return {
        reasoning: String(parsed.reasoning),
        plan: parsed.plan.map(String),
        priority,
        toolCategories,
      };
    },
    label: 'planner',
  });
}

/**
 * Run the planner with retry (temperature 0.3 → 0 on failure).
 * Works for both periodic and continuous modes.
 */
export async function runPlannerWithRetry(
  llmClient: LLMClient,
  plannerInput: { system: string; prompt: string },
  model: string,
  logger: Logger,
  maxRetries = 1
): Promise<PlannerResultWithUsage> {
  const temperatures = [0.3, 0];

  logger.debug({ model, temperature: temperatures[0], maxRetries }, 'Agent loop: planner starting');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const llmResult = await llmClient.generate(plannerInput.prompt, {
      system: plannerInput.system,
      model,
      temperature: temperatures[attempt] ?? 0,
    });
    const raw = llmResult.text;

    const result = parsePlannerResult(raw, logger);
    if (result) {
      if (attempt > 0) {
        logger.info({ attempt }, 'Agent loop: planner succeeded on retry');
      }
      return { ...result, usage: llmResult.usage };
    }

    if (attempt < maxRetries) {
      logger.warn(
        { attempt, raw: raw.slice(0, 200) },
        'Agent loop: planner failed to parse, retrying with temperature 0'
      );
    }
  }

  logger.warn(
    { attemptsTotal: maxRetries + 1, finalTemperature: temperatures[maxRetries] ?? 0 },
    'Agent loop: planner fallback to empty plan after all retries exhausted'
  );

  return {
    reasoning: 'Failed to parse planner output after retries',
    plan: [],
    priority: 'none',
  };
}
