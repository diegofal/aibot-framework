import { describe, expect, mock, test } from 'bun:test';
import { AskPermissionStore } from '../src/bot/ask-permission-store';

const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
} as any;

describe('AskPermissionStore.normalizeResource', () => {
  test('strips absolute project path', () => {
    expect(
      AskPermissionStore.normalizeResource(
        '/home/diego/projects/aibot-framework/src/bot/tool-executor.ts'
      )
    ).toBe('src/bot/tool-executor.ts');
  });

  test('strips home prefix for other paths', () => {
    expect(AskPermissionStore.normalizeResource('/home/diego/openclaw/src/tool.ts')).toBe(
      '~/openclaw/src/tool.ts'
    );
  });

  test('lowercases and trims', () => {
    expect(AskPermissionStore.normalizeResource('  SRC/Bot/Tool.ts  ')).toBe('src/bot/tool.ts');
  });

  test('collapses whitespace', () => {
    expect(AskPermissionStore.normalizeResource('src/bot/tool.ts,  src/bot/other.ts')).toBe(
      'src/bot/tool.ts, src/bot/other.ts'
    );
  });

  test('relative and absolute paths normalize to same value', () => {
    const abs = AskPermissionStore.normalizeResource(
      '/home/diego/projects/aibot-framework/src/bot/tool-executor.ts'
    );
    const rel = AskPermissionStore.normalizeResource('src/bot/tool-executor.ts');
    expect(abs).toBe(rel);
  });
});

describe('AskPermissionStore.hasRecentApproval', () => {
  test('returns false when no history exists', () => {
    const store = new AskPermissionStore(mockLogger);
    expect(store.hasRecentApproval('bot1', 'file_write', 'src/file.ts')).toBe(false);
  });

  test('returns true when resolved queue has matching approval', async () => {
    const store = new AskPermissionStore(mockLogger);

    const { id } = store.request('bot1', 'file_write', 'src/file.ts', 'test', 'normal');
    store.approveById(id);

    expect(store.hasRecentApproval('bot1', 'file_write', 'src/file.ts')).toBe(true);
  });

  test('returns true with normalized path match', async () => {
    const store = new AskPermissionStore(mockLogger);

    const { id } = store.request(
      'bot1',
      'file_write',
      '/home/diego/projects/aibot-framework/src/bot/tool-executor.ts',
      'test',
      'normal'
    );
    store.approveById(id);

    expect(store.hasRecentApproval('bot1', 'file_write', 'src/bot/tool-executor.ts')).toBe(true);
  });

  test('returns true after consumption (history check)', async () => {
    const store = new AskPermissionStore(mockLogger);

    const { id } = store.request('bot1', 'file_write', 'src/file.ts', 'test', 'normal');
    store.approveById(id);
    store.consumeDecisionsForBot('bot1');

    expect(store.hasRecentApproval('bot1', 'file_write', 'src/file.ts')).toBe(true);
  });

  test('returns false for different bot', async () => {
    const store = new AskPermissionStore(mockLogger);

    const { id } = store.request('bot1', 'file_write', 'src/file.ts', 'test', 'normal');
    store.approveById(id);

    expect(store.hasRecentApproval('bot2', 'file_write', 'src/file.ts')).toBe(false);
  });

  test('returns false for denied request', async () => {
    const store = new AskPermissionStore(mockLogger);

    const { id } = store.request('bot1', 'file_write', 'src/file.ts', 'test', 'normal');
    store.denyById(id);

    expect(store.hasRecentApproval('bot1', 'file_write', 'src/file.ts')).toBe(false);
  });

  test('pending duplicate check uses normalized paths', () => {
    const store = new AskPermissionStore(mockLogger);

    store.request(
      'bot1',
      'file_write',
      '/home/diego/projects/aibot-framework/src/bot/tool-executor.ts',
      'first request',
      'normal'
    );

    expect(store.hasPendingDuplicate('bot1', 'file_write', 'src/bot/tool-executor.ts')).toBe(true);
  });
});
