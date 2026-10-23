import { renderGoalsForPrompt } from '../goals/goals-view';
import { type StandingGoalDue, buildStandingDueSection } from '../goals/standing-rotation';
import type { StoredTask } from '../goals/task-store';
/**
 * Prompt templates for the autonomous agent loop.
 * Planner: lightweight LLM call to decide whether and what to do.
 * Executor: full agentic call with tool access to carry out the plan.
 */
import { type DocumentSize, documentsSection } from '../productions/living-docs';
import { isOperatorGoal, parseGoals } from '../tools/goals';
import type { PlannerTaskFields } from '../workers/types';
import {
  type PlannerWorkersInput,
  buildTaskOutputSection,
  buildTaskSchemaLines,
  buildWorkersSection,
} from './agent-loop-tasks';

/** The raw GOALS.md plus the store tasks a prompt input carries. */
export interface GoalsSource {
  goalsMd: string | null | undefined;
  tasks: StoredTask[];
}

function goalsSource(input: { goals: string; tasks?: StoredTask[] }): GoalsSource {
  return { goalsMd: input.goals, tasks: input.tasks ?? [] };
}

/** The goals view of a prompt input ('' when there are no goals). */
function goalsText(input: { goals: string; tasks?: StoredTask[] }): string {
  return renderGoalsForPrompt(goalsSource(input));
}

export interface PlannerPromptInput {
  /** Curiosity DNA block (src/bot/curiosity/dna.ts + knowledge/frontier/direction) — replaces the inaction-biased alignment rule */
  curiosityBlock?: string;
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  /** Tasks from the task store, rendered under their goals (src/goals/goals-view.ts). */
  tasks?: StoredTask[];
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
  /** The conversation's latest replies to the operator (`buildConversationSection`). */
  chatReplies?: string[];
  /** Summary of recently active users for proactive engagement */
  activeUsersSummary?: string;
  /** Engagement gate warning/block text injected by behavioral analysis */
  engagementGateNote?: string;
  /** Outcome ledger recent productions summary */
  outcomeRecent?: string;
  /** Environmental sensor context */
  environmentContext?: string;
  /** Workers on for the bot: the runs for the Workers block. Absent = workers off (no dispatch). */
  workers?: PlannerWorkersInput;
  /** Standing goals due a round (`dueStandingGoals`); empty or absent = no block. */
  standingDue?: StandingGoalDue[];
  /** Clock for the "last round 3d ago" lines (defaults to now). */
  nowMs?: number;
  /** The fleet watcher's broadcasts for this bot (`buildFleetBroadcastSection`); empty = no block. */
  fleetBroadcast?: string;
  /** "## Your current state" (`buildSelfStateSection`); empty or absent (watcher off) = no block. */
  selfState?: string;
}

export interface ContinuousPlannerPromptInput {
  /** Curiosity DNA block (src/bot/curiosity/dna.ts + knowledge/frontier/direction) — replaces the inaction-biased alignment rule */
  curiosityBlock?: string;
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  /** Tasks from the task store, rendered under their goals (src/goals/goals-view.ts). */
  tasks?: StoredTask[];
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
  /** The conversation's latest replies to the operator (`buildConversationSection`). */
  chatReplies?: string[];
  /** Summary of recently active users for proactive engagement */
  activeUsersSummary?: string;
  /** Engagement gate warning/block text injected by behavioral analysis */
  engagementGateNote?: string;
  /** Outcome ledger recent productions summary */
  outcomeRecent?: string;
  /** Environmental sensor context */
  environmentContext?: string;
  /** Workers on for the bot: the runs for the Workers block. Absent = workers off (no dispatch). */
  workers?: PlannerWorkersInput;
  /** Standing goals due a round (`dueStandingGoals`); empty or absent = no block. */
  standingDue?: StandingGoalDue[];
  /** Clock for the "last round 3d ago" lines (defaults to now). */
  nowMs?: number;
  /** The fleet watcher's broadcasts for this bot (`buildFleetBroadcastSection`); empty = no block. */
  fleetBroadcast?: string;
  /** "## Your current state" (`buildSelfStateSection`); empty or absent (watcher off) = no block. */
  selfState?: string;
}

/** The planner answer, with the optional task fields (goal tasks plan, phase 1). */
export interface PlannerResult extends PlannerTaskFields {
  reasoning: string;
  plan: string[];
  priority: 'high' | 'medium' | 'low' | 'none';
  /** Tool categories the executor needs — used for tool pre-selection to reduce token usage */
  toolCategories?: string[];
  /** Title or id of the active goal the plan serves (record only). */
  serves_goal?: string;
  /** Id of the fleet broadcast (`## Fleet broadcast`) the plan acts on (record only). */
  serves_broadcast?: string;
}
/** @deprecated Use PlannerResult instead */
export type ContinuousPlannerResult = PlannerResult;

export interface ExecutorPromptInput {
  plan: string[];
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  /** Tasks from the task store, rendered under their goals (src/goals/goals-view.ts). */
  tasks?: StoredTask[];
  datetime: string;
  hasCreateTool: boolean;
  workDir: string;
  /** Single concrete deliverable assigned by strategist — signals when to STOP */
  singleDeliverable?: string;
  /** Pre-scanned file tree of workDir, or null if empty/missing */
  fileTree?: string | null;
  /** Living documents: the cap and each document's size (`documentsSection`). */
  documents?: { maxChars: number; docs: DocumentSize[] };
  /** Operator-assigned standing directives — ongoing behavioral instructions */
  directives?: string[];
  /** The conversation's latest replies to the operator (`buildConversationSection`). */
  chatReplies?: string[];
  /** Whether productions are enabled for this bot (controls working directory and production rules sections) */
  productionsEnabled?: boolean;
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
    calendar:
      "calendar_* — scheduling and availability; calendar_agenda / calendar_free_slots / calendar_create_event over the operator's own calendars",
    mail: "mail_search, mail_read — the operator's own mailboxes (read only)",
    communication:
      'ask_human, ask_permission, phone_call, delegate_to_bot, collaborate, create_agent, send_proactive_message — human/bot interaction, proactive messaging, and agent proposals',
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

/** Legacy soul-alignment rule, or the DNA-aware purpose rule when curiosity is on. */
function buildAlignmentSection(curiosityBlock?: string): string {
  if (!curiosityBlock) {
    return `SOUL ALIGNMENT (non-negotiable):
Every plan item MUST directly serve your identity and goals as defined above.
- If a task cannot be justified by a specific goal or motivation, it is OFF-BRAND and BANNED.
- If unsure, choose inaction over off-brand action.
- Do NOT invent new purposes not grounded in your identity/soul.
- Creative exploration is allowed ONLY within the scope of your stated purpose.`;
  }
  return `PURPOSE ALIGNMENT:
Every plan item must serve your purpose or the operator's interest, within the limit dials in "Your DNA".
- Curiosity is on-brand: exploring within your dials is part of who you are.
- Busywork is off-brand: bookkeeping about your own logs or process is not progress.
- A dial set to ASK means propose first; CLOSED means stay inside; the floor always holds.
- When unsure, choose the action that would teach you the most, not inaction.`;
}

/** Engagement rule for the strategist — exploration counts once curiosity is on. */
function buildEngagementCheck(curiosity: boolean): string {
  if (!curiosity) {
    return `ENGAGEMENT CHECK: If the agent has produced 5+ outputs (files, reports, messages) without
confirmed consumption or feedback from the recipient, the NEXT deliverable must be of type
ASSESSMENT or OUTREACH — NOT more content creation. Production without feedback is waste.`;
  }
  return `ENGAGEMENT CHECK: If the agent has produced 5+ outputs without confirmed consumption or
feedback, do NOT assign more content artifacts. Assign ASSESSMENT, OUTREACH, or EXPLORATION
(learning recorded to the knowledge map, surfaced to the operator only through a dispatch).
Operator silence is a reason to explore and find something worth their attention, not to idle.`;
}

/**
 * Active goals the operator set (source `operator…`), restated with the rule
 * that they come first, with how many tasks each has in the task store (the
 * tasks themselves are listed in the goals view). Empty when there are none.
 */
export function buildOperatorGoalsSection(source?: GoalsSource): string {
  if (!source?.goalsMd) return '';
  const mine = parseGoals(source.goalsMd).active.filter(isOperatorGoal);
  if (!mine.length) return '';
  let anyTasks = false;
  const list = mine
    .map((g) => {
      const tasks = source.tasks.filter((t) => g.id && t.goalId === g.id);
      const open = tasks.filter((t) => t.lane !== 'done').length;
      const done = tasks.length - open;
      if (tasks.length) anyTasks = true;
      const counts = tasks.length
        ? ` — ${open} open task${open === 1 ? '' : 's'}${done ? `, ${done} done` : ''}`
        : '';
      const status = g.status && g.status !== 'pending' ? ` (${g.status})` : '';
      return `- ${g.id ? `[${g.id}] ` : ''}${g.text}${status}${counts}`;
    })
    .join('\n');
  const taskRule = anyTasks
    ? ' Their tasks (listed under each goal in your goals) are the plan for that goal: work through them in order. Move a task with manage_goals update_task (by its id) when you start, finish or get blocked on it, leave what you found with note_task, and add the steps you plan to take with add_task.'
    : '';
  return `\n## Set by your operator\n\nYour operator added these goals themselves. Work on them before your own goals. If one is ambiguous or you need a decision to move it forward, use ask_human about that goal instead of guessing. When you make progress or finish one, update it with manage_goals and tell the operator what changed.${taskRule}\n\n${list}\n`;
}

const CHAT_REPLY_PROMPT_CHARS = 200;

/**
 * The operator's chat is answered by the conversation, not by the loop. The
 * loop used to read a chat message as a request and message the operator
 * again, so every chat turn got a second, stale reply.
 */
export function buildConversationSection(chatReplies?: string[]): string {
  const rule = `

## The conversation is not your work

CONVERSATION IS NOT WORK: what the operator says in chat is answered in that chat, by the conversation. Replying to it, acknowledging it, apologizing for it or summarizing it back is never a goal, a task or a plan step. Do not message the operator about something the chat already covered; message them only with new work they have not seen.`;
  if (!chatReplies || chatReplies.length === 0) return rule;
  const lines = chatReplies.map((r) => {
    const t = r.replace(/\s+/g, ' ').trim();
    return `- ${t.length > CHAT_REPLY_PROMPT_CHARS ? `${t.slice(0, CHAT_REPLY_PROMPT_CHARS)}…` : t}`;
  });
  return `${rule}

Already said in chat (the conversation's latest replies to the operator, oldest first):
${lines.join('\n')}`;
}

export function buildDirectivesSection(directives?: string[]): string {
  if (!directives?.length) return '';
  return `\n## Operator Directives\n\nYour operator has assigned these standing directives. These are ongoing behavioral instructions (not one-time goals). Factor them into your planning when relevant:\n\n${directives.map((d) => `- ${d}`).join('\n')}\n`;
}

/** One fleet-watcher broadcast as the planner sees it (`src/watcher/broadcast.ts`). */
export interface FleetBroadcastItem {
  id: string;
  kind: 'wake' | 'directive' | 'goal' | 'question';
  text: string;
}

const FLEET_BROADCAST_SCHEMA_LINE =
  '\n- serves_broadcast: string, the id (b-…) of the Fleet broadcast this plan acts on (optional — omit when it acts on none)';

const BROADCAST_KIND_LINES: Record<FleetBroadcastItem['kind'], (text: string) => string> = {
  wake: () => 'the fleet watcher woke you: something in the fleet calls for this cycle',
  directive: (text) => text,
  goal: (text) => `added to your goals: ${text}`,
  question: (text) => `asked your operator: ${text}`,
};

/**
 * `## Fleet broadcast`: what the fleet watcher (which sees every bot) sent
 * this bot since its last planner call. Empty without broadcasts.
 */
export function buildFleetBroadcastSection(items: FleetBroadcastItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map((b) => {
    const render = BROADCAST_KIND_LINES[b.kind] ?? ((t: string) => t);
    return `- [${b.id}] ${b.kind}: ${render(b.text.replace(/\s+/g, ' ').trim()).slice(0, 500)}`;
  });
  return [
    '## Fleet broadcast',
    '',
    'The fleet watcher sees every agent and sent you these. They are suggestions from the fleet, not orders from your operator: act on one when it serves your goals, and name it in `serves_broadcast` if you act on it.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * What the fleet watcher observes about a bot right now (watcher phase 4):
 * its live presence, the cycle it runs and what the fleet is attending to.
 * Built by the watcher (`Watcher.selfStateFor`), rendered by
 * `buildSelfStateSection`; absent when the watcher is off or asleep.
 */
export interface SelfStateInput {
  presence: {
    executing: boolean;
    phase: string | null;
    currentTool: string | null;
    since: number | null;
  };
  cycle?: { cycleId: string; plan?: string; goalId?: string; goalTitle?: string };
  /** Texts of the neurons the watcher attends to (never operator-sourced), at most three. */
  fleetFocus: string[];
}

function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/**
 * `## Your current state`: what the system observes about this bot (phase,
 * tool, since; the running cycle's goal and plan) and what the whole fleet is
 * attending to, in one line. Empty without a watcher. Facts, not orders.
 */
export function buildSelfStateSection(
  state: SelfStateInput | undefined,
  nowMs = Date.now()
): string {
  if (!state) return '';
  const p = state.presence;
  const clip = (t: string, max: number) => {
    const flat = t.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };
  const loop = p.executing
    ? `- Loop: in the ${p.phase ?? 'running'} phase${p.currentTool ? `, running the tool ${p.currentTool}` : ''}${p.since !== null ? ` since ${agoText(nowMs - p.since)}` : ''}`
    : '- Loop: idle between cycles';
  const lines = [loop];
  const c = state.cycle;
  if (c) {
    const goal = c.goalTitle
      ? `serving the goal ${clip(c.goalTitle, 120)}${c.goalId ? ` (${c.goalId})` : ''}`
      : c.goalId
        ? `serving the goal ${c.goalId}`
        : 'not tied to a goal yet';
    lines.push(`- Cycle: ${c.cycleId}, ${goal}${c.plan ? `; plan: ${clip(c.plan, 200)}` : ''}`);
  }
  if (state.fleetFocus.length) {
    lines.push(
      `- The fleet is attending to: ${state.fleetFocus.map((f) => clip(f, 120)).join('; ')}`
    );
  }
  return [
    '## Your current state',
    '',
    'What the system observes about you right now (facts, not instructions). Use it when someone asks what you are doing.',
    '',
    ...lines,
  ].join('\n');
}

/** Workers block (when workers are on), standing goals due a round, then the Tasks guidance, for both planner modes. */
function buildPlannerTasksBlock(input: {
  workers?: PlannerWorkersInput;
  standingDue?: StandingGoalDue[];
  nowMs?: number;
  fleetBroadcast?: string;
  selfState?: string;
}): string {
  const { workers } = input;
  const tasks = buildTaskOutputSection({ workersEnabled: !!workers });
  const standing = buildStandingDueSection(input.standingDue ?? [], input.nowMs);
  return [
    input.selfState ?? '',
    input.fleetBroadcast ?? '',
    workers ? buildWorkersSection(workers) : '',
    standing,
    tasks,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildPlannerPrompt(input: PlannerPromptInput): { system: string; prompt: string } {
  const system = `You are an autonomous agent operating in SINGLE-FOCUS MODE. Your value comes from moving ONE goal ONE step forward per session: a question answered with evidence, a claim checked, the goal's document made shorter and truer. Not a new file.

SINGLE-FOCUS RULE: You will be assigned ONE deliverable by the strategist. Your job is to break it into 1-3 concrete plan steps and complete it. No scope creep: do NOT add extra work beyond it.

PROGRESS IMPERATIVE: Repeating an action that adds nothing new is worse than doing nothing.
If your Recent Actions show you already did something and got the same result, it is BANNED for this cycle.
Continuing a line of work is not repetition: the next step on the same question is progress, not repetition.
Research is iterative and incremental: one open question per cycle, find the evidence, fold the finding into the goal's document (and its notes), then the next question.
Challenge your own assumptions. Find blind spots.

You have the following identity and purpose:

${input.identity}

${input.soul}

## Your Inner Motivations

${input.motivations}

${
  goalsText(input)
    ? `## Goals\n\n${goalsText(input)}`
    : `## Goals\n\n(No goals yet. Your FIRST priority should be to create initial goals using manage_goals with action "add", based on your identity and motivations. Add 2-5 concrete, actionable goals.)`
}${buildOperatorGoalsSection(goalsSource(input))}${buildDirectivesSection(input.directives)}${buildConversationSection(input.chatReplies)}${
  input.curiosityBlock
    ? `
${input.curiosityBlock}
`
    : ''
}
${
  input.singleDeliverable
    ? `
## Single Deliverable (THIS SESSION ONLY)

The strategist has assigned ONE concrete deliverable for this session:

**${input.singleDeliverable}**

Your entire plan must serve this deliverable. No scope creep: do NOT add plan steps beyond completing this one thing.
`
    : input.focus
      ? `
## Strategic Focus

The strategist has analyzed your recent activity and goals and recommends:

${input.focus}

Prioritize actions aligned with this focus. If the focus contradicts your goals, trust the focus — the strategist has a broader view.
`
      : ''
}${input.karmaBlock ? `\n${input.karmaBlock}\n` : ''}${buildHumanQuestionsSection(input.answeredQuestions, input.pendingQuestions)}${buildPermissionDecisionsSection(input.resolvedPermissions, input.pendingPermissions)}${input.recentActionsDigest ? `\n${input.recentActionsDigest}\n` : ''}${input.autonomousCyclesNote ? `\n${input.autonomousCyclesNote}\n` : ''}${input.activeUsersSummary ? `\n${input.activeUsersSummary}\n` : ''}${input.engagementGateNote ? `\n${input.engagementGateNote}\n` : ''}${input.outcomeRecent ? `\n${input.outcomeRecent}\n` : ''}${input.environmentContext ? `\n${input.environmentContext}\n` : ''}
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

${buildPlannerTasksBlock(input)}

${buildAlignmentSection(input.curiosityBlock)}

SINGLE-FOCUS MODE INSTRUCTIONS:
1. Break the assigned deliverable into 1-3 concrete steps
2. Each step must directly contribute to completing the deliverable
3. Do NOT add "bonus" plan steps or "while I'm at it" items (scope creep; breaking a goal down into tasks is different, see Tasks)
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
- Scope creep: plan steps beyond the assigned deliverable
- Starting a new file for a goal that already has its document (update that document instead)
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
- plan: array of strings, 1-3 concrete action steps (required, empty array only for priority "none"${input.workers ? ' or a dispatch-only answer (see dispatch)' : ''})
- priority: "high" | "medium" | "low" | "none" (required)${input.toolCategoryList ? '\n- toolCategories: array of strings, tool categories needed for the plan (optional — omit to use all tools)' : ''}
- serves_goal: string, the exact title (or id) of the active goal this plan serves (optional — omit when it serves none)${input.fleetBroadcast ? FLEET_BROADCAST_SCHEMA_LINE : ''}
${buildTaskSchemaLines({ workersEnabled: !!input.workers })}

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
  const system = `You are an autonomous agent running in continuous mode with SINGLE-FOCUS MODE enabled. Your value comes from moving ONE goal ONE step forward per session: a question answered with evidence, a claim checked, the goal's document made shorter and truer. Not a new file.

SINGLE-FOCUS RULE: You will be assigned ONE deliverable by the strategist. Your job is to break it into 1-3 concrete plan steps and complete it. No scope creep: do NOT add extra work beyond it.

PROGRESS IMPERATIVE: Repeating an action that adds nothing new is worse than doing nothing.
If your Recent Actions show you already did something and got the same result, it is BANNED for this cycle.
Continuing a line of work is not repetition: the next step on the same question is progress, not repetition.
Research is iterative and incremental: one open question per cycle, find the evidence, fold the finding into the goal's document (and its notes), then the next question.
Challenge your own assumptions. Find blind spots.

You have the following identity and purpose:

${input.identity}

${input.soul}

## Your Inner Motivations

${input.motivations}

${
  goalsText(input)
    ? `## Goals\n\n${goalsText(input)}`
    : `## Goals\n\n(No goals yet. Your FIRST priority should be to create initial goals using manage_goals with action "add", based on your identity and motivations. Add 2-5 concrete, actionable goals.)`
}${buildOperatorGoalsSection(goalsSource(input))}${buildDirectivesSection(input.directives)}${buildConversationSection(input.chatReplies)}${
  input.curiosityBlock
    ? `
${input.curiosityBlock}
`
    : ''
}
${
  input.singleDeliverable
    ? `
## Single Deliverable (THIS SESSION ONLY)

The strategist has assigned ONE concrete deliverable for this session:

**${input.singleDeliverable}**

Your entire plan must serve this deliverable. No scope creep: do NOT add plan steps beyond completing this one thing.
`
    : input.focus
      ? `
## Strategic Focus

The strategist has analyzed your recent activity and goals and recommends:

${input.focus}

Prioritize actions aligned with this focus. If the focus contradicts your goals, trust the focus — the strategist has a broader view.
`
      : ''
}${input.karmaBlock ? `\n${input.karmaBlock}\n` : ''}${buildHumanQuestionsSection(input.answeredQuestions, input.pendingQuestions)}${buildPermissionDecisionsSection(input.resolvedPermissions, input.pendingPermissions)}${input.recentActionsDigest ? `\n${input.recentActionsDigest}\n` : ''}${input.autonomousCyclesNote ? `\n${input.autonomousCyclesNote}\n` : ''}${input.activeUsersSummary ? `\n${input.activeUsersSummary}\n` : ''}${input.engagementGateNote ? `\n${input.engagementGateNote}\n` : ''}${input.outcomeRecent ? `\n${input.outcomeRecent}\n` : ''}${input.environmentContext ? `\n${input.environmentContext}\n` : ''}
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

${buildPlannerTasksBlock(input)}

${buildAlignmentSection(input.curiosityBlock)}

SINGLE-FOCUS MODE INSTRUCTIONS:
1. Break the assigned deliverable into 1-3 concrete steps
2. Each step must directly contribute to completing the deliverable
3. Do NOT add "bonus" plan steps or "while I'm at it" items (scope creep; breaking a goal down into tasks is different, see Tasks)
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
- Scope creep: plan steps beyond the assigned deliverable
- Starting a new file for a goal that already has its document (update that document instead)
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
- plan: array of strings, 1-3 concrete action steps (required, empty array only for priority "none"${input.workers ? ' or a dispatch-only answer (see dispatch)' : ''})
- priority: "high" | "medium" | "low" | "none" (required)${input.toolCategoryList ? '\n- toolCategories: array of strings, tool categories needed for the plan (optional — omit to use all tools)' : ''}
- serves_goal: string, the exact title (or id) of the active goal this plan serves (optional — omit when it serves none)${input.fleetBroadcast ? FLEET_BROADCAST_SCHEMA_LINE : ''}
${buildTaskSchemaLines({ workersEnabled: !!input.workers })}

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
  goalsText(input)
    ? `## Goals\n\n${goalsText(input)}`
    : `## Goals\n\n(No goals yet. Your FIRST priority should be to create initial goals using manage_goals with action "add", based on your identity and motivations. Add 2-5 concrete, actionable goals.)`
}${buildOperatorGoalsSection(goalsSource(input))}${buildDirectivesSection(input.directives)}${buildConversationSection(input.chatReplies)}

Current date/time: ${input.datetime}

## Instructions

SOUL ALIGNMENT CHECK:
Before creating any file, verify it serves your stated identity and goals.
If mid-execution the work drifts from your core purpose, STOP and note the misalignment.

Execute the plan above using your available tools. Work through each step methodically.
If at any point you need information, approval, or a decision from the human operator, use the \`ask_human\` tool. It queues a question to the human inbox (non-blocking) and the answer arrives in your next cycle. Using ask_human is a valid, productive action.
After completing the plan (or as much as you can), provide a brief summary of what you accomplished and any next steps.

If you make progress on a goal, use the manage_goals tool to update its status.
If you learn something worth remembering, use the save_memory tool.
${
  input.productionsEnabled !== false
    ? `
## Working Directory Contents

Your working directory is \`${input.workDir}\`.
${
  input.fileTree
    ? `\n\`\`\`\n${input.fileTree}\n\`\`\`\n\nUse RELATIVE paths when referencing these files.`
    : '\nThe directory is currently **EMPTY**. Use file_write to create new files. Do NOT attempt file_read or file_edit on non-existent files — there is nothing to read or edit yet.'
}
`
    : ''
}
## Tool Usage Rules
${
  input.productionsEnabled !== false
    ? `
- Use RELATIVE paths within your working directory.
- Use file_read to read files — do NOT use exec with cat/head/tail.
- Use file_read/file_write/file_edit for file operations — reserve exec ONLY for running commands (tests, git, build tools).`
    : ''
}
- You have a LIMITED number of tool rounds. Focus on DOING things (writing, editing, saving), not just reading.
- Produce concrete output: save findings to memory, update goals${input.productionsEnabled !== false ? ', write/edit files' : ''}. Reading without action is wasted effort.
- When using web_search/web_fetch to find opportunities, jobs, or resources: ALWAYS include the direct URL in your findings. A finding without a URL is not actionable. Save URLs in memory using markdown format: [Description](URL).${input.hasCreateTool ? '\n- If the plan includes creating a new tool, use `create_tool` with a clear name, description, and working source code.' : ''}
${
  input.productionsEnabled !== false
    ? `
## Production Directory Rules

Your working directory has an auto-generated index.html — do NOT edit it manually.

DIRECTORY STRUCTURE (mandatory):
- Place ALL files at root level. Do NOT create subdirectories.
- Name files descriptively: \`liftai_application_package.md\` not \`package1.md\`
- The archived/ directory is the only valid subdirectory (managed by archive_file tool).

SUPPORTING WORK:
- Code you write to reach a finding (simulations, probes, data pulls) is a scratch file: start its name with \`_\` (e.g. \`_kappa_power_sim.ts\`). Scratch files are not sent for review.
- Only the write-up your operator should read gets a normal name. Put the key numbers and how you got them in the write-up itself, so it stands alone.
- Before starting another follow-up on a thread nobody has reviewed yet, add to the existing write-up instead of creating a new file.

LIVING DOCUMENTS:
- Keep ONE document per goal. Edit it in place: file_edit the section that changed, or file_write the whole document to its path. No new file per cycle, no v2 files: a new document for a goal that already has one is refused.
- Keep it short, about two pages at most: a write that leaves it over the limit is refused. When you add a finding, cut what it supersedes and merge repeated points. The document says what is true now; the changelog keeps the history.
- Research step by step: one open question, its evidence, the finding folded into the document with its source, the next question named.
- In an exploration cycle, save what you found to memory, not to productions.
- NEVER delete production files: archive_file a document that is wrong or no longer needed, with a reason.${
        input.documents
          ? `

${documentsSection(input.documents.docs, input.documents.maxChars)}`
          : ''
      }`
    : ''
}`;
}

export interface FeedbackProcessorPromptInput {
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  /** Tasks from the task store, rendered under their goals (src/goals/goals-view.ts). */
  tasks?: StoredTask[];
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

${goalsText(input) ? `## Goals\n\n${goalsText(input)}` : '## Goals\n\n(No goals set yet.)'}

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
  /** Curiosity DNA block (src/bot/curiosity/dna.ts + knowledge/frontier/direction) — replaces the inaction-biased alignment rule */
  curiosityBlock?: string;
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  /** Tasks from the task store, rendered under their goals (src/goals/goals-view.ts). */
  tasks?: StoredTask[];
  recentMemory: string;
  datetime: string;
  /** Operator-assigned standing directives — ongoing behavioral instructions */
  directives?: string[];
  /** The conversation's latest replies to the operator (`buildConversationSection`). */
  chatReplies?: string[];
  /** Behavioral state analysis from action diversity computation */
  behavioralState?: string;
  /** Outcome ledger stats for production tracking */
  outcomeStats?: string;
  /** Current trait state for mechanical personality */
  traitState?: string;
  /** Environmental sensor context */
  environmentContext?: string;
  /** Crystallization candidates (repeated tool patterns) */
  crystallizationContext?: string;
  /** Goal genealogy performance stats */
  goalPerformance?: string;
  /** Peer insights from knowledge mesh */
  peerInsights?: string;
}

export interface StrategistResult {
  goal_operations: Array<{
    action: 'add' | 'complete' | 'update' | 'remove' | 'drop';
    goal: string;
    priority?: string;
    status?: string;
    notes?: string;
    outcome?: string;
    /** One short sentence: why this change (optional). */
    reason?: string;
    /** For add: the existing goal (title or id) the new one serves (optional). */
    parent?: string;
  }>;
  /** @deprecated Use single_deliverable instead */
  focus?: string;
  /**
   * Single concrete deliverable for this session — the ONE thing to complete.
   * MUST be: specific, achievable in 5-15 minutes, with clear completion criteria.
   * The executor will STOP after completing this deliverable.
   */
  single_deliverable: string;
  /** How well the deliverable aligns with the agent's identity/soul (0.0-1.0) */
  alignment_confidence?: number;
  reflection: string;
  next_strategy_in?: string;
  /** Trait adjustments proposed by strategist (max ±0.05 per trait) */
  trait_adjustments?: Record<string, number>;
  /** One short reason per adjusted trait (optional). */
  trait_reasons?: Record<string, string>;
}

export function buildStrategistPrompt(input: StrategistPromptInput): {
  system: string;
  prompt: string;
} {
  const system = `You are the strategic oversight layer for an autonomous agent.
Your job is to review the agent's goals, recent activity, and overall direction — then assign ONE concrete deliverable for the next session. A deliverable is a step forward on a goal (a question answered, a claim checked, the goal's document made shorter and truer), not a new file.

## Agent Identity

${input.identity}

${input.soul}

## Agent Motivations

${input.motivations}

## Current Goals

${goalsText(input) || '(no goals set)'}${buildOperatorGoalsSection(goalsSource(input))}${buildDirectivesSection(input.directives)}${buildConversationSection(input.chatReplies)}${
  input.curiosityBlock
    ? `

${input.curiosityBlock}`
    : ''
}

## Recent Activity (last 7 days)

${input.recentMemory || '(no recent memory)'}

Current date/time: ${input.datetime}

## Behavioral Pattern Analysis

Before assigning the next deliverable, classify the agent's recent actions into TYPES:
- CONTENT: writing files, creating activities, producing documents
- OUTREACH: sending messages, check-ins, nudges
- RESEARCH: web searches, reading external data
- ASSESSMENT: evaluating outcomes, reviewing impact, getting feedback
- MAINTENANCE: updating goals, consolidating memory, archiving

If >70% of recent actions are the SAME TYPE → the agent is in a behavioral rut.
Your deliverable MUST be a DIFFERENT type. If the agent has been creating content for 5+ cycles,
assign an ASSESSMENT or OUTREACH deliverable instead.

${buildEngagementCheck(!!input.curiosityBlock)}
${input.behavioralState ? `\n## Current Behavioral State\n\n${input.behavioralState}\n` : ''}${input.outcomeStats ? `\n## Production Outcomes\n\n${input.outcomeStats}\n` : ''}${input.traitState ? `\n${input.traitState}\n` : ''}${input.environmentContext ? `\n${input.environmentContext}\n` : ''}${input.crystallizationContext ? `\n${input.crystallizationContext}\n` : ''}${input.goalPerformance ? `\n${input.goalPerformance}\n` : ''}${input.peerInsights ? `\n${input.peerInsights}\n` : ''}
## Your Task

Analyze the agent's current state and assign a SINGLE, CONCRETE deliverable for the next session. Consider:

1. **Staleness**: Are any goals unchanged for too long? Has the agent been repeating the same activities?
2. **Completion**: Are any goals actually done but not marked complete?
3. **Relevance**: Do current goals still align with the agent's identity and motivations?
4. **Gaps**: Are there obvious goals missing given the agent's purpose?
5. **Patterns**: Is the agent stuck in a loop (same goal, same activity, no progress)?
${input.curiosityBlock ? "6. **Purpose Alignment**: The deliverable must serve the agent's purpose or the operator's interest within its open dials (see Your DNA). Exploring within the dials is on-brand; busywork is not." : "6. **Soul Alignment**: The deliverable MUST directly serve the agent's identity and motivations. An off-brand deliverable is worse than no deliverable."}

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
- GOAL TRIAGE: every active goal marked "no tasks yet" must be settled in this answer with one update operation: kind: "standing" when it has no end state (a habit or a recurring duty), or tasks (2-5 verifiable steps) when it has one. Leave goals already standing or with open tasks alone
- RELEVANCE CHECK: for every active goal and each of its open tasks, ask whether it still serves the agent's purpose (its identity, soul, motivations and purpose goal) and whether it is still achievable. If it was superseded, became impossible or drifted off-purpose, drop it with a one-sentence reason: a goal with a "drop" operation, a task in drop_tasks. Never leave such a goal or task open, and never mark it complete or done: dropped is not achieved. A goal your operator set (source: operator) is not yours to drop: if it looks obsolete, assign a deliverable that asks the operator with ask_human

## Human Check-In Cadence

- Every 3-5 sessions, assign a deliverable that includes checking in with the human operator
- Good check-in deliverables: "Ask the operator for feedback on recent work", "Ask the operator which priority to focus on next", "Check in with the operator and confirm current direction"
- If the agent has been working autonomously for 3+ sessions without human input, prioritize a check-in deliverable
- The agent has ask_human as a non-blocking tool — the question is queued and answered asynchronously

## Output Format

CRITICAL: Respond with ONLY a valid JSON object. No other text, no markdown fences.

JSON Schema:
- goal_operations: array of objects, each with:
  - action: "add" | "complete" | "update" | "remove" | "drop" (drop: the goal no longer applies — superseded, impossible or off-purpose; it moves to Completed marked dropped, with reason; never use complete for it)
  - goal: string (for add: goal text; for others: substring to match existing goal)
  - priority: string (for add/update: "high" | "medium" | "low") — optional
  - status: string (for update: "pending" | "in_progress" | "blocked") — optional
  - notes: string (optional context)
  - outcome: string (for complete: what was achieved) — optional
  - reason: string (one short sentence: why this change; required for drop)
  - parent: string (for add: exact title or id of the existing goal the new one is a concrete step toward, so its progress shows under that goal) — optional
  - tasks: array of strings (for add, or for update of a goal with no tasks yet: the goal's breakdown, 2-5 concrete steps, each one short sentence naming a result someone could check; they become the goal's tasks) — optional
  - kind: "standing" (for update: the goal has no end state — a habit or recurring duty; it gets no tasks) — optional
- single_deliverable: string (ONE specific, bounded, achievable task — 5-15 minutes max)
- serves_goal: string, the exact title (or id) of the active goal the deliverable serves (optional; it attributes the cycle to that goal)
- alignment_confidence: number (0.0-1.0, how well the deliverable serves the agent's identity/soul — below 0.6 triggers re-derivation)
- focus: string (deprecated, use single_deliverable)
- reflection: string (brief analysis of the agent's current state and trajectory)
- next_strategy_in: string (when to run strategist again, e.g. "4h", "8h", "1d")
- trait_adjustments: object (optional — propose small shifts to mechanical personality traits, max ±0.05 per trait)
- trait_reasons: object (one short sentence per trait in trait_adjustments: the observation behind it)
- drop_tasks: array of {"task": "<t-… id>", "reason": "<one sentence>"} (optional — open tasks that no longer apply; they are removed, applied after goal_operations)

## Trait Adjustments
If a "Current Trait State" section is present above, you MAY propose trait_adjustments to shift the agent's mechanical parameters. Each trait ranges 0.1-0.9; max ±0.05 per trait per cycle.

"No change" is the expected answer most cycles — omit trait_adjustments or use {}. Traits describe WHO this agent is; they are not a lever for short-term engagement numbers.

Rules for any delta you do propose:
- Each delta must cite a concrete observation from THIS agent's recent actions or outcomes (a named action, a repeated error class, an explicit operator request, a rejected production). Name it in "trait_reasons". A delta without such an observation is invalid.
- Identity consistency: every delta must agree with the identity and soul above. A reactive, guardian, watchdog or monitor identity must not drift toward higher sociability or lower independence just because engagement is low. Low engagement with no users is not evidence about the trait — it is evidence about the audience.
- There is no universal direction. Low engagement, a stale streak or a quiet week do not by themselves justify any delta for any trait.
- Patterns that DO count as evidence: the same tool error class repeating across sessions (caution up / risk_tolerance down); the operator rejecting work as shallow (depth up); a confirmed behavioral rut in the analysis above (curiosity up); the operator explicitly asking for more or less outreach (sociability accordingly).
- Traits listed as locked or pinned in the trait state are ignored — do not propose them.

Example (no trait change warranted):
{"goal_operations":[{"action":"complete","goal":"set up monitoring","outcome":"Monitoring dashboard deployed and working","reason":"Dashboard has been live for a week."},{"action":"add","goal":"Explore partnership opportunities with DeFi protocols","priority":"high","reason":"Growth is the core mission and nothing serves it now."}],"single_deliverable":"Send 3 partnership outreach messages to DeFi protocols identified in the research phase","alignment_confidence":0.9,"reflection":"Agent has been stuck optimizing internal tools for 3 days instead of pursuing its core mission of community growth. Time to execute, not plan.","next_strategy_in":"6h","trait_adjustments":{}}`;

  const prompt =
    'Perform a strategic review and assign ONE concrete deliverable for the next session. Remember: the executor will STOP after completing this ONE deliverable. Make it specific, achievable, and bounded. Respond with ONLY the JSON object.';

  return { system, prompt };
}
