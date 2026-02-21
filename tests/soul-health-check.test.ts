import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { lintSoulDirectory, getUnconsolidatedLogs, runStartupSoulCheck } from '../src/bot/soul-health-check';
import { SoulLoader } from '../src/soul';

const TMP_DIR = join(import.meta.dir, '.tmp-soul-health-check');

const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: () => mockLogger,
} as any;

function setupSoulDir(files: Record<string, string> = {}): string {
  const soulDir = join(TMP_DIR, `soul-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(soulDir, 'memory'), { recursive: true });

  // Default files
  const defaults: Record<string, string> = {
    'IDENTITY.md': 'name: TestBot\nemoji: 🤖\nvibe: helpful',
    'SOUL.md': '## Personality\nA helpful bot.',
    'MOTIVATIONS.md': '## Impulsos centrales\n- Be helpful',
  };

  for (const [name, content] of Object.entries({ ...defaults, ...files })) {
    const filepath = join(soulDir, name);
    mkdirSync(join(soulDir, name.includes('/') ? name.split('/').slice(0, -1).join('/') : ''), { recursive: true });
    writeFileSync(filepath, content, 'utf-8');
  }

  return soulDir;
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// lintSoulDirectory
// ---------------------------------------------------------------------------

describe('lintSoulDirectory', () => {
  test('returns no issues for a valid soul directory', () => {
    const soulDir = setupSoulDir();
    const issues = lintSoulDirectory(soulDir);
    expect(issues).toEqual([]);
  });

  test('reports missing required files', () => {
    const soulDir = join(TMP_DIR, 'empty-soul');
    mkdirSync(join(soulDir, 'memory'), { recursive: true });

    const issues = lintSoulDirectory(soulDir);
    const errorFiles = issues.filter(i => i.severity === 'error').map(i => i.file);
    expect(errorFiles).toContain('IDENTITY.md');
    expect(errorFiles).toContain('SOUL.md');
    expect(errorFiles).toContain('MOTIVATIONS.md');
  });

  test('reports missing memory/ directory', () => {
    const soulDir = join(TMP_DIR, 'no-memory');
    mkdirSync(soulDir, { recursive: true });
    writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Test', 'utf-8');
    writeFileSync(join(soulDir, 'SOUL.md'), 'soul', 'utf-8');
    writeFileSync(join(soulDir, 'MOTIVATIONS.md'), 'motivations', 'utf-8');

    const issues = lintSoulDirectory(soulDir);
    const memoryIssue = issues.find(i => i.file === 'memory/');
    expect(memoryIssue).toBeDefined();
    expect(memoryIssue!.severity).toBe('warning');
  });

  test('detects duplicated headers in SOUL.md', () => {
    const soulDir = setupSoulDir({
      'SOUL.md': '## Personality\nA bot.\n\n## Your Inner Motivations\nShould not be here.',
    });

    const issues = lintSoulDirectory(soulDir);
    const soulIssues = issues.filter(i => i.file === 'SOUL.md');
    expect(soulIssues.length).toBeGreaterThan(0);
    expect(soulIssues[0].message).toContain('Your Inner Motivations');
  });

  test('detects stale placeholders in MOTIVATIONS.md', () => {
    const soulDir = setupSoulDir({
      'MOTIVATIONS.md': '## Auto-observaciones\n- (ninguna todavia — se poblara con reflexiones)',
    });

    const issues = lintSoulDirectory(soulDir);
    const motivIssues = issues.filter(i => i.file === 'MOTIVATIONS.md');
    expect(motivIssues.length).toBeGreaterThan(0);
    expect(motivIssues[0].message).toContain('stale placeholder');
  });

  test('detects multiple duplicate headers', () => {
    const soulDir = setupSoulDir({
      'SOUL.md': '## Soul\nContent\n\n## Goals\nGoal content\n\n## Impulsos centrales\nMore content',
    });

    const issues = lintSoulDirectory(soulDir);
    const soulIssues = issues.filter(i => i.file === 'SOUL.md');
    expect(soulIssues.length).toBe(2); // ## Goals + ## Impulsos centrales
  });
});

// ---------------------------------------------------------------------------
// getUnconsolidatedLogs
// ---------------------------------------------------------------------------

describe('getUnconsolidatedLogs', () => {
  test('returns empty for soul dir with no memory/', () => {
    const soulDir = join(TMP_DIR, 'no-mem');
    mkdirSync(soulDir, { recursive: true });
    expect(getUnconsolidatedLogs(soulDir)).toEqual([]);
  });

  test('returns old daily logs but not today', () => {
    const soulDir = setupSoulDir();
    const memoryDir = join(soulDir, 'memory');
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

    writeFileSync(join(memoryDir, `${today}.md`), '- today fact', 'utf-8');
    writeFileSync(join(memoryDir, `${yesterday}.md`), '- yesterday fact', 'utf-8');
    writeFileSync(join(memoryDir, `${twoDaysAgo}.md`), '- old fact', 'utf-8');

    const logs = getUnconsolidatedLogs(soulDir);
    expect(logs).toContain(`${yesterday}.md`);
    expect(logs).toContain(`${twoDaysAgo}.md`);
    expect(logs).not.toContain(`${today}.md`);
  });

  test('excludes legacy.md', () => {
    const soulDir = setupSoulDir();
    const memoryDir = join(soulDir, 'memory');
    writeFileSync(join(memoryDir, 'legacy.md'), 'legacy content', 'utf-8');
    writeFileSync(join(memoryDir, '2026-01-01.md'), 'old', 'utf-8');

    const logs = getUnconsolidatedLogs(soulDir);
    expect(logs).not.toContain('legacy.md');
    expect(logs).toContain('2026-01-01.md');
  });

  test('returns sorted results', () => {
    const soulDir = setupSoulDir();
    const memoryDir = join(soulDir, 'memory');
    writeFileSync(join(memoryDir, '2026-01-03.md'), 'c', 'utf-8');
    writeFileSync(join(memoryDir, '2026-01-01.md'), 'a', 'utf-8');
    writeFileSync(join(memoryDir, '2026-01-02.md'), 'b', 'utf-8');

    const logs = getUnconsolidatedLogs(soulDir);
    expect(logs).toEqual(['2026-01-01.md', '2026-01-02.md', '2026-01-03.md']);
  });
});

// ---------------------------------------------------------------------------
// Cooldown logic
// ---------------------------------------------------------------------------

describe('runStartupSoulCheck cooldown', () => {
  test('skips when cooldown is active', async () => {
    const soulDir = setupSoulDir();
    // Write a recent cooldown timestamp
    writeFileSync(join(soulDir, '.last-health-check'), String(Date.now()), 'utf-8');

    await runStartupSoulCheck({
      botId: 'test-bot',
      soulDir,
      cooldownMs: 86_400_000,
      claudePath: 'claude',
      timeout: 5000,
      logger: mockLogger,
    });

    // Should have logged "skipping (cooldown)"
    const debugCalls = (mockLogger.debug as any).mock.calls;
    const skipped = debugCalls.some((call: any[]) =>
      typeof call[1] === 'string' && call[1].includes('skipping (cooldown)')
    );
    expect(skipped).toBe(true);
  });

  test('runs when cooldown has expired', async () => {
    const soulDir = setupSoulDir();
    // Write an old cooldown timestamp
    writeFileSync(join(soulDir, '.last-health-check'), String(Date.now() - 100_000_000), 'utf-8');

    // Mock: the actual Claude CLI will fail but that's fine — we test that it TRIES to run
    await runStartupSoulCheck({
      botId: 'test-bot',
      soulDir,
      cooldownMs: 86_400_000,
      claudePath: '/nonexistent-claude-path',
      timeout: 2000,
      logger: mockLogger,
    });

    // Should have logged "starting"
    const infoCalls = (mockLogger.info as any).mock.calls;
    const started = infoCalls.some((call: any[]) =>
      typeof call[1] === 'string' && call[1].includes('starting')
    );
    expect(started).toBe(true);
  });

  test('runs when no cooldown file exists', async () => {
    const soulDir = setupSoulDir();

    await runStartupSoulCheck({
      botId: 'test-bot',
      soulDir,
      cooldownMs: 86_400_000,
      claudePath: '/nonexistent-claude-path',
      timeout: 2000,
      logger: mockLogger,
    });

    const infoCalls = (mockLogger.info as any).mock.calls;
    const started = infoCalls.some((call: any[]) =>
      typeof call[1] === 'string' && call[1].includes('starting')
    );
    expect(started).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// composeSystemPrompt: MEMORY.md loading
// ---------------------------------------------------------------------------

describe('SoulLoader.composeSystemPrompt with MEMORY.md', () => {
  test('loads MEMORY.md instead of legacy.md when it exists', () => {
    const soulDir = setupSoulDir({
      'MEMORY.md': '<!-- last-consolidated: 2026-02-20 -->\n## Facts\n- Important fact',
    });
    writeFileSync(join(soulDir, 'memory', 'legacy.md'), 'Legacy content that should not appear', 'utf-8');

    const loader = new SoulLoader({ enabled: true, dir: soulDir } as any, mockLogger);
    const prompt = loader.composeSystemPrompt()!;

    expect(prompt).toContain('Important fact');
    expect(prompt).not.toContain('Legacy content that should not appear');
  });

  test('falls back to legacy.md when MEMORY.md does not exist', () => {
    const soulDir = setupSoulDir();
    writeFileSync(join(soulDir, 'memory', 'legacy.md'), 'Legacy core data here', 'utf-8');

    const loader = new SoulLoader({ enabled: true, dir: soulDir } as any, mockLogger);
    const prompt = loader.composeSystemPrompt()!;

    expect(prompt).toContain('Legacy core data here');
  });

  test('loads only today daily log (not yesterday)', () => {
    const soulDir = setupSoulDir();
    const memoryDir = join(soulDir, 'memory');
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    writeFileSync(join(memoryDir, `${today}.md`), '- [10:00] Today fact', 'utf-8');
    writeFileSync(join(memoryDir, `${yesterday}.md`), '- [10:00] Yesterday fact', 'utf-8');

    const loader = new SoulLoader({ enabled: true, dir: soulDir } as any, mockLogger);
    const prompt = loader.composeSystemPrompt()!;

    expect(prompt).toContain('Today fact');
    expect(prompt).not.toContain('Yesterday fact');
  });

  test('skips old MEMORY.md migration when it has consolidation header', async () => {
    const soulDir = setupSoulDir({
      'MEMORY.md': '<!-- last-consolidated: 2026-02-20 -->\nConsolidated data',
    });

    const loader = new SoulLoader({ enabled: true, dir: soulDir } as any, mockLogger);
    await loader.initialize();

    // MEMORY.md should still be intact (not migrated to legacy.md)
    const memoryContent = readFileSync(join(soulDir, 'MEMORY.md'), 'utf-8');
    expect(memoryContent).toContain('Consolidated data');
    expect(existsSync(join(soulDir, 'memory', 'legacy.md'))).toBe(false);
  });
});
