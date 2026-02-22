import { describe, test, expect, mock } from 'bun:test';
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

describe('productions routes', () => {
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

    test('returns generated summary on success', async () => {
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

      const res = await app.request('http://localhost/api/productions/bot1/generate-summary', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.summary).toBe('The bot is focused on writing articles about technology trends.');
      expect(mockClaudeGenerate).toHaveBeenCalledTimes(1);

      // Verify prompt contains key context
      const callArgs = mockClaudeGenerate.mock.calls[0];
      const prompt = callArgs[0] as string;
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

    test('returns 500 when Claude CLI fails', async () => {
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

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain('CLI timeout');

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

      const res = await app.request('http://localhost/api/productions/bot1/generate-summary', {
        method: 'POST',
      });

      expect(res.status).toBe(200);

      const callArgs = mockClaudeGenerate.mock.calls[0];
      const prompt = callArgs[0] as string;
      expect(prompt).toContain('Content preview');
      expect(prompt).toContain('Sample Content');

      // Restore
      const { claudeGenerate: orig } = await import('../../../src/claude-cli');
      mock.module('../../../src/claude-cli', () => ({
        claudeGenerate: orig,
      }));
    });
  });
});
