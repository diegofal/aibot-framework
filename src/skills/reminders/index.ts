import type { Skill, SkillContext } from '../../core/types';

interface Reminder {
  id: string;
  text: string;
  scheduledAt: string;
  when: string;
  recurring: boolean;
  recurringPattern?: string;
  completed: boolean;
  snoozedUntil?: string;
  jobId?: string;
  createdAt: string;
}

interface RemindersData {
  reminders: Reminder[];
  lastId: number;
}

const DATA_KEY = 'reminders_data';

function getData(ctx: SkillContext): RemindersData {
  return ctx.data.get<RemindersData>(DATA_KEY) || { reminders: [], lastId: 0 };
}

function saveData(ctx: SkillContext, data: RemindersData): void {
  ctx.data.set(DATA_KEY, data);
}

function generateId(ctx: SkillContext): string {
  const data = getData(ctx);
  data.lastId++;
  saveData(ctx, data);
  return `rem_${data.lastId}`;
}

function parseTime(when: string): Date | null {
  const now = new Date();
  const lower = when.toLowerCase().trim();

  // "in X minutes/hours/days"
  const inMatch = lower.match(/^in\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/);
  if (inMatch) {
    const amount = Number.parseInt(inMatch[1]);
    const unit = inMatch[2];
    const result = new Date(now);
    if (unit.startsWith('minute')) result.setMinutes(result.getMinutes() + amount);
    else if (unit.startsWith('hour')) result.setHours(result.getHours() + amount);
    else if (unit.startsWith('day')) result.setDate(result.getDate() + amount);
    return result;
  }

  // "tomorrow [at] HH:MM"
  const tomorrowMatch = lower.match(/^tomorrow(?:\s+at\s+(\d{1,2}):?(\d{2})?)?$/);
  if (tomorrowMatch) {
    const result = new Date(now);
    result.setDate(result.getDate() + 1);
    if (tomorrowMatch[1]) {
      result.setHours(
        Number.parseInt(tomorrowMatch[1]),
        Number.parseInt(tomorrowMatch[2] || '0'),
        0,
        0
      );
    } else {
      result.setHours(9, 0, 0, 0);
    }
    return result;
  }

  // "today [at] HH:MM"
  const todayMatch = lower.match(/^today(?:\s+at\s+(\d{1,2}):?(\d{2})?)?$/);
  if (todayMatch) {
    const result = new Date(now);
    if (todayMatch[1]) {
      result.setHours(Number.parseInt(todayMatch[1]), Number.parseInt(todayMatch[2] || '0'), 0, 0);
    }
    return result;
  }

  // "at HH:MM" or "HH:MM"
  const timeMatch = lower.match(/^(?:at\s+)?(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const result = new Date(now);
    const hours = Number.parseInt(timeMatch[1]);
    const minutes = Number.parseInt(timeMatch[2]);
    result.setHours(hours, minutes, 0, 0);
    if (result <= now) {
      result.setDate(result.getDate() + 1);
    }
    return result;
  }

  // "YYYY-MM-DD HH:MM" or ISO string
  const isoMatch = lower.match(/^\d{4}-\d{2}-\d{2}/);
  if (isoMatch) {
    const parsed = new Date(when);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMins = Math.round(diffMs / 60000);

  if (diffMins < 0) return 'overdue';
  if (diffMins < 60) return `in ${diffMins} min`;
  if (diffMins < 1440) return `in ${Math.round(diffMins / 60)} hr`;
  return `in ${Math.round(diffMins / 1440)} days`;
}

function formatReminderTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const isTomorrow = new Date(now.getTime() + 86400000).toDateString() === date.toDateString();

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  if (isToday) return `today at ${timeStr}`;
  if (isTomorrow) return `tomorrow at ${timeStr}`;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Tool handlers
export const handlers: Record<
  string,
  (args: Record<string, unknown>, context: SkillContext) => Promise<unknown>
> = {
  async reminders_set(args, ctx) {
    try {
      const text = String(args.text || '');
      const when = String(args.when || '');
      const recurring = Boolean(args.recurring || false);
      const recurringPattern = args.recurring_pattern ? String(args.recurring_pattern) : undefined;

      if (!text || !when) {
        return { success: false, message: 'Text and when are required' };
      }

      const scheduledAt = parseTime(when);
      if (!scheduledAt) {
        return {
          success: false,
          message: `Could not parse time: "${when}". Try "in 5 minutes", "tomorrow at 9am", "at 3pm", or "2026-02-26 14:00"`,
        };
      }

      const id = generateId(ctx);
      const reminder: Reminder = {
        id,
        text,
        scheduledAt: scheduledAt.toISOString(),
        when,
        recurring,
        recurringPattern,
        completed: false,
        createdAt: new Date().toISOString(),
      };

      // Schedule the job
      const schedule: { kind: 'at'; at: string } | { kind: 'cron'; expr: string; tz: string } =
        recurring && recurringPattern
          ? {
              kind: 'cron',
              expr: recurringPattern,
              tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }
          : { kind: 'at', at: scheduledAt.toISOString() };

      const jobName = recurring ? `reminder-recurring-${id}` : `reminder-${id}`;
      await ctx.cron.add({
        name: jobName,
        schedule,
        text: `⏰ Reminder: ${text}`,
        deleteAfterRun: !recurring,
      });

      reminder.jobId = jobName;

      const data = getData(ctx);
      data.reminders.push(reminder);
      saveData(ctx, data);

      ctx.logger.info({ reminderId: id, scheduledAt }, 'Reminder set');

      return {
        success: true,
        data: {
          id,
          text,
          scheduledAt: scheduledAt.toISOString(),
          formatted: formatReminderTime(scheduledAt.toISOString()),
        },
      };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to set reminder');
      return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  async reminders_list(args, ctx) {
    try {
      const includeCompleted = Boolean(args.include_completed || false);
      const data = getData(ctx);

      let reminders = data.reminders;
      if (!includeCompleted) {
        reminders = reminders.filter((r) => !r.completed);
      }

      // Sort by scheduled time
      reminders.sort(
        (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
      );

      return { success: true, data: reminders };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to list reminders');
      return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  async reminders_delete(args, ctx) {
    try {
      const id = String(args.id || '');
      if (!id) {
        return { success: false, message: 'Reminder ID is required' };
      }

      const data = getData(ctx);
      const reminder = data.reminders.find((r) => r.id === id);

      if (!reminder) {
        return { success: false, message: `Reminder "${id}" not found` };
      }

      // Cancel the cron job if it exists
      if (reminder.jobId) {
        await ctx.cron.remove({ jobId: reminder.jobId }).catch(() => {
          ctx.logger.warn({ jobId: reminder.jobId }, 'Failed to cancel cron job');
        });
      }

      data.reminders = data.reminders.filter((r) => r.id !== id);
      saveData(ctx, data);

      ctx.logger.info({ reminderId: id }, 'Reminder deleted');
      return { success: true, data: { id } };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to delete reminder');
      return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  async reminders_snooze(args, ctx) {
    try {
      const id = String(args.id || '');
      const duration = String(args.duration || '');

      if (!id || !duration) {
        return { success: false, message: 'Reminder ID and duration are required' };
      }

      const data = getData(ctx);
      const reminder = data.reminders.find((r) => r.id === id);

      if (!reminder) {
        return { success: false, message: `Reminder "${id}" not found` };
      }

      const snoozeUntil = parseTime(duration);
      if (!snoozeUntil) {
        return {
          success: false,
          message: `Could not parse duration: "${duration}". Try "5 minutes", "30 minutes", "1 hour", "tomorrow"`,
        };
      }

      // Cancel old job
      if (reminder.jobId) {
        await ctx.cron.remove({ jobId: reminder.jobId }).catch(() => {});
      }

      // Create new job
      const jobName = `reminder-${id}-snoozed`;
      await ctx.cron.add({
        name: jobName,
        schedule: { kind: 'at', at: snoozeUntil.toISOString() },
        text: `⏰ Reminder: ${reminder.text}`,
        deleteAfterRun: true,
      });

      reminder.snoozedUntil = snoozeUntil.toISOString();
      reminder.jobId = jobName;
      saveData(ctx, data);

      ctx.logger.info({ reminderId: id, snoozeUntil }, 'Reminder snoozed');
      return { success: true, data: { id, snoozedUntil: snoozeUntil.toISOString() } };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to snooze reminder');
      return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  async reminders_complete(args, ctx) {
    try {
      const id = String(args.id || '');
      if (!id) {
        return { success: false, message: 'Reminder ID is required' };
      }

      const data = getData(ctx);
      const reminder = data.reminders.find((r) => r.id === id);

      if (!reminder) {
        return { success: false, message: `Reminder "${id}" not found` };
      }

      // Cancel the cron job
      if (reminder.jobId) {
        await ctx.cron.remove({ jobId: reminder.jobId }).catch(() => {});
      }

      reminder.completed = true;
      saveData(ctx, data);

      ctx.logger.info({ reminderId: id }, 'Reminder marked complete');
      return { success: true, data: { id } };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to complete reminder');
      return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
  },
};

// Skill definition
const skill: Skill = {
  id: 'reminders',
  name: 'Reminders',
  version: '1.0.0',
  description: 'Set time-based reminders with natural language scheduling',

  async onLoad(ctx) {
    ctx.logger.info('Reminders skill loaded');
  },

  async onUnload() {},

  commands: {
    remind: {
      description:
        'Reminder commands: set <text> in/at <time>, list, delete <id>, snooze <id> <duration>, done <id>',
      async handler(args: string[], ctx: SkillContext) {
        const subcommand = args[0]?.toLowerCase();

        if (!subcommand) {
          return 'Usage: /remind set <text> in 5 minutes\n/remind set <text> tomorrow at 9am\n/remind list\n/remind delete <id>\n/remind snooze <id> 30 minutes\n/remind done <id>';
        }

        // set: /remind set Call mom in 5 minutes
        if (subcommand === 'set') {
          const rest = args.slice(1).join(' ');
          // Parse "text in/at time" pattern
          const inMatch = rest.match(/^(.+?)\s+in\s+(.+)$/i);
          const atMatch = rest.match(/^(.+?)\s+at\s+(.+)$/i);
          const tomorrowMatch = rest.match(/^(.+?)\s+tomorrow\s*(.*)$/i);

          let text = rest;
          let when = '';

          if (inMatch) {
            text = inMatch[1].trim();
            when = `in ${inMatch[2].trim()}`;
          } else if (atMatch) {
            text = atMatch[1].trim();
            when = `at ${atMatch[2].trim()}`;
          } else if (tomorrowMatch) {
            text = tomorrowMatch[1].trim();
            const time = tomorrowMatch[2]?.trim();
            when = time ? `tomorrow at ${time}` : 'tomorrow';
          } else {
            return 'Usage: /remind set <text> in 5 minutes\n/remind set <text> at 3pm\n/remind set <text> tomorrow at 9am';
          }

          const result = await handlers.reminders_set({ text, when }, ctx);
          if (result.success) {
            return `✅ Reminder set: "${text}" for ${result.data?.formatted}`;
          }
          return `❌ Failed: ${result.message}`;
        }

        // list: /remind list
        if (subcommand === 'list') {
          const result = await handlers.reminders_list({ include_completed: false }, ctx);
          if (!result.success) {
            return `❌ Failed: ${result.message}`;
          }

          const reminders = result.data as Reminder[];
          if (reminders.length === 0) {
            return '📭 No active reminders. Set one with /remind set <text> in 5 minutes';
          }

          const lines = reminders.map((r) => {
            const time = formatReminderTime(r.scheduledAt);
            const ago = formatTimeAgo(r.scheduledAt);
            const recurring = r.recurring ? ' 🔄' : '';
            return `\`${r.id}\` ${r.text}\n   📅 ${time} (${ago})${recurring}`;
          });

          return `⏰ **Active Reminders**\n\n${lines.join('\n\n')}`;
        }

        // delete: /remind delete <id>
        if (subcommand === 'delete') {
          const id = args[1];
          if (!id) return 'Usage: /remind delete <id>';

          const result = await handlers.reminders_delete({ id }, ctx);
          if (result.success) {
            return `✅ Reminder \`${id}\` deleted`;
          }
          return `❌ Failed: ${result.message}`;
        }

        // snooze: /remind snooze <id> 30 minutes
        if (subcommand === 'snooze') {
          const id = args[1];
          const duration = args.slice(2).join(' ');
          if (!id || !duration) return 'Usage: /remind snooze <id> 30 minutes';

          const result = await handlers.reminders_snooze({ id, duration }, ctx);
          if (result.success) {
            const snoozed = new Date(result.data?.snoozedUntil as string);
            return `😴 Reminder \`${id}\` snoozed until ${snoozed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
          }
          return `❌ Failed: ${result.message}`;
        }

        // done: /remind done <id>
        if (subcommand === 'done') {
          const id = args[1];
          if (!id) return 'Usage: /remind done <id>';

          const result = await handlers.reminders_complete({ id }, ctx);
          if (result.success) {
            return `✅ Reminder \`${id}\` marked complete`;
          }
          return `❌ Failed: ${result.message}`;
        }

        return 'Unknown subcommand. Try: set, list, delete, snooze, done';
      },
    },
  },
};

export default skill;
