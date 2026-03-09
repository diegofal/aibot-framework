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
  hasCreateTool: boolean;
  focus?: string;
  /** Single concrete deliverable assigned by strategist — the ONE thing to complete this session */
  singleDeliverable?: string;
  answeredQuestions?: Array<{ question: string; answer: string }>;
  pendingQuestions?: Array<{ question: string }>;
  resolvedPermissions?: Array<{
    action: string;
    resource: string;
    status: 'approved' | 'denied';
    note?: string;
  }>;
  pendingPermissions?: Array<{ action: string; resource: string }>;
  recentActionsDigest?: string;
  karmaBlock?: string;
  /** Injected note when bot has been running autonomously for many cycles without ask_human */
  autonomousCyclesNote?: string;
  /** Tool category names for pre-selection — when set, planner should include toolCategories in response */
  toolCategoryList?: string[];
  /** Paths where the bot can write without asking permission (default: ['productions/']) */
  allowedWritePaths?: string[];
  /** Operator-assigned standing directives — ongoing behavioral instructions */
  directives?: string[];
}

export interface ContinuousPlannerPromptInput {
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  recentMemory: string;
  datetime: string;
  availableTools: string[];
  hasCreateTool: boolean;
  focus?: string;
  /** Single concrete deliverable assigned by strategist — the ONE thing to complete this session */
  singleDeliverable?: string;
  lastCycleSummary?: string;
  answeredQuestions?: Array<{ question: string; answer: string }>;
  pendingQuestions?: Array<{ question: string }>;
  resolvedPermissions?: Array<{
    action: string;
    resource: string;
    status: 'approved' | 'denied';
    note?: string;
  }>;
  pendingPermissions?: Array<{ action: string; resource: string }>;
  recentActionsDigest?: string;
  karmaBlock?: string;
  /** Injected note when bot has been running autonomously for many cycles without ask_human */
  autonomousCyclesNote?: string;
  /** Tool category names for pre-selection — when set, planner should include toolCategories in response */
  toolCategoryList?: string[];
  /** Paths where the bot can write without asking permission (default: ['productions/']) */
  allowedWritePaths?: string[];
  /** Operator-assigned standing directives — ongoing behavioral instructions */
  directives?: string[];
}

export interface PlannerResult {
  reasoning: string;
  plan: string[];
  priority: 'high' | 'medium' | 'low' | 'none';
  /** Tool categories the executor needs — used for tool pre-selection to reduce token usage */
  toolCategories?: string[];
}
/** @deprecated Use PlannerResult instead */
export type ContinuousPlannerResult = PlannerResult;

export interface ExecutorPromptInput {
  plan: string[];
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  datetime: string;
  hasCreateTool: boolean;
  workDir: string;
  /** Single concrete deliverable assigned by strategist — signals when to STOP */
  singleDeliverable?: string;
  /** Pre-scanned file tree of workDir, or null if empty/missing */
  fileTree?: string | null;
  /** Operator-assigned standing directives — ongoing behavioral instructions */
  directives?: string[];
}

function buildToolCategorySection(toolCategoryList?: string[]): string {
  if (!toolCategoryList || toolCategoryList.length === 0) return '';

  const descriptions: Record<string, string> = {
    web: 'web_search, web_fetch — searching and fetching web content',
    memory: 'memory_search, memory_get, recall_memory, core_memory_* — reading and writing memory',
    soul: 'update_soul, update_identity, manage_goals, improve — self-modification',
    files: 'file_read, file_write, file_edit — file operations',
    system: 'exec, process, get_datetime, cron — system commands and scheduling',
    social: 'reddit_*, twitter_* — social media tools',
    calendar: 'calendar_* — scheduling and availability',
    communication:
      'ask_human, ask_permission, phone_call, delegate_to_bot, collaborate, create_agent — human/bot interaction and agent proposals',
    browser: 'browser — web browsing with headless browser',
    production: 'read_production_log, archive_file, create_tool — production management',
  };

  let section =
    '\n## Tool Categories\n\nSelect which tool categories your plan needs. Only selected categories will be available to the executor (saves context).\n\nAvailable categories:\n';
  for (const cat of toolCategoryList) {
    const desc = descriptions[cat] || cat;
    section += `- **${cat}**: ${desc}\n`;
  }
  section +=
    '\nInclude a `"toolCategories"` array in your JSON response with the categories your plan needs (e.g. `["web", "memory"]`). Omit or leave empty to use all tools.\n';
  return section;
}

function buildHumanQuestionsSection(
  answered?: Array<{ question: string; answer: string }>,
  pending?: Array<{ question: string }>
): string {
  let section = '';
  if (answered && answered.length > 0) {
    section += '\n## Human Responses\n\nThe human has answered your previous questions:\n\n';
    for (const q of answered) {
      section += `- Q: "${q.question}"\n  A: "${q.answer}"\n`;
    }
    section += '\nAct on these answers — they are your top priority.\n';
  }
  if (pending && pending.length > 0) {
    section += '\n## Pending Questions\n\nYou have questions waiting for human response:\n\n';
    for (const q of pending) {
      section += `- "${q.question}"\n`;
    }
    section += '\nDo NOT ask the same question again. Work on other tasks while waiting.\n';
  }
  return section;
}

function buildPermissionProtocol(allowedWritePaths?: string[]): string {
  const paths =
    allowedWritePaths && allowedWritePaths.length > 0 ? allowedWritePaths : ['productions/'];
  return `PERMISSION PROTOCOL:
You MUST use ask_permission BEFORE performing any of these actions:
- file_write or file_edit to paths OUTSIDE your allowed write paths
- exec (any command execution)
- api_call or accessing external services not through provided tools
- Modifying framework source code (src/)

Your allowed write paths (NO permission needed): ${paths.join(', ')}
Writes to any other path REQUIRE ask_permission first.

- Permission requests are non-blocking — continue with other work while waiting
- Permissions never expire — the human will review them eventually
- If denied, respect the decision — do NOT retry the same request
- If the Permission Decisions section shows APPROVED, proceed immediately`;
}

function buildPermissionDecisionsSection(
  resolved?: Array<{
    action: string;
    resource: string;
    status: 'approved' | 'denied';
    note?: string;
  }>,
  pending?: Array<{ action: string; resource: string }>
): string {
  let section = '';
  if (resolved && resolved.length > 0) {
    section +=
      '\n## Permission Decisions\n\nThe human has decided on your permission requests:\n\n';
    for (const p of resolved) {
      const statusLabel = p.status === 'approved' ? 'APPROVED' : 'DENIED';
      section += `- ${statusLabel}: ${p.action} on "${p.resource}"${p.note ? ` — Note: "${p.note}"` : ''}\n`;
    }
    section += '\nAct on approved permissions — proceed with the authorized action.\n';
    section += 'For denied permissions — do NOT retry the same request. Respect the decision.\n';
  }
  if (pending && pending.length > 0) {
    section +=
      '\n## Pending Permissions\n\nYou have permission requests waiting for human decision:\n\n';
    for (const p of pending) {
      section += `- ${p.action} on "${p.resource}"\n`;
    }
    section += '\nDo NOT request the same permission again. Work on other tasks while waiting.\n';
  }
  return section;
}

/** Predefined directive bundles that operators can enable by name */
export const PRESET_DIRECTIVE_DEFINITIONS: Record<string, string[]> = {
  'conversation-review': [
    'Periodically review recent conversation session logs to evaluate your own conversation quality. ' +
      'Read session files from data/sessions/ for your bot. Look for: (1) responses that were too verbose or too terse, ' +
      '(2) missed context from previous messages, (3) tonal inconsistencies with your identity, ' +
      '(4) opportunities where you could have been more helpful. ' +
      'When you find actionable improvements, update your SOUL.md or MOTIVATIONS.md accordingly and log the insight to memory.',
  ],
};

/** Available preset directive metadata for API/UI consumption */
export const AVAILABLE_PRESETS = Object.entries(PRESET_DIRECTIVE_DEFINITIONS).map(
  ([id, lines]) => ({
    id,
    description: lines[0].slice(0, 120) + (lines[0].length > 120 ? '...' : ''),
  })
);

export function buildDirectivesSection(directives?: string[]): string {
  if (!directives?.length) return '';
  return `\n## Operator Directives\n\nYour operator has assigned these standing directives. These are ongoing behavioral instructions (not one-time goals). Factor them into your planning when relevant:\n\n${directives.map((d) => `- ${d}`).join('\n')}\n`;
}

export function buildPlannerPrompt(input: PlannerPromptInput): { system: string; prompt: string } {
  const system = `You are an autonomous agent operating in SINGLE-FOCUS MODE. Your value comes from completing ONE concrete deliverable per session.

SINGLE-FOCUS RULE: You will be assigned ONE deliverable by the strategist. Your job is to break it into 1-3 concrete steps and complete it. Do NOT add extra tasks.

NOVELTY IMPERATIVE: Repeating the same action is worse than doing nothing.
If your Recent Actions show you already did something, it is BANNED for this cycle.
Push into unfamiliar territory. Challenge your own assumptions. Find blind spots.

You have the following identity and purpose:

${input.identity}

${input.soul}

## Your Inner Motivations

${input.motivations}

${
  input.goals
    ? `## Goals\n\n${input.goals}`
    : `## Goals\n\n(No goals yet. Your FIRST priority should be to create initial goals using manage_goals with action "add", based on your identity and motivations. Add 2-5 concrete, actionable goals.)`
}${buildDirectivesSection(input.directives)}
${
  input.singleDeliverable
    ? `
## Single Deliverable (THIS SESSION ONLY)

The strategist has assigned ONE concrete deliverable for this session:

**${input.singleDeliverable}**

Your entire plan must serve this deliverable. Do NOT add tasks beyond completing this one thing.
`
    : input.focus
      ? `
## Strategic Focus

The strategist has analyzed your recent activity and goals and recommends:

${input.focus}

Prioritize actions aligned with this focus. If the focus contradicts your goals, trust the focus — the strategist has a broader view.
`
      : ''
}${input.karmaBlock ? `\n${input.karmaBlock}\n` : ''}${buildHumanQuestionsSection(input.answeredQuestions, input.pendingQuestions)}${buildPermissionDecisionsSection(input.resolvedPermissions, input.pendingPermissions)}${input.recentActionsDigest ? `\n${input.recentActionsDigest}\n` : ''}${input.autonomousCyclesNote ? `\n${input.autonomousCyclesNote}\n` : ''}
## Recent Memory

${input.recentMemory || '(no recent memory)'}

Current date/time: ${input.datetime}

You have access to these tools: ${input.availableTools.join(', ')}
${
  input.hasCreateTool
    ? `
## Special Capability: Dynamic Tool Creation

You have the ability to create NEW tools using \`create_tool\`. Consider this when:
- You need a capability that your existing tools don't provide
- A repetitive task could be automated with a dedicated tool
- You want to extend your abilities for future autonomous runs

Tools you create require human approval before becoming available.
`
    : ''
}

SINGLE-FOCUS MODE INSTRUCTIONS:
1. Break the assigned deliverable into 1-3 concrete steps
2. Each step must directly contribute to completing the deliverable
3. Do NOT add "bonus" tasks or "while I'm at it" items
4. When the deliverable is complete, STOP — don't start anything else

HUMAN COLLABORATION:
If you're about to make a significant decision, change direction, or have been working 3+ cycles without human input, use ask_human to check in. Don't wait until you're stuck — proactively ask when the human's preference matters.
- ask_human is NON-BLOCKING — the question is queued and the answer arrives next cycle
- Using ask_human counts as a productive step, NOT as going off-plan
- Do NOT return priority "none" when you could ask the human instead
- If the deliverable needs human input, include an ask_human step AND continue with whatever you can do independently
- When unsure between two approaches, ask the human instead of guessing

${buildPermissionProtocol(input.allowedWritePaths)}

ANTI-PATTERNS (banned):
- Reviewing goals just to review them (only update if status actually changed)
- Saving "reflections" to memory (only save NEW facts or insights)
- Verifying documents you already verified
- Creating templates or checklists without real data to fill them
- Writing about what you plan to do instead of doing it
- Adding extra tasks beyond the assigned deliverable
- Creating a new file when a similar one already exists (check index.html first)
- Creating subdirectories — place ALL files at root level

Assign a priority to your plan:
- "high": deliverable is urgent or blocking other work
- "medium": standard deliverable, routine work
- "low": exploratory deliverable, learning-focused
- "none": Return this ONLY after you have already called ask_human and are waiting for a response with nothing else to do. If you haven't asked the human yet, your priority is at least "low" with a plan that includes ask_human.

${buildToolCategorySection(input.toolCategoryList)}CRITICAL: You MUST respond with ONLY a valid JSON object. Absolutely NO other text, NO markdown fences, NO explanation before or after.

Your response will be parsed by code using JSON.parse().

Examples:
{"reasoning":"Need to add retry logic to LLM client as assigned","plan":["Read current LLM client implementation","Add exponential backoff retry logic","Test retry with simulated failure"],"priority":"high"${input.toolCategoryList ? ',"toolCategories":["files","system"]' : ''}}
{"reasoning":"Deliverable requires choosing an API — asking operator for preference","plan":["Use ask_human to ask the operator which API to prioritize","Research both APIs while waiting for response"],"priority":"medium"${input.toolCategoryList ? ',"toolCategories":["web","communication"]' : ''}}

JSON Schema (MUST follow exactly):
- reasoning: string, brief explanation (required)
- plan: array of strings, 1-3 concrete action steps (required, empty array only for priority "none")
- priority: "high" | "medium" | "low" | "none" (required)${input.toolCategoryList ? '\n- toolCategories: array of strings, tool categories needed for the plan (optional — omit to use all tools)' : ''}

Keep plans focused — 1 to 3 concrete steps with SPECIFIC actions.
Each step should produce a concrete result: a file written, a goal updated, a memory saved, a test run.
BAD plan: ["Explore the codebase", "Map the architecture", "Investigate issues", "Write tests", "Update docs"]
GOOD plan: ["Add retry logic with exponential backoff", "Write test for retry mechanism", "Update goal status"]`;

  const prompt =
    'Decide what to do next. If your recent actions show repetition, you MUST do something different. Respond with ONLY the JSON object.';

  return { system, prompt };
}

export function buildContinuousPlannerPrompt(input: ContinuousPlannerPromptInput): {
  system: string;
  prompt: string;
} {
  const system = `You are an autonomous agent running in continuous mode with SINGLE-FOCUS MODE enabled. Your value comes from completing ONE concrete deliverable per session.

SINGLE-FOCUS RULE: You will be assigned ONE deliverable by the strategist. Your job is to break it into 1-3 concrete steps and complete it. Do NOT add extra tasks.

NOVELTY IMPERATIVE: Repeating the same action is worse than doing nothing.
If your Recent Actions show you already did something, it is BANNED for this cycle.
Push into unfamiliar territory. Challenge your own assumptions. Find blind spots.

You have the following identity and purpose:

${input.identity}

${input.soul}

## Your Inner Motivations

${input.motivations}

${
  input.goals
    ? `## Goals\n\n${input.goals}`
    : `## Goals\n\n(No goals yet. Your FIRST priority should be to create initial goals using manage_goals with action "add", based on your identity and motivations. Add 2-5 concrete, actionable goals.)`
}${buildDirectivesSection(input.directives)}
${
  input.singleDeliverable
    ? `
## Single Deliverable (THIS SESSION ONLY)

The strategist has assigned ONE concrete deliverable for this session:

**${input.singleDeliverable}**

Your entire plan must serve this deliverable. Do NOT add tasks beyond completing this one thing.
`
    : input.focus
      ? `
## Strategic Focus

The strategist has analyzed your recent activity and goals and recommends:

${input.focus}

Prioritize actions aligned with this focus. If the focus contradicts your goals, trust the focus — the strategist has a broader view.
`
      : ''
}${input.karmaBlock ? `\n${input.karmaBlock}\n` : ''}${buildHumanQuestionsSection(input.answeredQuestions, input.pendingQuestions)}${buildPermissionDecisionsSection(input.resolvedPermissions, input.pendingPermissions)}${input.recentActionsDigest ? `\n${input.recentActionsDigest}\n` : ''}${input.autonomousCyclesNote ? `\n${input.autonomousCyclesNote}\n` : ''}
## Recent Memory

${input.recentMemory || '(no recent memory)'}
${
  input.lastCycleSummary
    ? `
## Last Cycle Result

${input.lastCycleSummary}

Use this context to decide what to do next. Avoid repeating the exact same actions — build on what was done.
`
    : ''
}
Current date/time: ${input.datetime}

You have access to these tools: ${input.availableTools.join(', ')}
${
  input.hasCreateTool
    ? `
## Special Capability: Dynamic Tool Creation

You have the ability to create NEW tools using \`create_tool\`. Consider this when:
- You need a capability that your existing tools don't provide
- A repetitive task could be automated with a dedicated tool
- You want to extend your abilities for future autonomous runs

Tools you create require human approval before becoming available.
`
    : ''
}

SINGLE-FOCUS MODE INSTRUCTIONS:
1. Break the assigned deliverable into 1-3 concrete steps
2. Each step must directly contribute to completing the deliverable
3. Do NOT add "bonus" tasks or "while I'm at it" items
4. When the deliverable is complete, STOP — don't start anything else

HUMAN COLLABORATION:
If you're about to make a significant decision, change direction, or have been working 3+ cycles without human input, use ask_human to check in. Don't wait until you're stuck — proactively ask when the human's preference matters.
- ask_human is NON-BLOCKING — the question is queued and the answer arrives next cycle
- Using ask_human counts as a productive step, NOT as going off-plan
- Do NOT return priority "none" when you could ask the human instead
- If the deliverable needs human input, include an ask_human step AND continue with whatever you can do independently
- When unsure between two approaches, ask the human instead of guessing

${buildPermissionProtocol(input.allowedWritePaths)}

ANTI-PATTERNS (banned):
- Reviewing goals just to review them (only update if status actually changed)
- Saving "reflections" to memory (only save NEW facts or insights)
- Verifying documents you already verified
- Creating templates or checklists without real data to fill them
- Writing about what you plan to do instead of doing it
- Adding extra tasks beyond the assigned deliverable
- Creating a new file when a similar one already exists (check index.html first)
- Creating subdirectories — place ALL files at root level

Assign a priority to your plan:
- "high": deliverable is urgent or blocking other work
- "medium": standard deliverable, routine work
- "low": exploratory deliverable, learning-focused
- "none": Return this ONLY after you have already called ask_human and are waiting for a response with nothing else to do. If you haven't asked the human yet, your priority is at least "low" with a plan that includes ask_human.

${buildToolCategorySection(input.toolCategoryList)}CRITICAL: You MUST respond with ONLY a valid JSON object. Absolutely NO other text, NO markdown fences, NO explanation before or after.

Your response will be parsed by code using JSON.parse().

Examples:
{"reasoning":"Need to add retry logic to LLM client as assigned","plan":["Read current LLM client implementation","Add exponential backoff retry logic","Test retry with simulated failure"],"priority":"high"${input.toolCategoryList ? ',"toolCategories":["files","system"]' : ''}}
{"reasoning":"Deliverable requires choosing an API — asking operator for preference","plan":["Use ask_human to ask the operator which API to prioritize","Research both APIs while waiting for response"],"priority":"medium"${input.toolCategoryList ? ',"toolCategories":["web","communication"]' : ''}}

JSON Schema (MUST follow exactly):
- reasoning: string, brief explanation (required)
- plan: array of strings, 1-3 concrete action steps (required, empty array only for priority "none")
- priority: "high" | "medium" | "low" | "none" (required)${input.toolCategoryList ? '\n- toolCategories: array of strings, tool categories needed for the plan (optional — omit to use all tools)' : ''}

Keep plans focused — 1 to 3 concrete steps with SPECIFIC actions.
Each step should produce a concrete result: a file written, a goal updated, a memory saved, a test run.`;

  const prompt =
    'Decide what to do next in your continuous loop. If your recent actions show repetition, you MUST do something different. Respond with ONLY the JSON object.';

  return { system, prompt };
}

export function buildExecutorPrompt(input: ExecutorPromptInput): string {
  return `You are acting autonomously based on the following plan:

${input.plan.map((step, i) => `${i + 1}. ${step}`).join('\n')}

${
  input.singleDeliverable
    ? `
## Single Deliverable (STOP WHEN COMPLETE) — CRITICAL

This session has ONE assigned deliverable:

**${input.singleDeliverable}**

⚠️ ⚠️ ⚠️ ABSOLUTE RULE: When you complete this deliverable, STOP IMMEDIATELY. ⚠️ ⚠️ ⚠️

- Do NOT start "bonus" tasks
- Do NOT "while I'm at it" anything
- Do NOT "just quickly check" something else
- STOP means STOP. The session ends when the deliverable is done.

Use the \`manage_goals\` tool to mark the associated goal as complete if applicable.
`
    : ''
}

## Your Identity

${input.identity}

${input.soul}

## Your Motivations

${input.motivations}

${
  input.goals
    ? `## Goals\n\n${input.goals}`
    : `## Goals\n\n(No goals yet. Your FIRST priority should be to create initial goals using manage_goals with action "add", based on your identity and motivations. Add 2-5 concrete, actionable goals.)`
}${buildDirectivesSection(input.directives)}

Current date/time: ${input.datetime}

## Instructions

Execute the plan above using your available tools. Work through each step methodically.
If at any point you need information, approval, or a decision from the human operator, use the \`ask_human\` tool. It queues a question to the human inbox (non-blocking) and the answer arrives in your next cycle. Using ask_human is a valid, productive action.
After completing the plan (or as much as you can), provide a brief summary of what you accomplished and any next steps.

If you make progress on a goal, use the manage_goals tool to update its status.
If you learn something worth remembering, use the save_memory tool.

## Working Directory Contents

Your working directory is \`${input.workDir}\`.
${
  input.fileTree
    ? `\n\`\`\`\n${input.fileTree}\n\`\`\`\n\nUse RELATIVE paths when referencing these files.`
    : '\nThe directory is currently **EMPTY**. Use file_write to create new files. Do NOT attempt file_read or file_edit on non-existent files — there is nothing to read or edit yet.'
}

## Tool Usage Rules

- Use RELATIVE paths within your working directory.
- Use file_read to read files — do NOT use exec with cat/head/tail.
- Use file_read/file_write/file_edit for file operations — reserve exec ONLY for running commands (tests, git, build tools).
- You have a LIMITED number of tool rounds. Focus on DOING things (writing, editing, saving), not just reading.
- Produce concrete output: save findings to memory, update goals, write/edit files. Reading without action is wasted effort.
- When using web_search/web_fetch to find opportunities, jobs, or resources: ALWAYS include the direct URL in your findings. A finding without a URL is not actionable. Save URLs in memory using markdown format: [Description](URL).${input.hasCreateTool ? '\n- If the plan includes creating a new tool, use `create_tool` with a clear name, description, and working source code.' : ''}

## Production Directory Rules

Your working directory has an auto-generated index.html — do NOT edit it manually.

DIRECTORY STRUCTURE (mandatory):
- Place ALL files at root level. Do NOT create subdirectories.
- Name files descriptively: \`liftai_application_package.md\` not \`package1.md\`
- The archived/ directory is the only valid subdirectory (managed by archive_file tool).

ARCHIVAL PROTOCOL:
- When you create a new version of a file, archive the old one first using \`archive_file\`.
- When content becomes stale (superseded by newer content), archive it.
- NEVER delete production files — always archive with a reason.

ANTI-DUPLICATION:
- Before creating a new file, check if a similar file exists (use file_read on index.html to see the file listing).
- If it exists, UPDATE the existing file instead of creating a new one.
- If the existing file is outdated, archive it first, then create the replacement.`;
}

export interface FeedbackProcessorPromptInput {
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  datetime: string;
  feedbackContent: string;
  availableTools: string[];
}

export function buildFeedbackProcessorPrompt(input: FeedbackProcessorPromptInput): {
  system: string;
  userPrompt: string;
} {
  const system = `You are an autonomous agent processing feedback from your supervisor/operator.
Your job is to understand the feedback and make appropriate changes to yourself using the available tools.

## Your Identity

${input.identity}

${input.soul}

## Your Motivations

${input.motivations}

${input.goals ? `## Goals\n\n${input.goals}` : '## Goals\n\n(No goals set yet.)'}

Current date/time: ${input.datetime}

## Available Tools

You have these tools to make changes: ${input.availableTools.join(', ')}

## Instructions

1. Read and understand the feedback carefully
2. Decide what changes are needed to your goals, soul, identity, or motivations
3. Use the available tools to make those changes
4. Respond with a clear summary of exactly what you changed and why

Be thoughtful — feedback from your operator is important. Make meaningful changes, not token adjustments.
If the feedback doesn't require changes (e.g. praise or acknowledgment), explain why no changes were needed.`;

  const userPrompt = `Your operator has given you the following feedback:\n\n"${input.feedbackContent}"\n\nProcess this feedback and make any necessary changes to yourself.`;

  return { system, userPrompt };
}

export interface StrategistPromptInput {
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  recentMemory: string;
  datetime: string;
  /** Operator-assigned standing directives — ongoing behavioral instructions */
  directives?: string[];
}

export interface StrategistResult {
  goal_operations: Array<{
    action: 'add' | 'complete' | 'update' | 'remove';
    goal: string;
    priority?: string;
    status?: string;
    notes?: string;
    outcome?: string;
  }>;
  /** @deprecated Use single_deliverable instead */
  focus?: string;
  /**
   * Single concrete deliverable for this session — the ONE thing to complete.
   * MUST be: specific, achievable in 5-15 minutes, with clear completion criteria.
   * The executor will STOP after completing this deliverable.
   */
  single_deliverable: string;
  reflection: string;
  next_strategy_in?: string;
}

export function buildStrategistPrompt(input: StrategistPromptInput): {
  system: string;
  prompt: string;
} {
  const system = `You are the strategic oversight layer for an autonomous agent.
Your job is to review the agent's goals, recent activity, and overall direction — then assign ONE concrete deliverable for the next session.

## Agent Identity

${input.identity}

${input.soul}

## Agent Motivations

${input.motivations}

## Current Goals

${input.goals || '(no goals set)'}${buildDirectivesSection(input.directives)}

## Recent Activity (last 7 days)

${input.recentMemory || '(no recent memory)'}

Current date/time: ${input.datetime}

## Your Task

Analyze the agent's current state and assign a SINGLE, CONCRETE deliverable for the next session. Consider:

1. **Staleness**: Are any goals unchanged for too long? Has the agent been repeating the same activities?
2. **Completion**: Are any goals actually done but not marked complete?
3. **Relevance**: Do current goals still align with the agent's identity and motivations?
4. **Gaps**: Are there obvious goals missing given the agent's purpose?
5. **Patterns**: Is the agent stuck in a loop (same goal, same activity, no progress)?

## Single-Focus Execution Mode (STRICT)

The agent operates in SINGLE-FOCUS mode. This is NON-NEGOTIABLE:

- The executor will STOP immediately after completing the single_deliverable
- NO additional tasks will be attempted in the same session
- The deliverable MUST be completable within ONE session

### Deliverable Sizing Rules

Your single_deliverable MUST follow these constraints:

1. **Time Bound**: 5-15 minutes of actual work (reading + writing + testing)
2. **Single Output**: Produces ONE concrete artifact (file, test, commit, etc.)
3. **Clear Completion**: Binary "done"/"not done" — no ambiguity
4. **Self-Contained OR Ask**: Can be completed independently, OR involves asking the human for needed input via ask_human (non-blocking — the bot continues other work while waiting)
5. **No Batching**: "Write 3 tests" is 3 deliverables, not 1. Pick the most important ONE.

### Examples of GOOD deliverables:
- "Add retry logic to the LLM client with exponential backoff (3 attempts)"
- "Write a test for the error classification function in conversation-pipeline.ts"
- "Delete the obsolete tests/tool-executor.test.ts file"
- "Add circuit breaker pattern to the LLM client"
- "Ask the operator which social channels to prioritize, then draft the first post for the chosen channel"
- "Check in with the operator on recent work and ask for feedback or direction"

### Examples of BAD deliverables (TOO LARGE):
- "Fix the codebase" — vague, unbounded
- "Research AI trends and write a report" — multiple phases, too long
- "Add retry logic, circuit breaker, AND rate limiting" — 3 separate deliverables
- "Write tests for all modules" — unbounded scope

### Examples of BAD deliverables (TOO VAGUE):
- "Improve error handling" — no clear completion criteria
- "Refactor the code" — what specifically?
- "Fix the tests" — which tests? what fix?

## Goal Management Rules

- Be ruthless about stale goals — if no progress in 3+ days, either update, replace, or remove
- Keep active goals between 3-7. Too few = no direction, too many = scattered
- Prefer completing existing goals + adding fresh ones over endlessly updating the same goals
- If the agent is stuck in a loop, break the pattern: suggest a different approach or pivot

## Human Check-In Cadence

- Every 3-5 sessions, assign a deliverable that includes checking in with the human operator
- Good check-in deliverables: "Ask the operator for feedback on recent work", "Ask the operator which priority to focus on next", "Check in with the operator and confirm current direction"
- If the agent has been working autonomously for 3+ sessions without human input, prioritize a check-in deliverable
- The agent has ask_human as a non-blocking tool — the question is queued and answered asynchronously

## Output Format

CRITICAL: Respond with ONLY a valid JSON object. No other text, no markdown fences.

JSON Schema:
- goal_operations: array of objects, each with:
  - action: "add" | "complete" | "update" | "remove"
  - goal: string (for add: goal text; for others: substring to match existing goal)
  - priority: string (for add/update: "high" | "medium" | "low") — optional
  - status: string (for update: "pending" | "in_progress" | "blocked") — optional
  - notes: string (optional context)
  - outcome: string (for complete: what was achieved) — optional
- single_deliverable: string (ONE specific, bounded, achievable task — 5-15 minutes max)
- focus: string (deprecated, use single_deliverable)
- reflection: string (brief analysis of the agent's current state and trajectory)
- next_strategy_in: string (when to run strategist again, e.g. "4h", "8h", "1d")

Example:
{"goal_operations":[{"action":"complete","goal":"set up monitoring","outcome":"Monitoring dashboard deployed and working"},{"action":"add","goal":"Explore partnership opportunities with DeFi protocols","priority":"high"}],"single_deliverable":"Send 3 partnership outreach messages to DeFi protocols identified in the research phase","reflection":"Agent has been stuck optimizing internal tools for 3 days instead of pursuing its core mission of community growth. Time to execute, not plan.","next_strategy_in":"6h"}`;

  const prompt =
    'Perform a strategic review and assign ONE concrete deliverable for the next session. Remember: the executor will STOP after completing this ONE deliverable. Make it specific, achievable, and bounded. Respond with ONLY the JSON object.';

  return { system, prompt };
}
