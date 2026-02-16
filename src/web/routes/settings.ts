import { readFileSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import type { Config } from '../../config';
import type { Logger } from '../../logger';

export function settingsRoutes(deps: {
  config: Config;
  configPath: string;
  logger: Logger;
}) {
  const app = new Hono();

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
    if (body.forumTopicIsolation !== undefined) session.forumTopicIsolation = body.forumTopicIsolation;

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
      if (rlc.contextMessages !== undefined) session.llmRelevanceCheck.contextMessages = rlc.contextMessages;
      if (rlc.broadcastCheck !== undefined) session.llmRelevanceCheck.broadcastCheck = rlc.broadcastCheck;
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
    if (body.internalQueryTimeout !== undefined) collab.internalQueryTimeout = body.internalQueryTimeout;
    if (body.enableTargetTools !== undefined) collab.enableTargetTools = body.enableTargetTools;
    if (body.maxConverseTurns !== undefined) collab.maxConverseTurns = body.maxConverseTurns;
    if (body.sessionTtlMs !== undefined) collab.sessionTtlMs = body.sessionTtlMs;
    if (body.visibleMaxTurns !== undefined) collab.visibleMaxTurns = body.visibleMaxTurns;

    persistCollaboration(deps.configPath, collab);
    deps.logger.info('Collaboration settings updated via API');

    return c.json(collab);
  });

  return app;
}

function persistSession(configPath: string, session: Config['session']): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  raw.session = session;
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}

function persistCollaboration(configPath: string, collaboration: Config['collaboration']): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  raw.collaboration = collaboration;
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}
