/**
 * Prompt templates for the autonomous agent loop.
 * Planner: lightweight LLM call to decide whether and what to do.
 * Executor: full agentic call with tool access to carry out the plan.
 */

export interface PlannerPromptInput {
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  recentMemory: string;
  datetime: string;
  availableTools: string[];
}

export interface ExecutorPromptInput {
  plan: string[];
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  datetime: string;
}

export function buildPlannerPrompt(input: PlannerPromptInput): { system: string; prompt: string } {
  const system = `You are an autonomous agent deciding whether to take proactive action.
You have the following identity and purpose:

${input.identity}

${input.soul}

## Your Inner Motivations

${input.motivations}

${input.goals ? `## Goals\n\n${input.goals}` : ''}

## Recent Memory

${input.recentMemory || '(no recent memory)'}

Current date/time: ${input.datetime}

You have access to these tools: ${input.availableTools.join(', ')}

Your job is to decide whether you should take autonomous action right now.
Consider:
- Your motivations and goals — is there something you should be working on?
- Your recent memory — have you already done this recently?
- The time of day — is this an appropriate time?
- Whether you have the tools needed to make progress

CRITICAL: You MUST respond with ONLY a valid JSON object. Absolutely NO other text, NO markdown fences, NO explanation before or after.

Your response will be parsed by code using JSON.parse().

Example response when you SHOULD act:
{"should_act":true,"reasoning":"I haven't reviewed my goals in 24 hours and should check progress","plan":["Read my current goals","Identify any stale goals","Update goal status if needed"]}

Example response when you should SKIP:
{"should_act":false,"reasoning":"I completed a goal review just 2 hours ago","skip_reason":"Already reviewed recently"}

JSON Schema (MUST follow exactly):
- should_act: boolean (required)
- reasoning: string, brief explanation (required)
- plan: array of strings, only if should_act is true (optional)
- skip_reason: string, only if should_act is false (optional)

Keep plans focused — 1 to 5 concrete steps.`;

  const prompt = 'Decide whether to take autonomous action now. Respond with ONLY the JSON object — no other text whatsoever.';

  return { system, prompt };
}

export function buildExecutorPrompt(input: ExecutorPromptInput): string {
  return `You are acting autonomously based on the following plan:

${input.plan.map((step, i) => `${i + 1}. ${step}`).join('\n')}

## Your Identity

${input.identity}

${input.soul}

## Your Motivations

${input.motivations}

${input.goals ? `## Goals\n\n${input.goals}` : ''}

Current date/time: ${input.datetime}

## Instructions

Execute the plan above using your available tools. Work through each step methodically.
After completing the plan (or as much as you can), provide a brief summary of what you accomplished and any next steps.

If you make progress on a goal, use the manage_goals tool to update its status.
If you learn something worth remembering, use the save_memory tool.

Be efficient — don't repeat searches you've already done. If a step fails, note it and move on.
End with a concise summary paragraph.`;
}
