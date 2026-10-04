/**
 * Cycle 4 — html.ts Red tests.
 *
 * Pinning the contract of src/productions/html.ts. Per
 * docs/architecture-docs/productions-refactor.md §4 C4, this module
 * extracts the HTML index generator + goals reader + 4 formatters
 * (formatDatetime, escHtml, fileIcon, formatSize) from ProductionsService.
 *
 * Pure functions on the file system's view (no mutable state). The
 * rebuildIndexPure function is the pure form of the existing rebuildIndex
 * — it does not call runCleanup. The facade in Cycle 8 composes
 * runCleanup + rebuildIndexPure once per cleanup.
 *
 * Per-function coverage: each function gets its own describe block with
 * branch tests (per the TDD rule in CLAUDE.md §"Flujo TDD obligatorio").
 *
 * Cycle 4.1 writes these tests (Red). Cycle 4.3 creates the module
 * (Green). Cycle 4.4 wires service.ts to delegate to it.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildIndexHtml,
  escHtml,
  fileIcon,
  formatDatetime,
  formatSize,
  getFileDescription,
  parseFirstSectionAsBullets,
  readActiveGoals,
} from '../../src/productions/html';

// ---------------------------------------------------------------------------
// formatDatetime
// ---------------------------------------------------------------------------

describe('formatDatetime', () => {
  test('formats a Date as YYYY-MM-DD HH:mm in UTC', () => {
    const d = new Date('2025-01-15T14:30:00.000Z');
    expect(formatDatetime(d)).toBe('2025-01-15 14:30');
  });

  test('zero-pads single-digit month and day', () => {
    const d = new Date('2025-03-05T09:05:00.000Z');
    expect(formatDatetime(d)).toBe('2025-03-05 09:05');
  });

  test('zero-pads single-digit hour and minute', () => {
    const d = new Date('2025-12-31T01:02:00.000Z');
    expect(formatDatetime(d)).toBe('2025-12-31 01:02');
  });

  test('handles end-of-year date', () => {
    const d = new Date('2025-12-31T23:59:00.000Z');
    expect(formatDatetime(d)).toBe('2025-12-31 23:59');
  });
});

// ---------------------------------------------------------------------------
// escHtml
// ---------------------------------------------------------------------------

describe('escHtml', () => {
  test('escapes ampersand', () => {
    expect(escHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  test('escapes less-than', () => {
    expect(escHtml('a < b')).toBe('a &lt; b');
  });

  test('escapes greater-than', () => {
    expect(escHtml('a > b')).toBe('a &gt; b');
  });

  test('escapes double-quote', () => {
    expect(escHtml('say "hi"')).toBe('say &quot;hi&quot;');
  });

  test('escapes all four in sequence (order matters)', () => {
    // The order of regex replaces is & first, then <, >, ". The ampersand
    // must be the first replacement so subsequent &-introductions are
    // not themselves escaped.
    expect(escHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;\'');
  });

  test('does not escape single-quote (CSS attribute-style, not HTML-attribute-encoding)',
    () => {
      expect(escHtml("it's")).toBe("it's");
    }
  );

  test('escapes empty string as empty string', () => {
    expect(escHtml('')).toBe('');
  });

  test('escapes XSS-style input', () => {
    expect(escHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });
});

// ---------------------------------------------------------------------------
// fileIcon
// ---------------------------------------------------------------------------

describe('fileIcon', () => {
  test('markdown files get the memo emoji', () => {
    expect(fileIcon('readme.md')).toBe('\u{1F4DD}');
  });

  test('html files get the globe emoji', () => {
    expect(fileIcon('page.html')).toBe('\u{1F310}');
  });

  test('json files get the clipboard emoji', () => {
    expect(fileIcon('data.json')).toBe('\u{1F4CB}');
  });

  test('csv and tsv files get the chart emoji', () => {
    expect(fileIcon('table.csv')).toBe('\u{1F4CA}');
    expect(fileIcon('table.tsv')).toBe('\u{1F4CA}');
  });

  test('code files (py, ts, js) get the laptop emoji', () => {
    expect(fileIcon('script.py')).toBe('\u{1F4BB}');
    expect(fileIcon('module.ts')).toBe('\u{1F4BB}');
    expect(fileIcon('app.js')).toBe('\u{1F4BB}');
  });

  test('unknown extensions get the document emoji', () => {
    expect(fileIcon('data.bin')).toBe('\u{1F4C4}');
    expect(fileIcon('file.unknownextension')).toBe('\u{1F4C4}');
    expect(fileIcon('noextension')).toBe('\u{1F4C4}');
  });

  test('extension match is case-sensitive (only lowercase)', () => {
    // The implementation uses endsWith('.md') which is case-sensitive.
    // .MD files get the default document icon.
    expect(fileIcon('README.MD')).toBe('\u{1F4C4}');
  });
});

// ---------------------------------------------------------------------------
// formatSize
// ---------------------------------------------------------------------------

describe('formatSize', () => {
  test('bytes < 1024 use B suffix', () => {
    expect(formatSize(0)).toBe('0B');
    expect(formatSize(500)).toBe('500B');
    expect(formatSize(1023)).toBe('1023B');
  });

  test('bytes < 1024*1024 use KB suffix with one decimal', () => {
    expect(formatSize(1024)).toBe('1.0KB');
    expect(formatSize(1536)).toBe('1.5KB');
    expect(formatSize(1024 * 1023)).toBe('1023.0KB');
  });

  test('bytes >= 1024*1024 use MB suffix with one decimal', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0MB');
    expect(formatSize(1024 * 1024 * 5)).toBe('5.0MB');
  });
});

// ---------------------------------------------------------------------------
// parseFirstSectionAsBullets
// ---------------------------------------------------------------------------

describe('parseFirstSectionAsBullets', () => {
  test('returns empty array for empty content', () => {
    expect(parseFirstSectionAsBullets('')).toEqual([]);
  });

  test('returns empty for content without a section heading', () => {
    const content = 'just some text\n- bullet 1';
    expect(parseFirstSectionAsBullets(content)).toEqual([]);
  });

  test('parses plain bullet items', () => {
    const content = '## Goals\n- item 1\n- item 2\n';
    expect(parseFirstSectionAsBullets(content)).toEqual([
      { text: 'item 1', status: 'pending', priority: 'medium' },
      { text: 'item 2', status: 'pending', priority: 'medium' },
    ]);
  });

  test('parses bold-prefixed bullets with continuation', () => {
    const content = '## Goals\n- **bold title**: description here\n- **another**\n';
    expect(parseFirstSectionAsBullets(content)).toEqual([
      { text: 'bold title: description here', status: 'pending', priority: 'medium' },
      { text: 'another', status: 'pending', priority: 'medium' },
    ]);
  });

  test('stops at the second ## section', () => {
    const content = '## First\n- item 1\n## Second\n- item 2\n';
    expect(parseFirstSectionAsBullets(content)).toEqual([
      { text: 'item 1', status: 'pending', priority: 'medium' },
    ]);
  });

  test('skips checkbox-style bullets (the [ ] prefix)', () => {
    const content = '## Goals\n- [ ] unfinished\n- done\n';
    expect(parseFirstSectionAsBullets(content)).toEqual([
      { text: 'done', status: 'pending', priority: 'medium' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// readActiveGoals
// ---------------------------------------------------------------------------

describe('readActiveGoals', () => {
  test('returns empty array for missing GOALS.md', () => {
    // Pass an obviously non-existent soul dir.
    expect(readActiveGoals('.test-read-active-goals-does-not-exist')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getFileDescription
// ---------------------------------------------------------------------------

describe('getFileDescription', () => {
  test('returns changelog description when present (not file_write/file_edit)', () => {
    const descMap = new Map([
      ['report.md', 'First-quarter analysis report'],
      ['auto.md', 'file_write: boring auto description'],
    ]);
    expect(getFileDescription('report.md', descMap, '/nonexistent')).toBe(
      'First-quarter analysis report'
    );
  });

  test('skips file_write: prefix in changelog (falls through to next source)', () => {
    const descMap = new Map([
      ['report.md', 'file_write: auto description'],
    ]);
    // The fallback path needs an existing .md file to extract from, OR
    // and existing map value, etc. Use a path that does not exist -
    // the function will fall through to humanize.
    const result = getFileDescription('report.md', descMap, '/nonexistent/report.md');
    // The path falls through to humanize since the file doesn't exist.
    expect(result).toBe('Report');
  });

  test('humanizes filename (strips number prefix, title-cases)', () => {
    const descMap = new Map<string, string>();
    expect(getFileDescription('01_my-report.md', descMap, '/nonexistent')).toBe('My Report');
    expect(getFileDescription('02_some_cool_file.md', descMap, '/nonexistent')).toBe(
      'Some Cool File'
    );
  });

  test('truncates long humanized filename to 60 chars', () => {
    const descMap = new Map<string, string>();
    const longName = 'a'.repeat(100);
    const result = getFileDescription(`${longName}.md`, descMap, '/nonexistent');
    expect(result.length).toBeLessThanOrEqual(60);
  });

  test('truncates changelog description to 120 chars', () => {
    const descMap = new Map([
      ['report.md', 'a'.repeat(200)],
    ]);
    const result = getFileDescription('report.md', descMap, '/nonexistent');
    expect(result.length).toBeLessThanOrEqual(120);
  });

  test('strips .md extension before humanizing', () => {
    const descMap = new Map<string, string>();
    expect(getFileDescription('report.md', descMap, '/nonexistent')).toBe('Report');
    // The implementation strips only .md (not .txt) — verify the actual
    // behavior. .txt files are title-cased with the extension preserved.
    expect(getFileDescription('story.txt', descMap, '/nonexistent')).toBe('Story.Txt');
  });
});

// ---------------------------------------------------------------------------
// buildIndexHtml
// ---------------------------------------------------------------------------

describe('buildIndexHtml', () => {
  const emptyFiles: never[] = [];
  const emptyGoals: never[] = [];

  test('returns a complete HTML document', () => {
    const html = buildIndexHtml('testbot', emptyFiles as any, emptyGoals as any, 0, 0);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
  });

  test('escapes the botId in the title and content', () => {
    const html = buildIndexHtml('bot<script>alert(1)</script>', emptyFiles as any, emptyGoals as any, 0, 0);
    expect(html).toContain('bot&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('bot<script>alert(1)</script>');
  });

  test('contains no <script> tag (no JS, no promise of JS)', () => {
    const html = buildIndexHtml('testbot', emptyFiles as any, emptyGoals as any, 0, 0);
    expect(html).not.toMatch(/<script[\s>]/);
  });

  test('contains no <script src=...> in particular', () => {
    const html = buildIndexHtml('testbot', emptyFiles as any, emptyGoals as any, 0, 0);
    expect(html).not.toContain('marked.min.js');
    expect(html).not.toContain('marked');
  });

  test('renders empty state when no files', () => {
    const html = buildIndexHtml('testbot', emptyFiles as any, emptyGoals as any, 0, 0);
    expect(html).toContain('No productions yet');
  });

  test('renders stat row with file count and size', () => {
    const files = [
      {
        relativePath: 'a.md',
        name: 'a.md',
        dir: '',
        size: 1024,
        created: new Date('2025-01-01T00:00:00.000Z'),
        isArchived: false,
        description: 'first file',
      },
    ];
    const html = buildIndexHtml('testbot', files as any, emptyGoals as any, 1, 1024);
    expect(html).toContain('1'); // file count
    expect(html).toContain('1.0KB');
  });

  test('renders "Active Goals" header when goals are present', () => {
    const goals = [{ text: 'Ship refactor', status: 'in_progress', priority: 'high' }];
    const html = buildIndexHtml('testbot', emptyFiles as any, goals as any, 0, 0);
    expect(html).toContain('Active Goals');
    expect(html).toContain('Ship refactor');
  });

  test('renders "No active goals" when goals array is empty', () => {
    const html = buildIndexHtml('testbot', emptyFiles as any, emptyGoals as any, 0, 0);
    expect(html).toContain('No active goals');
  });

  test('renders file rows with names, descriptions, and sizes', () => {
    const files = [
      {
        relativePath: 'report.md',
        name: 'report.md',
        dir: '',
        size: 2048,
        created: new Date('2025-01-15T14:30:00.000Z'),
        isArchived: false,
        description: 'Test report description',
      },
    ];
    const html = buildIndexHtml('testbot', files as any, emptyGoals as any, 1, 2048);
    expect(html).toContain('report.md');
    expect(html).toContain('Test report description');
    expect(html).toContain('2025-01-15 14:30');
    expect(html).toContain('2.0KB');
  });

  test('separates archived from non-archived files', () => {
    const files = [
      {
        relativePath: 'current.md',
        name: 'current.md',
        dir: '',
        size: 100,
        created: new Date('2025-01-01T00:00:00.000Z'),
        isArchived: false,
        description: 'current',
      },
      {
        relativePath: 'archived/old.md',
        name: 'old.md',
        dir: 'archived',
        size: 100,
        created: new Date('2024-01-01T00:00:00.000Z'),
        isArchived: true,
        description: 'old',
      },
    ];
    const html = buildIndexHtml('testbot', files as any, emptyGoals as any, 2, 200);
    // The current file appears in the Files table.
    expect(html).toContain('current.md');
    expect(html).toContain('Files');
    // Total file count is 1 (the non-archived one — archived files are
    // excluded from the Files table).
    expect(html).toMatch(/<div class="number">1<\/div><div class="label">Files<\/div>/);
    // The Archived stat card shows the count but not the file names.
    expect(html).toContain('Archived');
    expect(html).toMatch(/<div class="number">1<\/div><div class="label">Archived<\/div>/);
  });

  test('escapes filename in the file link (XSS prevention)', () => {
    const files = [
      {
        relativePath: '"><script>alert(1)</script>.md',
        name: '"><script>alert(1)</script>.md',
        dir: '',
        size: 100,
        created: new Date('2025-01-01T00:00:00.000Z'),
        isArchived: false,
        description: 'desc',
      },
    ];
    const html = buildIndexHtml('testbot', files as any, emptyGoals as any, 1, 100);
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).toContain('&quot;');
  });
});
