import type { Skill, SkillContext } from '../../core/types';

interface ToolResult {
  success: boolean;
  message?: string;
  task?: Task;
  tasks?: Task[];
  count?: number;
}

interface Task {
  id: string;
  title: string;
  priority: 'low' | 'medium' | 'high';
  status: 'pending' | 'done';
  dueDate?: string;
  tags: string[];
  createdAt: string;
  completedAt?: string;
}

interface TaskData {
  tasks: Task[];
  lastId: number;
}

const DATA_KEY = 'task_tracker_data';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function getData(ctx: SkillContext): TaskData {
  return ctx.data.get<TaskData>(DATA_KEY) || { tasks: [], lastId: 0 };
}

function saveData(ctx: SkillContext, data: TaskData): void {
  ctx.data.set(DATA_KEY, data);
}

function parseDueDate(input?: string): string | undefined {
  if (!input) return undefined;

  const lower = input.toLowerCase();
  const today = new Date();

  if (lower === 'today') {
    return today.toISOString().split('T')[0];
  }
  if (lower === 'tomorrow') {
    const tmrw = new Date(today);
    tmrw.setDate(tmrw.getDate() + 1);
    return tmrw.toISOString().split('T')[0];
  }
  if (lower === 'next week') {
    const next = new Date(today);
    next.setDate(next.getDate() + 7);
    return next.toISOString().split('T')[0];
  }

  // Try to parse as date
  const parsed = new Date(input);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }

  return undefined;
}

function getPriorityEmoji(priority: string): string {
  const emojis: Record<string, string> = {
    high: '🔴',
    medium: '🟡',
    low: '🟢',
  };
  return emojis[priority] || '⚪';
}

function formatTask(task: Task): string {
  const status = task.status === 'done' ? '✅' : '⬜';
  const priority = getPriorityEmoji(task.priority);
  const due = task.dueDate ? ` (📅 ${task.dueDate})` : '';
  const tags = task.tags.length > 0 ? ` ${task.tags.map((t) => `#${t}`).join(' ')}` : '';
  return `${status} ${priority} \`${task.id}\` ${task.title}${due}${tags}`;
}

// Tool handlers
export const handlers: Record<
  string,
  (args: Record<string, unknown>, context: SkillContext) => Promise<unknown>
> = {
  async task_add(args, ctx) {
    const title = String(args.title || '');
    if (!title.trim()) {
      return { success: false, message: 'Task title is required' };
    }

    const data = getData(ctx);
    const task: Task = {
      id: generateId(),
      title: title.trim(),
      priority: (args.priority as Task['priority']) || 'medium',
      status: 'pending',
      dueDate: parseDueDate(args.dueDate as string),
      tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
      createdAt: new Date().toISOString(),
    };

    data.tasks.push(task);
    saveData(ctx, data);

    ctx.logger.info({ taskId: task.id }, 'Task added');
    return { success: true, task };
  },

  async task_list(args, ctx) {
    const data = getData(ctx);
    let tasks = data.tasks;

    // Filter by status
    const status = (args.status as string) || 'pending';
    if (status !== 'all') {
      tasks = tasks.filter((t) => t.status === status);
    }

    // Filter by priority
    const priority = args.priority as string;
    if (priority && priority !== 'all') {
      tasks = tasks.filter((t) => t.priority === priority);
    }

    // Filter by tag
    const tag = args.tag as string;
    if (tag) {
      tasks = tasks.filter((t) => t.tags.includes(tag.toLowerCase()));
    }

    // Sort: high priority first, then by due date
    tasks.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[b.priority] - priorityOrder[a.priority];
      }
      if (a.dueDate && b.dueDate) {
        return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
      }
      return a.dueDate ? -1 : b.dueDate ? 1 : 0;
    });

    return { success: true, tasks, count: tasks.length };
  },

  async task_complete(args, ctx) {
    const taskId = String(args.taskId || '');
    const data = getData(ctx);

    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) {
      return { success: false, message: `Task ${taskId} not found` };
    }

    task.status = 'done';
    task.completedAt = new Date().toISOString();
    saveData(ctx, data);

    ctx.logger.info({ taskId }, 'Task completed');
    return { success: true, task };
  },

  async task_delete(args, ctx) {
    const taskId = String(args.taskId || '');
    const data = getData(ctx);

    const index = data.tasks.findIndex((t) => t.id === taskId);
    if (index === -1) {
      return { success: false, message: `Task ${taskId} not found` };
    }

    const deleted = data.tasks.splice(index, 1)[0];
    saveData(ctx, data);

    ctx.logger.info({ taskId }, 'Task deleted');
    return { success: true, task: deleted };
  },

  async task_prioritize(args, ctx) {
    const taskId = String(args.taskId || '');
    const priority = args.priority as Task['priority'];

    const data = getData(ctx);
    const task = data.tasks.find((t) => t.id === taskId);

    if (!task) {
      return { success: false, message: `Task ${taskId} not found` };
    }

    task.priority = priority;
    saveData(ctx, data);

    ctx.logger.info({ taskId, priority }, 'Task priority updated');
    return { success: true, task };
  },
};

// Skill definition
const skill: Skill = {
  id: 'task-tracker',
  name: 'Task Tracker',
  version: '1.0.0',
  description: 'Simple task management with priorities, due dates, and status tracking',

  async onLoad(ctx) {
    ctx.logger.info('Task tracker skill loaded');
  },

  async onUnload() {},

  commands: {
    task: {
      description:
        'Task management: add <title>, list [status], done <id>, delete <id>, priority <id> <level>',
      async handler(args: string[], ctx) {
        const subcommand = args[0]?.toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        // Default: show help
        if (!subcommand) {
          return 'Usage:\n/task add <title> [#tag] [priority:high|medium|low] [due:today|tomorrow|YYYY-MM-DD]\n/task list [all|pending|done] [priority:high|medium|low] [#tag]\n/task done <id>\n/task delete <id>\n/task priority <id> <high|medium|low>';
        }

        // Add task
        if (subcommand === 'add') {
          if (!rest) {
            return 'Usage: /task add <title> [#tag] [priority:high|medium|low] [due:today|tomorrow|YYYY-MM-DD]';
          }

          // Parse tags, priority, due date from the text
          const tags: string[] = [];
          let title = rest;
          let priority: Task['priority'] = 'medium';
          let dueDate: string | undefined;

          // Extract #tags
          const tagMatches = rest.match(/#(\w+)/g);
          if (tagMatches) {
            tagMatches.forEach((tag) => {
              tags.push(tag.slice(1).toLowerCase());
              title = title.replace(tag, '').trim();
            });
          }

          // Extract priority: prefix
          const priorityMatch = title.match(/priority:(high|medium|low)/i);
          if (priorityMatch) {
            priority = priorityMatch[1].toLowerCase() as Task['priority'];
            title = title.replace(priorityMatch[0], '').trim();
          }

          // Extract due: prefix
          const dueMatch = title.match(/due:(\S+)/i);
          if (dueMatch) {
            dueDate = parseDueDate(dueMatch[1]);
            title = title.replace(dueMatch[0], '').trim();
          }

          const result = (await handlers.task_add(
            { title, priority, dueDate, tags },
            ctx
          )) as ToolResult;
          if (!result.success) {
            return `❌ ${result.message}`;
          }
          return `✅ Task added: ${formatTask(result.task as Task)}`;
        }

        // List tasks
        if (subcommand === 'list' || subcommand === 'ls') {
          const listArgs: Record<string, string> = {};

          // Parse filters from remaining args
          const filters = rest.split(/\s+/).filter(Boolean);
          for (const filter of filters) {
            const lower = filter.toLowerCase();
            if (['pending', 'done', 'all'].includes(lower)) {
              listArgs.status = lower;
            } else if (['high', 'medium', 'low'].includes(lower)) {
              listArgs.priority = lower;
            } else if (filter.startsWith('#')) {
              listArgs.tag = filter.slice(1);
            }
          }

          const result = (await handlers.task_list(listArgs, ctx)) as ToolResult;
          const tasks = result.tasks ?? [];
          const count = result.count ?? 0;

          if (count === 0) {
            return '📭 No tasks found.';
          }

          const lines = [`📋 ${count} task${count === 1 ? '' : 's'}:`, ...tasks.map(formatTask)];
          return lines.join('\n');
        }

        // Complete task
        if (subcommand === 'done' || subcommand === 'complete') {
          const taskId = rest.split(/\s+/)[0];
          if (!taskId) {
            return 'Usage: /task done <task-id>';
          }

          const result = (await handlers.task_complete({ taskId }, ctx)) as ToolResult;
          if (!result.success) {
            return `❌ ${result.message}`;
          }
          return `✅ Completed: ${(result.task as Task).title}`;
        }

        // Delete task
        if (subcommand === 'delete' || subcommand === 'rm') {
          const taskId = rest.split(/\s+/)[0];
          if (!taskId) {
            return 'Usage: /task delete <task-id>';
          }

          const result = (await handlers.task_delete({ taskId }, ctx)) as ToolResult;
          if (!result.success) {
            return `❌ ${result.message}`;
          }
          return `🗑️ Deleted: ${(result.task as Task).title}`;
        }

        // Change priority
        if (subcommand === 'priority' || subcommand === 'prio') {
          const parts = rest.split(/\s+/).filter(Boolean);
          const taskId = parts[0];
          const priority = parts[1]?.toLowerCase() as Task['priority'];

          if (!taskId || !['high', 'medium', 'low'].includes(priority)) {
            return 'Usage: /task priority <task-id> <high|medium|low>';
          }

          const result = (await handlers.task_prioritize({ taskId, priority }, ctx)) as ToolResult;
          if (!result.success) {
            return `❌ ${result.message}`;
          }
          return `🔄 Priority set to ${priority}: ${(result.task as Task).title}`;
        }

        // Unknown command
        return 'Unknown command. Try: add, list, done, delete, priority';
      },
    },
  },
};

export default skill;
