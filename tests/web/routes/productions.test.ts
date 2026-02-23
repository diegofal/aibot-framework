import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { productionsRoutes } from '../../../src/web/routes/productions';
import type { Logger } from '../../../src/logger';
import type { Config } from '../../../src/config';

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
  ],
  improve: {
    claudePath: 'claude',
    timeout: 30_000,
  },
} as unknown as Config;

function makeMockDeps(overrides?: Record<string, unknown>) {
  const mockProductionsService = {
    getAllBotStats: () => [],
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
      {
        id: 'p2',
        timestamp: '2026-02-19T08:00:00Z',
        botId: 'bot1',
        tool: 'file_edit',
        path: '/output/notes.md',
        action: 'edit',
        description: 'Updated notes',
        size: 200,
        trackOnly: false,
        evaluation: { status: 'approved', rating: 4 },
      },
    ],
    getFileContent: () => '# Sample Content\nSome text here.',
    getEntry: () => null,
    evaluate: () => null,
    updateContent: () => false,
    deleteProduction: () => false,
    readSummary: () => null,
    writeSummary: mock(() => {}),
  };

  const mockBotManager = {
    getSoulLoader: () => ({
      readIdentity: () => 'I am TestBot',
      readGoals: () => '- Goal 1\n- Goal 2',
      readDailyLogsSince: () => 'Day 1 log\nDay 2 log',
    }),
  };

  return {
    productionsService: mockProductionsService as any,
    botManager: (overrides?.botManager ?? mockBotManager) as any,
    logger: noopLogger,
    config: (overrides?.config ?? mockConfig) as Config,
  };
}

/** Helper: wait for background async IIFE to settle */
function tick(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('productions routes', () => {
  describe('GET /all-entries', () => {
    test('returns entries and total', async () => {
      const deps = makeMockDeps();
      deps.productionsService.getAllEntries = () => ({
        entries: [
          {
            id: 'p1', timestamp: '2026-02-20T10:00:00Z', botId: 'bot1',
            tool: 'file_write', path: '/output/article.md', action: 'create',
            description: 'Wrote article', size: 500, trackOnly: false,
          },
        ],
        total: 1,
      });

      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/all-entries');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.entries).toHaveLength(1);
      expect(data.total).toBe(1);
      expect(data.entries[0].id).toBe('p1');
    });

    test('forwards query params to service', async () => {
      const deps = makeMockDeps();
      let receivedOpts: any = null;
      deps.productionsService.getAllEntries = (opts: any) => {
        receivedOpts = opts;
        return { entries: [], total: 0 };
      };

      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      await app.request('http://localhost/api/productions/all-entries?limit=50&offset=10&status=approved&botId=bot1');
      expect(receivedOpts).toBeTruthy();
      expect(receivedOpts.limit).toBe(50);
      expect(receivedOpts.offset).toBe(10);
      expect(receivedOpts.status).toBe('approved');
      expect(receivedOpts.botId).toBe('bot1');
    });

    test('defaults limit to 100 and offset to 0', async () => {
      const deps = makeMockDeps();
      let receivedOpts: any = null;
      deps.productionsService.getAllEntries = (opts: any) => {
        receivedOpts = opts;
        return { entries: [], total: 0 };
      };

      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      await app.request('http://localhost/api/productions/all-entries');
      expect(receivedOpts.limit).toBe(100);
      expect(receivedOpts.offset).toBe(0);
      expect(receivedOpts.status).toBeUndefined();
      expect(receivedOpts.botId).toBeUndefined();
    });
  });

  describe('POST /:botId/generate-summary', () => {
    test('returns 404 for unknown bot', async () => {
      const deps = makeMockDeps();
      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/unknown-bot/generate-summary', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Bot not found');
    });

    test('returns { status: "generating" } immediately', async () => {
      let resolveGenerate: (v: string) => void;
      const mockClaudeGenerate = mock(() =>
        new Promise<string>((resolve) => { resolveGenerate = resolve; })
      );

      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mockClaudeGenerate,
      }));

      const freshModule = await import('../../../src/web/routes/productions');
      const deps = makeMockDeps();

      const app = new Hono();
      app.route('/api/productions', freshModule.productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/generate-summary', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('generating');

      // Resolve the pending generation so it doesn't leak
      resolveGenerate!('done');
      await tick();

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: orig,
      }));
    });

    test('writes summary to service on success', async () => {
      const mockClaudeGenerate = mock(() =>
        Promise.resolve('The bot is focused on writing articles about technology trends.')
      );

      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mockClaudeGenerate,
      }));

      const freshModule = await import('../../../src/web/routes/productions');
      const deps = makeMockDeps();

      const app = new Hono();
      app.route('/api/productions', freshModule.productionsRoutes(deps));

      await app.request('http://localhost/api/productions/bot1/generate-summary', {
        method: 'POST',
      });

      // Wait for background async to complete
      await tick();

      expect(deps.productionsService.writeSummary).toHaveBeenCalledTimes(1);
      const callArgs = deps.productionsService.writeSummary.mock.calls[0];
      expect(callArgs[0]).toBe('bot1');
      expect(callArgs[1].summary).toBe('The bot is focused on writing articles about technology trends.');
      expect(callArgs[1].generatedAt).toBeTruthy();

      // Verify prompt contains key context
      expect(mockClaudeGenerate).toHaveBeenCalledTimes(1);
      const prompt = mockClaudeGenerate.mock.calls[0][0] as string;
      expect(prompt).toContain('TestBot');
      expect(prompt).toContain('Productions Stats');
      expect(prompt).toContain('Total: 10');
      expect(prompt).toContain('article.md');
      expect(prompt).toContain('Goal 1');

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: orig,
      }));
    });

    test('writes error to service when Claude CLI fails', async () => {
      const mockClaudeGenerate = mock(() => Promise.reject(new Error('CLI timeout')));

      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mockClaudeGenerate,
      }));

      const freshModule = await import('../../../src/web/routes/productions');
      const deps = makeMockDeps();

      const app = new Hono();
      app.route('/api/productions', freshModule.productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/generate-summary', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe('generating');

      // Wait for background async to complete
      await tick();

      expect(deps.productionsService.writeSummary).toHaveBeenCalledTimes(1);
      const callArgs = deps.productionsService.writeSummary.mock.calls[0];
      expect(callArgs[0]).toBe('bot1');
      expect(callArgs[1].error).toContain('CLI timeout');

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: orig,
      }));
    });

    test('guards against duplicate generation', async () => {
      let resolveGenerate: (v: string) => void;
      const mockClaudeGenerate = mock(() =>
        new Promise<string>((resolve) => { resolveGenerate = resolve; })
      );

      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mockClaudeGenerate,
      }));

      const freshModule = await import('../../../src/web/routes/productions');
      const deps = makeMockDeps();

      const app = new Hono();
      app.route('/api/productions', freshModule.productionsRoutes(deps));

      // First call starts generation
      const res1 = await app.request('http://localhost/api/productions/bot1/generate-summary', {
        method: 'POST',
      });
      expect((await res1.json()).status).toBe('generating');

      // Second call while still generating
      const res2 = await app.request('http://localhost/api/productions/bot1/generate-summary', {
        method: 'POST',
      });
      expect((await res2.json()).status).toBe('generating');

      // Claude should only have been called once
      expect(mockClaudeGenerate).toHaveBeenCalledTimes(1);

      // Resolve
      resolveGenerate!('done');
      await tick();

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: orig,
      }));
    });

    test('includes content samples for first entries', async () => {
      const mockClaudeGenerate = mock(() => Promise.resolve('Summary with content'));

      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mockClaudeGenerate,
      }));

      const freshModule = await import('../../../src/web/routes/productions');
      const deps = makeMockDeps();

      const app = new Hono();
      app.route('/api/productions', freshModule.productionsRoutes(deps));

      await app.request('http://localhost/api/productions/bot1/generate-summary', {
        method: 'POST',
      });

      await tick();

      const prompt = mockClaudeGenerate.mock.calls[0][0] as string;
      expect(prompt).toContain('Content preview');
      expect(prompt).toContain('Sample Content');

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: orig,
      }));
    });
  });

  describe('GET /:botId/summary-status', () => {
    test('returns 404 for unknown bot', async () => {
      const deps = makeMockDeps();
      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/unknown-bot/summary-status');
      expect(res.status).toBe(404);
    });

    test('returns idle when no summary exists', async () => {
      const deps = makeMockDeps();
      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/summary-status');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('idle');
    });

    test('returns done with summary data', async () => {
      const deps = makeMockDeps();
      deps.productionsService.readSummary = () => ({
        summary: 'Bot is working on articles',
        generatedAt: '2026-02-22T10:00:00Z',
      });

      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/summary-status');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('done');
      expect(data.summary).toBe('Bot is working on articles');
      expect(data.generatedAt).toBe('2026-02-22T10:00:00Z');
    });

    test('returns error when summary has error', async () => {
      const deps = makeMockDeps();
      deps.productionsService.readSummary = () => ({
        error: 'CLI timeout',
        generatedAt: '2026-02-22T10:00:00Z',
      });

      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/summary-status');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('error');
      expect(data.error).toBe('CLI timeout');
    });

    test('returns generating when generation is in progress', async () => {
      let resolveGenerate: (v: string) => void;
      const mockClaudeGenerate = mock(() =>
        new Promise<string>((resolve) => { resolveGenerate = resolve; })
      );

      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mockClaudeGenerate,
      }));

      const freshModule = await import('../../../src/web/routes/productions');
      const deps = makeMockDeps();

      const app = new Hono();
      app.route('/api/productions', freshModule.productionsRoutes(deps));

      // Start generation
      await app.request('http://localhost/api/productions/bot1/generate-summary', {
        method: 'POST',
      });

      // Poll status
      const res = await app.request('http://localhost/api/productions/bot1/summary-status');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('generating');

      // Resolve
      resolveGenerate!('done');
      await tick();

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: orig,
      }));
    });
  });

  describe('GET /:botId/:id/response-status', () => {
    test('returns 404 for non-existent entry', async () => {
      const deps = makeMockDeps();
      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/some-id/response-status');
      expect(res.status).toBe(404);
    });

    test('returns idle when entry has no AI response', async () => {
      const deps = makeMockDeps();
      deps.productionsService.getEntry = () => ({
        id: 'p1',
        botId: 'bot1',
        timestamp: '2026-02-20T10:00:00Z',
        tool: 'file_write',
        path: '/output/article.md',
        action: 'create',
        description: 'Wrote article',
        size: 500,
        trackOnly: false,
        evaluation: { status: 'approved', rating: 4, feedback: 'Good', evaluatedAt: '2026-02-20T11:00:00Z' },
      });

      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/p1/response-status');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('idle');
    });

    test('returns done with AI response when present', async () => {
      const deps = makeMockDeps();
      deps.productionsService.getEntry = () => ({
        id: 'p1',
        botId: 'bot1',
        timestamp: '2026-02-20T10:00:00Z',
        tool: 'file_write',
        path: '/output/article.md',
        action: 'create',
        description: 'Wrote article',
        size: 500,
        trackOnly: false,
        evaluation: {
          status: 'approved',
          rating: 4,
          feedback: 'Good',
          evaluatedAt: '2026-02-20T11:00:00Z',
          aiResponse: 'Thanks for the feedback!',
          aiResponseAt: '2026-02-20T11:01:00Z',
        },
      });

      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/p1/response-status');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('done');
      expect(data.response).toBe('Thanks for the feedback!');
      expect(data.generatedAt).toBe('2026-02-20T11:01:00Z');
    });
  });

  describe('POST /:botId/:id/thread', () => {
    test('returns 400 for empty message', async () => {
      const deps = makeMockDeps();
      deps.productionsService.getEntry = () => ({ id: 'p1', botId: 'bot1' });

      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/p1/thread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '' }),
      });

      expect(res.status).toBe(400);
    });

    test('returns 404 for non-existent entry', async () => {
      const deps = makeMockDeps();
      // getEntry returns null by default

      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/p1/thread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      });

      expect(res.status).toBe(404);
    });

    test('adds human message and returns entry', async () => {
      const mockClaudeGenerate = mock(() => Promise.resolve('Bot reply'));
      mock.module('../../../src/claude-cli', () => ({ claudeGenerate: mockClaudeGenerate }));

      const freshModule = await import('../../../src/web/routes/productions');
      const deps = makeMockDeps();
      const mockEntry = {
        id: 'p1', botId: 'bot1', tool: 'file_write', path: '/output/test.md',
        action: 'create', description: 'Test', size: 100, trackOnly: false,
        timestamp: '2026-02-20T10:00:00Z',
      };
      deps.productionsService.getEntry = () => mockEntry;
      deps.productionsService.addThreadMessage = mock((botId: string, id: string, role: string, content: string) => ({
        message: { id: 'msg1', role, content, createdAt: new Date().toISOString() },
        entry: { ...mockEntry, evaluation: { evaluatedAt: new Date().toISOString(), thread: [{ id: 'msg1', role, content, createdAt: new Date().toISOString() }] } },
      }));

      const mockSoulLoader = {
        readIdentity: () => 'I am TestBot',
        readGoals: () => '- Goal 1',
        appendDailyMemory: mock(() => {}),
      };
      deps.botManager = { getSoulLoader: () => mockSoulLoader } as any;

      const app = new Hono();
      app.route('/api/productions', freshModule.productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/p1/thread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'What was your reasoning?' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.message).toBeTruthy();
      expect(data.message.role).toBe('human');
      expect(data.entry).toBeTruthy();

      // Wait for background AI generation
      await tick();

      expect(mockClaudeGenerate).toHaveBeenCalledTimes(1);

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({ claudeGenerate: orig }));
    });
  });

  describe('GET /:botId/:id/thread-status', () => {
    test('returns 404 for non-existent entry', async () => {
      const deps = makeMockDeps();
      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/p1/thread-status');
      expect(res.status).toBe(404);
    });

    test('returns idle with last bot message when not generating', async () => {
      const deps = makeMockDeps();
      const botMsg = { id: 'bmsg1', role: 'bot', content: 'My reply', createdAt: '2026-02-22T10:00:00Z' };
      deps.productionsService.getEntry = () => ({
        id: 'p1', botId: 'bot1', tool: 'file_write', path: '/test.md',
        action: 'create', description: 'Test', size: 100, trackOnly: false,
        timestamp: '2026-02-20T10:00:00Z',
        evaluation: {
          evaluatedAt: '2026-02-20T10:00:00Z',
          thread: [
            { id: 'hmsg1', role: 'human', content: 'Hi', createdAt: '2026-02-22T09:00:00Z' },
            botMsg,
          ],
        },
      });

      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/p1/thread-status');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('idle');
      expect(data.lastBotMessage).toBeTruthy();
      expect(data.lastBotMessage.content).toBe('My reply');
    });

    test('returns idle with null when no bot messages', async () => {
      const deps = makeMockDeps();
      deps.productionsService.getEntry = () => ({
        id: 'p1', botId: 'bot1', tool: 'file_write', path: '/test.md',
        action: 'create', description: 'Test', size: 100, trackOnly: false,
        timestamp: '2026-02-20T10:00:00Z',
        evaluation: {
          evaluatedAt: '2026-02-20T10:00:00Z',
          thread: [{ id: 'hmsg1', role: 'human', content: 'Hi', createdAt: '2026-02-22T09:00:00Z' }],
        },
      });

      const app = new Hono();
      app.route('/api/productions', productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/p1/thread-status');
      const data = await res.json();
      expect(data.status).toBe('idle');
      expect(data.lastBotMessage).toBeNull();
    });
  });

  describe('POST /:botId/:id/evaluate with feedback', () => {
    test('triggers AI response generation when feedback is provided', async () => {
      const mockClaudeGenerate = mock(() => Promise.resolve('I understand the feedback.'));

      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mockClaudeGenerate,
      }));

      const freshModule = await import('../../../src/web/routes/productions');
      const deps = makeMockDeps();
      const evaluatedEntry = {
        id: 'p1',
        botId: 'bot1',
        timestamp: '2026-02-20T10:00:00Z',
        tool: 'file_write',
        path: '/output/article.md',
        action: 'create',
        description: 'Wrote article',
        size: 500,
        trackOnly: false,
        evaluation: { status: 'approved' as const, rating: 4, feedback: 'Great work', evaluatedAt: '2026-02-20T11:00:00Z' },
      };
      deps.productionsService.evaluate = () => evaluatedEntry;
      deps.productionsService.getFileContent = () => '# Article content';
      deps.productionsService.setAiResponse = mock(() => evaluatedEntry);

      const mockSoulLoader = {
        readIdentity: () => 'I am TestBot',
        readGoals: () => '- Goal 1',
        readDailyLogsSince: () => '',
        appendDailyMemory: mock(() => {}),
      };
      deps.botManager = {
        getSoulLoader: () => mockSoulLoader,
      } as any;

      const app = new Hono();
      app.route('/api/productions', freshModule.productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/p1/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved', rating: 4, feedback: 'Great work' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.entry).toBeTruthy();

      // Wait for background async
      await tick();

      expect(mockClaudeGenerate).toHaveBeenCalledTimes(1);
      expect(deps.productionsService.setAiResponse).toHaveBeenCalledTimes(1);
      const setArgs = (deps.productionsService.setAiResponse as any).mock.calls[0];
      expect(setArgs[0]).toBe('bot1');
      expect(setArgs[1]).toBe('p1');
      expect(setArgs[2]).toBe('I understand the feedback.');

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: orig,
      }));
    });

    test('does not trigger AI generation when no feedback', async () => {
      const mockClaudeGenerate = mock(() => Promise.resolve('response'));

      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: mockClaudeGenerate,
      }));

      const freshModule = await import('../../../src/web/routes/productions');
      const deps = makeMockDeps();
      deps.productionsService.evaluate = () => ({
        id: 'p1',
        botId: 'bot1',
        timestamp: '2026-02-20T10:00:00Z',
        tool: 'file_write',
        path: '/output/article.md',
        action: 'create',
        description: 'Wrote article',
        size: 500,
        trackOnly: false,
        evaluation: { status: 'approved', evaluatedAt: '2026-02-20T11:00:00Z' },
      });

      const app = new Hono();
      app.route('/api/productions', freshModule.productionsRoutes(deps));

      const res = await app.request('http://localhost/api/productions/bot1/p1/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      });

      expect(res.status).toBe(200);

      await tick();

      // Claude should not have been called
      expect(mockClaudeGenerate).toHaveBeenCalledTimes(0);

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: orig,
      }));
    });
  });
});
