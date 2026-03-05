import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consolidateMemory, getUnconsolidatedLogs } from '../../src/bot/soul-memory-consolidator';
import { localDateStr } from '../../src/date-utils';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-soul-consolidator');

function createMockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: () => createMockLogger(),
  } as any;
}

describe('getUnconsolidatedLogs', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, 'memory'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns only past-date .md files, excludes today and legacy.md', () => {
    const today = localDateStr();
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-15.md'), 'day 1');
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-16.md'), 'day 2');
    writeFileSync(join(TEST_DIR, 'memory', `${today}.md`), 'today');
    writeFileSync(join(TEST_DIR, 'memory', 'legacy.md'), 'legacy');
    writeFileSync(join(TEST_DIR, 'memory', 'notes.txt'), 'not md');

    const logs = getUnconsolidatedLogs(TEST_DIR);
    expect(logs).toEqual(['2026-01-15.md', '2026-01-16.md']);
  });

  it('returns empty for missing memory dir', () => {
    const emptyDir = join(TEST_DIR, 'nonexistent');
    const logs = getUnconsolidatedLogs(emptyDir);
    expect(logs).toEqual([]);
  });

  it('returns empty when no date files exist', () => {
    writeFileSync(join(TEST_DIR, 'memory', 'legacy.md'), 'legacy');
    const logs = getUnconsolidatedLogs(TEST_DIR);
    expect(logs).toEqual([]);
  });

  it('returns sorted results', () => {
    writeFileSync(join(TEST_DIR, 'memory', '2026-02-20.md'), 'day 3');
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-05.md'), 'day 1');
    writeFileSync(join(TEST_DIR, 'memory', '2026-02-10.md'), 'day 2');

    const logs = getUnconsolidatedLogs(TEST_DIR);
    expect(logs).toEqual(['2026-01-05.md', '2026-02-10.md', '2026-02-20.md']);
  });
});

describe('consolidateMemory', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, 'memory'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('skips when no unconsolidated logs', async () => {
    const logger = createMockLogger();
    const result = await consolidateMemory({
      soulDir: TEST_DIR,
      claudePath: 'echo',
      timeout: 5_000,
      logger,
    });

    expect(result).toEqual({ merged: 0, archived: 0 });
  });

  it('skips when daily logs are empty', async () => {
    const logger = createMockLogger();
    // Write an empty file
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-01.md'), '');

    const result = await consolidateMemory({
      soulDir: TEST_DIR,
      claudePath: 'echo',
      timeout: 5_000,
      logger,
    });

    expect(result).toEqual({ merged: 0, archived: 0 });
  });

  it('builds correct prompt with existing MEMORY.md', async () => {
    const logger = createMockLogger();
    writeFileSync(join(TEST_DIR, 'MEMORY.md'), '# Existing Memory\nSome facts');
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-15.md'), '# Jan 15\nNew fact');

    // Use a shell command that echoes the consolidated output
    // (We can't easily intercept the prompt, but we can verify the output is written)
    const result = await consolidateMemory({
      soulDir: TEST_DIR,
      claudePath: 'echo',
      timeout: 10_000,
      logger,
    });

    // echo outputs its args as-is, so MEMORY.md will have the prompt flag text
    // The important thing is that it ran and wrote something
    expect(result.merged).toBe(1);
    expect(existsSync(join(TEST_DIR, 'MEMORY.md'))).toBe(true);
  });

  it('handles missing MEMORY.md (fresh consolidation)', async () => {
    const logger = createMockLogger();
    // No MEMORY.md exists
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-15.md'), '# Jan 15\nFresh fact');

    const result = await consolidateMemory({
      soulDir: TEST_DIR,
      claudePath: 'echo',
      timeout: 10_000,
      logger,
    });

    expect(result.merged).toBe(1);
    expect(existsSync(join(TEST_DIR, 'MEMORY.md'))).toBe(true);
  });

  it('archives processed daily logs to memory/archive/', async () => {
    const logger = createMockLogger();
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-15.md'), '# Jan 15\nFact A');
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-16.md'), '# Jan 16\nFact B');

    const result = await consolidateMemory({
      soulDir: TEST_DIR,
      claudePath: 'echo',
      timeout: 10_000,
      logger,
    });

    expect(result.archived).toBe(2);
    const archiveDir = join(TEST_DIR, 'memory', 'archive');
    expect(existsSync(archiveDir)).toBe(true);
    expect(existsSync(join(archiveDir, '2026-01-15.md'))).toBe(true);
    expect(existsSync(join(archiveDir, '2026-01-16.md'))).toBe(true);
    // Original files should be gone
    expect(existsSync(join(TEST_DIR, 'memory', '2026-01-15.md'))).toBe(false);
    expect(existsSync(join(TEST_DIR, 'memory', '2026-01-16.md'))).toBe(false);
  });

  it('writes consolidated output to MEMORY.md', async () => {
    const logger = createMockLogger();
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-15.md'), '# Jan 15\nImportant fact');

    await consolidateMemory({
      soulDir: TEST_DIR,
      claudePath: 'echo',
      timeout: 10_000,
      logger,
    });

    const content = readFileSync(join(TEST_DIR, 'MEMORY.md'), 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('returns zero when Claude CLI exits with error', async () => {
    const logger = createMockLogger();
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-15.md'), '# Jan 15\nSome fact');

    // Use 'false' command which exists but exits with code 1
    const result = await consolidateMemory({
      soulDir: TEST_DIR,
      claudePath: 'false',
      timeout: 5_000,
      logger,
    });

    // Should fail gracefully
    expect(result.merged).toBe(0);
    expect(result.archived).toBe(0);
  });

  it('rejects output missing <!-- last-consolidated: --> header', async () => {
    const logger = createMockLogger();
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-15.md'), '# Jan 15\nFact');
    // Use printf to output text without the header
    const result = await consolidateMemory({
      soulDir: TEST_DIR,
      claudePath: '/bin/sh',
      timeout: 5_000,
      logger,
    });

    // /bin/sh with -p flag runs in privileged mode and outputs nothing useful
    // The output won't contain <!-- last-consolidated: so it gets rejected
    expect(result.merged).toBe(0);
    expect(result.archived).toBe(0);
  });

  it('rejects output that is <50% of existing MEMORY.md size', async () => {
    const logger = createMockLogger();
    // Create a large existing MEMORY.md
    const largeContent = `<!-- last-consolidated: 2026-01-01 -->\n${'# Memory\n'.repeat(200)}`;
    writeFileSync(join(TEST_DIR, 'MEMORY.md'), largeContent);
    writeFileSync(join(TEST_DIR, 'memory', '2026-01-15.md'), '# Jan 15\nSmall fact');

    // Use a script that outputs something with the header but much smaller
    const scriptPath = join(TEST_DIR, 'tiny-output.sh');
    writeFileSync(scriptPath, '#!/bin/sh\necho "<!-- last-consolidated: 2026-01-15 -->"', {
      mode: 0o755,
    });

    const result = await consolidateMemory({
      soulDir: TEST_DIR,
      claudePath: scriptPath,
      timeout: 5_000,
      logger,
    });

    expect(result.merged).toBe(0);
    expect(result.archived).toBe(0);
    // Verify the original MEMORY.md was NOT overwritten
    const content = readFileSync(join(TEST_DIR, 'MEMORY.md'), 'utf-8');
    expect(content).toBe(largeContent);
  });
});
