import { localDateStr } from '../date-utils';
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
export function findGoalIndex(goals: GoalEntry[], search: string): number {
  if (!search || goals.length === 0) return -1;

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
          'Goals persist in your soul directory and are visible during reflection and agent loop.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'add', 'update', 'complete'],
              description:
                'Action to perform. ' +
                '"list" — no extra params needed. ' +
                '"add" — requires goal (text), optional priority, notes. ' +
                '"update" — requires goal (substring match), optional status, priority, notes. ' +
                '"complete" — requires goal (substring match), optional outcome.',
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
              enum: ['pending', 'in_progress', 'blocked'],
              description: 'New status (for update action only)',
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
          },
          required: ['action'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const action = String(args.action ?? '').trim();
      const botId = String(args._botId ?? '');

      try {
        const soulLoader = getSoulLoader(botId);

        switch (action) {
          case 'list':
            return listGoals(soulLoader);

          case 'add': {
            const goal = resolveGoalParam(args);
            if (!goal) return { success: false, content: 'Missing required parameter: goal' };
            const priority = String(args.priority ?? 'medium').trim();
            const notes = args.notes ? String(args.notes).trim() : undefined;
            return addGoal(soulLoader, goal, priority, notes);
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
            return updateGoal(soulLoader, goal, { status, notes, priority });
          }

          case 'complete': {
            const goal = resolveGoalParam(args);
            if (!goal) return { success: false, content: 'Missing required parameter: goal' };
            const outcome = args.outcome ? String(args.outcome).trim() : undefined;
            return completeGoal(soulLoader, goal, outcome);
          }

          default:
            return {
              success: false,
              content: `Unknown action: ${action}. Use: list, add, update, complete`,
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
  return { success: true, content };
}

function addGoal(
  soulLoader: SoulLoader,
  goal: string,
  priority: string,
  notes?: string
): ToolResult {
  const content = soulLoader.readGoals();
  const { active, completed } = parseGoals(content);

  active.push({
    text: goal,
    status: 'pending',
    priority,
    notes,
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
