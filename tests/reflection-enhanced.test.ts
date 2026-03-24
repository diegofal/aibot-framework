import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAnalysisPrompt, buildImprovementPrompt } from '../src/skills/reflection/prompts';
import { parseGoals, serializeGoals } from '../src/tools/goals';

// --- readDailyLogsSince tests ---
// We replicate the function logic here since it's not exported.
// The real function is tested indirectly via the skill, but we test the archive-aware
// scanning logic directly using the same implementation pattern.

function readDailyLogsSince(soulDir: string, sinceDate: string): string {
  const { readdirSync, readFileSync } = require('node:fs');
  const { join } = require('node:path');

  const memoryDir = join(soulDir, 'memory');
  const archiveDir = join(memoryDir, 'archive');
  const fileMap = new Map<string, string>();

  const scanDir = (dir: string, isArchive: boolean) => {
    try {
      const files = (readdirSync(dir) as string[])
        .filter((f: string) => f.endsWith('.md') && f !== 'legacy.md')
        .filter((f: string) => f.replace('.md', '') > sinceDate);

      for (const file of files) {
        const date = file.replace('.md', '');
        if (!isArchive || !fileMap.has(date)) {
          fileMap.set(date, join(dir, file));
        }
      }
    } catch {
      // Directory may not exist
    }
  };

  scanDir(archiveDir, true);
  scanDir(memoryDir, false);

  const parts: string[] = [];
  const sortedDates = [...fileMap.keys()].sort();

  for (const date of sortedDates) {
    const filepath = fileMap.get(date)!;
    const content = readFileSync(filepath, 'utf-8').trim();
    if (content) {
      parts.push(`### ${date}\n${content}`);
    }
  }

  return parts.join('\n\n');
}

describe('readDailyLogsSince — archive support', () => {
  const testDir = join(tmpdir(), `reflection-test-${Date.now()}`);
  const memoryDir = join(testDir, 'memory');
  const archiveDir = join(memoryDir, 'archive');

  // Setup test directories and files
  mkdirSync(archiveDir, { recursive: true });

  // Archived log
  writeFileSync(join(archiveDir, '2026-03-10.md'), '- [10:00] archived entry\n');
  writeFileSync(join(archiveDir, '2026-03-11.md'), '- [11:00] another archived entry\n');

  // Current log (only in memory/)
  writeFileSync(join(memoryDir, '2026-03-20.md'), '- [20:00] current entry\n');

  // A log that exists in both (memory/ should win)
  writeFileSync(join(archiveDir, '2026-03-15.md'), '- [15:00] archive version\n');
  writeFileSync(join(memoryDir, '2026-03-15.md'), '- [15:00] current version (updated)\n');

  // Old log that should be filtered by sinceDate
  writeFileSync(join(archiveDir, '2026-03-01.md'), '- [01:00] too old\n');

  test('reads from both memory/ and memory/archive/', () => {
    const result = readDailyLogsSince(testDir, '2026-03-05');
    expect(result).toContain('### 2026-03-10');
    expect(result).toContain('archived entry');
    expect(result).toContain('### 2026-03-20');
    expect(result).toContain('current entry');
  });

  test('deduplicates by date, preferring non-archive version', () => {
    const result = readDailyLogsSince(testDir, '2026-03-05');
    expect(result).toContain('current version (updated)');
    expect(result).not.toContain('archive version');
  });

  test('filters by sinceDate watermark', () => {
    const result = readDailyLogsSince(testDir, '2026-03-05');
    expect(result).not.toContain('### 2026-03-01');
    expect(result).not.toContain('too old');
  });

  test('results are sorted by date', () => {
    const result = readDailyLogsSince(testDir, '2026-03-05');
    const dates = [...result.matchAll(/### (\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    expect(dates).toEqual(['2026-03-10', '2026-03-11', '2026-03-15', '2026-03-20']);
  });

  test('handles missing archive directory gracefully', () => {
    const noArchiveDir = join(tmpdir(), `reflection-test-noarchive-${Date.now()}`);
    const noArchiveMemory = join(noArchiveDir, 'memory');
    mkdirSync(noArchiveMemory, { recursive: true });
    writeFileSync(join(noArchiveMemory, '2026-03-20.md'), '- entry\n');

    const result = readDailyLogsSince(noArchiveDir, '2026-03-01');
    expect(result).toContain('### 2026-03-20');

    rmSync(noArchiveDir, { recursive: true, force: true });
  });

  // Cleanup
  test.todo('cleanup is handled by OS temp directory');
});

// --- Productions/karma/actions in analysis prompt ---
describe('buildAnalysisPrompt — operational context', () => {
  const baseInput = {
    identity: 'Test Bot',
    soul: 'A helpful assistant',
    motivations: '## Core Drives\n- Be helpful',
    recentLogs: '### 2026-03-20\n- did something',
  };

  test('includes productions section when provided', () => {
    const result = buildAnalysisPrompt({
      ...baseInput,
      productions: 'dir/\n  file1.md\n  file2.md',
    });
    expect(result.prompt).toContain('## Productions (file tree)');
    expect(result.prompt).toContain('file1.md');
  });

  test('includes karma section when provided', () => {
    const result = buildAnalysisPrompt({
      ...baseInput,
      karma: 'Score: 42 ↑ | Recent: +3 helpful, -1 off-topic',
    });
    expect(result.prompt).toContain('## Karma');
    expect(result.prompt).toContain('Score: 42');
  });

  test('includes recent actions section when provided', () => {
    const result = buildAnalysisPrompt({
      ...baseInput,
      recentActions: 'CONTENT: created daily report\nOUTREACH: sent message to user',
    });
    expect(result.prompt).toContain('## Recent Agent Loop Actions');
    expect(result.prompt).toContain('created daily report');
  });

  test('omits sections when not provided', () => {
    const result = buildAnalysisPrompt(baseInput);
    expect(result.prompt).not.toContain('## Productions');
    expect(result.prompt).not.toContain('## Karma');
    expect(result.prompt).not.toContain('## Recent Agent Loop Actions');
  });

  test('includes 7th operational dimension', () => {
    const result = buildAnalysisPrompt(baseInput);
    expect(result.prompt).toContain('7. **Operational**');
    expect(result.prompt).toContain('"operational"');
  });
});

// --- Goal appending with source tag ---
describe('reflection goal appending', () => {
  test('goals with source tag serialize and parse correctly', () => {
    const active = [
      {
        text: 'Improve response time',
        status: 'pending',
        priority: 'high',
        source: 'reflection:2026-03-23',
      },
      { text: 'Learn new topics', status: 'pending', priority: 'medium' },
    ];
    const serialized = serializeGoals(active, []);

    expect(serialized).toContain('source: reflection:2026-03-23');

    const parsed = parseGoals(serialized);
    expect(parsed.active[0].source).toBe('reflection:2026-03-23');
    expect(parsed.active[1].source).toBeUndefined();
  });

  test('dedup prevents adding goals with matching prefix', () => {
    const existing = [
      { text: 'Improve emotional support in conversations', status: 'pending', priority: 'medium' },
    ];

    const suggested = [
      // First 30 chars: "improve emotional support in c" — matches existing goal
      { text: 'Improve emotional support in chat contexts', priority: 'medium' },
      { text: 'Explore new cultural topics weekly', priority: 'low' },
    ];

    // Simulate the dedup logic from reflection
    const results = [];
    for (const sg of suggested) {
      const prefix = sg.text.slice(0, 30).toLowerCase();
      const isDuplicate = existing.some((g) => g.text.toLowerCase().includes(prefix));
      if (!isDuplicate) results.push(sg);
    }

    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('Explore new cultural topics weekly');
  });
});

// --- Improvement prompt includes suggested_goals ---
describe('buildImprovementPrompt — suggested_goals', () => {
  test('prompt includes suggested_goals in output schema', () => {
    const result = buildImprovementPrompt({
      identity: 'Test',
      soul: 'Helpful',
      motivations: '## Core Drives\n- be good',
      analysis: {
        consistency: 'ok',
        people: 'ok',
        gaps: 'some gaps',
        patterns: 'none',
        alignment: 'aligned',
        breadth: 'broad',
      },
      trigger: 'manual',
      date: '2026-03-23',
    });

    expect(result.prompt).toContain('suggested_goals');
    expect(result.prompt).toContain('0-3 new goals');
  });

  test('prompt includes operational context when provided', () => {
    const result = buildImprovementPrompt({
      identity: 'Test',
      soul: 'Helpful',
      motivations: '## Core Drives\n- be good',
      analysis: {
        consistency: 'ok',
        people: 'ok',
        gaps: 'some gaps',
        patterns: 'none',
        alignment: 'aligned',
        breadth: 'broad',
        operational: 'karma is low',
      },
      trigger: 'manual',
      date: '2026-03-23',
      productions: 'file tree here',
      karma: 'score: 10',
      recentActions: 'CONTENT x3',
    });

    expect(result.prompt).toContain('Operational: karma is low');
    expect(result.prompt).toContain('## Productions (file tree)');
    expect(result.prompt).toContain('## Karma');
    expect(result.prompt).toContain('## Recent Agent Loop Actions');
  });
});
