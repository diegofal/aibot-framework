import type { Tool, ToolResult } from './types';
import type { SoulLoader } from '../soul';
import type { Logger } from '../logger';

type SoulLoaderResolver = (botId: string) => SoulLoader;

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
              description: 'Action to perform: list, add, update, complete',
            },
            goal: {
              type: 'string',
              description: 'Goal text (for add) or goal identifier substring (for update/complete)',
            },
            status: {
              type: 'string',
              description: 'New status (for update): pending, in_progress, blocked',
            },
            priority: {
              type: 'string',
              description: 'Priority level (for add/update): high, medium, low',
            },
            notes: {
              type: 'string',
              description: 'Additional notes or context',
            },
            outcome: {
              type: 'string',
              description: 'Outcome summary (for complete)',
            },
          },
          required: ['action'],
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      logger: Logger,
    ): Promise<ToolResult> {
      const action = String(args.action ?? '').trim();
      const botId = String(args._botId ?? '');
      const soulLoader = getSoulLoader(botId);

      try {
        switch (action) {
          case 'list':
            return listGoals(soulLoader);

          case 'add': {
            const goal = String(args.goal ?? '').trim();
            if (!goal) return { success: false, content: 'Missing required parameter: goal' };
            const priority = String(args.priority ?? 'medium').trim();
            const notes = args.notes ? String(args.notes).trim() : undefined;
            return addGoal(soulLoader, goal, priority, notes);
          }

          case 'update': {
            const goal = String(args.goal ?? '').trim();
            if (!goal) return { success: false, content: 'Missing required parameter: goal' };
            const status = args.status ? String(args.status).trim() : undefined;
            const notes = args.notes ? String(args.notes).trim() : undefined;
            const priority = args.priority ? String(args.priority).trim() : undefined;
            return updateGoal(soulLoader, goal, { status, notes, priority });
          }

          case 'complete': {
            const goal = String(args.goal ?? '').trim();
            if (!goal) return { success: false, content: 'Missing required parameter: goal' };
            const outcome = args.outcome ? String(args.outcome).trim() : undefined;
            return completeGoal(soulLoader, goal, outcome);
          }

          default:
            return { success: false, content: `Unknown action: ${action}. Use: list, add, update, complete` };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'manage_goals failed');
        return { success: false, content: `Failed: ${message}` };
      }
    },
  };
}

export function parseGoals(content: string | null): { active: GoalEntry[]; completed: GoalEntry[] } {
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

  return lines.join('\n') + '\n';
}

function listGoals(soulLoader: SoulLoader): ToolResult {
  const content = soulLoader.readGoals();
  if (!content) {
    return { success: true, content: 'No goals file found. Use action "add" to create your first goal.' };
  }
  return { success: true, content };
}

function addGoal(soulLoader: SoulLoader, goal: string, priority: string, notes?: string): ToolResult {
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

function updateGoal(
  soulLoader: SoulLoader,
  goalSubstring: string,
  updates: { status?: string; notes?: string; priority?: string },
): ToolResult {
  const content = soulLoader.readGoals();
  const { active, completed } = parseGoals(content);

  const lower = goalSubstring.toLowerCase();
  const found = active.find((g) => g.text.toLowerCase().includes(lower));
  if (!found) {
    return { success: false, content: `No active goal matching "${goalSubstring}"` };
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

  const lower = goalSubstring.toLowerCase();
  const idx = active.findIndex((g) => g.text.toLowerCase().includes(lower));
  if (idx === -1) {
    return { success: false, content: `No active goal matching "${goalSubstring}"` };
  }

  const [goal] = active.splice(idx, 1);
  goal.status = 'completed';
  goal.completed = new Date().toISOString().slice(0, 10);
  if (outcome) goal.outcome = outcome;
  completed.push(goal);

  soulLoader.writeGoals(serializeGoals(active, completed));
  return { success: true, content: `Goal completed: ${goal.text}` };
}
