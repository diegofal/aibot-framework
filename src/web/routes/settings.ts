import { readFileSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config, McpServerEntry } from '../../config';
import { discoverProductionSkillPaths } from '../../core/external-skill-loader';
import type { Logger } from '../../logger';
import type { McpServerConfig } from '../../mcp/client';
import { getTenantId, isAdminOrSingleTenant } from '../../tenant/tenant-scoping';

export function settingsRoutes(deps: {
  config: Config;
  configPath: string;
  logger: Logger;
  botManager?: BotManager;
}) {
  const app = new Hono();

  // Admin-only gate: settings are global config, not per-tenant
  app.use('*', async (c, next) => {
    const tenantId = getTenantId(c);
    if (!isAdminOrSingleTenant(tenantId)) {
      return c.json({ error: 'Admin access required' }, 403);
    }
    return next();
  });

  // Get session settings
  app.get('/session', (c) => {
    return c.json(deps.config.session);
  });

  // Update session settings
  app.patch('/session', async (c) => {
    const body = await c.req.json();

    const session = deps.config.session;

    // Top-level session fields
    if (body.groupActivation !== undefined) session.groupActivation = body.groupActivation;
    if (body.replyWindow !== undefined) session.replyWindow = body.replyWindow;
    if (body.forumTopicIsolation !== undefined)
      session.forumTopicIsolation = body.forumTopicIsolation;

    // Reset policy
    if (body.resetPolicy) {
      if (body.resetPolicy.daily) {
        if (body.resetPolicy.daily.enabled !== undefined)
          session.resetPolicy.daily.enabled = body.resetPolicy.daily.enabled;
        if (body.resetPolicy.daily.hour !== undefined)
          session.resetPolicy.daily.hour = body.resetPolicy.daily.hour;
      }
      if (body.resetPolicy.idle) {
        if (body.resetPolicy.idle.enabled !== undefined)
          session.resetPolicy.idle.enabled = body.resetPolicy.idle.enabled;
        if (body.resetPolicy.idle.minutes !== undefined)
          session.resetPolicy.idle.minutes = body.resetPolicy.idle.minutes;
      }
    }

    // LLM relevance check
    if (body.llmRelevanceCheck) {
      const rlc = body.llmRelevanceCheck;
      if (rlc.enabled !== undefined) session.llmRelevanceCheck.enabled = rlc.enabled;
      if (rlc.temperature !== undefined) session.llmRelevanceCheck.temperature = rlc.temperature;
      if (rlc.timeout !== undefined) session.llmRelevanceCheck.timeout = rlc.timeout;
      if (rlc.contextMessages !== undefined)
        session.llmRelevanceCheck.contextMessages = rlc.contextMessages;
      if (rlc.broadcastCheck !== undefined)
        session.llmRelevanceCheck.broadcastCheck = rlc.broadcastCheck;
    }

    persistSession(deps.configPath, session);
    deps.logger.info('Session settings updated via API');

    return c.json(session);
  });

  // Get collaboration settings
  app.get('/collaboration', (c) => {
    return c.json(deps.config.collaboration);
  });

  // Update collaboration settings
  app.patch('/collaboration', async (c) => {
    const body = await c.req.json();

    const collab = deps.config.collaboration;

    if (body.enabled !== undefined) collab.enabled = body.enabled;
    if (body.maxRounds !== undefined) collab.maxRounds = body.maxRounds;
    if (body.cooldownMs !== undefined) collab.cooldownMs = body.cooldownMs;
    if (body.internalQueryTimeout !== undefined)
      collab.internalQueryTimeout = body.internalQueryTimeout;
    if (body.enableTargetTools !== undefined) collab.enableTargetTools = body.enableTargetTools;
    if (body.maxConverseTurns !== undefined) collab.maxConverseTurns = body.maxConverseTurns;
    if (body.sessionTtlMs !== undefined) collab.sessionTtlMs = body.sessionTtlMs;
    if (body.visibleMaxTurns !== undefined) collab.visibleMaxTurns = body.visibleMaxTurns;

    persistCollaboration(deps.configPath, collab);
    deps.logger.info('Collaboration settings updated via API');

    return c.json(collab);
  });

  // Get skills folders (configured + auto-discovered production paths)
  app.get('/skills-folders', (c) => {
    const configuredPaths = deps.config.skillsFolders?.paths ?? [];
    const productionEntries = discoverProductionSkillPaths(
      deps.config.productions?.baseDir ?? './productions'
    );
    const productionPaths = productionEntries.map((e) => e.path);

    // Merge and deduplicate
    const allPaths = [...new Set([...configuredPaths, ...productionPaths])];

    return c.json({
      paths: allPaths,
      configuredPaths,
      productionPaths,
      defaultPath: deps.config.paths.skills,
    });
  });

  // Update skills folders
  app.patch('/skills-folders', async (c) => {
    const body = await c.req.json<{ paths: string[] }>();

    if (!Array.isArray(body.paths)) {
      return c.json({ error: 'paths must be an array of strings' }, 400);
    }

    deps.config.skillsFolders.paths = body.paths.filter((p) => typeof p === 'string' && p.trim());
    persistSkillsFolders(deps.configPath, deps.config.skillsFolders);
    deps.logger.info({ paths: deps.config.skillsFolders.paths }, 'Skills folders updated via API');

    return c.json({
      paths: deps.config.skillsFolders.paths,
      defaultPath: deps.config.paths.skills,
    });
  });

  // Get health check (quality review) settings
  app.get('/health-check', (c) => {
    return c.json(deps.config.soul.healthCheck);
  });

  // Update health check (quality review) settings
  app.patch('/health-check', async (c) => {
    const body = await c.req.json();
    const hc = deps.config.soul.healthCheck;

    if (body.enabled !== undefined) hc.enabled = body.enabled;
    if (body.cooldownMs !== undefined) hc.cooldownMs = body.cooldownMs;
    if (body.consolidateMemory !== undefined) hc.consolidateMemory = body.consolidateMemory;
    if (body.llmBackend !== undefined) hc.llmBackend = body.llmBackend;
    if (body.model !== undefined) hc.model = body.model || undefined;

    persistHealthCheck(deps.configPath, hc);
    deps.logger.info(
      { llmBackend: hc.llmBackend, model: hc.model },
      'Health check settings updated via API'
    );

    return c.json(hc);
  });

  // Get memory search settings (includes MMR)
  app.get('/memory-search', (c) => {
    return c.json(deps.config.soul.search);
  });

  // Update memory search settings
  app.patch('/memory-search', async (c) => {
    const body = await c.req.json();
    const search = deps.config.soul.search;

    // MMR sub-config
    if (body.mmr) {
      if (body.mmr.enabled !== undefined) search.mmr.enabled = body.mmr.enabled;
      if (body.mmr.lambda !== undefined) search.mmr.lambda = body.mmr.lambda;
    }

    // AutoRag sub-config
    if (body.autoRag) {
      if (body.autoRag.enabled !== undefined) search.autoRag.enabled = body.autoRag.enabled;
      if (body.autoRag.maxResults !== undefined)
        search.autoRag.maxResults = body.autoRag.maxResults;
      if (body.autoRag.minScore !== undefined) search.autoRag.minScore = body.autoRag.minScore;
      if (body.autoRag.maxContentChars !== undefined)
        search.autoRag.maxContentChars = body.autoRag.maxContentChars;
    }

    persistMemorySearch(deps.configPath, search);
    deps.logger.info('Memory search settings updated via API');

    return c.json(search);
  });

  // --- MCP Server Management ---

  // GET /mcp — return MCP config + live status
  app.get('/mcp', (c) => {
    const mcpConfig = deps.config.mcp;
    const pool = deps.botManager?.getMcpClientPool();
    return c.json({
      servers: mcpConfig.servers,
      status: pool?.getStatus() ?? [],
      connectedCount: pool?.connectedCount ?? 0,
      totalCount: pool?.size ?? 0,
    });
  });

  // POST /mcp/servers — add a new MCP server
  app.post('/mcp/servers', async (c) => {
    const body = await c.req.json<Partial<McpServerEntry>>();

    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'name is required' }, 400);
    }
    if (!body.transport || !['stdio', 'sse'].includes(body.transport)) {
      return c.json({ error: 'transport must be "stdio" or "sse"' }, 400);
    }
    if (body.transport === 'stdio' && !body.command) {
      return c.json({ error: 'command is required for stdio transport' }, 400);
    }
    if (body.transport === 'sse' && !body.url) {
      return c.json({ error: 'url is required for sse transport' }, 400);
    }

    // Check for duplicate name
    const existing = deps.config.mcp.servers.find((s) => s.name === body.name);
    if (existing) {
      return c.json({ error: `MCP server "${body.name}" already exists` }, 409);
    }

    const entry: McpServerEntry = {
      name: body.name,
      transport: body.transport,
      command: body.command,
      args: body.args,
      env: body.env,
      url: body.url,
      headers: body.headers,
      timeout: body.timeout ?? 30_000,
      autoReconnect: body.autoReconnect ?? true,
      toolPrefix: body.toolPrefix,
      allowedTools: body.allowedTools,
      deniedTools: body.deniedTools,
    };

    deps.config.mcp.servers.push(entry);
    persistMcp(deps.configPath, deps.config.mcp);

    // Live connect if botManager available
    const pool = deps.botManager?.getMcpClientPool();
    if (pool) {
      const serverConfig: McpServerConfig = {
        name: entry.name,
        transport: entry.transport,
        command: entry.command,
        args: entry.args,
        env: entry.env,
        url: entry.url,
        headers: entry.headers,
        timeout: entry.timeout,
        autoReconnect: entry.autoReconnect,
        toolPrefix: entry.toolPrefix,
        allowedTools: entry.allowedTools,
        deniedTools: entry.deniedTools,
      };
      try {
        const client = pool.addServer(serverConfig);
        await client.connect();
        deps.botManager?.getToolRegistry().registerMcpTools();
        deps.logger.info({ name: entry.name }, 'MCP server added and connected via Settings UI');
      } catch (err) {
        deps.logger.warn({ name: entry.name, err }, 'MCP server added but connect failed');
      }
    }

    return c.json({ ok: true, server: entry }, 201);
  });

  // DELETE /mcp/servers/:name — remove an MCP server
  app.delete('/mcp/servers/:name', async (c) => {
    const name = c.req.param('name');
    const idx = deps.config.mcp.servers.findIndex((s) => s.name === name);
    if (idx === -1) {
      return c.json({ error: `MCP server "${name}" not found` }, 404);
    }

    deps.config.mcp.servers.splice(idx, 1);
    persistMcp(deps.configPath, deps.config.mcp);

    // Live disconnect
    const pool = deps.botManager?.getMcpClientPool();
    if (pool) {
      await pool.removeServer(name);
      deps.botManager?.getToolRegistry().registerMcpTools();
      deps.logger.info({ name }, 'MCP server removed via Settings UI');
    }

    return c.json({ ok: true });
  });

  // --- Claude CLI Settings ---

  app.get('/claude-cli', (c) => {
    return c.json(deps.config.claudeCli);
  });

  app.patch('/claude-cli', async (c) => {
    const body = await c.req.json();
    const cli = deps.config.claudeCli;

    if (body.model !== undefined) {
      cli.model = body.model || undefined;
    }

    persistClaudeCli(deps.configPath, cli);
    deps.logger.info({ model: cli.model }, 'Claude CLI settings updated via API');

    return c.json(cli);
  });

  return app;
}

function persistMcp(configPath: string, mcp: Config['mcp']): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  raw.mcp = mcp;
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

function persistSession(configPath: string, session: Config['session']): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  raw.session = session;
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

function persistCollaboration(configPath: string, collaboration: Config['collaboration']): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  raw.collaboration = collaboration;
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

function persistSkillsFolders(configPath: string, skillsFolders: Config['skillsFolders']): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  raw.skillsFolders = skillsFolders;
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

function persistMemorySearch(configPath: string, search: Config['soul']['search']): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  if (!raw.soul) raw.soul = {};
  raw.soul.search = search;
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

function persistHealthCheck(configPath: string, healthCheck: Config['soul']['healthCheck']): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  if (!raw.soul) raw.soul = {};
  raw.soul.healthCheck = healthCheck;
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

function persistClaudeCli(configPath: string, claudeCli: Config['claudeCli']): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  raw.claudeCli = claudeCli;
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}
