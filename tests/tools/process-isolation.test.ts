import { afterEach, describe, expect, test, vi } from 'bun:test';
import type { Subprocess } from 'bun';
import type { Logger } from '../../src/logger';
import {
  type ProcessToolConfig,
  createProcessTool,
  registerProcess,
} from '../../src/tools/process';

function makeLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

/**
 * Create a mock subprocess that immediately exits.
 * We just need an object with the right shape — no real process.
 */
function mockProc(exitCode = 0): Subprocess {
  let resolveExited: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    resolveExited = r;
  });

  const proc = {
    pid: Math.floor(Math.random() * 100000),
    stdout: null,
    stderr: null,
    stdin: null,
    exited: exitedPromise,
    kill: vi.fn(() => {
      resolveExited(exitCode);
    }),
    killed: false,
    exitCode: null,
    signalCode: null,
    ref: vi.fn(),
    unref: vi.fn(),
  } as unknown as Subprocess;

  // Auto-exit after a tick
  setTimeout(() => resolveExited(exitCode), 5);

  return proc;
}

const config: ProcessToolConfig = { maxSessions: 10, maxOutputChars: 10000, finishedTtlMs: 60000 };

describe('process tool per-bot isolation', () => {
  test('registerProcess prefixes session ID with botId', () => {
    const logger = makeLogger();
    const proc = mockProc();

    const { sessionId } = registerProcess('alpha', 'echo hello', proc, config, logger);
    expect(sessionId.startsWith('alpha_proc_')).toBe(true);
  });

  test('sessions from different bots have different prefixes', () => {
    const logger = makeLogger();

    const { sessionId: idA } = registerProcess('alpha', 'echo a', mockProc(), config, logger);
    const { sessionId: idB } = registerProcess('beta', 'echo b', mockProc(), config, logger);

    expect(idA.startsWith('alpha_proc_')).toBe(true);
    expect(idB.startsWith('beta_proc_')).toBe(true);
    expect(idA).not.toBe(idB);
  });

  test('list action only shows sessions for the calling bot', async () => {
    const logger = makeLogger();
    const tool = createProcessTool(config);

    registerProcess('alpha', 'echo alpha', mockProc(), config, logger);
    registerProcess('beta', 'echo beta', mockProc(), config, logger);

    // List as alpha
    const resultA = await tool.execute({ action: 'list', _botId: 'alpha' }, logger);
    expect(resultA.success).toBe(true);
    expect(resultA.content).toContain('alpha');
    expect(resultA.content).not.toContain('beta_proc_');

    // List as beta
    const resultB = await tool.execute({ action: 'list', _botId: 'beta' }, logger);
    expect(resultB.success).toBe(true);
    expect(resultB.content).toContain('beta');
    expect(resultB.content).not.toContain('alpha_proc_');
  });

  test('list returns "No background processes" for bot with no sessions', async () => {
    const logger = makeLogger();
    const tool = createProcessTool(config);

    registerProcess('alpha', 'echo alpha', mockProc(), config, logger);

    const result = await tool.execute({ action: 'list', _botId: 'gamma' }, logger);
    expect(result.content).toBe('No background processes.');
  });

  test('poll fails when session belongs to another bot', async () => {
    const logger = makeLogger();
    const tool = createProcessTool(config);

    const { sessionId } = registerProcess('alpha', 'echo test', mockProc(), config, logger);

    // Try to poll from beta
    const result = await tool.execute(
      { action: 'poll', session_id: sessionId, _botId: 'beta' },
      logger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('belongs to another bot');
  });

  test('kill fails when session belongs to another bot', async () => {
    const logger = makeLogger();
    const tool = createProcessTool(config);

    const proc = mockProc();
    // Prevent auto-exit so the process stays active
    const neverResolve = new Promise<number>(() => {});
    (proc as any).exited = neverResolve;

    const { sessionId } = registerProcess('alpha', 'sleep 100', proc, config, logger);

    // Try to kill from beta
    const result = await tool.execute(
      { action: 'kill', session_id: sessionId, _botId: 'beta' },
      logger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('belongs to another bot');
  });

  test('write fails when session belongs to another bot', async () => {
    const logger = makeLogger();
    const tool = createProcessTool(config);

    const proc = mockProc();
    (proc as any).exited = new Promise<number>(() => {});

    const { sessionId } = registerProcess('alpha', 'cat', proc, config, logger);

    const result = await tool.execute(
      { action: 'write', session_id: sessionId, input: 'hello', _botId: 'beta' },
      logger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('belongs to another bot');
  });

  test('clear fails when finished session belongs to another bot', async () => {
    const logger = makeLogger();
    const tool = createProcessTool(config);

    const { sessionId } = registerProcess('alpha', 'echo done', mockProc(0), config, logger);

    // Wait for process to finish
    await new Promise((r) => setTimeout(r, 20));

    // Try to clear from beta
    const result = await tool.execute(
      { action: 'clear', session_id: sessionId, _botId: 'beta' },
      logger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('belongs to another bot');
  });

  test('max sessions limit is per-bot', () => {
    const logger = makeLogger();
    const limitedConfig: ProcessToolConfig = {
      maxSessions: 2,
      maxOutputChars: 10000,
      finishedTtlMs: 60000,
    };

    // Use unique bot names to avoid leakage from other tests
    const botA = `limit-testA-${Date.now()}`;
    const botB = `limit-testB-${Date.now()}`;

    // Each proc needs to stay alive
    const makeAliveProc = () => {
      const p = mockProc();
      (p as any).exited = new Promise<number>(() => {});
      return p;
    };

    // Register 2 for botA — should succeed
    registerProcess(botA, 'cmd1', makeAliveProc(), limitedConfig, logger);
    registerProcess(botA, 'cmd2', makeAliveProc(), limitedConfig, logger);

    // 3rd for botA should fail
    expect(() => {
      registerProcess(botA, 'cmd3', makeAliveProc(), limitedConfig, logger);
    }).toThrow(/Max background sessions/);

    // botB should still be able to register (separate limit)
    expect(() => {
      registerProcess(botB, 'cmd1', makeAliveProc(), limitedConfig, logger);
    }).not.toThrow();
  });
});
