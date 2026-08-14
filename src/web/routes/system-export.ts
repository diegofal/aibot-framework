/**
 * Whole-system export/import endpoints.
 *
 * SECURITY: in single-tenant mode the dashboard and `/api/*` have no
 * authentication at all, and these routes mount unconditionally alongside the
 * per-agent ones. `GET /api/system/export` returns every soul, every session
 * transcript and the whole configuration in one request — a far more valuable
 * target than a single agent's archive. Bind the web server to `127.0.0.1`
 * (the default) or put it behind an authenticating reverse proxy. Never expose
 * it to the internet.
 *
 * Set `AIBOT_SYSTEM_EXPORT_REQUIRE_ADMIN_KEY=true` to require `ADMIN_API_KEY`
 * on these two routes specifically. It is opt-in rather than automatic so that
 * setting `ADMIN_API_KEY` (needed by `/api/admin/*`) does not silently break
 * the local no-auth dashboard workflow.
 */

import { type Context, Hono } from 'hono';
import type { BotManager } from '../../bot';
import { ConflictError } from '../../bot/bot-export-service';
import type { Config } from '../../config';
import { safeCompare } from '../../crypto-utils';
import type { Logger } from '../../logger';
import type { MemoryManager } from '../../memory/manager';
import { SystemExportService } from '../../system/system-export-service';
import { SystemImportService, VersionMismatchError } from '../../system/system-import-service';
import { parseSections } from '../../system/types';
import { getTenantId, isAdminOrSingleTenant } from '../../tenant/tenant-scoping';

export interface SystemExportRouteDeps {
  config: Config;
  configPath: string;
  botManager: BotManager;
  logger: Logger;
  memoryManager?: MemoryManager;
  rootDir?: string;
}

function isTruthy(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

/** Comma-separated query parameter -> trimmed list. */
function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function systemExportRoutes(deps: SystemExportRouteDeps) {
  const app = new Hono();

  const requireAdminKey = () => isTruthy(process.env.AIBOT_SYSTEM_EXPORT_REQUIRE_ADMIN_KEY);

  /**
   * Returns an error response when the caller may not use system-level
   * export/import, or null when it may proceed.
   */
  const denyReason = (c: Context) => {
    if (!isAdminOrSingleTenant(getTenantId(c))) {
      return c.json({ error: 'Forbidden: system export is admin-only' }, 403);
    }
    if (!requireAdminKey()) return null;

    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) {
      deps.logger.error(
        'AIBOT_SYSTEM_EXPORT_REQUIRE_ADMIN_KEY is set but ADMIN_API_KEY is not — system export is locked'
      );
      return c.json({ error: 'System export requires ADMIN_API_KEY to be configured' }, 503);
    }

    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const header = c.req.header('x-admin-key');
    if (safeCompare(bearer, adminKey) || safeCompare(header, adminKey)) return null;
    if (getTenantId(c) === '__admin__') return null; // authenticated admin session

    return c.json({ error: 'Unauthorized: admin key required for system export' }, 401);
  };

  const exportService = () =>
    new SystemExportService({
      config: deps.config,
      configPath: deps.configPath,
      logger: deps.logger,
      rootDir: deps.rootDir,
      botExportService: undefined,
    });

  // GET /api/system/export — download the whole-instance bundle
  app.get('/export', async (c) => {
    const denied = denyReason(c);
    if (denied) return denied;

    try {
      const { buffer, manifest } = await exportService().export({
        sections: parseSections(c.req.query('sections')),
        agentIds: csv(c.req.query('agents')),
        productions: isTruthy(c.req.query('productions')),
        conversations: isTruthy(c.req.query('conversations')),
        karma: isTruthy(c.req.query('karma')),
      });

      const date = new Date().toISOString().slice(0, 10);
      const filename = `aibot-system-export-${date}.tar.gz`;

      return new Response(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(buffer.length),
          'X-Export-Sections': manifest.sections.join(','),
          'X-Export-Agents': String(manifest.inventory.agents.length),
        },
      });
    } catch (err: unknown) {
      deps.logger.error({ err }, 'System export failed');
      return c.json({ error: err instanceof Error ? err.message : 'System export failed' }, 500);
    }
  });

  // GET /api/system/export/manifest — inspect what an export would contain
  app.get('/export/manifest', async (c) => {
    const denied = denyReason(c);
    if (denied) return denied;

    try {
      const { manifest } = await exportService().export({
        sections: parseSections(c.req.query('sections')),
        agentIds: csv(c.req.query('agents')),
      });
      return c.json(manifest);
    } catch (err: unknown) {
      deps.logger.error({ err }, 'System export manifest failed');
      return c.json({ error: err instanceof Error ? err.message : 'Failed' }, 500);
    }
  });

  // POST /api/system/import — restore a bundle
  app.post('/import', async (c) => {
    const denied = denyReason(c);
    if (denied) return denied;

    try {
      const contentType = c.req.header('content-type') ?? '';
      let buffer: Buffer;

      if (contentType.includes('multipart/form-data')) {
        const formData = await c.req.formData();
        const file = formData.get('file');
        if (!file || !(file instanceof File)) {
          return c.json(
            { error: 'No file uploaded. Send as multipart with field name "file".' },
            400
          );
        }
        buffer = Buffer.from(await file.arrayBuffer());
      } else if (
        contentType.includes('application/gzip') ||
        contentType.includes('application/octet-stream')
      ) {
        buffer = Buffer.from(await c.req.arrayBuffer());
      } else {
        return c.json(
          { error: 'Unsupported content type. Use multipart/form-data or application/gzip.' },
          400
        );
      }

      if (buffer.length === 0) return c.json({ error: 'Empty file' }, 400);

      const service = new SystemImportService({
        targetRoot: deps.rootDir ?? process.cwd(),
        configPath: deps.configPath,
        logger: deps.logger,
        config: deps.config,
        isAnyBotRunning: () =>
          deps.config.bots.filter((bot) => deps.botManager.isRunning(bot.id)).map((bot) => bot.id),
        getCoreMemory: deps.memoryManager
          ? () => deps.memoryManager?.getCoreMemory() ?? null
          : undefined,
        onSoulFilesImported: deps.memoryManager
          ? () => deps.memoryManager?.reindex() ?? Promise.resolve()
          : undefined,
      });

      const result = await service.import(buffer, {
        sections: c.req.query('sections') ? parseSections(c.req.query('sections')) : undefined,
        agentIds: csv(c.req.query('agents')),
        overwrite: isTruthy(c.req.query('overwrite')),
        dryRun: isTruthy(c.req.query('dryRun')),
      });

      return c.json(result, 200);
    } catch (err: unknown) {
      if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
      if (err instanceof VersionMismatchError) return c.json({ error: err.message }, 422);
      deps.logger.error({ err }, 'System import failed');
      return c.json({ error: err instanceof Error ? err.message : 'System import failed' }, 500);
    }
  });

  return app;
}
