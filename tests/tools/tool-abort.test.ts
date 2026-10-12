import { describe, expect, mock, test } from 'bun:test';
import { createBrowserTool } from '../../src/tools/browser';
import { createExecTool } from '../../src/tools/exec';
import { createWebFetchTool } from '../../src/tools/web-fetch';

const logger = { debug: mock(), info: mock(), warn: mock(), error: mock() } as any;

describe('exec honours _signal', () => {
  test('abort kills a running command and returns a stopped result', async () => {
    const tool = createExecTool({ timeout: 30_000 });
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 300);
    const res = await tool.execute({ command: 'sleep 20', _signal: ac.signal }, logger);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(res.success).toBe(false);
    expect(res.content).toContain('Stopped');
  }, 20_000);

  test('an already-aborted signal never spawns', async () => {
    const tool = createExecTool();
    const ac = new AbortController();
    ac.abort();
    const res = await tool.execute({ command: 'echo hi', _signal: ac.signal }, logger);
    expect(res.success).toBe(false);
    expect(res.content).toContain('Stopped');
  });

  test('without _signal the command runs as before', async () => {
    const res = await createExecTool().execute({ command: 'echo hi' }, logger);
    expect(res.success).toBe(true);
    expect(res.content).toContain('hi');
  });
});

describe('web_fetch honours _signal', () => {
  test('passes a signal that aborts with the caller and returns a stopped result', async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchImpl = mock((_url: unknown, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      });
    }) as unknown as typeof fetch;
    const tool = createWebFetchTool({ fetchImpl });
    const pending = tool.execute({ url: 'https://example.com/a', _signal: ac.signal }, logger);
    await new Promise((r) => setTimeout(r, 5));
    expect(seen?.aborted).toBe(false);
    ac.abort();
    const res = await pending;
    expect(seen?.aborted).toBe(true);
    expect(res.success).toBe(false);
    expect(res.content).toContain('Stopped');
  });
});

describe('browser honours _signal', () => {
  test('an already-aborted signal does nothing', async () => {
    const tool = createBrowserTool({} as any);
    const ac = new AbortController();
    ac.abort();
    const res = await tool.execute(
      { action: 'navigate', url: 'https://example.com', _botId: 'b', _signal: ac.signal },
      logger
    );
    expect(res.success).toBe(false);
    expect(res.content).toContain('Stopped');
  });
});
