import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import { type Config, resolveAgentConfig } from '../../config';
import type { SkillRegistry } from '../../core/skill-registry';
import type { Logger } from '../../logger';
import { getTenantId, isBotAccessible } from '../../tenant/tenant-scoping';

export interface SkillCommandsDeps {
  config: Config;
  botManager: BotManager;
  skillRegistry: SkillRegistry;
  logger: Logger;
}

export function skillCommandRoutes(deps: SkillCommandsDeps) {
  const app = new Hono();

  /**
   * GET /:botId/skills — List skills and their commands for a bot
   */
  app.get('/:botId/skills', (c) => {
    const botId = c.req.param('botId');
    const tenantId = getTenantId(c);
    const botConfig = deps.config.bots.find((b) => b.id === botId);

    if (!botConfig || !isBotAccessible(botConfig, tenantId)) {
      return c.json({ error: `Bot not found: ${botId}` }, 404);
    }

    const skills = botConfig.skills
      .map((skillId) => {
        const skill = deps.skillRegistry.get(skillId);
        if (!skill) return null;
        return {
          id: skill.id,
          name: skill.name,
          version: skill.version,
          description: skill.description,
          commands: Object.entries(skill.commands ?? {}).map(([name, cmd]) => ({
            name,
            description: cmd.description,
          })),
        };
      })
      .filter(Boolean);

    return c.json({ botId, skills });
  });

  /**
   * POST /:botId/skills/:skillId/:command — Execute a skill command headlessly
   */
  app.post('/:botId/skills/:skillId/:command', async (c) => {
    const botId = c.req.param('botId');
    const skillId = c.req.param('skillId');
    const command = c.req.param('command');
    const tenantId = getTenantId(c);

    // Tenant scoping
    const botConfig = deps.config.bots.find((b) => b.id === botId);
    if (!botConfig || !isBotAccessible(botConfig, tenantId)) {
      return c.json({ error: `Bot not found: ${botId}` }, 404);
    }

    // Parse optional args from body
    let args: string[] = [];
    try {
      const body = await c.req.json().catch(() => ({}));
      if (Array.isArray(body.args)) {
        args = body.args.map(String);
      }
    } catch {
      // empty body is fine
    }

    const startMs = Date.now();
    try {
      const result = await deps.botManager.executeSkillCommand(botId, skillId, command, args);
      const durationMs = Date.now() - startMs;

      deps.logger.info({ botId, skillId, command, durationMs }, 'Operator skill command executed');

      // Publish to activity stream
      deps.botManager.getActivityStream().publish({
        type: 'agent:phase',
        botId,
        timestamp: Date.now(),
        phase: 'operator:skill-command',
        data: { skillId, command, durationMs },
      });

      return c.json({ ok: true, result, durationMs });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startMs;

      deps.logger.warn(
        { botId, skillId, command, error: message, durationMs },
        'Operator skill command failed'
      );

      // Determine status code from error message
      const is404 =
        message.includes('not found') ||
        message.includes('not running') ||
        message.includes('does not have skill') ||
        message.includes('not initialized');
      const status = is404 ? 404 : 500;

      return c.json({ error: message, durationMs }, status);
    }
  });

  /**
   * GET /:botId/reflections — Reflection journal timeline
   */
  app.get('/:botId/reflections', (c) => {
    const botId = c.req.param('botId');
    const tenantId = getTenantId(c);
    const botConfig = deps.config.bots.find((b) => b.id === botId);

    if (!botConfig || !isBotAccessible(botConfig, tenantId)) {
      return c.json({ error: `Bot not found: ${botId}` }, 404);
    }

    const { soulDir } = resolveAgentConfig(deps.config, botConfig);

    // Parse Last Reflection from MOTIVATIONS.md
    let lastReflection: { date: string; trigger: string; changes: string } | null = null;
    const motivationsPath = join(soulDir, 'MOTIVATIONS.md');
    if (existsSync(motivationsPath)) {
      const motivations = readFileSync(motivationsPath, 'utf-8');
      const dateMatch = motivations.match(/^- date:\s*(.+)$/m);
      const triggerMatch = motivations.match(/^- trigger:\s*(.+)$/m);
      const changesMatch = motivations.match(/^- changes:\s*(.+)$/m);
      if (dateMatch?.[1] && /\d{4}-\d{2}-\d{2}/.test(dateMatch[1])) {
        lastReflection = {
          date: dateMatch[1].trim(),
          trigger: triggerMatch?.[1]?.trim() ?? 'unknown',
          changes: changesMatch?.[1]?.trim() ?? '',
        };
      }
    }

    // Scan memory/ and memory/archive/ for [reflection] entries
    const entries: Array<{
      date: string;
      time: string;
      journal: string;
      hasMotivationsBackup: boolean;
    }> = [];
    const memoryDirs = [join(soulDir, 'memory'), join(soulDir, 'memory', 'archive')];
    const reflectionRegex = /^- \[(\d{2}:\d{2})\] \[reflection\] (.+)$/;

    // Collect MOTIVATIONS backup timestamps for cross-reference
    const versionsDir = join(soulDir, '.versions');
    const motivationsVersions: string[] = [];
    const motivationsBackupDates = new Set<string>();
    if (existsSync(versionsDir)) {
      for (const f of readdirSync(versionsDir)) {
        const m = f.match(/^MOTIVATIONS\.md\.(.+)\.bak$/);
        if (m) {
          motivationsVersions.push(m[1]);
          // Extract date portion (YYYY-MM-DD) from timestamp like 2026-03-19T10-19-41
          const datePart = m[1].substring(0, 10);
          motivationsBackupDates.add(datePart);
        }
      }
    }
    motivationsVersions.sort().reverse();

    for (const dir of memoryDirs) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
        if (!dateMatch) continue;
        const date = dateMatch[1];
        const content = readFileSync(join(dir, file), 'utf-8');
        for (const line of content.split('\n')) {
          const m = line.match(reflectionRegex);
          if (m) {
            entries.push({
              date,
              time: m[1],
              journal: m[2],
              hasMotivationsBackup: motivationsBackupDates.has(date),
            });
          }
        }
      }
    }

    // Sort most recent first
    entries.sort((a, b) => {
      const cmp = b.date.localeCompare(a.date);
      return cmp !== 0 ? cmp : b.time.localeCompare(a.time);
    });

    return c.json({
      botId,
      lastReflection,
      entries: entries.slice(0, 50),
      motivationsVersions,
    });
  });

  /**
   * GET /:botId/reflections/motivations/:version — Content of a specific MOTIVATIONS backup
   */
  app.get('/:botId/reflections/motivations/:version', (c) => {
    const botId = c.req.param('botId');
    const version = c.req.param('version');
    const tenantId = getTenantId(c);
    const botConfig = deps.config.bots.find((b) => b.id === botId);

    if (!botConfig || !isBotAccessible(botConfig, tenantId)) {
      return c.json({ error: `Bot not found: ${botId}` }, 404);
    }

    // Validate version format to prevent path traversal
    if (!/^[\dT-]+$/.test(version)) {
      return c.json({ error: 'Invalid version format' }, 400);
    }

    const { soulDir } = resolveAgentConfig(deps.config, botConfig);
    const filePath = join(soulDir, '.versions', `MOTIVATIONS.md.${version}.bak`);

    if (!existsSync(filePath)) {
      return c.json({ error: `Version not found: ${version}` }, 404);
    }

    const content = readFileSync(filePath, 'utf-8');
    return c.json({ version, content });
  });

  return app;
}
