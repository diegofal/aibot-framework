import type { Skill, SkillContext } from '../../core/types';

interface PriorityItem {
  text: string;
  completed: boolean;
  completedAt?: string;
}

interface DailyEntry {
  date: string;
  priorities: PriorityItem[];
  reflection?: string;
  reviewedAt?: string;
}

interface DailyData {
  entries: Record<string, DailyEntry>;
}

const DATA_KEY = 'daily_priorities_data';

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

function getData(ctx: SkillContext): DailyData {
  return ctx.data.get<DailyData>(DATA_KEY) || { entries: {} };
}

function saveData(ctx: SkillContext, data: DailyData): void {
  ctx.data.set(DATA_KEY, data);
}

function getEntry(ctx: SkillContext, date: string): DailyEntry | undefined {
  const data = getData(ctx);
  return data.entries[date];
}

function saveEntry(ctx: SkillContext, entry: DailyEntry): void {
  const data = getData(ctx);
  data.entries[entry.date] = entry;
  saveData(ctx, data);
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  if (dateStr === getToday()) return 'Today';
  if (dateStr === yesterday.toISOString().split('T')[0]) return 'Yesterday';
  
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Tool handlers
export const handlers: Record<string, (args: Record<string, unknown>, context: SkillContext) => Promise<unknown>> = {
  async daily_set_priorities(args, ctx) {
    const priorities = Array.isArray(args.priorities) ? args.priorities : [];
    const date = String(args.date || getToday());
    
    if (priorities.length === 0) {
      return { success: false, message: 'At least one priority is required' };
    }
    
    if (priorities.length > 5) {
      return { success: false, message: 'Maximum 5 priorities allowed. Focus on what matters most.' };
    }
    
    const entry: DailyEntry = {
      date,
      priorities: priorities.map(p => ({ text: String(p), completed: false })),
    };
    
    saveEntry(ctx, entry);
    ctx.logger.info({ date, count: priorities.length }, 'Daily priorities set');
    
    return { success: true, entry };
  },

  async daily_get_priorities(args, ctx) {
    const date = String(args.date || getToday());
    const entry = getEntry(ctx, date);
    
    if (!entry) {
      return { success: true, entry: null, message: 'No priorities set for this date' };
    }
    
    const completed = entry.priorities.filter(p => p.completed).length;
    const total = entry.priorities.length;
    
    return { success: true, entry, progress: { completed, total, percent: Math.round((completed / total) * 100) } };
  },

  async daily_check_progress(args, ctx) {
    const index = Number(args.index);
    const date = String(args.date || getToday());
    
    if (isNaN(index) || index < 0) {
      return { success: false, message: 'Valid priority index required' };
    }
    
    const entry = getEntry(ctx, date);
    if (!entry) {
      return { success: false, message: 'No priorities found for this date' };
    }
    
    if (index >= entry.priorities.length) {
      return { success: false, message: `Priority ${index + 1} does not exist` };
    }
    
    entry.priorities[index].completed = true;
    entry.priorities[index].completedAt = new Date().toISOString();
    saveEntry(ctx, entry);
    
    ctx.logger.info({ date, index }, 'Priority checked off');
    return { success: true, entry, checked: entry.priorities[index] };
  },

  async daily_review(args, ctx) {
    const reflection = String(args.reflection || '');
    const date = String(args.date || getToday());
    
    if (!reflection.trim()) {
      return { success: false, message: 'Reflection is required for evening review' };
    }
    
    const entry = getEntry(ctx, date);
    if (!entry) {
      return { success: false, message: 'No priorities set for today. Set priorities first with /priorities set' };
    }
    
    entry.reflection = reflection.trim();
    entry.reviewedAt = new Date().toISOString();
    saveEntry(ctx, entry);
    
    const completed = entry.priorities.filter(p => p.completed).length;
    const total = entry.priorities.length;
    
    ctx.logger.info({ date, completed, total }, 'Daily review completed');
    return { success: true, entry, summary: { completed, total, percent: Math.round((completed / total) * 100) } };
  },

  async daily_get_history(args, ctx) {
    const days = Math.min(Math.max(Number(args.days) || 7, 1), 30);
    const data = getData(ctx);
    const dates: string[] = [];
    
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }
    
    const entries = dates
      .filter(date => data.entries[date])
      .map(date => data.entries[date]);
    
    return { success: true, entries, count: entries.length, days };
  },

  async daily_get_stats(args, ctx) {
    const days = Math.min(Math.max(Number(args.days) || 30, 1), 90);
    const data = getData(ctx);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    
    let totalDays = 0;
    let totalCompleted = 0;
    let totalPriorities = 0;
    let reviewedDays = 0;
    
    Object.values(data.entries).forEach(entry => {
      const entryDate = new Date(entry.date);
      if (entryDate >= cutoff) {
        totalDays++;
        totalPriorities += entry.priorities.length;
        totalCompleted += entry.priorities.filter(p => p.completed).length;
        if (entry.reviewedAt) reviewedDays++;
      }
    });
    
    const completionRate = totalPriorities > 0 ? Math.round((totalCompleted / totalPriorities) * 100) : 0;
    const reviewRate = totalDays > 0 ? Math.round((reviewedDays / totalDays) * 100) : 0;
    
    return {
      success: true,
      stats: {
        daysTracked: totalDays,
        totalPriorities,
        totalCompleted,
        completionRate,
        reviewedDays,
        reviewRate,
        periodDays: days,
      },
    };
  },
};

// Skill definition
const skill: Skill = {
  id: 'daily-priorities',
  name: 'Daily Priorities',
  version: '1.0.0',
  description: 'Morning priority setting and evening review with progress tracking',

  async onLoad(ctx) {
    ctx.logger.info('Daily priorities skill loaded');
  },

  async onUnload() {},

  commands: {
    priorities: {
      description: 'Daily priorities: set <items>, today, check <n>, review <text>, history, stats',
      async handler(args: string[], ctx) {
        const subcommand = args[0]?.toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        // Default: show today's priorities
        if (!subcommand) {
          const result = await handlers.daily_get_priorities({}, ctx) as { success: boolean; entry: DailyEntry | null; progress?: { completed: number; total: number; percent: number }; message?: string };
          
          if (!result.entry) {
            return `🎯 No priorities set for today.

Set your top 3 with:
/priorities set "First priority" "Second priority" "Third priority"`;
          }
          
          const lines = [
            `🎯 Today's Priorities (${result.progress?.completed}/${result.progress?.total} done):`,
            '',
            ...result.entry.priorities.map((p, i) => {
              const status = p.completed ? '✅' : `⬜`;
              return `${status} ${i + 1}. ${p.text}`;
            }),
          ];
          
          if (result.entry.reflection) {
            lines.push('', `📝 Evening review completed at ${new Date(result.entry.reviewedAt!).toLocaleTimeString()}`);
          }
          
          return lines.join('\n');
        }

        // Set priorities
        if (subcommand === 'set') {
          if (!rest) {
            return 'Usage: /priorities set "First priority" "Second priority" ...';
          }
          
          // Parse quoted items or comma-separated
          const priorities: string[] = [];
          const quoted = rest.match(/"([^"]*)"/g);
          if (quoted) {
            quoted.forEach(q => priorities.push(q.slice(1, -1)));
          } else {
            rest.split(/,|;/).forEach(p => {
              const trimmed = p.trim();
              if (trimmed) priorities.push(trimmed);
            });
          }
          
          if (priorities.length === 0) {
            return 'Please provide at least one priority. Use quotes for multi-word items.';
          }
          
          const result = await handlers.daily_set_priorities({ priorities }, ctx) as { success: boolean; entry?: DailyEntry; message?: string };
          if (!result.success) {
            return `❌ ${result.message}`;
          }
          
          const lines = [
            '✅ Priorities set for today:',
            '',
            ...(result.entry?.priorities.map((p, i) => `${i + 1}. ${p.text}`) || []),
            '',
            'Mark complete with: /priorities check 1',
          ];
          return lines.join('\n');
        }

        // Check off a priority
        if (subcommand === 'check' || subcommand === 'done' || subcommand === 'complete') {
          const index = parseInt(rest.split(' ')[0]) - 1;
          if (isNaN(index)) {
            return 'Usage: /priorities check <number> (e.g., /priorities check 1)';
          }
          
          const result = await handlers.daily_check_progress({ index }, ctx) as { success: boolean; checked?: PriorityItem; message?: string };
          if (!result.success) {
            return `❌ ${result.message}`;
          }
          return `✅ Checked off: ${result.checked?.text}`;
        }

        // Uncheck a priority
        if (subcommand === 'uncheck') {
          const index = parseInt(rest.split(' ')[0]) - 1;
          if (isNaN(index)) {
            return 'Usage: /priorities uncheck <number>';
          }
          
          const entry = getEntry(ctx, getToday());
          if (!entry || index >= entry.priorities.length) {
            return 'Priority not found.';
          }
          
          entry.priorities[index].completed = false;
          delete entry.priorities[index].completedAt;
          saveEntry(ctx, entry);
          
          return `⬜ Unchecked: ${entry.priorities[index].text}`;
        }

        // Evening review
        if (subcommand === 'review') {
          if (!rest) {
            return 'Usage: /priorities review <reflection>\n\nExample: /priorities review "Great day, finished all three priorities despite interruptions"';
          }
          
          const result = await handlers.daily_review({ reflection: rest }, ctx) as { success: boolean; entry?: DailyEntry; summary?: { completed: number; total: number; percent: number }; message?: string };
          if (!result.success) {
            return `❌ ${result.message}`;
          }
          
          const lines = [
            '🌙 Evening Review Complete',
            '',
            `Progress: ${result.summary?.completed}/${result.summary?.total} (${result.summary?.percent}%)`,
            '',
            '📝 Reflection:',
            result.entry?.reflection || '',
          ];
          return lines.join('\n');
        }

        // Show today
        if (subcommand === 'today') {
          const result = await handlers.daily_get_priorities({}, ctx) as { success: boolean; entry: DailyEntry | null; progress?: { completed: number; total: number; percent: number } };
          
          if (!result.entry) {
            return '🎯 No priorities set for today.';
          }
          
          const lines = [
            `🎯 Today's Priorities (${result.progress?.completed}/${result.progress?.total} done):`,
            '',
            ...result.entry.priorities.map((p, i) => {
              const status = p.completed ? '✅' : `⬜`;
              return `${status} ${i + 1}. ${p.text}`;
            }),
          ];
          return lines.join('\n');
        }

        // History
        if (subcommand === 'history') {
          const days = parseInt(rest) || 7;
          const result = await handlers.daily_get_history({ days }, ctx) as { success: boolean; entries: DailyEntry[]; count: number };
          
          if (result.count === 0) {
            return '📊 No history yet. Start by setting priorities with /priorities set';
          }
          
          const lines = [
            `📊 Last ${result.count} days:`,
            '',
          ];
          
          result.entries.forEach(entry => {
            const completed = entry.priorities.filter(p => p.completed).length;
            const total = entry.priorities.length;
            const percent = Math.round((completed / total) * 100);
            const reviewed = entry.reviewedAt ? ' ✓' : '';
            
            lines.push(`${formatDate(entry.date)}: ${completed}/${total} (${percent}%)${reviewed}`);
            entry.priorities.forEach(p => {
              const icon = p.completed ? '✓' : '○';
              lines.push(`  ${icon} ${p.text.slice(0, 30)}${p.text.length > 30 ? '...' : ''}`);
            });
            lines.push('');
          });
          
          return lines.join('\n');
        }

        // Stats
        if (subcommand === 'stats') {
          const days = parseInt(rest) || 30;
          const result = await handlers.daily_get_stats({ days }, ctx) as { success: boolean; stats: { daysTracked: number; totalPriorities: number; totalCompleted: number; completionRate: number; reviewedDays: number; reviewRate: number } };
          const s = result.stats;
          
          const lines = [
            `📈 Daily Priorities Stats (last ${days} days)`,
            '',
            `Days tracked: ${s.daysTracked}`,
            `Total priorities: ${s.totalPriorities}`,
            `Completed: ${s.totalCompleted}`,
            `Completion rate: ${s.completionRate}%`,
            '',
            `Evening reviews: ${s.reviewedDays}`,
            `Review rate: ${s.reviewRate}%`,
          ];
          return lines.join('\n');
        }

        // Help
        return `🎯 Daily Priorities

Morning routine:
• /priorities set "First" "Second" "Third" — Set today's priorities
• /priorities today — View today's list

During the day:
• /priorities check 1 — Mark priority #1 complete
• /priorities uncheck 1 — Mark incomplete

Evening routine:
• /priorities review "Reflection" — Complete daily review

Tracking:
• /priorities history [days] — View past days
• /priorities stats [days] — See completion rates`;
      },
    },
  },
};

export default skill;
