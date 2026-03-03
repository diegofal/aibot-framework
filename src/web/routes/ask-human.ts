import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { ConversationsService } from '../../conversations/service';
import type { Logger } from '../../logger';
import { getTenantId, scopeBots } from '../../tenant/tenant-scoping';

export function askHumanRoutes(deps: {
  botManager: BotManager;
  logger: Logger;
  conversationsService?: ConversationsService;
  config?: import('../../config').Config;
}) {
  const app = new Hono();

  /** Get allowed bot IDs for the requesting tenant (undefined = all allowed) */
  function getAllowedBotIds(c: import('hono').Context): Set<string> | undefined {
    const tenantId = getTenantId(c);
    if (!tenantId || !deps.config) return undefined;
    return new Set(scopeBots(deps.config.bots, tenantId).map((b) => b.id));
  }

  // List all pending questions
  app.get('/', (c) => {
    let questions = deps.botManager.getAskHumanPending();
    const allowedIds = getAllowedBotIds(c);
    if (allowedIds) {
      questions = questions.filter((q: any) => allowedIds.has(q.botId));
    }

    return c.json({
      questions,
      totalCount: questions.length,
    });
  });

  // Lightweight count for badge polling
  // Counts pending inbox conversations across all bots (if conversationsService available),
  // falls back to in-memory pending count.
  app.get('/count', (c) => {
    const allowedIds = getAllowedBotIds(c);
    if (deps.conversationsService) {
      let count = 0;
      for (const botId of deps.conversationsService.getBotIds()) {
        if (allowedIds && !allowedIds.has(botId)) continue;
        count += deps.conversationsService.countByInboxStatus(botId, 'pending');
      }
      return c.json({ count });
    }
    if (allowedIds) {
      const questions = deps.botManager.getAskHumanPending();
      const count = questions.filter((q: any) => allowedIds.has(q.botId)).length;
      return c.json({ count });
    }
    const questionCount = deps.botManager.getAskHumanCount();
    return c.json({ count: questionCount });
  });

  // Dismiss a pending question
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const ok = deps.botManager.dismissAskHuman(id);
    if (!ok) {
      return c.json({ error: 'Question not found or already expired' }, 404);
    }
    deps.logger.info({ questionId: id }, 'Ask-human question dismissed via web');
    return c.json({ ok: true });
  });

  // Answer a pending question
  app.post('/:id/answer', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ answer?: string }>();

    if (!body.answer || typeof body.answer !== 'string') {
      return c.json({ error: 'Missing "answer" string in body' }, 400);
    }

    const ok = deps.botManager.answerAskHuman(id, body.answer);
    if (!ok) {
      return c.json({ error: 'Question not found or already expired' }, 404);
    }

    deps.logger.info({ questionId: id }, 'Ask-human question answered via web');
    return c.json({ ok: true });
  });

  return app;
}
