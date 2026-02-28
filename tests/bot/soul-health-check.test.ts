import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runStartupSoulCheck } from '../../src/bot/soul-health-check';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-soul-health');

function createMockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: () => createMockLogger(),
  } as any;
}

describe('runStartupSoulCheck', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    // Create required soul files so lint doesn't error on missing dir
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), '# Identity\nTest bot');
    writeFileSync(join(TEST_DIR, 'SOUL.md'), '# Soul\nTest soul');
    writeFileSync(join(TEST_DIR, 'MOTIVATIONS.md'), '# Motivations\nTest motivations');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('skips when cooldown is active', async () => {
    const logger = createMockLogger();
    // Write a recent cooldown timestamp
    writeFileSync(join(TEST_DIR, '.last-health-check'), String(Date.now()));

    await runStartupSoulCheck({
      botId: 'test-bot',
      soulDir: TEST_DIR,
      cooldownMs: 60_000,
      claudePath: 'echo', // won't be called due to cooldown
      timeout: 5_000,
      logger,
    });

    // Should log debug skip message
    expect(logger.debug).toHaveBeenCalled();
    const debugArgs = logger.debug.mock.calls.flat();
    expect(debugArgs.some((a: unknown) => String(a).includes('cooldown'))).toBe(true);
  });

  it('runs when cooldown has expired', async () => {
    const logger = createMockLogger();
    // Write an old cooldown timestamp (2 hours ago)
    writeFileSync(join(TEST_DIR, '.last-health-check'), String(Date.now() - 2 * 3600_000));

    await runStartupSoulCheck({
      botId: 'test-bot',
      soulDir: TEST_DIR,
      cooldownMs: 60_000,
      claudePath: 'echo', // stub — just needs to exit 0
      timeout: 10_000,
      logger,
    });

    // Should have written a new cooldown file
    const content = readFileSync(join(TEST_DIR, '.last-health-check'), 'utf-8');
    const ts = Number(content.trim());
    expect(Date.now() - ts).toBeLessThan(5000);
  });

  it('runs when no cooldown file exists', async () => {
    const logger = createMockLogger();

    await runStartupSoulCheck({
      botId: 'test-bot',
      soulDir: TEST_DIR,
      cooldownMs: 60_000,
      claudePath: 'echo',
      timeout: 10_000,
      logger,
    });

    // Cooldown file should now exist
    expect(existsSync(join(TEST_DIR, '.last-health-check'))).toBe(true);
  });

  it('writes cooldown file after completion', async () => {
    const logger = createMockLogger();

    await runStartupSoulCheck({
      botId: 'test-bot',
      soulDir: TEST_DIR,
      cooldownMs: 60_000,
      claudePath: 'echo',
      timeout: 10_000,
      logger,
    });

    const filepath = join(TEST_DIR, '.last-health-check');
    expect(existsSync(filepath)).toBe(true);
    const ts = Number(readFileSync(filepath, 'utf-8').trim());
    expect(Number.isFinite(ts)).toBe(true);
  });

  it('runs lint + quality review + memory consolidation concurrently', async () => {
    const logger = createMockLogger();

    await runStartupSoulCheck({
      botId: 'test-bot',
      soulDir: TEST_DIR,
      cooldownMs: 0,
      claudePath: 'echo', // both quality review and consolidation use this
      timeout: 10_000,
      logger,
      consolidateMemory: true,
    });

    // Should have completed (lint info log)
    const infoCalls = logger.info.mock.calls.flat().map(String);
    expect(infoCalls.some((s) => s.includes('lint'))).toBe(true);
  });

  it('individual step failure does not prevent other steps', async () => {
    const logger = createMockLogger();
    // Use a non-existent command to make quality review fail
    await runStartupSoulCheck({
      botId: 'test-bot',
      soulDir: TEST_DIR,
      cooldownMs: 0,
      claudePath: '/nonexistent/claude-cli-binary',
      timeout: 5_000,
      logger,
      consolidateMemory: true,
    });

    // Cooldown file should still be written (overall completion)
    expect(existsSync(join(TEST_DIR, '.last-health-check'))).toBe(true);

    // Lint should have completed even though quality review failed
    const infoCalls = logger.info.mock.calls.flat().map(String);
    expect(infoCalls.some((s) => s.includes('lint'))).toBe(true);
  });

  it('consolidateMemory: false skips memory consolidation', async () => {
    const logger = createMockLogger();
    // Create a daily log that would trigger consolidation
    mkdirSync(join(TEST_DIR, 'memory'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-01.md'), '# Old log');

    await runStartupSoulCheck({
      botId: 'test-bot',
      soulDir: TEST_DIR,
      cooldownMs: 0,
      claudePath: 'echo',
      timeout: 10_000,
      logger,
      consolidateMemory: false,
    });

    // Memory consolidation info should NOT be logged
    const infoCalls = logger.info.mock.calls.flat().map(String);
    expect(infoCalls.some((s) => s.includes('memory consolidation complete'))).toBe(false);
  });
});
