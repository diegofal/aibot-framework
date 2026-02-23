import type { Logger } from '../logger';
import type { LLMClient } from '../core/llm-client';
import type { PlannerResult, ContinuousPlannerResult } from './agent-loop-prompts';
import { parseLLMJson } from './llm-json-parser';

/**
 * Parse a planner result (works for both periodic and continuous modes).
 */
export function parsePlannerResult(raw: string, logger: Pick<Logger, 'warn'>): PlannerResult | null {
  return parseLLMJson<PlannerResult>(raw, logger, {
    extractPattern: /\{[\s\S]*"plan"[\s\S]*\}/,
    validate: (parsed) => {
      if (!parsed.reasoning || !Array.isArray(parsed.plan)) return null;
      const priority = ['high', 'medium', 'low', 'none'].includes(parsed.priority)
        ? parsed.priority
        : 'medium';
      if (parsed.plan.length === 0 && priority !== 'none') return null;
      return {
        reasoning: String(parsed.reasoning),
        plan: parsed.plan.map(String),
        priority,
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
  maxRetries = 1,
): Promise<PlannerResult> {
  const temperatures = [0.3, 0];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const raw = await llmClient.generate(plannerInput.prompt, {
      system: plannerInput.system,
      model,
      temperature: temperatures[attempt] ?? 0,
    });

    const result = parsePlannerResult(raw, logger);
    if (result) {
      if (attempt > 0) {
        logger.info({ attempt }, 'Agent loop: planner succeeded on retry');
      }
      return result;
    }

    if (attempt < maxRetries) {
      logger.warn(
        { attempt, raw: raw.slice(0, 200) },
        'Agent loop: planner failed to parse, retrying with temperature 0',
      );
    }
  }

  return {
    reasoning: 'Failed to parse planner output after retries',
    plan: [],
    priority: 'none',
  };
}
