import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentFeedbackRoutes } from '../../../src/web/routes/agent-feedback';
import { AgentFeedbackStore } from '../../../src/bot/agent-feedback-store';
import type { Logger } from '../../../src/logger';
import type { Config } from '../../../src/config';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

describe('agent-feedback routes', () => {
  let app: Hono;
  let store: AgentFeedbackStore;
  let tmpDir: string;

  const mockConfig = {
    bots: [
      { id: 'bot1', name: 'TestBot' },
      { id: 'bot2', name: 'OtherBot' },
    ],
  } as unknown as Config;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `feedback-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const tmpDir2 = join(tmpDir, 'bot2');
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir2, { recursive: true });

    store = new AgentFeedbackStore(noopLogger);
    store.loadFromDisk('bot1', tmpDir);
    store.loadFromDisk('bot2', tmpDir2);

    const mockBotManager = {
      getAgentFeedbackBotIds: () => store.getBotIds(),
      getAgentFeedback: (botId: string, opts?: any) => store.getAll(botId, opts),
      getAgentFeedbackPendingCount: () => store.getPendingCount(),
      submitAgentFeedback: (botId: string, content: string) => store.submit(botId, content),
      dismissAgentFeedback: (botId: string, id: string) => store.dismiss(botId, id),
      getSoulLoader: () => ({
        readIdentity: () => 'I am TestBot',
        readSoul: () => 'A helpful soul',
        readMotivations: () => 'Stay curious',
        readGoals: () => '- Goal 1\n- Goal 2',
        readDailyLogsSince: () => 'Day 1 log\nDay 2 log',
      }),
      getProductionsService: () => undefined,
    };

    app = new Hono();
    app.route(
      '/api/agent-feedback',
      agentFeedbackRoutes({
        config: mockConfig,
        botManager: mockBotManager as any,
        logger: noopLogger,
      }),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function req(path: string, opts?: RequestInit) {
    const url = path === '/'
      ? 'http://localhost/api/agent-feedback'
      : `http://localhost/api/agent-feedback${path}`;
    return app.request(url, opts);
  }

  describe('GET /', () => {
    test('lists bots with counts', async () => {
      store.submit('bot1', 'Feedback A');
      store.submit('bot1', 'Feedback B');

      const res = await req('/');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);

      const bot1 = data.find((b: any) => b.botId === 'bot1');
      expect(bot1).toBeTruthy();
      expect(bot1.pending).toBe(2);
      expect(bot1.name).toBe('TestBot');
    });
  });

  describe('GET /count', () => {
    test('returns total pending count', async () => {
      store.submit('bot1', 'One');
      store.submit('bot2', 'Two');

      const res = await req('/count');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.count).toBe(2);
    });

    test('returns 0 when no pending', async () => {
      const res = await req('/count');
      const data = await res.json();
      expect(data.count).toBe(0);
    });
  });

  describe('GET /:botId', () => {
    test('lists feedback for a bot', async () => {
      store.submit('bot1', 'First');
      store.submit('bot1', 'Second');

      const res = await req('/bot1');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.entries).toHaveLength(2);
    });

    test('filters by status', async () => {
      const f1 = store.submit('bot1', 'Will apply');
      store.submit('bot1', 'Still pending');
      store.markApplied('bot1', f1.id, 'Done');

      const res = await req('/bot1?status=applied');
      const data = await res.json();
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0].status).toBe('applied');
    });

    test('returns empty for bot with no feedback', async () => {
      const res = await req('/bot2');
      const data = await res.json();
      expect(data.entries).toEqual([]);
    });
  });

  describe('POST /:botId', () => {
    test('submits feedback', async () => {
      const res = await req('/bot1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Be more creative' }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.content).toBe('Be more creative');
      expect(data.status).toBe('pending');
      expect(data.id).toBeTruthy();
    });

    test('rejects empty content', async () => {
      const res = await req('/bot1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '' }),
      });

      expect(res.status).toBe(400);
    });

    test('rejects missing content', async () => {
      const res = await req('/bot1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /:botId/:id', () => {
    test('dismisses pending feedback', async () => {
      const entry = store.submit('bot1', 'Dismiss me');

      const res = await req(`/bot1/${entry.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.ok).toBe(true);

      expect(store.getPendingCount()).toBe(0);
    });

    test('returns 404 for unknown id', async () => {
      const res = await req('/bot1/nonexistent', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /:botId/generate', () => {
    test('returns 404 for unknown bot', async () => {
      const res = await req('/unknown-bot/generate', { method: 'POST' });
      expect(res.status).toBe(404);

      const data = await res.json();
      expect(data.error).toBe('Bot not found');
    });

    test('returns generated feedback on success', async () => {
      // Build a separate app with claudeGenerate mocked via deps
      const mockClaudeGenerate = mock(() => Promise.resolve('Stop writing templated garbage. Focus on original content.'));

      // We need to create a route instance where claudeGenerate is mockable.
      // Since claudeGenerate is imported directly, we test via the full route
      // with a mock module approach.
      const { claudeGenerate: originalClaudeGenerate } = await import('../../../src/claude-cli');

      // Use mock.module to replace claudeGenerate
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mockClaudeGenerate,
      }));

      // Re-import the route to pick up the mock
      // Clear module cache by using dynamic import with cache-bust
      const freshModule = await import('../../../src/web/routes/agent-feedback');

      const mockBotManager = {
        getAgentFeedbackBotIds: () => store.getBotIds(),
        getAgentFeedback: (botId: string, opts?: any) => store.getAll(botId, opts),
        getAgentFeedbackPendingCount: () => store.getPendingCount(),
        submitAgentFeedback: (botId: string, content: string) => store.submit(botId, content),
        dismissAgentFeedback: (botId: string, id: string) => store.dismiss(botId, id),
        getSoulLoader: () => ({
          readIdentity: () => 'I am TestBot',
          readSoul: () => 'A helpful soul',
          readMotivations: () => 'Stay curious',
          readGoals: () => '- Goal 1\n- Goal 2',
          readDailyLogsSince: () => 'Day 1 log\nDay 2 log',
        }),
        getProductionsService: () => undefined,
      };

      const testApp = new Hono();
      testApp.route(
        '/api/agent-feedback',
        freshModule.agentFeedbackRoutes({
          config: mockConfig,
          botManager: mockBotManager as any,
          logger: noopLogger,
        }),
      );

      const res = await testApp.request('http://localhost/api/agent-feedback/bot1/generate', {
        method: 'POST',
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.feedback).toBe('Stop writing templated garbage. Focus on original content.');
      expect(mockClaudeGenerate).toHaveBeenCalledTimes(1);

      // Restore original module
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: originalClaudeGenerate,
      }));
    });

    test('returns 500 when Claude CLI fails', async () => {
      const mockClaudeGenerate = mock(() => Promise.reject(new Error('CLI timeout')));

      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mockClaudeGenerate,
      }));

      const freshModule = await import('../../../src/web/routes/agent-feedback');

      const mockBotManager = {
        getAgentFeedbackBotIds: () => store.getBotIds(),
        getAgentFeedback: (botId: string, opts?: any) => store.getAll(botId, opts),
        getAgentFeedbackPendingCount: () => store.getPendingCount(),
        submitAgentFeedback: (botId: string, content: string) => store.submit(botId, content),
        dismissAgentFeedback: (botId: string, id: string) => store.dismiss(botId, id),
        getSoulLoader: () => ({
          readIdentity: () => 'I am TestBot',
          readSoul: () => null,
          readMotivations: () => null,
          readGoals: () => null,
          readDailyLogsSince: () => '',
        }),
        getProductionsService: () => undefined,
      };

      const testApp = new Hono();
      testApp.route(
        '/api/agent-feedback',
        freshModule.agentFeedbackRoutes({
          config: mockConfig,
          botManager: mockBotManager as any,
          logger: noopLogger,
        }),
      );

      const res = await testApp.request('http://localhost/api/agent-feedback/bot1/generate', {
        method: 'POST',
      });
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toContain('CLI timeout');

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: orig,
      }));
    });

    test('includes productions context when service is available', async () => {
      const mockClaudeGenerate = mock(() => Promise.resolve('Feedback with productions context'));

      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mockClaudeGenerate,
      }));

      const freshModule = await import('../../../src/web/routes/agent-feedback');

      const mockProductionsService = {
        getStats: () => ({
          total: 10,
          approved: 5,
          rejected: 2,
          unreviewed: 3,
          avgRating: 3.5,
        }),
        getChangelog: () => [
          {
            id: 'p1',
            timestamp: '2026-02-20T10:00:00Z',
            botId: 'bot1',
            tool: 'file_write',
            path: '/output/article.md',
            action: 'create',
            description: 'Wrote article',
            size: 500,
            trackOnly: false,
          },
        ],
        getFileContent: () => '# Sample Article\nSome content here.',
      };

      const mockBotManager = {
        getAgentFeedbackBotIds: () => store.getBotIds(),
        getAgentFeedback: () => [],
        getAgentFeedbackPendingCount: () => 0,
        submitAgentFeedback: (botId: string, content: string) => store.submit(botId, content),
        dismissAgentFeedback: (botId: string, id: string) => store.dismiss(botId, id),
        getSoulLoader: () => ({
          readIdentity: () => 'I am TestBot',
          readSoul: () => null,
          readMotivations: () => null,
          readGoals: () => null,
          readDailyLogsSince: () => '',
        }),
        getProductionsService: () => mockProductionsService,
      };

      const testApp = new Hono();
      testApp.route(
        '/api/agent-feedback',
        freshModule.agentFeedbackRoutes({
          config: mockConfig,
          botManager: mockBotManager as any,
          logger: noopLogger,
          productionsService: mockProductionsService as any,
        }),
      );

      const res = await testApp.request('http://localhost/api/agent-feedback/bot1/generate', {
        method: 'POST',
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.feedback).toBe('Feedback with productions context');

      // Verify the prompt included productions info
      const callArgs = mockClaudeGenerate.mock.calls[0];
      const prompt = callArgs[0] as string;
      expect(prompt).toContain('Productions Stats');
      expect(prompt).toContain('Total: 10');
      expect(prompt).toContain('article.md');

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: orig,
      }));
    });
  });
});
