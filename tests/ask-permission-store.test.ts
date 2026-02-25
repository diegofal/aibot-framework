import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AskPermissionStore } from '../src/bot/ask-permission-store';
import { createAskPermissionTool } from '../src/tools/ask-permission';

function makeLogger() {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    child: () => makeLogger(),
  } as any;
}

describe('AskPermissionStore', () => {
  let store: AskPermissionStore;

  beforeEach(() => {
    store = new AskPermissionStore(makeLogger());
  });

  test('getAll() returns empty array initially', () => {
    expect(store.getAll()).toEqual([]);
  });

  test('getPendingCount() returns 0 initially', () => {
    expect(store.getPendingCount()).toBe(0);
  });

  test('request() creates pending with correct fields', () => {
    const { id, promise } = store.request('bot1', 'file_write', '/tmp/test.txt', 'Need to save results');
    promise.catch(() => {});
    const all = store.getAll();
    expect(all).toHaveLength(1);

    const r = all[0];
    expect(r.botId).toBe('bot1');
    expect(r.action).toBe('file_write');
    expect(r.resource).toBe('/tmp/test.txt');
    expect(r.description).toBe('Need to save results');
    expect(r.urgency).toBe('normal');
    expect(r.status).toBe('pending');
    expect(typeof r.id).toBe('string');
    expect(typeof r.createdAt).toBe('number');
    expect(r.remainingMs).toBeGreaterThan(0);
    store.dispose();
  });

  test('request() with custom urgency and timeout', () => {
    const { promise } = store.request('bot1', 'exec', 'npm test', 'Run tests', 'high', 30 * 60_000);
    promise.catch(() => {});
    const all = store.getAll();
    expect(all[0].urgency).toBe('high');
    expect(all[0].timeoutMs).toBe(30 * 60_000);
    store.dispose();
  });

  test('approveById() resolves promise and returns true', async () => {
    const { id, promise } = store.request('bot1', 'file_write', '/tmp/out.txt', 'Save data');
    expect(store.getPendingCount()).toBe(1);

    const ok = store.approveById(id, 'Go ahead');
    expect(ok).toBe(true);
    expect(store.getPendingCount()).toBe(0);

    const decision = await promise;
    expect(decision).toBe('approved');
  });

  test('denyById() resolves promise and returns true', async () => {
    const { id, promise } = store.request('bot1', 'exec', 'rm -rf /', 'Clean up');
    const ok = store.denyById(id, 'Too dangerous');
    expect(ok).toBe(true);
    expect(store.getPendingCount()).toBe(0);

    const decision = await promise;
    expect(decision).toBe('denied');
  });

  test('approveById() returns false for unknown ID', () => {
    expect(store.approveById('nonexistent')).toBe(false);
  });

  test('denyById() returns false for unknown ID', () => {
    expect(store.denyById('nonexistent')).toBe(false);
  });

  test('approveById() returns false for already-resolved request', async () => {
    const { id, promise } = store.request('bot1', 'file_write', '/tmp/x', 'test');
    store.approveById(id);
    await promise;
    expect(store.approveById(id)).toBe(false);
  });

  test('hasPendingDuplicate() detects duplicates', () => {
    const { promise } = store.request('bot1', 'file_write', '/tmp/test.txt', 'Save');
    promise.catch(() => {});
    expect(store.hasPendingDuplicate('bot1', 'file_write', '/tmp/test.txt')).toBe(true);
    expect(store.hasPendingDuplicate('bot1', 'file_write', '/tmp/other.txt')).toBe(false);
    expect(store.hasPendingDuplicate('bot2', 'file_write', '/tmp/test.txt')).toBe(false);
    expect(store.hasPendingDuplicate('bot1', 'exec', '/tmp/test.txt')).toBe(false);
    store.dispose();
  });

  test('duplicate request returns existing ID', async () => {
    const first = store.request('bot1', 'file_write', '/tmp/test.txt', 'Save v1');
    const second = store.request('bot1', 'file_write', '/tmp/test.txt', 'Save v2');

    expect(second.id).toBe(first.id);
    expect(store.getPendingCount()).toBe(1);

    // Clean up — both promises resolve
    store.approveById(first.id);
    await first.promise;
    await second.promise;
  });

  test('consumeDecisionsForBot() returns and deletes resolved', async () => {
    const { id: id1 } = store.request('bot1', 'file_write', '/a', 'desc1');
    const { id: id2 } = store.request('bot1', 'exec', 'cmd', 'desc2');
    store.approveById(id1, 'ok');
    store.denyById(id2, 'no');

    const decisions = store.consumeDecisionsForBot('bot1');
    expect(decisions).toHaveLength(2);

    const approved = decisions.find(d => d.status === 'approved')!;
    expect(approved).toBeDefined();
    expect(approved.action).toBe('file_write');
    expect(approved.resource).toBe('/a');
    expect(approved.note).toBe('ok');

    const denied = decisions.find(d => d.status === 'denied')!;
    expect(denied).toBeDefined();
    expect(denied.action).toBe('exec');
    expect(denied.note).toBe('no');

    // Second call returns empty — consumed
    expect(store.consumeDecisionsForBot('bot1')).toEqual([]);
  });

  test('consumeDecisionsForBot() returns empty for unknown bot', () => {
    const { id } = store.request('bot1', 'file_write', '/x', 'test');
    store.approveById(id);

    expect(store.consumeDecisionsForBot('bot-unknown')).toEqual([]);
  });

  test('getPendingForBot() filters by bot', () => {
    const { promise: p1 } = store.request('bot1', 'file_write', '/a', 'desc1');
    const { promise: p2 } = store.request('bot2', 'exec', 'cmd', 'desc2');
    const { promise: p3 } = store.request('bot1', 'api_call', 'url', 'desc3');
    p1.catch(() => {}); p2.catch(() => {}); p3.catch(() => {});

    const bot1Pending = store.getPendingForBot('bot1');
    expect(bot1Pending).toHaveLength(2);
    expect(bot1Pending.every(r => r.botId === 'bot1')).toBe(true);

    const bot2Pending = store.getPendingForBot('bot2');
    expect(bot2Pending).toHaveLength(1);
    expect(bot2Pending[0].botId).toBe('bot2');

    expect(store.getPendingForBot('bot-unknown')).toEqual([]);
    store.dispose();
  });

  test('timeout auto-expires request', async () => {
    const { promise } = store.request('bot1', 'file_write', '/x', 'test', 'normal', 50);
    promise.catch(() => {}); // prevent unhandled rejection

    await new Promise(r => setTimeout(r, 100));
    expect(store.getPendingCount()).toBe(0);
    await expect(promise).rejects.toThrow('timed out');
  });

  test('dispose() clears all and rejects promises', async () => {
    const { promise: p1 } = store.request('bot1', 'file_write', '/a', 'd1');
    const { promise: p2 } = store.request('bot2', 'exec', 'cmd', 'd2');
    p1.catch(() => {});
    p2.catch(() => {});

    expect(store.getPendingCount()).toBe(2);

    store.dispose();
    expect(store.getPendingCount()).toBe(0);
    expect(store.getAll()).toEqual([]);

    await expect(p1).rejects.toThrow('AskPermissionStore disposed');
    await expect(p2).rejects.toThrow('AskPermissionStore disposed');
  });

  test('dispose() clears resolved map too', () => {
    const { id } = store.request('bot1', 'file_write', '/x', 'test');
    store.approveById(id);

    store.dispose();
    expect(store.consumeDecisionsForBot('bot1')).toEqual([]);
  });
});

describe('AskPermissionStore history', () => {
  let store: AskPermissionStore;

  beforeEach(() => {
    store = new AskPermissionStore(makeLogger());
  });

  test('getHistory() returns empty array initially', () => {
    expect(store.getHistory()).toEqual([]);
  });

  test('approveById writes to history with decided status', async () => {
    const { id, promise } = store.request('bot1', 'file_write', '/tmp/x', 'test');
    store.approveById(id, 'ok');
    await promise;

    const history = store.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(id);
    expect(history[0].status).toBe('approved');
    expect(history[0].executionStatus).toBe('decided');
    expect(history[0].note).toBe('ok');
  });

  test('denyById writes to history with decided status', async () => {
    const { id, promise } = store.request('bot1', 'exec', 'cmd', 'test');
    store.denyById(id, 'nope');
    await promise;

    const history = store.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('denied');
    expect(history[0].executionStatus).toBe('decided');
    expect(history[0].note).toBe('nope');
  });

  test('consumeDecisionsForBot updates history to consumed', async () => {
    const { id, promise } = store.request('bot1', 'file_write', '/a', 'desc');
    store.approveById(id);
    await promise;

    store.consumeDecisionsForBot('bot1');

    const entry = store.getHistoryById(id);
    expect(entry).toBeDefined();
    expect(entry!.executionStatus).toBe('consumed');
    expect(typeof entry!.consumedAt).toBe('number');
  });

  test('reportExecution updates to executed', async () => {
    const { id, promise } = store.request('bot1', 'file_write', '/a', 'desc');
    store.approveById(id);
    await promise;

    store.consumeDecisionsForBot('bot1');
    store.reportExecution([id], 'Action completed', [{ name: 'file_write', success: true }], true);

    const entry = store.getHistoryById(id);
    expect(entry!.executionStatus).toBe('executed');
    expect(entry!.executionSummary).toBe('Action completed');
    expect(entry!.toolCalls).toEqual([{ name: 'file_write', success: true }]);
    expect(typeof entry!.executedAt).toBe('number');
  });

  test('reportExecution updates to failed', async () => {
    const { id, promise } = store.request('bot1', 'exec', 'cmd', 'desc');
    store.approveById(id);
    await promise;

    store.consumeDecisionsForBot('bot1');
    store.reportExecution([id], 'Executor crashed', [], false);

    const entry = store.getHistoryById(id);
    expect(entry!.executionStatus).toBe('failed');
    expect(entry!.executionSummary).toBe('Executor crashed');
  });

  test('getHistoryById returns undefined for unknown ID', () => {
    expect(store.getHistoryById('nonexistent')).toBeUndefined();
  });

  test('getHistory returns all entries and respects limit', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id, promise } = store.request('bot1', `action${i}`, `res${i}`, `desc${i}`);
      store.approveById(id);
      await promise;
      ids.push(id);
    }

    const all = store.getHistory(10);
    expect(all).toHaveLength(5);
    // All IDs should be present
    const allIds = new Set(all.map(e => e.id));
    for (const id of ids) {
      expect(allIds.has(id)).toBe(true);
    }

    const limited = store.getHistory(2);
    expect(limited).toHaveLength(2);
  });

  test('reportExecution ignores unknown IDs', () => {
    // Should not throw
    store.reportExecution(['unknown1', 'unknown2'], 'summary', [], true);
    expect(store.getHistory()).toEqual([]);
  });

  test('dispose clears history', async () => {
    const { id, promise } = store.request('bot1', 'file_write', '/a', 'desc');
    store.approveById(id);
    await promise;

    expect(store.getHistory()).toHaveLength(1);
    store.dispose();
    expect(store.getHistory()).toEqual([]);
  });
});

describe('ask_permission tool', () => {
  let store: AskPermissionStore;

  beforeEach(() => {
    store = new AskPermissionStore(makeLogger());
  });

  test('returns immediately (non-blocking) with queued message', async () => {
    const tool = createAskPermissionTool({
      store,
      getBotInstance: () => undefined,
      getBotName: () => 'TestBot',
    });

    const result = await tool.execute(
      { action: 'file_write', resource: '/tmp/out.txt', description: 'Save results', _botId: 'bot1', _chatId: 0 },
      makeLogger(),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Permission request queued');
    expect(result.content).toContain('next cycle');
    expect(store.getPendingCount()).toBe(1);

    const pending = store.getAll();
    expect(pending[0].action).toBe('file_write');
    expect(pending[0].resource).toBe('/tmp/out.txt');
    expect(pending[0].botId).toBe('bot1');

    store.dispose();
  });

  test('returns dedup message when same request is pending', async () => {
    const tool = createAskPermissionTool({
      store,
      getBotInstance: () => undefined,
      getBotName: () => 'TestBot',
    });

    // First call
    await tool.execute(
      { action: 'file_write', resource: '/tmp/out.txt', description: 'Save', _botId: 'bot1', _chatId: 0 },
      makeLogger(),
    );
    expect(store.getPendingCount()).toBe(1);

    // Second call with same action+resource
    const result = await tool.execute(
      { action: 'file_write', resource: '/tmp/out.txt', description: 'Save again', _botId: 'bot1', _chatId: 0 },
      makeLogger(),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('already have a pending permission request');
    expect(store.getPendingCount()).toBe(1);
    store.dispose();
  });

  test('fails when _botId is missing', async () => {
    const tool = createAskPermissionTool({
      store,
      getBotInstance: () => undefined,
      getBotName: () => 'TestBot',
    });

    const result = await tool.execute(
      { action: 'file_write', resource: '/tmp/x', description: 'test' },
      makeLogger(),
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('_botId');
  });

  test('fails when required params are missing', async () => {
    const tool = createAskPermissionTool({
      store,
      getBotInstance: () => undefined,
      getBotName: () => 'TestBot',
    });

    const result = await tool.execute(
      { action: 'file_write', _botId: 'bot1', _chatId: 0 },
      makeLogger(),
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing required parameters');
  });

  test('dismiss after tool.execute does not cause unhandled rejection', async () => {
    const logger = makeLogger();
    const tool = createAskPermissionTool({
      store,
      getBotInstance: () => undefined,
      getBotName: () => 'TestBot',
    });

    await tool.execute(
      { action: 'exec', resource: 'npm test', description: 'Run tests', _botId: 'bot1', _chatId: 0 },
      logger,
    );

    // Expire/dispose — the tool attaches .catch() internally so no unhandled rejection
    store.dispose();
    await new Promise(r => setTimeout(r, 10));

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: expect.any(String), botId: 'bot1' }),
      'ask_permission: request closed without decision',
    );
  });
});

describe('AskPermissionStore persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ask-perm-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('history survives store recreation', async () => {
    const store1 = new AskPermissionStore(makeLogger(), tmpDir);
    const { id, promise } = store1.request('bot1', 'file_write', '/a', 'desc');
    store1.approveById(id, 'ok');
    await promise;

    // Create a new store pointing at the same directory
    const store2 = new AskPermissionStore(makeLogger(), tmpDir);
    const history = store2.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(id);
    expect(history[0].status).toBe('approved');
    expect(history[0].note).toBe('ok');
  });

  test('resolved decisions survive store recreation', async () => {
    const store1 = new AskPermissionStore(makeLogger(), tmpDir);
    const { id } = store1.request('bot1', 'exec', 'cmd', 'desc');
    store1.denyById(id, 'nope');

    // Recreate — resolved decisions should be consumable
    const store2 = new AskPermissionStore(makeLogger(), tmpDir);
    const decisions = store2.consumeDecisionsForBot('bot1');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe('denied');
  });

  test('execution status persists across restarts', async () => {
    const store1 = new AskPermissionStore(makeLogger(), tmpDir);
    const { id, promise } = store1.request('bot1', 'file_write', '/a', 'desc');
    store1.approveById(id);
    await promise;
    store1.consumeDecisionsForBot('bot1');
    store1.reportExecution([id], 'Done', [{ name: 'file_write', success: true }], true);

    const store2 = new AskPermissionStore(makeLogger(), tmpDir);
    const entry = store2.getHistoryById(id);
    expect(entry).toBeDefined();
    expect(entry!.executionStatus).toBe('executed');
    expect(entry!.executionSummary).toBe('Done');
  });

  test('backward compat: no dataDir means no persistence', () => {
    const store = new AskPermissionStore(makeLogger());
    const { id } = store.request('bot1', 'file_write', '/a', 'desc');
    store.approveById(id);
    // Should not throw — just silently skips disk operations
    expect(store.getHistory()).toHaveLength(1);
    store.dispose();
  });

  test('clearForBot removes persisted entries', async () => {
    const store1 = new AskPermissionStore(makeLogger(), tmpDir);
    const { id, promise } = store1.request('bot1', 'file_write', '/a', 'desc');
    store1.approveById(id);
    await promise;
    store1.clearForBot('bot1');

    const store2 = new AskPermissionStore(makeLogger(), tmpDir);
    expect(store2.getHistory()).toHaveLength(0);
  });
});
