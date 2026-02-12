import type { Skill, SkillContext } from '../../core/types';

const skill: Skill = {
  id: 'example',
  name: 'Example Skill',
  version: '1.0.0',
  description: 'A simple example skill',

  async onLoad(ctx: SkillContext) {
    ctx.logger.info('Example skill loaded');
  },

  async onUnload() {
    console.log('Example skill unloaded');
  },

  commands: {
    ping: {
      description: 'Responds with pong',
      async handler(_args: string[], ctx: SkillContext) {
        ctx.logger.debug('Ping command executed');
        return '🏓 Pong!';
      },
    },

    echo: {
      description: 'Echoes your message',
      async handler(args: string[], ctx: SkillContext) {
        if (args.length === 0) {
          return '🔊 Echo... echo... echo...\n\nUsage: /echo <message>';
        }

        const message = args.join(' ');
        ctx.logger.debug({ message }, 'Echo command executed');

        return `🔊 ${message}`;
      },
    },

    ai: {
      description: 'Ask the AI a question',
      async handler(args: string[], ctx: SkillContext) {
        if (args.length === 0) {
          return '🤖 Ask me something!\n\nUsage: /ai <question>';
        }

        const question = args.join(' ');
        ctx.logger.info({ question }, 'AI question received');

        try {
          const response = await ctx.ollama.generate(question, {
            system: 'You are a helpful assistant. Be concise and friendly.',
            temperature: 0.7,
          });

          return `🤖 ${response}`;
        } catch (error) {
          ctx.logger.error({ error }, 'AI generation failed');
          return '❌ Sorry, I encountered an error. Please try again later.';
        }
      },
    },

    status: {
      description: 'Show skill status and information',
      async handler(_args: string[], ctx: SkillContext) {
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);

        return `📊 *Example Skill Status*

✅ Status: Active
⏱️ Uptime: ${hours}h ${minutes}m ${seconds}s
🤖 AI: Connected

Commands:
• /ping - Test bot responsiveness
• /echo - Echo messages
• /ai - Ask AI questions
• /status - Show this status`;
      },
    },
  },
};

export default skill;
