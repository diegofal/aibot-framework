import type { Skill, SkillContext } from '../../core/types';

export const handlers: Record<
  string,
  (args: Record<string, unknown>, context: SkillContext) => Promise<unknown>
> = {
  async reddit_search(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const result = await ctx.tools.execute?.('reddit_search', args, ctx);
    return result ?? { success: false, message: 'reddit_search tool not available' };
  },

  async reddit_hot(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const result = await ctx.tools.execute?.('reddit_hot', args, ctx);
    return result ?? { success: false, message: 'reddit_hot tool not available' };
  },
};

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
          const result = await handlers.reddit_hot({ subreddit: rest }, ctx);
          return (result as { content?: string })?.content || 'No results';
        }

        if (subcommand === 'search') {
          if (!rest) return 'Usage: /reddit search <query>';
          const result = await handlers.reddit_search({ query: rest }, ctx);
          return (result as { content?: string })?.content || 'No results';
        }

        return 'Usage: /reddit hot <subreddit> | /reddit search <query>';
      },
    },
  },
};

export default skill;
