import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import { AVAILABLE_PRESETS } from '../../bot/agent-loop-prompts';
import { resolveDirectives } from '../../bot/agent-scheduler';
import { type BotConfig, type Config, persistBots, resolveAgentConfig } from '../../config';
import type { SkillRegistry } from '../../core/skill-registry';
import type { Logger } from '../../logger';
import { backupSoulFile } from '../../soul';
import { generateSoul } from '../../soul-generator';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';

export function agentsRoutes(deps: {
  config: Config;
  botManager: BotManager;
  skillRegistry: SkillRegistry;
  configPath: string;
  logger: Logger;
}) {
  const app = new Hono();

  /** Find a bot by id, respecting tenant scope. Returns null if not found or not accessible. */
  function findBotScoped(c: import('hono').Context, id: string): BotConfig | null {
    const bot = deps.config.bots.find((b) => b.id === id);
    if (!bot) return null;
    if (!isBotAccessible(bot, getTenantId(c))) return null;
    return bot;
  }

  // List all agents
  app.get('/', (c) => {
    const tenantId = getTenantId(c);
    const agents = scopeBots(deps.config.bots, tenantId).map((bot) => ({
      ...bot,
      token: maskToken(bot.token),
      running: deps.botManager.isRunning(bot.id),
    }));
    return c.json(agents);
  });

  // Get global defaults for placeholder display
  app.get('/defaults', (c) => {
    return c.json({
      model: deps.config.ollama.models.primary,
      availableModels: [
        deps.config.ollama.models.primary,
        ...(deps.config.ollama.models.fallbacks || []),
        'claude-cli',
      ],
      systemPrompt: deps.config.conversation.systemPrompt,
      temperature: deps.config.conversation.temperature,
      maxHistory: deps.config.conversation.maxHistory,
      soulDir: deps.config.soul.dir,
      productionsBaseDir: deps.config.productions.baseDir,
      agentLoopInterval: deps.config.agentLoop.every,
      availableTools: deps.botManager.getAvailableToolNames(),
      availableSkills: deps.botManager.getExternalSkillNames(),
      ttsEnabled: !!deps.config.media?.tts,
      ttsVoiceId: deps.config.media?.tts?.voiceId,
    });
  });

  // Get single agent
  app.get('/:id', (c) => {
    const bot = findBotScoped(c, c.req.param('id'));
    if (!bot) return c.json({ error: 'Agent not found' }, 404);
    return c.json({
      ...bot,
      token: maskToken(bot.token),
      running: deps.botManager.isRunning(bot.id),
    });
  });

  // Create new agent
  app.post('/', async (c) => {
    const body = await c.req.json<Partial<BotConfig>>();
    if (!body.id || !body.name) {
      return c.json({ error: 'id and name are required' }, 400);
    }
    if (deps.config.bots.some((b) => b.id === body.id)) {
      return c.json({ error: 'Agent with this id already exists' }, 409);
    }

    const tenantId = getTenantId(c);

    let skills: string[];
    if (body.skills !== undefined) {
      skills = [...new Set(body.skills)];
    } else {
      const builtIn = (await deps.skillRegistry.listAvailable()).map((s) => s.id);
      const external = deps.botManager.getExternalSkillNames();
      skills = [...new Set([...builtIn, ...external])];
    }

    const newBot: BotConfig = {
      id: body.id,
      name: body.name,
      token: body.token ?? '',
      enabled: body.enabled ?? false,
      skills,
      allowedUsers: body.allowedUsers,
      mentionPatterns: body.mentionPatterns,
      model: body.model,
      llmBackend: body.llmBackend,
      soulDir: body.soulDir,
      disabledTools: body.disabledTools,
      conversation: body.conversation,
      ...(tenantId ? { tenantId } : {}),
    };

    deps.config.bots.push(newBot);
    persistBots(deps.configPath, deps.config.bots);

    return c.json({ ...newBot, token: maskToken(newBot.token) }, 201);
  });

  // Update agent
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const bot = findBotScoped(c, id);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);

    const body = await c.req.json<Partial<BotConfig>>();

    if (body.name !== undefined) bot.name = body.name;
    if (body.token !== undefined) bot.token = body.token;
    if (body.enabled !== undefined) bot.enabled = body.enabled;
    if (body.skills !== undefined) bot.skills = [...new Set(body.skills)];
    if (body.allowedUsers !== undefined) bot.allowedUsers = body.allowedUsers;
    if (body.mentionPatterns !== undefined) bot.mentionPatterns = body.mentionPatterns;
    if (body.disabledTools !== undefined) bot.disabledTools = body.disabledTools;
    if (body.disabledSkills !== undefined) bot.disabledSkills = body.disabledSkills;

    // Per-agent override fields (undefined = clear override, use global default)
    if ('model' in body) bot.model = body.model || undefined;
    if ('llmBackend' in body) bot.llmBackend = body.llmBackend || undefined;
    if ('soulDir' in body) bot.soulDir = body.soulDir || undefined;
    if ('workDir' in body) bot.workDir = body.workDir || undefined;
    if ('conversation' in body) {
      if (body.conversation && Object.values(body.conversation).some((v) => v !== undefined)) {
        bot.conversation = body.conversation;
      } else {
        bot.conversation = undefined;
      }
    }
    if ('agentLoop' in body) {
      const al = body.agentLoop;
      if (al && Object.values(al).some((v: unknown) => v !== undefined)) {
        bot.agentLoop = { ...bot.agentLoop, ...al };
      } else {
        bot.agentLoop = undefined;
      }
    }
    if ('productions' in body) {
      const prod = body.productions;
      if (prod && Object.values(prod).some((v: unknown) => v !== undefined)) {
        bot.productions = { ...bot.productions, ...prod };
      } else {
        bot.productions = undefined;
      }
    }
    if ('tts' in body) {
      const tts = body.tts;
      if (tts && Object.values(tts).some((v: unknown) => v !== undefined)) {
        bot.tts = tts;
      } else {
        bot.tts = undefined;
      }
    }

    persistBots(deps.configPath, deps.config.bots);

    return c.json({
      ...bot,
      token: maskToken(bot.token),
      running: deps.botManager.isRunning(bot.id),
    });
  });

  // Delete agent
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!findBotScoped(c, id)) return c.json({ error: 'Agent not found' }, 404);
    if (deps.botManager.isRunning(id)) {
      return c.json({ error: 'Stop the agent before deleting' }, 400);
    }
    const idx = deps.config.bots.findIndex((b) => b.id === id);
    if (idx === -1) return c.json({ error: 'Agent not found' }, 404);

    deps.config.bots.splice(idx, 1);
    persistBots(deps.configPath, deps.config.bots);

    return c.json({ ok: true });
  });

  // Start agent
  app.post('/:id/start', async (c) => {
    const id = c.req.param('id');
    const bot = findBotScoped(c, id);
    if (!bot) {
      deps.logger.warn({ botId: id }, 'Start failed: agent not found');
      return c.json({ error: 'Agent not found' }, 404);
    }
    if (deps.botManager.isRunning(id)) {
      deps.logger.warn({ botId: id }, 'Start failed: already running');
      return c.json({ error: 'Agent already running' }, 400);
    }

    try {
      await deps.botManager.startBot(bot);
      deps.logger.info({ botId: id }, 'Agent started via API');
      return c.json({ ok: true, running: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to start agent';
      deps.logger.error({ botId: id, error: message }, 'Start failed');
      return c.json({ error: message }, 500);
    }
  });

  // Stop agent
  app.post('/:id/stop', async (c) => {
    const id = c.req.param('id');
    const bot = findBotScoped(c, id);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);
    if (!deps.botManager.isRunning(id)) {
      deps.logger.warn({ botId: id }, 'Stop failed: agent not running');
      return c.json({ error: 'Agent not running' }, 400);
    }

    await deps.botManager.stopBot(id);
    deps.logger.info({ botId: id }, 'Agent stopped via API');
    return c.json({ ok: true, running: false });
  });

  // Reset agent (full reset to baseline)
  app.post('/:id/reset', async (c) => {
    const id = c.req.param('id');
    const bot = findBotScoped(c, id);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);
    if (deps.botManager.isRunning(id)) {
      return c.json({ error: 'Stop the agent before resetting' }, 400);
    }

    try {
      const result = await deps.botManager.resetBot(id);
      deps.logger.info({ botId: id, cleared: result.cleared }, 'Agent reset via API');
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Reset failed';
      deps.logger.error({ botId: id, error: message }, 'Reset failed');
      return c.json({ error: message }, 500);
    }
  });

  // Clone agent
  app.post('/:id/clone', async (c) => {
    const id = c.req.param('id');
    const source = findBotScoped(c, id);
    if (!source) return c.json({ error: 'Agent not found' }, 404);

    const body = await c.req.json<{ id: string; name: string }>();
    if (!body.id || !body.name) {
      return c.json({ error: 'id and name are required' }, 400);
    }
    if (deps.config.bots.some((b) => b.id === body.id)) {
      return c.json({ error: 'Agent with this id already exists' }, 409);
    }

    const tenantId = getTenantId(c);
    const clone: BotConfig = {
      ...structuredClone(source),
      id: body.id,
      name: body.name,
      token: '',
      enabled: false,
      ...(tenantId ? { tenantId } : {}),
    };

    // Copy soul files from source bot's resolved soulDir
    const sourceSoulDir = resolveAgentConfig(deps.config, source).soulDir;
    if (existsSync(sourceSoulDir)) {
      const cloneSoulDir = `${deps.config.soul.dir}/${body.id}`;
      mkdirSync(cloneSoulDir, { recursive: true });
      cpSync(sourceSoulDir, cloneSoulDir, { recursive: true });
    }

    deps.config.bots.push(clone);
    persistBots(deps.configPath, deps.config.bots);

    return c.json({ ...clone, token: '', running: false }, 201);
  });

  // Check soul file status for an agent
  app.get('/:id/soul-status', (c) => {
    const id = c.req.param('id');
    const bot = findBotScoped(c, id);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);

    const soulDir = resolveAgentConfig(deps.config, bot).soulDir;
    const hasSoulDir = existsSync(soulDir);

    const fileStatus = (filename: string) => {
      const filepath = join(soulDir, filename);
      if (!existsSync(filepath)) return { exists: false, length: 0 };
      try {
        const stat = statSync(filepath);
        return { exists: true, length: stat.size };
      } catch {
        return { exists: false, length: 0 };
      }
    };

    const identity = fileStatus('IDENTITY.md');
    const soul = fileStatus('SOUL.md');
    const motivations = fileStatus('MOTIVATIONS.md');
    const complete =
      hasSoulDir &&
      identity.exists &&
      soul.exists &&
      motivations.exists &&
      identity.length > 0 &&
      soul.length > 0 &&
      motivations.length > 0;

    return c.json({
      soulDir,
      hasSoulDir,
      files: { identity, soul, motivations },
      complete,
    });
  });

  // Initialize per-agent soul directory
  app.post('/:id/init-soul', async (c) => {
    const id = c.req.param('id');
    const bot = findBotScoped(c, id);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);

    const agentSoulDir = `./config/soul/${id}`;

    if (!existsSync(agentSoulDir)) {
      mkdirSync(join(agentSoulDir, 'memory'), { recursive: true });
      writeFileSync(join(agentSoulDir, 'IDENTITY.md'), `name: ${bot.name}\n`);
    }

    bot.soulDir = agentSoulDir;
    persistBots(deps.configPath, deps.config.bots);

    return c.json({ ok: true, soulDir: agentSoulDir });
  });

  // Generate soul files with AI (preview only — doesn't write)
  app.post('/:id/generate-soul', async (c) => {
    const id = c.req.param('id');
    const bot = findBotScoped(c, id);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);

    const body = await c.req.json<{
      name?: string;
      role: string;
      personalityDescription: string;
      language?: string;
      emoji?: string;
      llmBackend?: 'ollama' | 'claude-cli';
      model?: string;
    }>();

    if (!body.role || !body.personalityDescription) {
      return c.json({ error: 'role and personalityDescription are required' }, 400);
    }

    let generate: ((prompt: string) => Promise<string>) | undefined;
    if (body.llmBackend === 'ollama') {
      const ollamaClient = deps.botManager.getOllamaClient();
      const model = body.model || deps.config.ollama.models.primary;
      generate = async (prompt) => (await ollamaClient.generate(prompt, { model })).text;
    }

    try {
      const result = await generateSoul(
        {
          name: body.name || bot.name,
          role: body.role,
          personalityDescription: body.personalityDescription,
          language: body.language,
          emoji: body.emoji,
        },
        {
          soulDir: deps.config.soul.dir,
          claudeModel: deps.config.claudeCli?.model,
          logger: deps.logger,
          generate,
        }
      );
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Soul generation failed';
      deps.logger.error({ botId: id, error: message }, 'Soul generation failed');
      return c.json({ error: message }, 500);
    }
  });

  // Get directives for an agent
  app.get('/:id/directives', (c) => {
    const bot = findBotScoped(c, c.req.param('id'));
    if (!bot) return c.json({ error: 'Agent not found' }, 404);

    return c.json({
      directives: bot.agentLoop?.directives ?? [],
      presetDirectives: bot.agentLoop?.presetDirectives ?? [],
      resolvedDirectives: resolveDirectives(bot),
      availablePresets: AVAILABLE_PRESETS,
    });
  });

  // Apply generated soul files to disk
  app.post('/:id/apply-soul', async (c) => {
    const id = c.req.param('id');
    const bot = findBotScoped(c, id);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);

    const body = await c.req.json<{
      identity: string;
      soul: string;
      motivations: string;
    }>();

    if (!body.identity || !body.soul || !body.motivations) {
      return c.json({ error: 'identity, soul, and motivations are required' }, 400);
    }

    const soulDir = resolveAgentConfig(deps.config, bot).soulDir;
    mkdirSync(join(soulDir, 'memory'), { recursive: true });

    // Back up existing files
    for (const filename of ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md']) {
      const filepath = join(soulDir, filename);
      if (existsSync(filepath)) {
        backupSoulFile(filepath, deps.logger);
      }
    }

    // Write new files
    writeFileSync(join(soulDir, 'IDENTITY.md'), body.identity, 'utf-8');
    writeFileSync(join(soulDir, 'SOUL.md'), body.soul, 'utf-8');
    writeFileSync(join(soulDir, 'MOTIVATIONS.md'), body.motivations, 'utf-8');

    // Save baseline for reset
    const baselineDir = join(soulDir, '.baseline');
    mkdirSync(baselineDir, { recursive: true });
    writeFileSync(join(baselineDir, 'IDENTITY.md'), body.identity, 'utf-8');
    writeFileSync(join(baselineDir, 'SOUL.md'), body.soul, 'utf-8');
    writeFileSync(join(baselineDir, 'MOTIVATIONS.md'), body.motivations, 'utf-8');

    deps.logger.info({ botId: id, soulDir }, 'Soul files applied via API');
    return c.json({ ok: true, soulDir });
  });

  return app;
}

function maskToken(token: string): string {
  if (!token || token.startsWith('${')) return token;
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}
