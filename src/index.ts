import { join } from 'node:path';
import { BotManager } from './bot';
import { loadConfig } from './config';
import { createLLMClient } from './core/llm-client';
import { SkillRegistry } from './core/skill-registry';
import { CronService } from './cron';
import { createLogger } from './logger';
import { MemoryManager } from './memory/manager';
import { SessionManager } from './session';
import { SoulLoader, migrateSoulRootToPerBot } from './soul';
import { startWebServer } from './web/server';

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const jobFlag = args.indexOf('--job');
  const runSingleJob = jobFlag >= 0 ? args[jobFlag + 1] : null;

  try {
    // Load configuration
    const config = await loadConfig('./config/config.json');
    const logger = createLogger(config.logging);

    logger.info('Starting AIBot Framework v1.0.0');
    logger.info({ platform: process.platform, node: process.version }, 'System info');

    // Load skills
    logger.info('Loading skills...');
    const skillRegistry = new SkillRegistry(config, logger);
    await skillRegistry.loadSkills(config.skills.enabled);
    logger.info({ count: skillRegistry.getAll().length }, 'Skills loaded');

    // If running single job, execute and exit
    if (runSingleJob) {
      logger.info({ jobId: runSingleJob }, 'Running single job');

      // Find skill with this job
      for (const skill of skillRegistry.getAll()) {
        if (skill.jobs) {
          for (const job of skill.jobs) {
            if (job.id === runSingleJob) {
              const context = skillRegistry.getContext(skill.id);
              if (context) {
                await job.handler(context);
                logger.info({ jobId: runSingleJob }, 'Job completed');
                return;
              }
            }
          }
        }
      }

      logger.error({ jobId: runSingleJob }, 'Job not found');
      process.exit(1);
    }

    // Migrate flat soul layout to per-bot subdirectories (idempotent)
    migrateSoulRootToPerBot(config.soul.dir, 'default', logger);

    // Initialize soul loader (fallback for bots without per-bot loader)
    const soulLoader = new SoulLoader(config.soul, logger);
    await soulLoader.initialize();

    // Initialize semantic memory search (if enabled)
    let memoryManager: MemoryManager | undefined;
    if (config.soul.search?.enabled) {
      logger.info('Initializing semantic memory search...');
      const transcriptsDir = config.soul.sessionMemory?.enabled
        ? join(config.session.dataDir, 'transcripts')
        : undefined;
      memoryManager = new MemoryManager(
        config.soul.dir,
        config.soul.search,
        skillRegistry.getOllamaClient(),
        logger,
        transcriptsDir,
      );
      await memoryManager.initialize();
      logger.info('Semantic memory search initialized');

      // Index session transcripts on startup if configured
      if (config.soul.sessionMemory?.enabled && config.soul.sessionMemory.indexOnStartup) {
        logger.info('Indexing session transcripts...');
        await memoryManager.indexSessions();
        logger.info('Session transcript indexing complete');
      }
    }

    // Initialize session manager
    const sessionManager = new SessionManager(config.session, logger);
    await sessionManager.initialize();

    // Initialize CronService
    // sendMessage will be wired up after BotManager is created
    let botManager: BotManager;

    const cronService = new CronService({
      logger,
      storePath: config.cron.storePath,
      cronEnabled: config.cron.enabled,
      sendMessage: async (chatId: number, text: string, botId: string) => {
        await botManager.sendMessage(chatId, text, botId);
      },
      resolveSkillHandler: (payload) => {
        const skill = skillRegistry.get(payload.skillId);
        if (!skill?.jobs) return undefined;
        const job = skill.jobs.find((j) => j.id === payload.jobId);
        if (!job) return undefined;
        let context = skillRegistry.getContext(payload.skillId);
        if (!context) return undefined;

        // Per-job LLM backend override
        if (payload.llmBackend) {
          const llm = createLLMClient(
            {
              llmBackend: payload.llmBackend,
              claudePath: payload.claudePath,
              claudeTimeout: payload.claudeTimeout,
            },
            skillRegistry.getOllamaClient(),
            context.logger,
          );
          context = { ...context, llm };
        }

        return async () => {
          return await job.handler(context);
        };
      },
      onEvent: (evt) => {
        logger.debug({ evt }, 'cron event');
      },
    });

    // Register skill jobs in CronService
    for (const skill of skillRegistry.getAll()) {
      if (skill.jobs) {
        for (const job of skill.jobs) {
          // Check if skill job already exists in store (will be deduplicated by name)
          const existingJobs = await cronService.list({ includeDisabled: true });
          const alreadyExists = existingJobs.some(
            (j) =>
              j.payload.kind === 'skillJob' &&
              j.payload.skillId === skill.id &&
              j.payload.jobId === job.id
          );
          if (!alreadyExists) {
            await cronService.add({
              name: `${skill.name}: ${job.id}`,
              enabled: true,
              schedule: { kind: 'cron', expr: job.schedule },
              payload: { kind: 'skillJob', skillId: skill.id, jobId: job.id },
            });
            logger.info(
              { skillId: skill.id, jobId: job.id, schedule: job.schedule },
              'Skill job registered in CronService'
            );
          }
        }
      }
    }

    await cronService.start();

    // Start bots
    logger.info('Starting Telegram bots...');
    botManager = new BotManager(
      skillRegistry,
      logger,
      skillRegistry.getOllamaClient(),
      config,
      sessionManager,
      soulLoader,
      cronService,
      memoryManager
    );

    for (const botConfig of config.bots.filter((b) => b.enabled)) {
      await botManager.startBot(botConfig);
      logger.info({ botId: botConfig.id, name: botConfig.name }, 'Bot started');
    }

    // Start global agent loop timer
    botManager.startAgentLoop();

    // Start web server if enabled
    if (config.web.enabled) {
      startWebServer({
        config,
        configPath: './config/config.json',
        logger,
        botManager,
        sessionManager,
        skillRegistry,
        cronService,
      });
    }

    logger.info('All systems operational');
    logger.info('Press Ctrl+C to stop');

    // Handle graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down...');
      await botManager.stopAll();
      cronService.stop();
      sessionManager.dispose();
      memoryManager?.dispose();
      logger.info('Shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    await new Promise(() => {});
  } catch (error: any) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main().catch(console.error);
