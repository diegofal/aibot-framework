import { randomUUID } from 'node:crypto';
import { localDateStr } from '../date-utils';
import type { StoredTask } from '../goals/task-store';
import type { Logger } from '../logger';
import type { SoulLoader } from '../soul';
import type { Tool, ToolResult } from './types';

type SoulLoaderResolver = (botId: string) => SoulLoader;

/**
 * LLMs frequently call manage_goals with "goalId" (numeric ID) instead of
 * "goal" (substring text).  Normalise common aliases observed in production.
 */
const GOAL_ALIASES = [
  'goalId',
  'goal_id',
  'name',
  'title',
  'text',
  'description',
  'jobId',
  'job',
  'id',
  'key',
] as const;

export function resolveGoalParam(args: Record<string, unknown>): string {
  const direct = String(args.goal ?? '').trim();
  if (direct) return direct;

  for (const alias of GOAL_ALIASES) {
    const val = String(args[alias] ?? '').trim();
    if (val) return val;
  }
  return '';
}

const FILLER_WORDS = new Set(['goal', 'task', 'objective', 'item', 'todo']);

/**
 * Smart goal matching that handles common LLM patterns:
 * 1. Numeric IDs → 1-based index into the array
 * 2. Direct substring match (original behaviour)
 * 3. Slug-normalised match (dashes/underscores → spaces, filler words stripped)
 * 4. Word-based fallback (all words ≥3 chars in search appear in goal)
 * 5. Jaccard word similarity (best match above threshold)
 */
/** Undo HTML escaping some models apply to tool arguments (`&amp;` for `&`). */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function findGoalIndex(goals: GoalEntry[], rawSearch: string): number {
  if (!rawSearch || goals.length === 0) return -1;
  const search = decodeHtmlEntities(rawSearch);

  // 1. Numeric ID → 1-based index
  if (/^\d+$/.test(search)) {
    const idx = Number.parseInt(search, 10) - 1;
    return idx >= 0 && idx < goals.length ? idx : -1;
  }

  const lower = search.toLowerCase();

  // 2. Direct substring
  const directIdx = goals.findIndex((g) => g.text.toLowerCase().includes(lower));
  if (directIdx !== -1) return directIdx;

  // 3. Slug-normalised (dashes/underscores → spaces, filler words stripped)
  const normalised = lower.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = normalised
    .split(/\s+/)
    .filter((w) => !FILLER_WORDS.has(w))
    .join(' ')
    .trim();
  const slugCandidate = stripped || normalised;
  if (slugCandidate !== lower) {
    const slugIdx = goals.findIndex((g) => g.text.toLowerCase().includes(slugCandidate));
    if (slugIdx !== -1) return slugIdx;
  }

  // 4. Word-based: all significant words in search must appear in goal text
  const words = slugCandidate.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length >= 2) {
    const wordIdx = goals.findIndex((g) => {
      const goalLower = g.text.toLowerCase();
      return words.every((w) => goalLower.includes(w));
    });
    if (wordIdx !== -1) return wordIdx;
  }

  // 5. Jaccard word similarity: best match above threshold
  const searchWords = new Set(slugCandidate.split(/\s+/).filter((w) => w.length >= 3));
  if (searchWords.size >= 2) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < goals.length; i++) {
      const goalWords = new Set(
        goals[i].text
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length >= 3)
      );
      let intersection = 0;
      for (const w of searchWords) {
        if (goalWords.has(w)) intersection++;
      }
      const union = new Set([...searchWords, ...goalWords]).size;
      const score = union > 0 ? intersection / union : 0;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx !== -1 && bestScore >= 0.3) return bestIdx;
  }

  return -1;
}

export interface GoalEntry {
  text: string;
  status: string;
  priority: string;
  notes?: string;
  completed?: string;
  outcome?: string;
  source?: string;
  /** Local date the goal was added (YYYY-MM-DD). */
  created?: string;
  /** Stable id (`g-` + 8 hex), assigned on write by `ensureGoalIds`. */
  id?: string;
  /** ISO time the goal first went in_progress. */
  started?: string;
  /** ISO time of the last change to the goal. */
  updated?: string;
  /**
   * Legacy subtasks (`- task: [ ] …` lines), read only so the task store can
   * migrate them (src/goals/task-store.ts). Nothing new writes them.
   */
  tasks?: GoalTask[];
  /** Short card title set on the board; `text` stays the full brief the agent reads. */
  headline?: string;
  /** Id of the goal this one was made from (`- parent: g-…`): reflection, strategist or the agent. */
  parent?: string;
}

/** Status of one subtask: the same four lanes as goals on the board. */
export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Who created a subtask. */
export type TaskAuthor = 'operator' | 'agent';

/** One subtask of a goal. Stored as a metadata line, never as a `- [ ]` line (that would be a goal). */
export interface GoalTask {
  text: string;
  /** Kept for older readers; always `status === 'done'` when `status` is set. */
  done: boolean;
  status?: TaskStatus;
  /** Stable id (`t-` + 6 hex), assigned on write by `ensureGoalIds`. */
  id?: string;
  /** Absent on tasks written before authors were recorded (all set from the dashboard). */
  by?: TaskAuthor;
  /** The agent cycle that created the task. */
  cycleId?: string;
}

const TASK_LINE = /^\[([ xX~!])\]\s*(.+)$/;
const TASK_SUFFIX = /\s*\{((?:(?:id|by|cycle): [\w.:-]+)(?:, (?:id|by|cycle): [\w.:-]+)*)\}$/;
const MARK_STATUS: Record<string, TaskStatus> = {
  ' ': 'todo',
  '~': 'in_progress',
  '!': 'blocked',
  x: 'done',
  X: 'done',
};
const STATUS_MARK: Record<TaskStatus, string> = {
  todo: ' ',
  in_progress: '~',
  blocked: '!',
  done: 'x',
};

/** A task's status, falling back to its checkbox for tasks without one. */
export function taskStatus(t: GoalTask): TaskStatus {
  return t.status ?? (t.done ? 'done' : 'todo');
}

/** Parse the value of a `- task:` line, or null when it is not one. */
function parseTaskValue(value: string): GoalTask | null {
  const m = value.match(TASK_LINE);
  if (!m) return null;
  const status = MARK_STATUS[m[1]];
  let text = m[2].trim();
  const task: GoalTask = { text, done: status === 'done', status };
  const suffix = text.match(TASK_SUFFIX);
  if (suffix) {
    text = text.slice(0, suffix.index).trim();
    if (text) {
      task.text = text;
      for (const pair of suffix[1].split(', ')) {
        const [key, val] = pair.split(': ');
        if (key === 'id') task.id = val;
        else if (key === 'by' && (val === 'agent' || val === 'operator')) task.by = val;
        else if (key === 'cycle') task.cycleId = val;
      }
    }
  }
  return task;
}

function taskLine(t: GoalTask): string {
  const meta = [
    t.id ? `id: ${t.id}` : '',
    t.by ? `by: ${t.by}` : '',
    t.cycleId ? `cycle: ${t.cycleId}` : '',
  ].filter(Boolean);
  return `  - task: [${STATUS_MARK[taskStatus(t)]}] ${t.text}${meta.length ? ` {${meta.join(', ')}}` : ''}`;
}

function taskLines(g: GoalEntry): string[] {
  const head = g.headline ? [`  - headline: ${g.headline}`] : [];
  return [...head, ...(g.tasks ?? []).map(taskLine)];
}

/** A fresh goal id: `g-` + 8 lowercase hex. */
export function newGoalId(): string {
  return `g-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/** A fresh task id: `t-` + 6 lowercase hex. */
export function newTaskId(): string {
  return `t-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

/**
 * Give every goal and every task without an id a fresh one (mutates).
 * Returns how many goal ids were assigned.
 */
export function ensureGoalIds(active: GoalEntry[], completed: GoalEntry[]): number {
  let assigned = 0;
  for (const g of [...active, ...completed]) {
    if (!g.id) {
      g.id = newGoalId();
      assigned++;
    }
    for (const t of g.tasks ?? []) if (!t.id) t.id = newTaskId();
  }
  return assigned;
}

const GOAL_ID = /^g-[0-9a-f]{8}$/;

/**
 * The id of the goal `ref` names (an id, or a title / piece of one, matched like
 * every other goal reference), for a new goal's `parent`. A goal written before
 * ids gets one here (mutates), so the link survives the write. Undefined when
 * nothing matches.
 */
export function resolveParentGoalId(
  active: GoalEntry[],
  completed: GoalEntry[],
  ref: string | undefined
): string | undefined {
  const raw = String(ref ?? '').trim();
  if (!raw) return undefined;
  const all = [...active, ...completed];
  if (GOAL_ID.test(raw)) return all.some((g) => g.id === raw) ? raw : undefined;
  const idx = findGoalIndex(all, raw);
  if (idx === -1) return undefined;
  const goal = all[idx];
  goal.id ??= newGoalId();
  return goal.id;
}

/** True when the operator set this goal from the dashboard (not the agent, not a preset). */
export function isOperatorGoal(goal: GoalEntry): boolean {
  return /^operator\b/i.test(goal.source ?? '');
}

/** Append one goal to the Active section of a GOALS.md, keeping the rest. */
export function appendGoal(content: string | null, goal: GoalEntry): string {
  const { active, completed } = parseGoals(content);
  active.push({ ...goal, id: goal.id ?? newGoalId() });
  return serializeGoals(active, completed);
}

/**
 * The goal a `serves_goal` reference names: exact id, then exact title
 * (trimmed, case-insensitive), then the fuzzy match `manage_goals` uses.
 */
export function resolveGoalRef(ref: string | undefined, goals: GoalEntry[]): GoalEntry | null {
  const r = String(ref ?? '').trim();
  if (!r) return null;
  const byId = goals.find((g) => g.id === r);
  if (byId) return byId;
  const lower = r.toLowerCase();
  const byTitle = goals.find((g) => g.text.trim().toLowerCase() === lower);
  if (byTitle) return byTitle;
  const idx = findGoalIndex(goals, r);
  return idx === -1 ? null : goals[idx];
}

/** The goal a `manage_goals` call names (add/update/complete), or null. */
export function goalFromManageGoalsArgs(
  args: Record<string, unknown>,
  goals: GoalEntry[]
): GoalEntry | null {
  const action = String(args.action ?? '');
  if (!['add', 'update', 'complete'].includes(action)) return null;
  return resolveGoalRef(resolveGoalParam(args), goals);
}

/** Statuses the dashboard board can move a goal to. */
export const BOARD_STATUSES = ['pending', 'in_progress', 'blocked', 'done'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

/** Board column of an active goal's status. */
export function goalBucket(status: string | undefined): 'todo' | 'inProgress' | 'blocked' {
  const s = String(status ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (s === 'blocked') return 'blocked';
  if (['in_progress', 'active', 'doing', 'started', 'ongoing'].includes(s)) return 'inProgress';
  return 'todo';
}

/**
 * Start the active goal with this id: a To do goal moves to `in_progress`.
 * Returns the new GOALS.md, or null when the goal is missing or not To do.
 */
export function startGoal(content: string | null, goalId: string): string | null {
  const goal = parseGoals(content).active.find((g) => g.id === goalId);
  if (!goal || goalBucket(goal.status) !== 'todo') return null;
  return setGoalStatus(content, goal.text, 'in_progress');
}

/** Fields the operator can edit on a goal. Empty `notes` clears them. */
export interface GoalEdits {
  text?: string;
  notes?: string;
  priority?: string;
  /** Short card title; `''` clears it. */
  headline?: string;
}

/**
 * Edit the goal with this id (or exact title), active or completed.
 * Returns the new GOALS.md, or null when no goal matches.
 */
export function editGoal(content: string | null, ref: string, edits: GoalEdits): string | null {
  const { active, completed } = parseGoals(content);
  const key = ref.trim().toLowerCase();
  const goal =
    [...active, ...completed].find((g) => g.id === ref) ??
    [...active, ...completed].find((g) => g.text.trim().toLowerCase() === key);
  if (!goal) return null;
  if (edits.text !== undefined) goal.text = edits.text;
  if (edits.notes !== undefined) goal.notes = edits.notes || undefined;
  if (edits.priority !== undefined) goal.priority = edits.priority;
  if (edits.headline !== undefined) goal.headline = edits.headline || undefined;
  return serializeGoals(active, completed);
}

/**
 * Delete the goal with this id (or exact title, case-insensitive), active or
 * completed. Returns the new GOALS.md, or null when no goal matches.
 */
export function removeGoal(content: string | null, ref: string): string | null {
  const { active, completed } = parseGoals(content);
  const key = ref.trim().toLowerCase();
  const matches = (g: GoalEntry) => g.id === ref || g.text.trim().toLowerCase() === key;
  const nextActive = active.filter((g) => !matches(g));
  const nextCompleted = completed.filter((g) => !matches(g));
  if (nextActive.length === active.length && nextCompleted.length === completed.length) return null;
  return serializeGoals(nextActive, nextCompleted);
}

/**
 * Move the goal titled exactly `title` (trimmed, case-insensitive) to `status`.
 * `done` moves it to Completed with today's date; any other status on a completed
 * goal reopens it. Returns the new GOALS.md, or null when no goal has that title.
 */
export function setGoalStatus(
  content: string | null,
  title: string,
  status: BoardStatus,
  now: () => Date = () => new Date()
): string | null {
  const { active, completed } = parseGoals(content);
  const stamp = now().toISOString();
  const key = title.trim().toLowerCase();
  const same = (g: GoalEntry) => g.text.trim().toLowerCase() === key;
  const ai = active.findIndex(same);
  const ci = ai === -1 ? completed.findIndex(same) : -1;
  if (ai === -1 && ci === -1) return null;

  if (ai !== -1) {
    if (status === 'done') {
      const [goal] = active.splice(ai, 1);
      goal.status = 'completed';
      goal.completed = localDateStr();
      goal.updated = stamp;
      completed.push(goal);
    } else {
      active[ai].status = status;
      active[ai].updated = stamp;
      if (status === 'in_progress' && !active[ai].started) active[ai].started = stamp;
    }
  } else if (status !== 'done') {
    const [goal] = completed.splice(ci, 1);
    goal.status = status;
    goal.priority = goal.priority || 'medium';
    goal.completed = undefined;
    goal.outcome = undefined;
    goal.updated = stamp;
    if (status === 'in_progress' && !goal.started) goal.started = stamp;
    active.push(goal);
  }
  return serializeGoals(active, completed);
}

/** The loader, with its GOALS.md writes attributed to `opts` (actor, cycle). */
function writingAs(loader: SoulLoader, opts: { actor: 'agent'; cycleId?: string }): SoulLoader {
  return new Proxy(loader, {
    get(target, prop) {
      if (prop === 'writeGoals') return (content: string) => target.writeGoals(content, opts);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Tool that lets the LLM manage structured goals in GOALS.md
 */
export function createGoalsTool(getSoulLoader: SoulLoaderResolver): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'manage_goals',
        description:
          'Manage your structured goals. Use this to track tasks, projects, and objectives. ' +
          'Goals persist in your soul directory and are visible during reflection and agent loop. ' +
          'When talking to a user, goals default to per-user scope. Use scope: "shared" for bot-level goals.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'add', 'update', 'complete', 'add_task', 'update_task', 'note_task'],
              description:
                'Action to perform. ' +
                '"list" — no extra params needed. ' +
                '"add" — requires goal (text), optional priority, notes, parent. ' +
                '"update" — requires goal (substring match), optional status, priority, notes. ' +
                '"complete" — requires goal (substring match), optional outcome. ' +
                '"add_task" — a step you will take toward a goal: requires goal (id or substring) and task (one line, max 200 chars), optional lane. A near-duplicate of an open task returns that task instead. ' +
                '"update_task" — move a task between todo/in_progress/blocked/done: requires task (its id like t-1a2b3c is enough; or a substring of its text, with goal when it is ambiguous) and lane, optional note. ' +
                '"note_task" — leave a short note on a task (what you found, why it is blocked): requires task and note. ' +
                'Tasks are listed under each goal in your goals ([ ] to do, [~] in progress, [!] blocked; done ones are counted). Your operator sees and moves them on the board; a task marked "(worker running)" belongs to a worker run, leave it.',
            },
            goal: {
              type: 'string',
              description:
                'REQUIRED for add/update/complete. ' +
                'For "add": the full goal text. ' +
                'For "update"/"complete": a substring that uniquely identifies an existing goal.',
            },
            status: {
              type: 'string',
              enum: ['pending', 'todo', 'in_progress', 'blocked', 'done'],
              description:
                'For update: the goal status (pending, in_progress, blocked). For add_task/update_task: same as lane (pending means todo).',
            },
            lane: {
              type: 'string',
              enum: ['todo', 'in_progress', 'blocked', 'done'],
              description: 'For add_task/update_task: the task lane.',
            },
            task: {
              type: 'string',
              description:
                'For add_task: the task text (one line). For update_task/note_task: the task id (t-…) or a substring of its text.',
            },
            note: {
              type: 'string',
              description:
                'For update_task/note_task: a short note on the task (max 200 chars), e.g. what you found or why it is blocked.',
            },
            priority: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'Priority level (for add/update)',
            },
            notes: {
              type: 'string',
              description: 'Additional notes or context',
            },
            outcome: {
              type: 'string',
              description: 'Outcome summary (for complete action)',
            },
            parent: {
              type: 'string',
              description:
                'For "add": the existing goal this new one serves (its title or id), when you are breaking a bigger goal into a concrete one. Omit for unrelated goals.',
            },
            scope: {
              type: 'string',
              enum: ['user', 'shared'],
              description:
                'Goal scope: "user" for per-user goals (default when in user context), "shared" for bot-level goals',
            },
          },
          required: ['action'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const action = String(args.action ?? '').trim();
      const botId = String(args._botId ?? '');
      const userId = args._userId ? String(args._userId) : undefined;
      const scope = args.scope ? String(args.scope) : undefined;

      try {
        const cycleId = args._cycleId ? String(args._cycleId) : undefined;
        const soulLoader = writingAs(getSoulLoader(botId), { actor: 'agent', cycleId });

        switch (action) {
          case 'list': {
            if (userId) {
              return listGoalsWithUserScope(soulLoader, userId, scope);
            }
            return listGoals(soulLoader);
          }

          case 'add': {
            const goal = resolveGoalParam(args);
            if (!goal) return { success: false, content: 'Missing required parameter: goal' };
            const priority = String(args.priority ?? 'medium').trim();
            const notes = args.notes ? String(args.notes).trim() : undefined;
            if (userId && scope !== 'shared') {
              return addUserGoal(soulLoader, userId, goal, priority, notes);
            }
            const parent = args.parent ? String(args.parent).trim() : undefined;
            return addGoal(soulLoader, goal, priority, notes, parent);
          }

          case 'update': {
            const goal = resolveGoalParam(args);
            if (!goal) return { success: false, content: 'Missing required parameter: goal' };
            const status =
              (args.status ?? args.new_status)
                ? String(args.status ?? args.new_status).trim()
                : undefined;
            const notes =
              (args.notes ?? args.new_notes)
                ? String(args.notes ?? args.new_notes).trim()
                : undefined;
            const priority =
              (args.priority ?? args.new_priority)
                ? String(args.priority ?? args.new_priority).trim()
                : undefined;
            if (userId && scope !== 'shared') {
              return updateUserGoal(soulLoader, userId, goal, { status, notes, priority });
            }
            return updateGoal(soulLoader, goal, { status, notes, priority });
          }

          case 'complete': {
            const goal = resolveGoalParam(args);
            if (!goal) return { success: false, content: 'Missing required parameter: goal' };
            const outcome = args.outcome ? String(args.outcome).trim() : undefined;
            if (userId && scope !== 'shared') {
              return completeUserGoal(soulLoader, userId, goal, outcome);
            }
            return completeGoal(soulLoader, goal, outcome);
          }

          case 'add_task': {
            const goal = resolveGoalParam(args);
            if (!goal) return { success: false, content: 'Missing required parameter: goal' };
            const task = String(args.task ?? '').trim();
            if (!task) return { success: false, content: 'Missing required parameter: task' };
            const lane = parseLane(args.lane ?? args.status);
            if (lane === null) return badLane(args.lane ?? args.status);
            return addTask(soulLoader, goal, task, lane, cycleId);
          }

          case 'update_task':
          case 'note_task': {
            const task = String(args.task ?? args.task_id ?? args.taskId ?? '').trim();
            if (!task) return { success: false, content: 'Missing required parameter: task' };
            const goal = String(args.goal ?? '').trim();
            const rawNote = args.note ?? (action === 'note_task' ? args.notes : undefined);
            const note = rawNote === undefined ? undefined : String(rawNote).trim();
            if (action === 'note_task') {
              if (!note) return { success: false, content: 'Missing required parameter: note' };
              return updateTask(soulLoader, goal, task, undefined, note, cycleId);
            }
            const lane = parseLane(args.lane ?? args.status);
            if (lane === null) return badLane(args.lane ?? args.status);
            return updateTask(soulLoader, goal, task, lane, note, cycleId);
          }

          default:
            return {
              success: false,
              content: `Unknown action: ${action}. Use: list, add, update, complete, add_task, update_task, note_task`,
            };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'manage_goals failed');
        return { success: false, content: `Failed: ${message}` };
      }
    },
  };
}

export function parseGoals(content: string | null): {
  active: GoalEntry[];
  completed: GoalEntry[];
} {
  const active: GoalEntry[] = [];
  const completed: GoalEntry[] = [];

  if (!content) return { active, completed };

  let section: 'active' | 'completed' | 'none' = 'none';
  let currentGoal: GoalEntry | null = null;
  const pushCurrent = () => {
    if (currentGoal) {
      if (section === 'completed') completed.push(currentGoal);
      else active.push(currentGoal);
    }
  };

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('## Active') || trimmed.startsWith('## active')) {
      pushCurrent();
      currentGoal = null;
      section = 'active';
      continue;
    }
    if (trimmed.startsWith('## Completed') || trimmed.startsWith('## completed')) {
      pushCurrent();
      currentGoal = null;
      section = 'completed';
      continue;
    }
    if (trimmed.startsWith('## ')) {
      pushCurrent();
      currentGoal = null;
      section = 'none';
      continue;
    }

    // Goal line: - [ ] or - [x]
    const goalMatch = trimmed.match(/^- \[([ x])\] (.+)$/);
    if (goalMatch) {
      pushCurrent();
      const isCompleted = goalMatch[1] === 'x';
      currentGoal = {
        text: goalMatch[2],
        status: isCompleted ? 'completed' : 'pending',
        priority: 'medium',
      };
      if (section === 'none') section = isCompleted ? 'completed' : 'active';
      continue;
    }

    // Metadata line:   - key: value
    const metaMatch = trimmed.match(/^- (\w+):\s*(.+)$/);
    if (metaMatch && currentGoal) {
      const key = metaMatch[1];
      const value = metaMatch[2];
      if (key === 'status') currentGoal.status = value;
      else if (key === 'priority') currentGoal.priority = value;
      else if (key === 'notes') currentGoal.notes = value;
      else if (key === 'completed') currentGoal.completed = value;
      else if (key === 'outcome') currentGoal.outcome = value;
      else if (key === 'source') currentGoal.source = value;
      else if (key === 'created') currentGoal.created = value;
      else if (key === 'id') currentGoal.id = value;
      else if (key === 'started') currentGoal.started = value;
      else if (key === 'updated') currentGoal.updated = value;
      else if (key === 'headline') currentGoal.headline = value;
      else if (key === 'parent') currentGoal.parent = value;
      else if (key === 'task') {
        const task = parseTaskValue(value);
        if (task) currentGoal.tasks = [...(currentGoal.tasks ?? []), task];
      }
    }
  }

  pushCurrent();
  return { active, completed };
}

export function serializeGoals(active: GoalEntry[], completed: GoalEntry[]): string {
  const lines: string[] = ['## Active Goals'];

  if (active.length === 0) {
    lines.push('(no active goals)');
  } else {
    for (const g of active) {
      lines.push(`- [ ] ${g.text}`);
      lines.push(`  - status: ${g.status}`);
      lines.push(`  - priority: ${g.priority}`);
      if (g.notes) lines.push(`  - notes: ${g.notes}`);
      lines.push(...taskLines(g));
      if (g.source) lines.push(`  - source: ${g.source}`);
      if (g.parent) lines.push(`  - parent: ${g.parent}`);
      if (g.created) lines.push(`  - created: ${g.created}`);
      if (g.id) lines.push(`  - id: ${g.id}`);
      if (g.started) lines.push(`  - started: ${g.started}`);
      if (g.updated) lines.push(`  - updated: ${g.updated}`);
    }
  }

  lines.push('');
  lines.push('## Completed');

  if (completed.length === 0) {
    lines.push('(none yet)');
  } else {
    // Keep only last 10 completed goals
    const recent = completed.slice(-10);
    for (const g of recent) {
      lines.push(`- [x] ${g.text}`);
      if (g.completed) lines.push(`  - completed: ${g.completed}`);
      if (g.outcome) lines.push(`  - outcome: ${g.outcome}`);
      if (g.priority && g.priority !== 'medium') lines.push(`  - priority: ${g.priority}`);
      if (g.notes) lines.push(`  - notes: ${g.notes}`);
      lines.push(...taskLines(g));
      if (g.source) lines.push(`  - source: ${g.source}`);
      if (g.parent) lines.push(`  - parent: ${g.parent}`);
      if (g.created) lines.push(`  - created: ${g.created}`);
      if (g.id) lines.push(`  - id: ${g.id}`);
      if (g.started) lines.push(`  - started: ${g.started}`);
      if (g.updated) lines.push(`  - updated: ${g.updated}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function listGoals(soulLoader: SoulLoader): ToolResult {
  const content = soulLoader.readGoals();
  if (!content) {
    return {
      success: true,
      content: 'No goals file found. Use action "add" to create your first goal.',
    };
  }
  return { success: true, content: soulLoader.readGoalsView() || content };
}

function addGoal(
  soulLoader: SoulLoader,
  goal: string,
  priority: string,
  notes?: string,
  parentRef?: string
): ToolResult {
  const content = soulLoader.readGoals();
  const { active, completed } = parseGoals(content);
  const parent = resolveParentGoalId(active, completed, parentRef);

  active.push({
    text: goal,
    status: 'pending',
    priority,
    notes,
    source: 'agent',
    created: localDateStr(),
    ...(parent ? { parent } : {}),
  });

  soulLoader.writeGoals(serializeGoals(active, completed));
  return { success: true, content: `Goal added: ${goal} (priority: ${priority})` };
}

function goalListHint(active: GoalEntry[]): string {
  if (active.length === 0) return ' No active goals exist.';
  const list = active.map((g, i) => `  ${i + 1}. ${g.text.slice(0, 80)}`).join('\n');
  return `\nActive goals:\n${list}`;
}

function updateGoal(
  soulLoader: SoulLoader,
  goalSubstring: string,
  updates: { status?: string; notes?: string; priority?: string }
): ToolResult {
  const content = soulLoader.readGoals();
  const { active, completed } = parseGoals(content);

  const idx = findGoalIndex(active, goalSubstring);
  if (idx === -1) {
    return {
      success: false,
      content: `No active goal matching "${goalSubstring}".${goalListHint(active)}`,
    };
  }

  const found = active[idx];

  // If LLM sets status to "completed" via update, redirect to complete logic
  if (updates.status === 'completed' || updates.status === 'done') {
    const [goal] = active.splice(idx, 1);
    goal.status = 'completed';
    goal.completed = localDateStr();
    if (updates.notes) goal.outcome = updates.notes;
    completed.push(goal);
    soulLoader.writeGoals(serializeGoals(active, completed));
    return { success: true, content: `Goal completed (via update): ${goal.text}` };
  }

  if (updates.status) found.status = updates.status;
  if (updates.notes) found.notes = updates.notes;
  if (updates.priority) found.priority = updates.priority;

  soulLoader.writeGoals(serializeGoals(active, completed));
  return { success: true, content: `Goal updated: ${found.text}` };
}

function completeGoal(soulLoader: SoulLoader, goalSubstring: string, outcome?: string): ToolResult {
  const content = soulLoader.readGoals();
  const { active, completed } = parseGoals(content);

  const idx = findGoalIndex(active, goalSubstring);
  if (idx === -1) {
    return {
      success: false,
      content: `No active goal matching "${goalSubstring}".${goalListHint(active)}`,
    };
  }

  const [goal] = active.splice(idx, 1);
  goal.status = 'completed';
  goal.completed = localDateStr();
  if (outcome) goal.outcome = outcome;
  completed.push(goal);

  soulLoader.writeGoals(serializeGoals(active, completed));
  return { success: true, content: `Goal completed: ${goal.text}` };
}

function badLane(raw: unknown): ToolResult {
  return {
    success: false,
    content: `Invalid task lane "${String(raw)}". Use: ${TASK_STATUSES.join(', ')}`,
  };
}

/** Lanes the agent may name; `pending` reads as todo (goal vocabulary). */
function parseLane(raw: unknown): TaskStatus | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const v = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const lane = v === 'pending' ? 'todo' : v;
  return (TASK_STATUSES as readonly string[]).includes(lane) ? (lane as TaskStatus) : null;
}

const TASK_ID = /^t-[0-9a-f]{6}$/;

function taskListHint(tasks: StoredTask[]): string {
  if (!tasks.length) return ' There are no tasks yet.';
  const list = tasks.map((t) => `  ${t.id} [${t.lane}] ${t.text.slice(0, 80)}`);
  return `\nTasks:\n${list.join('\n')}`;
}

/** The goal a task call names, with an id (a goal written before ids gets one first). */
function resolveTaskGoal(
  soulLoader: SoulLoader,
  ref: string
): { goal: GoalEntry } | { error: string } {
  let { active } = parseGoals(soulLoader.readGoals());
  const idx = active.findIndex((g) => g.id === ref);
  const at = idx !== -1 ? idx : findGoalIndex(active, ref);
  if (at === -1) return { error: `No active goal matching "${ref}".${goalListHint(active)}` };
  if (!active[at].id) {
    const content = soulLoader.readGoals();
    if (content) soulLoader.writeGoals(content);
    active = parseGoals(soulLoader.readGoals()).active;
  }
  const goal = active[at];
  return goal?.id ? { goal } : { error: `Goal "${ref}" has no id yet; try again.` };
}

/** The task a call names: its id, or a piece of its text (within `goalRef` when given). */
function resolveTask(
  soulLoader: SoulLoader,
  ref: string,
  goalRef: string
): { task: StoredTask } | { error: string } {
  const tasks = soulLoader.getTaskStore().listForGoals();
  if (TASK_ID.test(ref)) {
    const byId = tasks.find((t) => t.id === ref);
    if (byId) return { task: byId };
  }
  let pool = tasks;
  if (goalRef) {
    const found = resolveTaskGoal(soulLoader, goalRef);
    if ('error' in found) return found;
    pool = tasks.filter((t) => t.goalId === found.goal.id);
  }
  const byId = pool.find((t) => t.id === ref);
  if (byId) return { task: byId };
  const lower = decodeHtmlEntities(ref).toLowerCase();
  const matches = pool.filter((t) => t.text.toLowerCase().includes(lower));
  const open = matches.filter((t) => t.lane !== 'done');
  const pick = open.length === 1 ? open : matches;
  if (pick.length === 1) return { task: pick[0] };
  if (pick.length > 1) {
    return {
      error: `"${ref}" matches ${pick.length} tasks: name it by id, or give the goal.${taskListHint(pick)}`,
    };
  }
  return {
    error: `No task matching "${ref}"${goalRef ? ` in "${goalRef.slice(0, 80)}"` : ''}.${taskListHint(pool)}`,
  };
}

function storeFailure(result: { reason: string; message: string }): ToolResult {
  const hint =
    result.reason === 'claimed'
      ? ' A worker run owns this task right now: leave it to the run (the operator can still move it).'
      : '';
  return { success: false, content: `${result.message}.${hint}` };
}

function addTask(
  soulLoader: SoulLoader,
  goalRef: string,
  text: string,
  lane: TaskStatus = 'todo',
  cycleId?: string
): ToolResult {
  const found = resolveTaskGoal(soulLoader, goalRef);
  if ('error' in found) return { success: false, content: found.error };
  const { goal } = found;
  const store = soulLoader.getTaskStore();
  const r = store.apply([{ op: 'add', goalId: goal.id as string, text, lane }], {
    actor: 'agent',
    cycleId,
  });
  if (!r.ok) return storeFailure(r);
  const res = r.results[0];
  const task = store.get(res.id);
  if (res.existing) {
    return {
      success: true,
      content: `Task ${res.id} already exists in "${goal.text.slice(0, 80)}" (${task?.lane}): ${task?.text}. Use update_task to move it.`,
    };
  }
  return {
    success: true,
    content: `Task ${res.id} added to "${goal.text.slice(0, 80)}" (${task?.lane ?? lane}): ${task?.text ?? text}`,
  };
}

function updateTask(
  soulLoader: SoulLoader,
  goalRef: string,
  taskRef: string,
  lane: TaskStatus | undefined,
  note: string | undefined,
  cycleId?: string
): ToolResult {
  if (!lane && note === undefined)
    return { success: false, content: 'Missing required parameter: status (or note)' };
  const found = resolveTask(soulLoader, taskRef, goalRef);
  if ('error' in found) return { success: false, content: found.error };
  const { task } = found;
  const store = soulLoader.getTaskStore();
  const r = store.apply(
    lane
      ? [{ op: 'move', id: task.id, lane, ...(note !== undefined ? { note } : {}) }]
      : [{ op: 'note', id: task.id, text: note ?? '' }],
    { actor: 'agent', cycleId }
  );
  if (!r.ok) return storeFailure(r);
  const left = store.forGoal(task.goalId).filter((t) => t.lane !== 'done').length;
  const tail =
    lane === 'done' && left === 0
      ? ' All tasks of this goal are done: complete the goal if it is achieved.'
      : '';
  return {
    success: true,
    content: lane
      ? `Task ${task.id} → ${lane}: ${task.text}.${tail}`
      : `Note left on task ${task.id}: ${task.text}.`,
  };
}

// --- Per-user goal helpers ---

function listGoalsWithUserScope(
  soulLoader: SoulLoader,
  userId: string,
  scope?: string
): ToolResult {
  const parts: string[] = [];

  if (scope !== 'user') {
    const sharedContent = soulLoader.readGoals() ? soulLoader.readGoalsView() : null;
    if (sharedContent) {
      parts.push(`# Shared Goals (all users)\n${sharedContent}`);
    }
  }

  if (scope !== 'shared') {
    const userContent = soulLoader.readUserGoals(userId);
    if (userContent) {
      parts.push(`# Your Personal Goals\n${userContent}`);
    } else if (scope === 'user') {
      parts.push('No personal goals yet. Use action "add" to create one.');
    }
  }

  if (parts.length === 0) {
    return {
      success: true,
      content: 'No goals found. Use action "add" to create your first goal.',
    };
  }

  return { success: true, content: parts.join('\n\n---\n\n') };
}

function addUserGoal(
  soulLoader: SoulLoader,
  userId: string,
  goal: string,
  priority: string,
  notes?: string
): ToolResult {
  const content = soulLoader.readUserGoals(userId);
  const { active, completed } = parseGoals(content);
  active.push({ text: goal, status: 'pending', priority, notes });
  soulLoader.writeUserGoals(userId, serializeGoals(active, completed));
  return { success: true, content: `Personal goal added: ${goal} (priority: ${priority})` };
}

function updateUserGoal(
  soulLoader: SoulLoader,
  userId: string,
  goalSubstring: string,
  updates: { status?: string; notes?: string; priority?: string }
): ToolResult {
  const content = soulLoader.readUserGoals(userId);
  const { active, completed } = parseGoals(content);
  const idx = findGoalIndex(active, goalSubstring);
  if (idx === -1) {
    return {
      success: false,
      content: `No personal goal matching "${goalSubstring}".${goalListHint(active)}`,
    };
  }
  const found = active[idx];
  if (updates.status === 'completed' || updates.status === 'done') {
    const [goal] = active.splice(idx, 1);
    goal.status = 'completed';
    goal.completed = localDateStr();
    if (updates.notes) goal.outcome = updates.notes;
    completed.push(goal);
    soulLoader.writeUserGoals(userId, serializeGoals(active, completed));
    return { success: true, content: `Personal goal completed: ${goal.text}` };
  }
  if (updates.status) found.status = updates.status;
  if (updates.notes) found.notes = updates.notes;
  if (updates.priority) found.priority = updates.priority;
  soulLoader.writeUserGoals(userId, serializeGoals(active, completed));
  return { success: true, content: `Personal goal updated: ${found.text}` };
}

function completeUserGoal(
  soulLoader: SoulLoader,
  userId: string,
  goalSubstring: string,
  outcome?: string
): ToolResult {
  const content = soulLoader.readUserGoals(userId);
  const { active, completed } = parseGoals(content);
  const idx = findGoalIndex(active, goalSubstring);
  if (idx === -1) {
    return {
      success: false,
      content: `No personal goal matching "${goalSubstring}".${goalListHint(active)}`,
    };
  }
  const [goal] = active.splice(idx, 1);
  goal.status = 'completed';
  goal.completed = localDateStr();
  if (outcome) goal.outcome = outcome;
  completed.push(goal);
  soulLoader.writeUserGoals(userId, serializeGoals(active, completed));
  return { success: true, content: `Personal goal completed: ${goal.text}` };
}
