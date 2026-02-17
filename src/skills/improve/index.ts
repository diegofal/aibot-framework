import type { Skill, SkillContext } from '../../core/types';
import { runImprove, VALID_FOCUS, type FocusArea } from '../../tools/improve';

interface ImproveConfig {
  soulDir?: string;
  claudePath?: string;
  timeout?: number;
  maxOutputLength?: number;
  telegramChatId?: number;
}

const DEFAULT_SOUL_DIR = './config/soul';
const DEFAULT_CLAUDE_PATH = 'claude';
const DEFAULT_TIMEOUT = 300_000;
const DEFAULT_MAX_OUTPUT = 15_000;

// Lock to prevent concurrent /improve runs (e.g. both bots in a group)
let running = false;

const skill: Skill = {
  id: 'improve',
  name: 'Soul Improve',
  version: '1.0.0',
  description: 'Spawn Claude Code to review and improve soul/memory files',

  async onLoad(ctx: SkillContext) {
    ctx.logger.info('Improve skill loaded');
  },

  commands: {
    improve: {
      description: 'Run Claude Code to improve soul files. Usage: /improve [focus] [context]. Focus: memory, soul, motivations, identity, all (default)',
      async handler(args: string[], ctx: SkillContext) {
        // Concurrency guard — only one session at a time across all bots
        if (running) {
          ctx.logger.debug('Improve already running, skipping');
          return '';
        }
        running = true;

        try {
          const config = ctx.config as ImproveConfig;
          const soulDir = ctx.soulDir || config.soulDir || DEFAULT_SOUL_DIR;
          const claudePath = config.claudePath || DEFAULT_CLAUDE_PATH;
          const timeout = config.timeout || DEFAULT_TIMEOUT;
          const maxOutputLength = config.maxOutputLength || DEFAULT_MAX_OUTPUT;

          // Parse focus from first arg
          const rawFocus = (args[0] || 'all').toLowerCase();
          const focus: FocusArea = (VALID_FOCUS as readonly string[]).includes(rawFocus)
            ? (rawFocus as FocusArea)
            : 'all';

          // Remaining args become context string
          const contextArgs = (VALID_FOCUS as readonly string[]).includes(rawFocus)
            ? args.slice(1)
            : args;
          const context = contextArgs.length > 0 ? contextArgs.join(' ') : undefined;

          ctx.logger.info({ focus, context }, 'Improve command invoked');

          // Send immediate feedback
          const chatId = ctx.session!.chatId;
          await ctx.telegram.sendMessage(chatId, `🔧 Starting soul improvement (focus: ${focus})... This may take a few minutes.`);

          const result = await runImprove({
            claudePath,
            timeout,
            maxOutputLength,
            soulDir,
            focus,
            context,
            logger: ctx.logger,
          });

          if (result.success) {
            return result.content;
          }

          return `❌ ${result.content}`;
        } finally {
          running = false;
        }
      },
    },
  },
};

export default skill;
