import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';
import { discoverProductionSkillPaths } from '../../core/external-skill-loader';
import type { SkillRegistry } from '../../core/skill-registry';
import type { Logger } from '../../logger';
import { generateSkill } from '../../skill-generator';

export interface SkillsRouteDeps {
  skillRegistry: SkillRegistry;
  config: Config;
  configPath: string;
  botManager: BotManager;
  logger: Logger;
}

/**
 * Get all valid skills folder paths: configured + auto-discovered production paths.
 */
export function getValidSkillsPaths(config: Config): string[] {
  const paths = [...(config.skillsFolders?.paths ?? [])];
  const productionEntries = discoverProductionSkillPaths(
    config.productions?.baseDir ?? './productions'
  );
  for (const entry of productionEntries) {
    paths.push(entry.path);
  }
  return paths;
}

/**
 * Check that a target directory is within one of the valid skills folder paths.
 */
function isInsideSkillsFolders(dir: string, config: Config): boolean {
  const resolved = resolve(dir);
  const paths = getValidSkillsPaths(config);
  return paths.some((p) => resolved.startsWith(resolve(p)));
}

export function skillsRoutes(deps: SkillsRouteDeps) {
  const app = new Hono();

  // GET / — List all skills (all built-in with enabled/disabled + external merged)
  app.get('/', async (c) => {
    const enabledIds = deps.skillRegistry.getEnabledIds();
    const allAvailable = await deps.skillRegistry.listAvailable();

    const builtIn = allAvailable.map(({ id, manifest }) => {
      const loaded = deps.skillRegistry.get(id);
      const enabled = enabledIds.has(id);
      const ctx = enabled ? deps.skillRegistry.getContext(id) : undefined;
      const cfg = (ctx?.config ?? {}) as Record<string, unknown>;

      return {
        id,
        name: loaded?.name ?? manifest?.name ?? id,
        type: 'builtin' as const,
        version: loaded?.version ?? manifest?.version ?? undefined,
        description: loaded?.description ?? manifest?.description ?? undefined,
        author: manifest?.author ?? undefined,
        enabled,
        commands: loaded?.commands ? Object.keys(loaded.commands) : [],
        jobs: loaded?.jobs?.map((j) => ({ id: j.id, schedule: j.schedule })) ?? [],
        hasOnMessage: loaded ? !!loaded.onMessage : false,
        llmBackend: enabled ? (cfg.llmBackend as string) || 'ollama' : undefined,
      };
    });

    const builtInIds = new Set(builtIn.map((s) => s.id));
    const seenExternalIds = new Set<string>();
    const external = deps.botManager
      .getExternalSkills()
      .filter((s) => {
        if (builtInIds.has(s.manifest.id)) return false;
        if (seenExternalIds.has(s.manifest.id)) return false;
        seenExternalIds.add(s.manifest.id);
        return true;
      })
      .map((s) => ({
        id: s.manifest.id,
        name: s.manifest.name,
        type: 'external' as const,
        version: s.manifest.version,
        description: s.manifest.description,
        author: undefined as string | undefined,
        toolCount: s.manifest.tools.length,
        warnings: s.warnings,
        dir: s.dir,
        requires: s.manifest.requires,
        botName: s.botName,
      }));

    return c.json([...builtIn, ...external]);
  });

  // GET /:id — Detail for a single skill
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const enabledIds = deps.skillRegistry.getEnabledIds();

    // Check built-in first (loaded or available via manifest)
    const builtInSkill = deps.skillRegistry.get(id);
    if (builtInSkill) {
      const ctx = deps.skillRegistry.getContext(id);
      const cfg = (ctx?.config ?? {}) as Record<string, unknown>;
      return c.json({
        id: builtInSkill.id,
        name: builtInSkill.name,
        type: 'builtin',
        version: builtInSkill.version,
        description: builtInSkill.description,
        enabled: enabledIds.has(id),
        commands: builtInSkill.commands ? Object.keys(builtInSkill.commands) : [],
        jobs: builtInSkill.jobs?.map((j) => ({ id: j.id, schedule: j.schedule })) ?? [],
        hasOnMessage: !!builtInSkill.onMessage,
        llmBackend: (cfg.llmBackend as string) || 'ollama',
      });
    }

    // Check if it's a known but unloaded built-in
    const allAvailable = await deps.skillRegistry.listAvailable();
    const availableEntry = allAvailable.find((a) => a.id === id);
    if (availableEntry) {
      const manifest = availableEntry.manifest;
      return c.json({
        id,
        name: manifest?.name ?? id,
        type: 'builtin',
        version: manifest?.version,
        description: manifest?.description,
        enabled: false,
        commands: [],
        jobs: [],
        hasOnMessage: false,
      });
    }

    // Check external
    const extSkill = deps.botManager.getExternalSkills().find((s) => s.manifest.id === id);
    if (extSkill) {
      return c.json({
        id: extSkill.manifest.id,
        name: extSkill.manifest.name,
        type: 'external',
        version: extSkill.manifest.version,
        description: extSkill.manifest.description,
        tools: extSkill.manifest.tools,
        warnings: extSkill.warnings,
        dir: extSkill.dir,
        requires: extSkill.manifest.requires,
        config: extSkill.manifest.config,
        botName: extSkill.botName,
      });
    }

    return c.json({ error: 'Skill not found' }, 404);
  });

  // GET /:id/source — Handler source code (external only)
  app.get('/:id/source', (c) => {
    const id = c.req.param('id');

    const extSkill = deps.botManager.getExternalSkills().find((s) => s.manifest.id === id);
    if (!extSkill) {
      return c.json({ error: 'External skill not found' }, 404);
    }

    const handlerPath = join(extSkill.dir, 'index.ts');
    try {
      const source = readFileSync(handlerPath, 'utf-8');
      return c.json({ source });
    } catch {
      return c.json({ error: 'Handler file not found' }, 404);
    }
  });

  // POST / — Create a new external skill
  app.post('/', async (c) => {
    const body = await c.req.json<{
      id: string;
      targetFolder: string;
      skillJson: Record<string, unknown>;
      handlerCode: string;
    }>();

    if (!body.id || !body.targetFolder || !body.skillJson || !body.handlerCode) {
      return c.json(
        { error: 'Missing required fields: id, targetFolder, skillJson, handlerCode' },
        400
      );
    }

    if (!isInsideSkillsFolders(body.targetFolder, deps.config)) {
      return c.json({ error: 'Target folder is not in configured skillsFolders paths' }, 403);
    }

    const skillDir = join(resolve(body.targetFolder), body.id);
    if (existsSync(skillDir)) {
      return c.json({ error: `Skill directory already exists: ${skillDir}` }, 409);
    }

    try {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'skill.json'),
        `${JSON.stringify(body.skillJson, null, 2)}\n`,
        'utf-8'
      );
      writeFileSync(join(skillDir, 'index.ts'), body.handlerCode, 'utf-8');
      deps.logger.info({ id: body.id, dir: skillDir }, 'External skill created via API');
      return c.json({ ok: true, dir: skillDir });
    } catch (err) {
      deps.logger.error({ err, id: body.id }, 'Failed to create external skill');
      return c.json({ error: `Failed to create skill: ${err}` }, 500);
    }
  });

  // POST /generate — AI-generate a skill (preview only, no write)
  app.post('/generate', async (c) => {
    const body = await c.req.json<{
      id: string;
      name: string;
      description: string;
      purpose: string;
    }>();

    if (!body.id || !body.name || !body.description || !body.purpose) {
      return c.json({ error: 'Missing required fields: id, name, description, purpose' }, 400);
    }

    try {
      const result = await generateSkill(
        { id: body.id, name: body.name, description: body.description, purpose: body.purpose },
        {
          claudePath: deps.config.improve?.claudePath,
          claudeModel: deps.config.claudeCli?.model,
          timeout: deps.config.improve?.timeout,
          skillsFolderPaths: deps.config.skillsFolders?.paths ?? [],
          logger: deps.logger,
        }
      );
      return c.json(result);
    } catch (err) {
      deps.logger.error({ err }, 'Skill generation failed');
      return c.json({ error: `Generation failed: ${err}` }, 500);
    }
  });

  // POST /generate/apply — Apply a generated skill to disk
  app.post('/generate/apply', async (c) => {
    const body = await c.req.json<{
      id: string;
      targetFolder: string;
      skillJson: Record<string, unknown>;
      handlerCode: string;
    }>();

    if (!body.id || !body.targetFolder || !body.skillJson || !body.handlerCode) {
      return c.json(
        { error: 'Missing required fields: id, targetFolder, skillJson, handlerCode' },
        400
      );
    }

    if (!isInsideSkillsFolders(body.targetFolder, deps.config)) {
      return c.json({ error: 'Target folder is not in configured skillsFolders paths' }, 403);
    }

    const skillDir = join(resolve(body.targetFolder), body.id);

    try {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'skill.json'),
        `${JSON.stringify(body.skillJson, null, 2)}\n`,
        'utf-8'
      );
      writeFileSync(join(skillDir, 'index.ts'), body.handlerCode, 'utf-8');
      deps.logger.info({ id: body.id, dir: skillDir }, 'Generated skill applied to disk');
      return c.json({ ok: true, dir: skillDir });
    } catch (err) {
      deps.logger.error({ err, id: body.id }, 'Failed to apply generated skill');
      return c.json({ error: `Failed to apply skill: ${err}` }, 500);
    }
  });

  // PUT /:id — Update an external skill
  app.put('/:id', async (c) => {
    const id = c.req.param('id');

    // Reject built-in
    const builtIn = deps.skillRegistry.getAll().find((s) => s.id === id);
    if (builtIn) {
      return c.json({ error: 'Cannot update built-in skills' }, 403);
    }

    const extSkill = deps.botManager.getExternalSkills().find((s) => s.manifest.id === id);
    if (!extSkill) {
      return c.json({ error: 'External skill not found' }, 404);
    }

    if (!isInsideSkillsFolders(extSkill.dir, deps.config)) {
      return c.json({ error: 'Skill directory is not in configured skillsFolders paths' }, 403);
    }

    const body = await c.req.json<{
      skillJson?: Record<string, unknown>;
      handlerCode?: string;
    }>();

    try {
      if (body.skillJson) {
        writeFileSync(
          join(extSkill.dir, 'skill.json'),
          `${JSON.stringify(body.skillJson, null, 2)}\n`,
          'utf-8'
        );
      }
      if (body.handlerCode) {
        writeFileSync(join(extSkill.dir, 'index.ts'), body.handlerCode, 'utf-8');
      }
      deps.logger.info({ id, dir: extSkill.dir }, 'External skill updated via API');
      return c.json({ ok: true });
    } catch (err) {
      deps.logger.error({ err, id }, 'Failed to update external skill');
      return c.json({ error: `Failed to update skill: ${err}` }, 500);
    }
  });

  // DELETE /:id — Delete an external skill
  app.delete('/:id', (c) => {
    const id = c.req.param('id');

    // Reject built-in
    const builtIn = deps.skillRegistry.getAll().find((s) => s.id === id);
    if (builtIn) {
      return c.json({ error: 'Cannot delete built-in skills' }, 403);
    }

    const extSkill = deps.botManager.getExternalSkills().find((s) => s.manifest.id === id);
    if (!extSkill) {
      return c.json({ error: 'External skill not found' }, 404);
    }

    if (!isInsideSkillsFolders(extSkill.dir, deps.config)) {
      return c.json({ error: 'Skill directory is not in configured skillsFolders paths' }, 403);
    }

    try {
      rmSync(extSkill.dir, { recursive: true });
      deps.logger.info({ id, dir: extSkill.dir }, 'External skill deleted via API');
      return c.json({ ok: true });
    } catch (err) {
      deps.logger.error({ err, id }, 'Failed to delete external skill');
      return c.json({ error: `Failed to delete skill: ${err}` }, 500);
    }
  });

  return app;
}
