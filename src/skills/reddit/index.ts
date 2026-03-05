import type { Skill, SkillContext } from '../../core/types';

const skill: Skill = {
  id: 'reddit',
  name: 'Reddit',
  version: '1.0.0',
  description: 'Browse Reddit: search posts, view hot/top, read threads',

  async onLoad(ctx: SkillContext) {
    ctx.logger.info('Reddit skill loaded');
  },

  async onUnload() {},

  commands: {
    reddit: {
      description: 'Reddit commands: hot <subreddit>, search <query>',
      async handler(args: string[], ctx: SkillContext) {
        const subcommand = args[0]?.toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        if (subcommand === 'hot') {
          if (!rest) return 'Usage: /reddit hot <subreddit>';
          const result = await ctx.tools?.execute?.('reddit_hot', { subreddit: rest });
          if (result?.success) return result.content;
          return 'Reddit tools not available. Ask me in conversation to browse Reddit.';
        }

        if (subcommand === 'search') {
          if (!rest) return 'Usage: /reddit search <query>';
          const result = await ctx.tools?.execute?.('reddit_search', { query: rest });
          if (result?.success) return result.content;
          return 'Reddit tools not available. Ask me in conversation to search Reddit.';
        }

        return 'Usage: /reddit hot <subreddit> | /reddit search <query>';
      },
    },
  },
};

export default skill;
