import type { Skill, SkillContext } from '../../core/types';
import { type FocusArea, VALID_FOCUS, runImprove } from '../../tools/improve';

interface ImproveConfig {
  soulDir?: string;
  claudePath?: string;
  timeout?: number;
  maxOutputLength?: number;
  telegramChatId?: number;
}

const DEFAULT_CLAUDE_PATH = 'claude';
const DEFAULT_TIMEOUT = 300_000;
const DEFAULT_MAX_OUTPUT = 15_000;

// Per-bot lock to prevent concurrent /improve runs per bot
const runningBots = new Set<string>();

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
      description:
        'Run Claude Code to improve soul files. Usage: /improve [focus] [context]. Focus: memory, soul, motivations, identity, all (default)',
      async handler(args: string[], ctx: SkillContext) {
        const lockKey = ctx.botId ?? 'unknown';

        // Concurrency guard — one session per bot
        if (runningBots.has(lockKey)) {
          ctx.logger.debug({ botId: lockKey }, 'Improve already running for this bot, skipping');
          return '';
        }
        runningBots.add(lockKey);

        try {
          const config = ctx.config as ImproveConfig;
          const soulDir = ctx.soulDir || config.soulDir;
          if (!soulDir) {
            ctx.logger.error(
              'Improve skipped: soulDir not configured (no fallback to shared root)'
            );
            return '❌ Improve skipped: soulDir not configured.';
          }
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
          const chatId = ctx.session?.chatId;
          await ctx.telegram.sendMessage(
            chatId,
            `🔧 Starting soul improvement (focus: ${focus})... This may take a few minutes.`
          );

          const result = await runImprove({
            claudePath,
            claudeModel: ctx.claudeCliModel,
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
          runningBots.delete(lockKey);
        }
      },
    },
  },
};

export default skill;
