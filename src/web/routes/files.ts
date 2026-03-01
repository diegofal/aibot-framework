import { existsSync, lstatSync, readlinkSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../../config';
import { resolveAgentConfig } from '../../config';
import type { Logger } from '../../logger';

/** Sensitive file patterns — ported from src/tools/file.ts BUILTIN_DENIED */
const DENIED_PATTERNS = [
  /\.env($|\.)/,
  /credentials/i,
  /\.key$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /id_rsa/,
  /id_ed25519/,
  /\.ssh\//,
  /shadow$/,
  /\.secret/i,
  /token\.json/i,
];

const MAX_FILE_SIZE = 1_048_576; // 1MB

export function filesRoutes(deps: { config: Config; logger: Logger }) {
  const app = new Hono();
  const { config, logger } = deps;

  // GET /:botId/*path — serve a file from a bot's workDir
  app.get('/:botId/*', async (c) => {
    const botId = c.req.param('botId');
    const botConfig = config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    const agentConfig = resolveAgentConfig(config, botConfig);
    const workDir = resolve(agentConfig.workDir);

    // Extract the file path (everything after /:botId/)
    const url = new URL(c.req.url);
    const prefix = `/api/files/${botId}/`;
    const idx = url.pathname.indexOf(prefix);
    const rawPath = idx >= 0 ? decodeURIComponent(url.pathname.slice(idx + prefix.length)) : '';

    if (!rawPath) {
      return c.json({ error: 'Missing file path' }, 400);
    }

    // Resolve and validate path traversal
    const resolvedPath = resolve(workDir, rawPath);
    const rel = relative(workDir, resolvedPath);
    if (rel.startsWith('..') || resolve(workDir, rel) !== resolvedPath) {
      logger.warn({ botId, path: rawPath }, 'files: path traversal blocked');
      return c.json({ error: 'Path outside allowed directory' }, 403);
    }

    // Check denied patterns
    for (const pattern of DENIED_PATTERNS) {
      if (pattern.test(resolvedPath) || pattern.test(rawPath)) {
        logger.warn(
          { botId, path: rawPath, pattern: String(pattern) },
          'files: denied pattern blocked'
        );
        return c.json({ error: 'Access denied: file matches blocked pattern' }, 403);
      }
    }

    // Check symlink escape
    try {
      const st = lstatSync(resolvedPath);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(resolvedPath);
        const resolvedTarget = resolve(workDir, target);
        const relTarget = relative(workDir, resolvedTarget);
        if (relTarget.startsWith('..')) {
          logger.warn({ botId, path: rawPath }, 'files: symlink escape blocked');
          return c.json({ error: 'Symlink escapes allowed directory' }, 403);
        }
      }
    } catch {
      // File doesn't exist — handle below
    }

    // Check existence
    if (!existsSync(resolvedPath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    // Check it's a regular file
    const stat = statSync(resolvedPath);
    if (!stat.isFile()) {
      return c.json({ error: 'Not a file' }, 400);
    }

    // Check size
    if (stat.size > MAX_FILE_SIZE) {
      return c.json({ error: `File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})` }, 400);
    }

    // Read and return
    try {
      const file = Bun.file(resolvedPath);
      const text = await file.text();
      return c.json({ path: rawPath, content: text, size: stat.size });
    } catch (err) {
      logger.error({ botId, path: rawPath, err }, 'files: read failed');
      return c.json({ error: 'Failed to read file' }, 500);
    }
  });

  return app;
}
