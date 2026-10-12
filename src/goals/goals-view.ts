/**
 * The goals an agent reads, rendered once for every prompt that carries them
 * (planner, strategist, executor, feedback, navigator, conversations,
 * `manage_goals list`): each active goal with its id, full text, status,
 * priority, source, notes and open tasks (id, lane mark, text, note, a
 * "worker running" marker), how many tasks are done, then the completed goals
 * one line each.
 *
 * Bounded by `maxChars`: completed goals are dropped first, then the done
 * counts, then goal notes, then task notes. Ids are never dropped: `serves_goal`
 * and `update_task` resolve by them.
 */
import { parseGoals } from '../tools/goals';
import { type StoredTask, liveClaim } from './task-store';

export const GOALS_VIEW_MAX_CHARS = 6000;

export interface GoalsViewInput {
  goalsMd: string | null | undefined;
  tasks: StoredTask[];
  maxChars?: number;
  /** For the "worker running" marker (claims are leases). */
  nowMs?: number;
}

const MARK: Record<StoredTask['lane'], string> = {
  todo: '[ ]',
  in_progress: '[~]',
  blocked: '[!]',
  done: '[x]',
};

interface Level {
  completed: boolean;
  doneCounts: boolean;
  goalNotes: boolean;
  taskNotes: boolean;
}

const LEVELS: Level[] = [
  { completed: true, doneCounts: true, goalNotes: true, taskNotes: true },
  { completed: false, doneCounts: true, goalNotes: true, taskNotes: true },
  { completed: false, doneCounts: false, goalNotes: true, taskNotes: true },
  { completed: false, doneCounts: false, goalNotes: false, taskNotes: true },
  { completed: false, doneCounts: false, goalNotes: false, taskNotes: false },
];

export function renderGoalsForPrompt(input: GoalsViewInput): string {
  const raw = input.goalsMd ?? '';
  const max = input.maxChars ?? GOALS_VIEW_MAX_CHARS;
  const { active, completed } = parseGoals(raw);
  if (active.length + completed.length === 0) {
    const text = raw.trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
  const nowMs = input.nowMs ?? Date.now();
  const byGoal = new Map<string, StoredTask[]>();
  for (const t of [...input.tasks].sort((a, b) => a.order - b.order)) {
    const list = byGoal.get(t.goalId) ?? [];
    list.push(t);
    byGoal.set(t.goalId, list);
  }
  const anyOpen = active.some((g) => (byGoal.get(g.id ?? '') ?? []).some((t) => t.lane !== 'done'));

  const render = (lv: Level): string => {
    const lines: string[] = ['### Active goals'];
    if (anyOpen)
      lines.push(
        'Task marks: [ ] to do, [~] in progress, [!] blocked. Move tasks with manage_goals update_task by id.'
      );
    if (active.length === 0) lines.push('(none)');
    for (const g of active) {
      lines.push(`- ${g.id ? `[${g.id}] ` : ''}${g.text}`);
      const meta = [`status: ${g.status}`, `priority: ${g.priority}`];
      if (g.source) meta.push(`source: ${g.source}`);
      lines.push(`  ${meta.join(' · ')}`);
      if (lv.goalNotes && g.notes) lines.push(`  notes: ${g.notes}`);
      const tasks = byGoal.get(g.id ?? '') ?? [];
      if (g.kind === 'standing') {
        lines.push('  standing goal: no tasks; when you serve it, do one round of it');
      } else if (!tasks.some((t) => t.lane !== 'done')) {
        lines.push(
          '  no tasks yet: break it down (new_tasks) when you serve it, or mark it standing_goal'
        );
      }
      for (const t of tasks) {
        if (t.lane === 'done') continue;
        const note = lv.taskNotes && t.note ? ` — note: ${t.note}` : '';
        const worker = liveClaim(t, nowMs) ? ' (worker running)' : '';
        lines.push(`  ${MARK[t.lane]} ${t.id} ${t.text}${note}${worker}`);
      }
      const done = tasks.filter((t) => t.lane === 'done').length;
      if (lv.doneCounts && done > 0) lines.push(`  +${done} done`);
    }
    if (lv.completed && completed.length > 0) {
      lines.push('', '### Completed goals');
      for (const g of completed) {
        lines.push(
          `- ${g.id ? `[${g.id}] ` : ''}${g.text}${g.completed ? ` (completed ${g.completed})` : ''}`
        );
      }
    }
    return lines.join('\n');
  };

  let out = '';
  for (const lv of LEVELS) {
    out = render(lv);
    if (out.length <= max) return out;
  }
  return out;
}
