import type { Skill, SkillContext } from '../../core/types';

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
          const result = await ctx.tools?.execute?.('calendar_list', { days: 1 });
          if (result?.success) return result.content;
          return `No events for ${today}`;
        }

        if (subcommand === 'availability') {
          if (!rest) return 'Usage: /cal availability <YYYY-MM-DD>';
          const result = await ctx.tools?.execute?.('calendar_availability', { date: rest });
          if (result?.success) return result.content;
          return 'Calendar tools not available. Ask me in conversation to check availability.';
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
