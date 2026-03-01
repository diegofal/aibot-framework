import type { Skill, SkillContext } from '../../core/types';

export const handlers: Record<
  string,
  (args: Record<string, unknown>, context: SkillContext) => Promise<unknown>
> = {
  async calendar_list(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const result = await ctx.tools.execute?.('calendar_list', args, ctx);
    return result ?? { success: false, message: 'calendar_list tool not available' };
  },

  async calendar_availability(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const result = await ctx.tools.execute?.('calendar_availability', args, ctx);
    return result ?? { success: false, message: 'calendar_availability tool not available' };
  },

  async calendar_schedule(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const result = await ctx.tools.execute?.('calendar_schedule', args, ctx);
    return result ?? { success: false, message: 'calendar_schedule tool not available' };
  },
};

const skill: Skill = {
  id: 'calendar',
  name: 'Calendar',
  version: '1.0.0',
  description: 'Manage calendar events: list, check availability, schedule',

  async onLoad(ctx: SkillContext) {
    ctx.logger.info('Calendar skill loaded');
  },

  async onUnload() {},

  commands: {
    cal: {
      description: 'Calendar commands: today, availability <date>, schedule <title>',
      async handler(args: string[], ctx: SkillContext) {
        const subcommand = args[0]?.toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        if (subcommand === 'today') {
          const today = new Date().toISOString().split('T')[0];
          const result = await handlers.calendar_list({ days: 1 }, ctx);
          return (result as { content?: string })?.content || `No events for ${today}`;
        }

        if (subcommand === 'availability') {
          if (!rest) return 'Usage: /cal availability <YYYY-MM-DD>';
          const result = await handlers.calendar_availability({ date: rest }, ctx);
          return (result as { content?: string })?.content || 'Could not check availability';
        }

        if (subcommand === 'schedule') {
          return "To schedule an event, provide details in natural language and I'll use the calendar_schedule tool.";
        }

        return 'Usage: /cal today | /cal availability <YYYY-MM-DD> | /cal schedule';
      },
    },
  },
};

export default skill;
