import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import { ConversationsService } from '../../../src/conversations/service';
import type { Logger } from '../../../src/logger';
import { conversationsRoutes } from '../../../src/web/routes/conversations';

const TEST_DIR = join(import.meta.dir, '.tmp-conversations-routes-test');

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const mockConfig = {
  bots: [
    { id: 'bot1', name: 'TestBot' },
    { id: 'bot2', name: 'OtherBot' },
  ],
  improve: {
    claudePath: 'claude',
    timeout: 30_000,
  },
} as unknown as Config;

function makeDeps(overrides?: Record<string, unknown>) {
  const svc = new ConversationsService(TEST_DIR);

  const mockBotManager = {
    getSoulLoader: () => ({
      readIdentity: () => 'I am TestBot',
      readSoul: () => 'Kind soul',
      readMotivations: () => 'Help humans',
      readGoals: () => '- Goal 1',
      appendDailyMemory: mock(() => {}),
    }),
    getLLMClient: () => {
      throw new Error('No LLMClient in test');
    },
    getToolRegistry: () => ({
      getDefinitionsForBot: () => [],
      createExecutor: () => async () => ({ success: true, content: 'ok' }),
    }),
  };

  const mockProductionsService = {
    getStats: () => ({ total: 5, approved: 3, rejected: 1, unreviewed: 1, avgRating: 4 }),
    getChangelog: () => [
      {
        timestamp: '2026-02-20T10:00:00Z',
        action: 'create',
        path: '/output/file.md',
        description: 'Wrote file',
      },
    ],
  };

  return {
    conversationsService: svc,
    botManager: (overrides?.botManager ?? mockBotManager) as any,
    logger: noopLogger,
    config: (overrides?.config ?? mockConfig) as Config,
    productionsService: (overrides?.productionsService ?? mockProductionsService) as any,
  };
}

function makeApp(deps: ReturnType<typeof makeDeps>) {
  const app = new Hono();
  app.route('/api/conversations', conversationsRoutes(deps));
  return app;
}

function tick(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('conversations routes', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe('GET /', () => {
    test('lists all configured bots with conversation counts', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      // Create a conversation for bot1
      deps.conversationsService.createConversation('bot1');

      const res = await app.request('http://localhost/api/conversations');
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.length).toBe(2); // bot1 + bot2
      const bot1 = data.find((b: any) => b.botId === 'bot1');
      expect(bot1).toBeTruthy();
      expect(bot1.conversationCount).toBe(1);
      expect(bot1.name).toBe('TestBot');

      const bot2 = data.find((b: any) => b.botId === 'bot2');
      expect(bot2).toBeTruthy();
      expect(bot2.conversationCount).toBe(0);
    });
  });

  describe('GET /:botId', () => {
    test('lists conversations for a bot', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      deps.conversationsService.createConversation('bot1', 'general', 'Chat 1');
      deps.conversationsService.createConversation('bot1', 'productions', 'Prod Chat');

      const res = await app.request('http://localhost/api/conversations/bot1');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.length).toBe(2);
    });

    test('filters by type', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      deps.conversationsService.createConversation('bot1', 'general', 'Chat 1');
      deps.conversationsService.createConversation('bot1', 'productions', 'Prod Chat');

      const res = await app.request('http://localhost/api/conversations/bot1?type=productions');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.length).toBe(1);
      expect(data[0].type).toBe('productions');
    });

    test('returns empty array for bot with no conversations', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await app.request('http://localhost/api/conversations/bot1');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([]);
    });
  });

  describe('POST /:botId', () => {
    test('creates a general conversation', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await app.request('http://localhost/api/conversations/bot1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeTruthy();
      expect(data.type).toBe('general');
      expect(data.title).toBe('New Conversation');
    });

    test('creates a productions conversation with custom title', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await app.request('http://localhost/api/conversations/bot1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'productions', title: 'About my recent work' }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.type).toBe('productions');
      expect(data.title).toBe('About my recent work');
    });
  });

  describe('GET /:botId/:id', () => {
    test('returns conversation with messages', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const convo = deps.conversationsService.createConversation('bot1');
      deps.conversationsService.addMessage('bot1', convo.id, 'human', 'Hello');

      const res = await app.request(`http://localhost/api/conversations/bot1/${convo.id}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.conversation.id).toBe(convo.id);
      expect(data.messages.length).toBe(1);
      expect(data.messages[0].content).toBe('Hello');
    });

    test('returns 404 for non-existent conversation', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await app.request('http://localhost/api/conversations/bot1/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /:botId/:id', () => {
    test('deletes a conversation', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const convo = deps.conversationsService.createConversation('bot1');

      const res = await app.request(`http://localhost/api/conversations/bot1/${convo.id}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      // Verify it's gone
      const getRes = await app.request(`http://localhost/api/conversations/bot1/${convo.id}`);
      expect(getRes.status).toBe(404);
    });

    test('returns 404 for non-existent', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await app.request('http://localhost/api/conversations/bot1/nonexistent', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /:botId (all for bot)', () => {
    test('deletes all conversations for a bot', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      deps.conversationsService.createConversation('bot1', 'general', 'C1');
      deps.conversationsService.createConversation('bot1', 'general', 'C2');

      const res = await app.request('http://localhost/api/conversations/bot1', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.deleted).toBe(2);

      // Verify they're gone
      const listRes = await app.request('http://localhost/api/conversations/bot1');
      const listData = await listRes.json();
      expect(listData).toEqual([]);
    });

    test('returns 0 deleted for bot with no conversations', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await app.request('http://localhost/api/conversations/bot1', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.deleted).toBe(0);
    });
  });

  describe('DELETE / (all conversations)', () => {
    test('deletes all conversations across all bots', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      deps.conversationsService.createConversation('bot1', 'general', 'C1');
      deps.conversationsService.createConversation('bot1', 'general', 'C2');
      deps.conversationsService.createConversation('bot2', 'general', 'C3');

      const res = await app.request('http://localhost/api/conversations', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.deleted).toBe(3);

      // Verify all gone
      const listRes1 = await app.request('http://localhost/api/conversations/bot1');
      expect(await listRes1.json()).toEqual([]);
      const listRes2 = await app.request('http://localhost/api/conversations/bot2');
      expect(await listRes2.json()).toEqual([]);
    });

    test('returns 0 deleted when no conversations exist', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await app.request('http://localhost/api/conversations', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.deleted).toBe(0);
    });
  });

  describe('POST /:botId/:id/messages', () => {
    test('adds human message and returns it', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      // Mock claudeGenerate to avoid real CLI call
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mock(() => Promise.resolve('Bot reply')),
      }));

      const convo = deps.conversationsService.createConversation('bot1');

      const res = await app.request(
        `http://localhost/api/conversations/bot1/${convo.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Hello bot' }),
        }
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.message.role).toBe('human');
      expect(data.message.content).toBe('Hello bot');
    });

    test('returns 400 for missing message', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const convo = deps.conversationsService.createConversation('bot1');

      const res = await app.request(
        `http://localhost/api/conversations/bot1/${convo.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      expect(res.status).toBe(400);
    });

    test('returns 404 for non-existent conversation', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await app.request(
        'http://localhost/api/conversations/bot1/nonexistent/messages',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Hello' }),
        }
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /:botId (inbox type)', () => {
    test('creates an inbox conversation', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await app.request('http://localhost/api/conversations/bot1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'inbox', title: 'Should I post today?' }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.type).toBe('inbox');
      expect(data.title).toBe('Should I post today?');
    });
  });

  describe('POST /:botId/:id/messages (inbox first-reply resolution)', () => {
    test('resolves ask_human question on first reply and triggers bot reply generation', async () => {
      const deps = makeDeps();

      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mock(() => Promise.resolve('Thanks for the direction!')),
      }));

      // Add answerAskHuman mock to botManager
      let answeredId = '';
      let answeredText = '';
      (deps.botManager as any).answerAskHuman = mock((id: string, answer: string) => {
        answeredId = id;
        answeredText = answer;
        // Simulate what BotManager does: write message + mark status
        deps.conversationsService.addMessage('bot1', convo.id, 'human', answer);
        deps.conversationsService.markInboxStatus('bot1', convo.id, 'answered');
        return true;
      });

      const convo = deps.conversationsService.createConversation(
        'bot1',
        'inbox',
        'What strategy?',
        {
          askHumanQuestionId: 'q-test-123',
          inboxStatus: 'pending',
        }
      );
      deps.conversationsService.addMessage('bot1', convo.id, 'bot', 'What strategy should I use?');

      const app = makeApp(deps);

      const res = await app.request(
        `http://localhost/api/conversations/bot1/${convo.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Go with DeFi' }),
        }
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.inboxResolved).toBe(true);
      expect(answeredId).toBe('q-test-123');
      expect(answeredText).toBe('Go with DeFi');

      // Wait for the fire-and-forget bot reply to complete
      await tick(500);

      // Verify bot reply was generated (original question + follow-up reply)
      const msgs = deps.conversationsService.getMessages('bot1', convo.id);
      const botMsgs = msgs.filter((m) => m.role === 'bot');
      expect(botMsgs.length).toBe(2);
      expect(botMsgs[1].content).toBe('Thanks for the direction!');

      // Status should be back to idle after completion
      const statusRes = await app.request(
        `http://localhost/api/conversations/bot1/${convo.id}/status`
      );
      const statusData = await statusRes.json();
      expect(statusData.status).toBe('idle');
      expect(statusData.lastBotMessage.content).toBe('Thanks for the direction!');
    });

    test('falls through to normal chat for already-answered inbox conversation', async () => {
      const deps = makeDeps();
      (deps.botManager as any).answerAskHuman = mock(() => false);

      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mock(() => Promise.resolve('Bot reply')),
      }));

      const convo = deps.conversationsService.createConversation('bot1', 'inbox', 'Old question', {
        askHumanQuestionId: 'q-old',
        inboxStatus: 'answered',
      });

      const app = makeApp(deps);

      const res = await app.request(
        `http://localhost/api/conversations/bot1/${convo.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Follow up question' }),
        }
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      // Should not be inbox resolved since status is already 'answered'
      expect(data.inboxResolved).toBeUndefined();
      expect(data.message.content).toBe('Follow up question');
    });
  });

  describe('GET /:botId (inbox filter)', () => {
    test('filters inbox conversations', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      deps.conversationsService.createConversation('bot1', 'general', 'Gen');
      deps.conversationsService.createConversation('bot1', 'inbox', 'Q1', {
        inboxStatus: 'pending',
      });
      deps.conversationsService.createConversation('bot1', 'inbox', 'Q2', {
        inboxStatus: 'answered',
      });

      const res = await app.request('http://localhost/api/conversations/bot1?type=inbox');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.length).toBe(2);
      expect(data.every((c: any) => c.type === 'inbox')).toBe(true);
    });
  });

  describe('GET /:botId/:id/status', () => {
    test('returns idle when not generating', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const convo = deps.conversationsService.createConversation('bot1');

      const res = await app.request(`http://localhost/api/conversations/bot1/${convo.id}/status`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('idle');
      expect(data.lastBotMessage).toBeNull();
    });

    test('returns last bot message when available', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const convo = deps.conversationsService.createConversation('bot1');
      deps.conversationsService.addMessage('bot1', convo.id, 'human', 'Hi');
      deps.conversationsService.addMessage('bot1', convo.id, 'bot', 'Hello there!');

      const res = await app.request(`http://localhost/api/conversations/bot1/${convo.id}/status`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('idle');
      expect(data.lastBotMessage).toBeTruthy();
      expect(data.lastBotMessage.content).toBe('Hello there!');
    });

    test('returns 404 for non-existent conversation', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await app.request('http://localhost/api/conversations/bot1/nonexistent/status');
      expect(res.status).toBe(404);
    });

    test('returns error status after generation failure', async () => {
      const mockClaudeGenerate = mock(() => Promise.reject(new Error('CLI crashed')));
      mock.module('../../../src/claude-cli', () => ({ claudeGenerate: mockClaudeGenerate }));

      const freshModule = await import('../../../src/web/routes/conversations');
      const deps = makeDeps();
      const freshApp = new Hono();
      freshApp.route('/api/conversations', freshModule.conversationsRoutes(deps));

      const convo = deps.conversationsService.createConversation('bot1');

      // Send a message to trigger generation that will fail
      await freshApp.request(`http://localhost/api/conversations/bot1/${convo.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      });

      // Wait for fire-and-forget to complete
      await tick(100);

      // Status should return error
      const statusRes = await freshApp.request(
        `http://localhost/api/conversations/bot1/${convo.id}/status`
      );
      const statusData = await statusRes.json();
      expect(statusData.status).toBe('error');
      expect(statusData.error).toContain('CLI crashed');

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({ claudeGenerate: orig }));
    });
  });

  describe('POST /:botId/:id/retry', () => {
    test('re-triggers generation and succeeds', async () => {
      let callCount = 0;
      const mockClaudeGenerate = mock(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('Transient failure'));
        return Promise.resolve('Retry succeeded!');
      });
      mock.module('../../../src/claude-cli', () => ({ claudeGenerate: mockClaudeGenerate }));

      const freshModule = await import('../../../src/web/routes/conversations');
      const deps = makeDeps();
      const freshApp = new Hono();
      freshApp.route('/api/conversations', freshModule.conversationsRoutes(deps));

      const convo = deps.conversationsService.createConversation('bot1');

      // First send fails
      await freshApp.request(`http://localhost/api/conversations/bot1/${convo.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      });
      await tick(100);

      // Status should be error
      let statusRes = await freshApp.request(
        `http://localhost/api/conversations/bot1/${convo.id}/status`
      );
      let statusData = await statusRes.json();
      expect(statusData.status).toBe('error');

      // Retry
      const retryRes = await freshApp.request(
        `http://localhost/api/conversations/bot1/${convo.id}/retry`,
        {
          method: 'POST',
        }
      );
      expect(retryRes.status).toBe(200);
      const retryData = await retryRes.json();
      expect(retryData.status).toBe('generating');

      // Wait for retry to complete
      await tick(100);

      // Status should be idle with bot message
      statusRes = await freshApp.request(
        `http://localhost/api/conversations/bot1/${convo.id}/status`
      );
      statusData = await statusRes.json();
      expect(statusData.status).toBe('idle');
      expect(statusData.lastBotMessage).toBeTruthy();
      expect(statusData.lastBotMessage.content).toBe('Retry succeeded!');

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({ claudeGenerate: orig }));
    });

    test('returns 409 when already generating', async () => {
      let resolveGenerate: (v: string) => void;
      const mockClaudeGenerate = mock(
        () =>
          new Promise<string>((resolve) => {
            resolveGenerate = resolve;
          })
      );
      mock.module('../../../src/claude-cli', () => ({ claudeGenerate: mockClaudeGenerate }));

      const freshModule = await import('../../../src/web/routes/conversations');
      const deps = makeDeps();
      const freshApp = new Hono();
      freshApp.route('/api/conversations', freshModule.conversationsRoutes(deps));

      const convo = deps.conversationsService.createConversation('bot1');

      // Start generation
      await freshApp.request(`http://localhost/api/conversations/bot1/${convo.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      });

      // Try retry while generating
      const retryRes = await freshApp.request(
        `http://localhost/api/conversations/bot1/${convo.id}/retry`,
        {
          method: 'POST',
        }
      );
      expect(retryRes.status).toBe(409);

      // Cleanup
      resolveGenerate?.('done');
      await tick();

      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({ claudeGenerate: orig }));
    });

    test('returns 404 for non-existent conversation', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await app.request('http://localhost/api/conversations/bot1/nonexistent/retry', {
        method: 'POST',
      });
      expect(res.status).toBe(404);
    });

    test('new message clears error state', async () => {
      let callCount = 0;
      const mockClaudeGenerate = mock(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('First fail'));
        return Promise.resolve('Second works!');
      });
      mock.module('../../../src/claude-cli', () => ({ claudeGenerate: mockClaudeGenerate }));

      const freshModule = await import('../../../src/web/routes/conversations');
      const deps = makeDeps();
      const freshApp = new Hono();
      freshApp.route('/api/conversations', freshModule.conversationsRoutes(deps));

      const convo = deps.conversationsService.createConversation('bot1');

      // First send fails
      await freshApp.request(`http://localhost/api/conversations/bot1/${convo.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      });
      await tick(100);

      // Confirm error
      let statusRes = await freshApp.request(
        `http://localhost/api/conversations/bot1/${convo.id}/status`
      );
      expect((await statusRes.json()).status).toBe('error');

      // Send another message (should clear error and succeed)
      await freshApp.request(`http://localhost/api/conversations/bot1/${convo.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Try again' }),
      });
      await tick(100);

      statusRes = await freshApp.request(
        `http://localhost/api/conversations/bot1/${convo.id}/status`
      );
      const statusData = await statusRes.json();
      expect(statusData.status).toBe('idle');
      expect(statusData.lastBotMessage.content).toBe('Second works!');

      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({ claudeGenerate: orig }));
    });
  });
});
