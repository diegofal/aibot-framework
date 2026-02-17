import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import { resolveAgentConfig, type BotConfig, type Config } from '../../config';
import type { Logger } from '../../logger';
import { generateSoul } from '../../soul-generator';
import { backupSoulFile } from '../../soul';

export function agentsRoutes(deps: {
  config: Config;
  botManager: BotManager;
  configPath: string;
  logger: Logger;
}) {
  const app = new Hono();

  // List all agents
  app.get('/', (c) => {
    const agents = deps.config.bots.map((bot) => ({
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
      systemPrompt: deps.config.conversation.systemPrompt,
      temperature: deps.config.conversation.temperature,
      maxHistory: deps.config.conversation.maxHistory,
      soulDir: deps.config.soul.dir,
    });
  });

  // Get single agent
  app.get('/:id', (c) => {
    const bot = deps.config.bots.find((b) => b.id === c.req.param('id'));
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

    const newBot: BotConfig = {
      id: body.id,
      name: body.name,
      token: body.token ?? '',
      enabled: body.enabled ?? false,
      skills: body.skills ?? [],
      allowedUsers: body.allowedUsers,
      mentionPatterns: body.mentionPatterns,
      model: body.model,
      soulDir: body.soulDir,
      disabledTools: body.disabledTools,
      conversation: body.conversation,
    };

    deps.config.bots.push(newBot);
    persistBots(deps.configPath, deps.config.bots);

    return c.json({ ...newBot, token: maskToken(newBot.token) }, 201);
  });

  // Update agent
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const bot = deps.config.bots.find((b) => b.id === id);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);

    const body = await c.req.json<Partial<BotConfig>>();

    if (body.name !== undefined) bot.name = body.name;
    if (body.token !== undefined) bot.token = body.token;
    if (body.enabled !== undefined) bot.enabled = body.enabled;
    if (body.skills !== undefined) bot.skills = body.skills;
    if (body.allowedUsers !== undefined) bot.allowedUsers = body.allowedUsers;
    if (body.mentionPatterns !== undefined) bot.mentionPatterns = body.mentionPatterns;
    if (body.disabledTools !== undefined) bot.disabledTools = body.disabledTools;

    // Per-agent override fields (undefined = clear override, use global default)
    if ('model' in body) bot.model = body.model || undefined;
    if ('soulDir' in body) bot.soulDir = body.soulDir || undefined;
    if ('conversation' in body) {
      if (body.conversation && Object.values(body.conversation).some((v) => v !== undefined)) {
        bot.conversation = body.conversation;
      } else {
        bot.conversation = undefined;
      }
    }

    persistBots(deps.configPath, deps.config.bots);

    return c.json({ ...bot, token: maskToken(bot.token), running: deps.botManager.isRunning(bot.id) });
  });

  // Delete agent
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
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
    const bot = deps.config.bots.find((b) => b.id === id);
    if (!bot) {
      deps.logger.warn({ botId: id }, 'Start failed: agent not found');
      return c.json({ error: 'Agent not found' }, 404);
    }
    if (!bot.token) {
      deps.logger.warn({ botId: id }, 'Start failed: no token configured');
      return c.json({ error: 'Agent has no token configured' }, 400);
    }
    if (deps.botManager.isRunning(id)) {
      deps.logger.warn({ botId: id }, 'Start failed: already running');
      return c.json({ error: 'Agent already running' }, 400);
    }

    try {
      await deps.botManager.startBot(bot);
      deps.logger.info({ botId: id }, 'Agent started via API');
      return c.json({ ok: true, running: true });
    } catch (err: any) {
      deps.logger.error({ botId: id, error: err.message }, 'Start failed');
      return c.json({ error: err.message ?? 'Failed to start agent' }, 500);
    }
  });

  // Stop agent
  app.post('/:id/stop', async (c) => {
    const id = c.req.param('id');
    if (!deps.botManager.isRunning(id)) {
      deps.logger.warn({ botId: id }, 'Stop failed: agent not running');
      return c.json({ error: 'Agent not running' }, 400);
    }

    await deps.botManager.stopBot(id);
    deps.logger.info({ botId: id }, 'Agent stopped via API');
    return c.json({ ok: true, running: false });
  });

  // Clone agent
  app.post('/:id/clone', async (c) => {
    const id = c.req.param('id');
    const source = deps.config.bots.find((b) => b.id === id);
    if (!source) return c.json({ error: 'Agent not found' }, 404);

    const body = await c.req.json<{ id: string; name: string }>();
    if (!body.id || !body.name) {
      return c.json({ error: 'id and name are required' }, 400);
    }
    if (deps.config.bots.some((b) => b.id === body.id)) {
      return c.json({ error: 'Agent with this id already exists' }, 409);
    }

    const clone: BotConfig = {
      ...structuredClone(source),
      id: body.id,
      name: body.name,
      token: '',
      enabled: false,
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

  // Initialize per-agent soul directory
  app.post('/:id/init-soul', async (c) => {
    const id = c.req.param('id');
    const bot = deps.config.bots.find((b) => b.id === id);
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
    const bot = deps.config.bots.find((b) => b.id === id);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);

    const body = await c.req.json<{
      name?: string;
      role: string;
      personalityDescription: string;
      language?: string;
      emoji?: string;
    }>();

    if (!body.role || !body.personalityDescription) {
      return c.json({ error: 'role and personalityDescription are required' }, 400);
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
          logger: deps.logger,
        },
      );
      return c.json(result);
    } catch (err: any) {
      deps.logger.error({ botId: id, error: err.message }, 'Soul generation failed');
      return c.json({ error: err.message ?? 'Soul generation failed' }, 500);
    }
  });

  // Apply generated soul files to disk
  app.post('/:id/apply-soul', async (c) => {
    const id = c.req.param('id');
    const bot = deps.config.bots.find((b) => b.id === id);
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

    deps.logger.info({ botId: id, soulDir }, 'Soul files applied via API');
    return c.json({ ok: true, soulDir });
  });

  return app;
}

function maskToken(token: string): string {
  if (!token || token.startsWith('${')) return token;
  if (token.length <= 8) return '****';
  return token.slice(0, 4) + '****' + token.slice(-4);
}

/**
 * Persist only the bots array to config.json, preserving env var references
 * in the rest of the file.
 */
function persistBots(configPath: string, bots: BotConfig[]): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  raw.bots = bots;
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}
