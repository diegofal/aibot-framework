import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Logger } from '../../logger';

export function askHumanRoutes(deps: {
  botManager: BotManager;
  logger: Logger;
}) {
  const app = new Hono();

  // List all pending questions
  app.get('/', (c) => {
    const questions = deps.botManager.getAskHumanPending();

    return c.json({
      questions,
      totalCount: questions.length,
    });
  });

  // Lightweight count for badge polling
  app.get('/count', (c) => {
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
