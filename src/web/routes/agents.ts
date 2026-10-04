import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import { AVAILABLE_PRESETS } from '../../bot/agent-loop-prompts';
import { resolveDirectives } from '../../bot/agent-scheduler';
import {
  type Personality,
  type TelegramTokenCheck,
  WIZARD_SOUL_FILES,
  createTelegramTokenCheck,
  describePersonality,
  initialGoalsMarkdown,
  isChannelKind,
  isPersonality,
  personalityToTraits,
  seedTraits,
  traitsBaseDirFor,
  validateChannelToken,
  writeWizardSoul,
} from '../../bot/agent-wizard';
import { BotDisabledError } from '../../bot/auto-start';
import {
  applyPreset,
  getPreset,
  listPresets,
  presetGoalsMarkdown,
  presetSummary,
} from '../../bot/presets';
import { DEFAULT_PERMISSIONS } from '../../bot/tool-permissions';
import type { TraitSet } from '../../bot/trait-registers';
import { CLAUDE_CLI_MODEL_OPTIONS } from '../../claude-cli';
import {
  type BotConfig,
  type Config,
  CuriosityConfigSchema,
  persistBots,
  resolveAgentConfig,
  resolveAgentConfigWithTenant,
} from '../../config';
import type { SkillRegistry } from '../../core/skill-registry';
import type { Logger } from '../../logger';
import { backupSoulFile } from '../../soul';
import { type GeneratedSoul, type SoulGenerationInput, generateSoul } from '../../soul-generator';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';

/**
 * Injection points for the create-an-agent wizard (session S6). Production
 * uses the real soul generator and a live Telegram `getMe`; tests pass both.
 */
export interface AgentWizardDeps {
  generateSoul?: typeof generateSoul;
  telegramCheck?: TelegramTokenCheck;
}

/** Wizard fields accepted by `POST /api/agents` on top of the legacy BotConfig subset. */
export interface CreateAgentWizardBody {
  purpose?: string;
  personality?: Partial<Personality>;
  traits?: Partial<TraitSet>;
  quirks?: string;
  language?: string;
  emoji?: string;
  generation?: { llmBackend?: 'ollama' | 'claude-cli'; model?: string };
  greet?: boolean;
  /** Preset id (S7): its defaults are merged under everything else in the body. */
  preset?: string;
}

/** An id becomes a directory name under data/ and productions/, so it must be one safe path segment. */
export const BOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export function isSafeBotId(id: unknown): id is string {
  return typeof id === 'string' && BOT_ID_PATTERN.test(id) && id !== '.' && id !== '..';
}

export function agentsRoutes(deps: {
  config: Config;
  botManager: BotManager;
  skillRegistry: SkillRegistry;
  configPath: string;
  logger: Logger;
  wizard?: AgentWizardDeps;
}) {
  const app = new Hono();
  const soulGenerator = deps.wizard?.generateSoul ?? generateSoul;
  const telegramCheck = deps.wizard?.telegramCheck ?? createTelegramTokenCheck();

  /** Same resolution BotManager.startBot uses, so the wizard writes where the bot will read. */
  function soulDirFor(bot: BotConfig): string {
    return bot.tenantId && deps.config.multiTenant?.enabled
      ? resolveAgentConfigWithTenant(deps.config, undefined, bot, bot.tenantId).soulDir
      : resolveAgentConfig(deps.config, bot).soulDir;
  }

  /** Ollama-backed generate function when the caller asks for it; undefined = Claude CLI. */
  function generateFnFor(generation?: CreateAgentWizardBody['generation']) {
    if (generation?.llmBackend !== 'ollama') return undefined;
    const ollamaClient = deps.botManager.getOllamaClient();
    const model = generation.model || deps.config.ollama.models.primary;
    return async (prompt: string) => (await ollamaClient.generate(prompt, { model })).text;
  }

  /** Find a bot by id, respecting tenant scope. Returns null if not found or not accessible. */
  function findBotScoped(c: import('hono').Context, id: string): BotConfig | null {
    const bot = deps.config.bots.find((b) => b.id === id);
    if (!bot) return null;
    if (!isBotAccessible(bot, getTenantId(c))) return null;
    return bot;
  }

  /**
   * Channel outcome for the dashboard. Optional-called because route tests
   * stub BotManager with only the methods they exercise.
   */
  function channelOf(botId: string) {
    return deps.botManager.getChannelState?.(botId) ?? null;
  }

  // List all agents
  app.get('/', (c) => {
    const tenantId = getTenantId(c);
    const agents = scopeBots(deps.config.bots, tenantId).map((bot) => ({
      ...bot,
      token: maskToken(bot.token),
      running: deps.botManager.isRunning(bot.id),
      channel: channelOf(bot.id),
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
      // Claude CLI: the fleet-wide default model and the list the dashboard offers
      // for a per-agent override (same list as Settings → Claude CLI).
      claudeCliModel: deps.config.claudeCli?.model ?? '',
      claudeCliModels: CLAUDE_CLI_MODEL_OPTIONS,
      systemPrompt: deps.config.conversation.systemPrompt,
      temperature: deps.config.conversation.temperature,
      maxHistory: deps.config.conversation.maxHistory,
      soulDir: deps.config.soul.dir,
      productionsBaseDir: deps.config.productions.baseDir,
      agentLoopInterval: deps.config.agentLoop.every,
      agentLoop: {
        enabled: deps.config.agentLoop.enabled,
        every: deps.config.agentLoop.every,
        maxToolRounds: deps.config.agentLoop.maxToolRounds,
        claudeTimeout: deps.config.agentLoop.claudeTimeout,
        maxDurationMs: deps.config.agentLoop.maxDurationMs,
        toolPreSelection: deps.config.agentLoop.toolPreSelection,
        idleSuppression: deps.config.agentLoop.idleSuppression,
        phaseTimeouts: deps.config.agentLoop.phaseTimeouts,
        strategist: deps.config.agentLoop.strategist,
        retry: deps.config.agentLoop.retry,
        loopDetection: deps.config.agentLoop.loopDetection,
      },
      evolution: deps.config.evolution,
      availableTools: deps.botManager.getAvailableToolNames(),
      availableSkills: deps.botManager.getExternalSkillNames(),
      ttsEnabled: !!deps.config.media?.tts,
      ttsVoiceId: deps.config.media?.tts?.voiceId,
      defaultToolPermissions: DEFAULT_PERMISSIONS,
      permissionLevels: ['free', 'inform', 'confirm', 'blocked'],
    });
  });

  // Preset catalogue for the wizard's step 1 (S7). Registered before `/:id`
  // for the same reason as `/defaults`.
  app.get('/presets', (c) => c.json(listPresets().map(presetSummary)));

  // Get single agent
  app.get('/:id', (c) => {
    const bot = findBotScoped(c, c.req.param('id'));
    if (!bot) return c.json({ error: 'Agent not found' }, 404);
    return c.json({
      ...bot,
      token: maskToken(bot.token),
      running: deps.botManager.isRunning(bot.id),
      channel: channelOf(bot.id),
    });
  });

  // Validate a channel credential for the wizard's step 3. Shape-only for
  // missing/placeholder tokens; a shaped Telegram token gets a live getMe
  // (injected, so tests never reach Telegram). Discord/WhatsApp: shape only.
  app.post('/validate-token', async (c) => {
    const body = await c.req
      .json<{ kind?: unknown; token?: unknown }>()
      .catch(() => ({}) as { kind?: unknown; token?: unknown });
    if (!isChannelKind(body.kind)) {
      return c.json({ error: "kind must be 'telegram', 'whatsapp' or 'discord'" }, 400);
    }
    const token = typeof body.token === 'string' ? body.token : '';
    const result = await validateChannelToken(body.kind, token, telegramCheck);
    deps.logger.info(
      { kind: result.kind, state: result.state, live: result.live },
      'Token validated'
    );
    return c.json(result);
  });

  // Create new agent.
  //
  // Two payloads share this route. The legacy one (`{ id, name, token?, ... }`)
  // is unchanged: a disabled, soul-less bot and a flat BotConfig reply. The
  // wizard payload adds `purpose` (+ `personality` sliders or explicit `traits`,
  // `quirks`, `language`, `emoji`, `generation`); the soul is generated
  // synchronously and written together with GOALS.md and TRAITS.json BEFORE
  // the bot is registered, so a failed generation leaves nothing behind. The
  // wizard reply is `{ agent, soul: { generated, files, soulDir } }`.
  app.post('/', async (c) => {
    const raw = await c.req.json<Partial<BotConfig> & CreateAgentWizardBody>();
    // A preset fills only what the caller left undefined (applyPreset is pure),
    // so `{ id, preset }` is a complete wizard creation and a fully-typed wizard
    // body with `preset` comes out unchanged except for the missing pieces.
    let body: Partial<BotConfig> & CreateAgentWizardBody = raw;
    if (raw.preset !== undefined) {
      const preset = getPreset(raw.preset);
      if (!preset) {
        return c.json(
          { error: `Unknown preset '${String(raw.preset)}'; see GET /api/agents/presets` },
          400
        );
      }
      body = applyPreset(preset, raw) as Partial<BotConfig> & CreateAgentWizardBody;
    }
    if (!body.id || !body.name) {
      return c.json({ error: 'id and name are required' }, 400);
    }
    if (!isSafeBotId(body.id)) {
      return c.json(
        { error: 'id must be letters, digits, "-", "_" or "." and start with a letter or digit' },
        400
      );
    }
    if (deps.config.bots.some((b) => b.id === body.id)) {
      return c.json({ error: 'Agent with this id already exists' }, 409);
    }

    const wizard = typeof body.purpose === 'string';
    const purpose = wizard ? (body.purpose as string).trim() : '';
    if (wizard && !purpose) {
      return c.json({ error: 'purpose must be a non-empty sentence' }, 400);
    }
    if (wizard && body.personality !== undefined && !isPersonality(body.personality)) {
      return c.json(
        { error: 'personality must be { warmth, boldness, rigor, playfulness } numbers in 0..1' },
        400
      );
    }
    if (body.token !== undefined && body.token !== null && typeof body.token !== 'string') {
      return c.json({ error: 'token must be a string or null' }, 400);
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
      // `null` is the explicit "headless on purpose" value (BotConfigSchema
      // normalises it to '' too); the wizard sends it when no channel is chosen.
      token: body.token ?? '',
      enabled: body.enabled ?? false,
      skills,
      // Required on BotConfig (Zod `.default()`); previously omitted here, so a
      // freshly created agent had them undefined in memory until the next config
      // reload filled the same defaults in.
      disabledSkills: body.disabledSkills ?? [],
      plan: body.plan ?? 'free',
      allowedUsers: body.allowedUsers,
      mentionPatterns: body.mentionPatterns,
      model: body.model || undefined,
      llmBackend: body.llmBackend || undefined,
      soulDir: body.soulDir,
      disabledTools: body.disabledTools,
      conversation: body.conversation,
      ...(body.agentLoop ? { agentLoop: body.agentLoop } : {}),
      ...(body.preset ? { preset: body.preset } : {}),
      ...(body.whatsapp?.phoneNumberId && body.whatsapp.accessToken
        ? { whatsapp: body.whatsapp }
        : {}),
      ...(body.discord?.token ? { discord: body.discord } : {}),
      ...(tenantId ? { tenantId } : {}),
    };

    if (!wizard) {
      deps.config.bots.push(newBot);
      persistBots(deps.configPath, deps.config.bots);
      return c.json({ ...newBot, token: maskToken(newBot.token) }, 201);
    }

    // ── Wizard path ──
    const soulDir = soulDirFor(newBot);
    if (WIZARD_SOUL_FILES.some((f) => existsSync(join(soulDir, f)))) {
      return c.json(
        {
          error: `A soul already exists at ${soulDir}; pick another id or remove it first`,
          code: 'soul_exists',
        },
        409
      );
    }

    const preset = body.preset ? getPreset(body.preset) : undefined;
    const traits: Partial<TraitSet> =
      body.traits && typeof body.traits === 'object'
        ? body.traits
        : personalityToTraits(body.personality ?? {});
    const input: SoulGenerationInput = {
      name: newBot.name,
      role: purpose,
      personalityDescription: describePersonality(body.personality ?? {}, body.quirks),
      language: body.language,
      emoji: body.emoji || undefined,
    };

    let soul: GeneratedSoul;
    try {
      soul = await soulGenerator(input, {
        soulDir: deps.config.soul.dir,
        claudeModel: deps.config.claudeCli?.model,
        logger: deps.logger,
        generate: generateFnFor(body.generation),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Soul generation failed';
      deps.logger.error({ botId: newBot.id, error: message }, 'Wizard: soul generation failed');
      return c.json(
        { error: `Soul generation failed: ${message}`, code: 'soul_generation_failed' },
        502
      );
    }

    // Everything below writes to disk; on any failure remove exactly what we
    // created (never a directory that was already there) and register nothing.
    const botDir = dirname(soulDir);
    const traitsBase = traitsBaseDirFor(deps.config);
    const traitsDir = join(traitsBase, newBot.id);
    const existed = {
      soulDir: existsSync(soulDir),
      botDir: existsSync(botDir),
      traitsDir: existsSync(traitsDir),
    };
    const rollback = () => {
      const rm = (p: string) => {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch (err) {
          deps.logger.warn({ err, path: p }, 'Wizard: rollback could not remove path');
        }
      };
      if (!existed.soulDir) rm(soulDir);
      if (!existed.traitsDir) rm(traitsDir);
      if (!existed.botDir) rm(botDir);
    };

    let files: string[];
    let writtenTraits: TraitSet;
    try {
      files = writeWizardSoul(
        soulDir,
        soul,
        preset ? presetGoalsMarkdown(preset, purpose) : initialGoalsMarkdown(purpose)
      );
      writtenTraits = seedTraits(traitsBase, newBot.id, traits, deps.logger, newBot.traits);
      files.push('TRAITS.json');
      deps.config.bots.push(newBot);
      try {
        persistBots(deps.configPath, deps.config.bots);
      } catch (err) {
        deps.config.bots.splice(deps.config.bots.indexOf(newBot), 1);
        throw err;
      }
    } catch (err: unknown) {
      rollback();
      const message = err instanceof Error ? err.message : 'Failed to write the soul';
      deps.logger.error({ botId: newBot.id, error: message, soulDir }, 'Wizard: soul write failed');
      return c.json(
        { error: `Could not write the soul: ${message}`, code: 'soul_write_failed' },
        500
      );
    }

    deps.logger.info(
      {
        botId: newBot.id,
        soulDir,
        files,
        traits: writtenTraits,
        headless: newBot.token === '',
        preset: preset?.id,
      },
      'Agent created via wizard'
    );
    return c.json(
      {
        agent: {
          ...newBot,
          token: maskToken(newBot.token),
          running: deps.botManager.isRunning(newBot.id),
        },
        soul: { generated: true, files, soulDir, ...(preset ? { preset: preset.id } : {}) },
      },
      201
    );
  });

  /**
   * Bulk-update several agents in one call.
   *
   * Registered BEFORE `/:id` deliberately: Hono matches routes in registration
   * order, so `/:id` would otherwise capture "bulk" as an agent id and answer
   * 404. (An agent literally named "bulk" is therefore unreachable via
   * `PATCH /:id`; it can still be edited through this endpoint.)
   *
   * Unknown ids are reported rather than fatal, so one stale id in a selection
   * does not discard the rest of the operator's edit. The whole set is written
   * once at the end instead of per agent.
   */
  app.patch('/bulk', async (c) => {
    const body = await c.req
      .json<{ ids?: unknown; patch?: Partial<BotConfig> }>()
      .catch(() => null);

    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return c.json({ error: 'ids must be a non-empty array of agent ids' }, 400);
    }

    const patch = body?.patch;
    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      return c.json({ error: 'patch must contain at least one field' }, 400);
    }

    // Validated before anything is mutated, so a bad value cannot leave half the
    // selection updated.
    if (patch.llmBackend !== undefined && patch.llmBackend !== null) {
      const backend = patch.llmBackend as string;
      if (backend !== '' && backend !== 'ollama' && backend !== 'claude-cli') {
        return c.json({ error: "llmBackend must be 'ollama' or 'claude-cli'" }, 400);
      }
    }
    const bulkCuriosityError = validateCuriosityPatch(patch);
    if (bulkCuriosityError) return c.json({ error: bulkCuriosityError }, 400);

    const updated: string[] = [];
    const notFound: string[] = [];
    const agents: unknown[] = [];

    for (const rawId of ids) {
      const id = String(rawId);
      const bot = findBotScoped(c, id);
      if (!bot) {
        notFound.push(id);
        continue;
      }
      applyBotPatch(bot, patch);
      updated.push(bot.id);
      agents.push({
        ...bot,
        token: maskToken(bot.token),
        running: deps.botManager.isRunning(bot.id),
      });
    }

    if (updated.length > 0) {
      persistBots(deps.configPath, deps.config.bots);
      deps.logger.info({ updated, patch }, 'Bulk agent update applied');
    }

    return c.json({ updated, notFound, agents });
  });

  // Update agent
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const bot = findBotScoped(c, id);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);

    const body = await c.req.json<Partial<BotConfig>>();

    const curiosityError = validateCuriosityPatch(body);
    if (curiosityError) return c.json({ error: curiosityError }, 400);

    applyBotPatch(bot, body);

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

  // Start agent.
  //
  // `enabled: false` is now enforced by BotManager.startBot(), so this route
  // must translate that refusal into something actionable rather than a 500.
  // `?enable=true` is the explicit "go live" form: it flips `enabled` (and
  // persists it, so the agent also survives a restart) and then starts. The
  // dashboard uses it behind a button labelled "Enable & Start", so the side
  // effect is stated in the UI rather than applied silently.
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

    const enableRequested = c.req.query('enable') === 'true';
    if (bot.enabled === false) {
      if (!enableRequested) {
        deps.logger.warn({ botId: id }, 'Start refused: agent is disabled');
        return c.json(
          {
            error: `Agent "${id}" is disabled. Enable it first, or call this route with ?enable=true to enable and start it in one step.`,
            code: 'agent_disabled',
          },
          409
        );
      }
      bot.enabled = true;
      persistBots(deps.configPath, deps.config.bots);
      deps.logger.info({ botId: id }, 'Agent enabled via start?enable=true');
    }

    try {
      await deps.botManager.startBot(bot);
      deps.logger.info({ botId: id }, 'Agent started via API');
      return c.json({ ok: true, running: true, enabled: bot.enabled });
    } catch (err: unknown) {
      // A BotDisabledError here means the config changed underneath us between
      // the check above and the call; report it the same way rather than as 500.
      if (err instanceof BotDisabledError) {
        deps.logger.warn({ botId: id }, 'Start refused: agent is disabled');
        return c.json({ error: err.message, code: err.code }, 409);
      }
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

  // Get LLM query log for an agent
  app.get('/:id/llm-log', (c) => {
    const bot = findBotScoped(c, c.req.param('id'));
    if (!bot) return c.json({ error: 'Agent not found' }, 404);

    const llmQueryLog = deps.botManager.getLlmQueryLog();
    const date = c.req.query('date') || new Date().toISOString().slice(0, 10);
    const entries = llmQueryLog.getEntries(bot.id, date);
    const availableDates = llmQueryLog.getAvailableDates(bot.id);
    return c.json({ date, entries, availableDates });
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

/**
 * Apply a partial agent update in place.
 *
 * Shared by `PATCH /:id` and `PATCH /bulk` so the two cannot drift: a field
 * handled by one but not the other is the kind of gap nobody notices until an
 * operator finds a bulk edit silently dropping half their change.
 *
 * Per-agent override fields treat an empty value as "clear the override and
 * fall back to the global default", which is why they test `in body` rather
 * than `!== undefined`.
 */
/**
 * `agentLoop.curiosity` is validated before it is merged: an out-of-range value
 * would make bots.json fail schema validation on the next boot. `null` (clear
 * the override) is always accepted. Returns an error message or null.
 */
export function validateCuriosityPatch(body: Partial<BotConfig>): string | null {
  const al = body?.agentLoop as Record<string, unknown> | null | undefined;
  if (!al || typeof al !== 'object' || !('curiosity' in al)) return null;
  const cur = al.curiosity;
  if (cur === null || cur === undefined) return null;
  const parsed = CuriosityConfigSchema.safeParse(cur);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const where = issue?.path?.length ? `.${issue.path.join('.')}` : '';
  return `Invalid agentLoop.curiosity${where}: ${issue?.message ?? 'invalid value'}`;
}

export function applyBotPatch(bot: BotConfig, body: Partial<BotConfig>): void {
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
    if (al && Object.values(al).some((v: unknown) => v !== undefined && v !== null)) {
      // Merge, but treat null values as "delete this key" (undefined is lost in JSON serialization)
      const merged = { ...bot.agentLoop, ...al } as Record<string, unknown>;
      for (const k of Object.keys(merged)) {
        if (merged[k] === null) delete merged[k];
      }
      bot.agentLoop = merged as typeof bot.agentLoop;
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
  if ('toolPermissions' in body) {
    const tp = body.toolPermissions;
    bot.toolPermissions = tp && Object.keys(tp).length > 0 ? tp : undefined;
  }
}

function maskToken(token: string): string {
  if (!token || token.startsWith('${')) return token;
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}
