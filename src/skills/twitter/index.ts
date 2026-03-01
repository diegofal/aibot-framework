import type { Skill, SkillContext } from '../../core/types';

export const handlers: Record<
  string,
  (args: Record<string, unknown>, context: SkillContext) => Promise<unknown>
> = {
  async twitter_search(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const result = await ctx.tools.execute?.('twitter_search', args, ctx);
    return result ?? { success: false, message: 'twitter_search tool not available' };
  },

  async twitter_read(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const result = await ctx.tools.execute?.('twitter_read', args, ctx);
    return result ?? { success: false, message: 'twitter_read tool not available' };
  },

  async twitter_post(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const result = await ctx.tools.execute?.('twitter_post', args, ctx);
    return result ?? { success: false, message: 'twitter_post tool not available' };
  },
};

const skill: Skill = {
  id: 'twitter',
  name: 'Twitter/X',
  version: '1.0.0',
  description: 'Search tweets, read timelines, and post on Twitter/X',

  async onLoad(ctx: SkillContext) {
    ctx.logger.info('Twitter skill loaded');
  },

  async onUnload() {},

  commands: {
    twitter: {
      description: 'Twitter commands: search <query>, trending, post <text>',
      async handler(args: string[], ctx: SkillContext) {
        const subcommand = args[0]?.toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        if (subcommand === 'search') {
          if (!rest) return 'Usage: /twitter search <query>';
          const result = await handlers.twitter_search({ query: rest }, ctx);
          return (result as { content?: string })?.content || 'No results';
        }

        if (subcommand === 'trending') {
          const result = await handlers.twitter_search({ query: 'trending', max_results: 20 }, ctx);
          return (result as { content?: string })?.content || 'No results';
        }

        if (subcommand === 'post') {
          if (!rest) return 'Usage: /twitter post <text>';
          const result = await handlers.twitter_post({ text: rest }, ctx);
          return (result as { content?: string })?.content || 'Post failed';
        }

        return 'Usage: /twitter search <query> | /twitter trending | /twitter post <text>';
      },
    },
  },
};

export default skill;
