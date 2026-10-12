import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { claudeGenerate, claudeGenerateWithTools } from '../src/claude-cli';
import { LLMAbortedError } from '../src/core/abort';
import { claudeCliSemaphore } from '../src/core/cli-semaphore';
import type { ToolDefinition } from '../src/tools/types';

function logger() {
  return { info: mock(), warn: mock(), error: mock(), debug: mock() } as any;
}

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: { name: 'slow', description: 's', parameters: { type: 'object', properties: {} } },
  },
];

/** A fake Claude process that never finishes on its own; kill() ends it like SIGTERM. */
function fakeProc() {
  let close: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    close = r;
  });
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        exited.then(() => controller.close());
      },
    });
  const proc = {
    pid: 4242,
    stdout: stream(),
    stderr: stream(),
    exited,
    kill: mock(() => close(143)),
  };
  return proc;
}

let spawnSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  spawnSpy?.mockRestore();
  spawnSpy = undefined;
  claudeCliSemaphore.setLimit(3);
});

describe('claudeGenerate cancellation', () => {
  test('abort kills the child and rejects with LLMAbortedError', async () => {
    const proc = fakeProc();
    spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(proc as any);
    const ac = new AbortController();
    const pending = claudeGenerate('hi', { logger: logger(), timeout: 60_000, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(LLMAbortedError);
    expect(proc.kill).toHaveBeenCalled();
    expect(claudeCliSemaphore.stats().active).toBe(0);
  });

  test('an already-aborted signal never spawns', async () => {
    spawnSpy = spyOn(Bun, 'spawn');
    const ac = new AbortController();
    ac.abort();
    await expect(
      claudeGenerate('hi', { logger: logger(), signal: ac.signal })
    ).rejects.toBeInstanceOf(LLMAbortedError);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test('waits for a semaphore slot; abort while queued never spawns', async () => {
    claudeCliSemaphore.setLimit(1);
    const hold = await claudeCliSemaphore.acquire('interactive');
    spawnSpy = spyOn(Bun, 'spawn');
    const ac = new AbortController();
    const pending = claudeGenerate('hi', { logger: logger(), signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    expect(claudeCliSemaphore.stats().queued).toBe(1);
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(LLMAbortedError);
    expect(spawnSpy).not.toHaveBeenCalled();
    hold();
  });
});

describe('claudeGenerateWithTools cancellation', () => {
  test('abort kills the child, waits for the in-flight tool callback, then closes the server', async () => {
    const proc = fakeProc();
    let args: string[] = [];
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((a: string[]) => {
      args = a;
      return proc;
    }) as any);

    let toolDone = false;
    let releaseTool: () => void = () => {};
    const toolExecutor = mock(
      () =>
        new Promise<{ success: boolean; content: string }>((resolve) => {
          releaseTool = () => {
            toolDone = true;
            resolve({ success: true, content: 'ok' });
          };
        })
    );

    const ac = new AbortController();
    const pending = claudeGenerateWithTools('hi', {
      logger: logger(),
      timeout: 60_000,
      tools,
      toolExecutor,
      signal: ac.signal,
    });

    // Wait for the spawn, then play the MCP bridge: call the tool via the callback server.
    while (args.length === 0) await new Promise((r) => setTimeout(r, 5));
    const cfgPath = args[args.indexOf('--mcp-config') + 1];
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const port = cfg.mcpServers['aibot-tools'].env.CALLBACK_PORT;
    const call = fetch(`http://127.0.0.1:${port}/call`, {
      method: 'POST',
      body: JSON.stringify({ name: 'slow', arguments: {} }),
    });
    while (toolExecutor.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 5));

    let settled = false;
    pending
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
    ac.abort();
    await new Promise((r) => setTimeout(r, 30));
    expect(proc.kill).toHaveBeenCalled();
    // Still waiting for the tool already in flight.
    expect(settled).toBe(false);

    releaseTool();
    await expect(pending).rejects.toBeInstanceOf(LLMAbortedError);
    expect(toolDone).toBe(true);
    await call.catch(() => undefined);
    // The callback server is closed: a late bridge call fails.
    await expect(
      fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', body: '{}' })
    ).rejects.toThrow();
    expect(claudeCliSemaphore.stats().active).toBe(0);
  });
});
