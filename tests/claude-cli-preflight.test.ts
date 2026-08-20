import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { checkClaudeCli, formatPreflight } from '../src/bot/claude-cli-preflight';

const realPlatform = process.platform;

/**
 * Run `fn` with `process.platform` forced, always restoring the real value.
 * Awaits `fn` before restoring — a synchronous restore would put the platform
 * back before the probe's own awaits resume, and the override would do nothing.
 */
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
}

/** PATH lookup that resolves only the listed commands. */
function fakeWhich(installed: string[]) {
  return (command: string): string | null =>
    installed.includes(command) ? `/fake/bin/${command}` : null;
}

/** `claude --version` stub that records the argv it was handed. */
function fakeRun(result: { exitCode: number; stdout: string } | Error) {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (result instanceof Error) throw result;
    return result;
  };
  return Object.assign(run, { calls });
}

const VERSION_OK = { exitCode: 0, stdout: '2.1.237 (Claude Code)\n' };

describe('checkClaudeCli', () => {
  test('reports unavailable when the binary is not on PATH', async () => {
    const run = fakeRun(VERSION_OK);
    const result = await checkClaudeCli({
      claudePath: 'claude',
      which: fakeWhich([]),
      run,
      configDir: '/cfg',
      exists: async () => true,
    });

    expect(result.available).toBe(false);
    expect(result.reason).toContain('PATH');
    // No point spawning a binary we already know is absent.
    expect(run.calls).toEqual([]);
  });

  test('reports the version when the binary answers --version', async () => {
    const run = fakeRun(VERSION_OK);
    const result = await checkClaudeCli({
      claudePath: 'claude',
      which: fakeWhich(['claude']),
      run,
      configDir: '/cfg',
      exists: async () => true,
    });

    expect(result.available).toBe(true);
    expect(result.version).toBe('2.1.237');
    expect(run.calls[0]).toEqual(['claude', '--version']);
  });

  test('stays available but version-less when the output has no version string', async () => {
    const result = await checkClaudeCli({
      claudePath: 'claude',
      which: fakeWhich(['claude']),
      run: fakeRun({ exitCode: 0, stdout: 'something unexpected' }),
      configDir: '/cfg',
      exists: async () => true,
    });

    expect(result.available).toBe(true);
    expect(result.version).toBeUndefined();
  });

  test('reports unavailable when --version exits non-zero', async () => {
    const result = await checkClaudeCli({
      claudePath: 'claude',
      which: fakeWhich(['claude']),
      run: fakeRun({ exitCode: 127, stdout: '' }),
      configDir: '/cfg',
      exists: async () => true,
    });

    expect(result.available).toBe(false);
    expect(result.reason).toContain('127');
  });

  test('reports unavailable when the probe throws (timeout, ENOENT)', async () => {
    const result = await checkClaudeCli({
      claudePath: 'claude',
      which: fakeWhich(['claude']),
      run: fakeRun(new Error('probe timed out')),
      configDir: '/cfg',
      exists: async () => true,
    });

    expect(result.available).toBe(false);
    expect(result.reason).toContain('probe timed out');
  });

  test('finds credentials in the configured directory', async () => {
    const probed: string[] = [];
    const result = await checkClaudeCli({
      claudePath: 'claude',
      which: fakeWhich(['claude']),
      run: fakeRun(VERSION_OK),
      configDir: '/app/data/claude',
      exists: async (path) => {
        probed.push(path);
        return true;
      },
    });

    expect(result.credentials).toBe('present');
    expect(result.configDir).toBe('/app/data/claude');
    expect(probed).toContain(join('/app/data/claude', '.credentials.json'));
  });

  test('reports missing credentials when the file is absent', async () => {
    const result = await withPlatform('linux', () =>
      checkClaudeCli({
        claudePath: 'claude',
        which: fakeWhich(['claude']),
        run: fakeRun(VERSION_OK),
        configDir: '/app/data/claude',
        exists: async () => false,
      })
    );

    expect(result.credentials).toBe('missing');
  });

  test('does not claim missing credentials on darwin, where they live in the Keychain', async () => {
    const result = await withPlatform('darwin', () =>
      checkClaudeCli({
        claudePath: 'claude',
        which: fakeWhich(['claude']),
        run: fakeRun(VERSION_OK),
        configDir: '/Users/x/.claude',
        exists: async () => false,
      })
    );

    expect(result.credentials).toBe('unknown');
  });

  test('does not probe credentials when the binary is missing', async () => {
    const result = await checkClaudeCli({
      claudePath: 'claude',
      which: fakeWhich([]),
      run: fakeRun(VERSION_OK),
      configDir: '/cfg',
      exists: async () => {
        throw new Error('should not be called');
      },
    });

    expect(result.credentials).toBe('unknown');
  });

  test('falls back to CLAUDE_CONFIG_DIR when no directory is passed', async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/env/config/dir';
    try {
      const result = await checkClaudeCli({
        claudePath: 'claude',
        which: fakeWhich(['claude']),
        run: fakeRun(VERSION_OK),
        exists: async () => true,
      });
      expect(result.configDir).toBe('/env/config/dir');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});

describe('formatPreflight', () => {
  test('describes a healthy install', () => {
    const line = formatPreflight({
      available: true,
      version: '2.1.237',
      configDir: '/app/data/claude',
      credentials: 'present',
    });
    expect(line).toContain('2.1.237');
    expect(line).toContain('/app/data/claude');
  });

  test('describes a missing binary with its reason', () => {
    const line = formatPreflight({
      available: false,
      configDir: '/app/data/claude',
      credentials: 'unknown',
      reason: 'not found on PATH',
    });
    expect(line).toContain('not found on PATH');
  });

  test('calls out an authenticated-but-unlogged install', () => {
    const line = formatPreflight({
      available: true,
      version: '2.1.237',
      configDir: '/app/data/claude',
      credentials: 'missing',
    });
    expect(line).toMatch(/not logged in|claude auth login/i);
  });
});
