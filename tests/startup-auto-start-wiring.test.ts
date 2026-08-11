/**
 * How auto-start is wired into the boot sequence.
 *
 * The behaviour of the policy itself is covered by `tests/bot/auto-start.test.ts`.
 * What cannot be unit-tested is the *placement* of the call inside
 * `src/index.ts`: running `main()` needs a real config, a reachable Ollama and
 * live Telegram tokens, and starting a bot for real would take the token away
 * from whatever else is polling it. So the ordering guarantees are asserted
 * against the source, in the same spirit as `seeded-deployment-inert.test.ts`
 * asserting on the shipped entrypoint script.
 *
 * Each assertion below is a property someone could plausibly break by moving a
 * few lines, and each one, broken, is an outage or a double-poller.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';

const REPO_ROOT = join(import.meta.dir, '..');
const INDEX_SOURCE = readFileSync(join(REPO_ROOT, 'src', 'index.ts'), 'utf-8');

const TEST_DIR = join(tmpdir(), `auto-start-wiring-${Date.now()}`);

function writeConfig(extra: Record<string, unknown> = {}): string {
  const configPath = join(TEST_DIR, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      ollama: { baseUrl: 'http://127.0.0.1:11434', models: { primary: 'llama3' } },
      skills: { enabled: [], config: {} },
      logging: { level: 'error' },
      paths: { data: './data', logs: './data/logs', skills: './src/skills' },
      ...extra,
    })
  );
  writeFileSync(join(TEST_DIR, 'bots.json'), '[]');
  return configPath;
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe('startup.autoStartBots', () => {
  test('defaults to true — an unattended restart must heal itself', async () => {
    const config = await loadConfig(writeConfig());
    expect(config.startup.autoStartBots).toBe(true);
  });

  test('can be turned off in the config file', async () => {
    const config = await loadConfig(writeConfig({ startup: { autoStartBots: false } }));
    expect(config.startup.autoStartBots).toBe(false);
  });
});

describe('src/index.ts boot sequence', () => {
  const idxOf = (needle: string): number => {
    const idx = INDEX_SOURCE.indexOf(needle);
    expect(idx, `expected src/index.ts to contain ${needle}`).toBeGreaterThan(-1);
    return idx;
  };

  test('calls autoStartEnabledBots exactly once', () => {
    const occurrences = INDEX_SOURCE.split('autoStartEnabledBots({').length - 1;
    expect(occurrences).toBe(1);
  });

  test('reads the escape hatch through resolveAutoStart(startup.autoStartBots)', () => {
    expect(INDEX_SOURCE).toContain('resolveAutoStart(');
    expect(INDEX_SOURCE).toContain('config.startup.autoStartBots');
    // Guarded by the decision, not called unconditionally.
    expect(idxOf('resolveAutoStart(')).toBeLessThan(idxOf('autoStartEnabledBots({'));
  });

  test('--job mode returns before anything can start a bot', () => {
    const jobBranch = idxOf('if (runSingleJob)');
    const autoStart = idxOf('autoStartEnabledBots({');
    expect(jobBranch).toBeLessThan(autoStart);

    // Every path out of the single-job branch leaves main(): a completed job
    // returns, a missing job exits non-zero. Nothing falls through into the
    // long-running boot path, so a cron-style one-shot never polls Telegram.
    const branch = INDEX_SOURCE.slice(jobBranch, autoStart);
    const jobBranchBody = branch.slice(0, branch.indexOf('\n\n    //'));
    expect(jobBranchBody).toContain('return;');
    expect(jobBranchBody).toContain('process.exit(1)');
  });

  test('the web server is started before bots, so the dashboard survives a failed start', () => {
    expect(idxOf('startWebServer({')).toBeLessThan(idxOf('autoStartEnabledBots({'));
  });

  test('signal handlers are registered before bots are started', () => {
    // Starting N bots is the slowest part of boot; a SIGTERM arriving during it
    // must still reach the graceful shutdown path.
    expect(idxOf("process.on('SIGTERM', shutdown)")).toBeLessThan(idxOf('autoStartEnabledBots({'));
  });

  test('auto-start is told when shutdown has begun', () => {
    expect(INDEX_SOURCE).toContain('isShuttingDown: () => shuttingDown');
  });
});
