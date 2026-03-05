import { describe, expect, mock, test } from 'bun:test';
import { createProductionLogTool } from '../src/tools/production-log';

const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
} as any;

function mockProductionsService(entries: any[] = [], stats?: any) {
  return {
    isEnabled: () => true,
    getChangelog: () => entries,
    getStats: () =>
      stats ?? {
        total: entries.length,
        approved: 0,
        rejected: 0,
        unreviewed: entries.length,
        avgRating: null,
      },
  } as any;
}

describe('read_production_log null safety', () => {
  test('handles entries with missing timestamp', async () => {
    const entries = [{ action: 'create', path: 'docs/readme.md' }];
    const tool = createProductionLogTool(mockProductionsService(entries));

    const result = await tool.execute({ _botId: 'test' }, mockLogger);

    expect(result.success).toBe(true);
    expect(result.content).toContain('| create | docs/readme.md |');
  });

  test('handles entries with missing action and path', async () => {
    const entries = [{ timestamp: '2026-03-04T12:00:00Z' }];
    const tool = createProductionLogTool(mockProductionsService(entries));

    const result = await tool.execute({ _botId: 'test' }, mockLogger);

    expect(result.success).toBe(true);
    expect(result.content).toContain('2026-03-04T12:00');
    expect(result.content).toContain('| ? | ? |');
  });

  test('handles completely empty entry', async () => {
    const entries = [{}];
    const tool = createProductionLogTool(mockProductionsService(entries));

    const result = await tool.execute({ _botId: 'test' }, mockLogger);

    expect(result.success).toBe(true);
    expect(result.content).toContain('| ? | ? |');
  });

  test('handles normal entries correctly', async () => {
    const entries = [
      {
        timestamp: '2026-03-04T14:30:00Z',
        action: 'create',
        path: 'articles/01_intro.md',
        evaluation: { status: 'approved', rating: 4, feedback: 'Good' },
      },
    ];
    const tool = createProductionLogTool(mockProductionsService(entries));

    const result = await tool.execute({ _botId: 'test' }, mockLogger);

    expect(result.success).toBe(true);
    expect(result.content).toContain('2026-03-04T14:30');
    expect(result.content).toContain('create');
    expect(result.content).toContain('articles/01_intro.md');
    expect(result.content).toContain('[APPROVED 4/5]');
  });
});
