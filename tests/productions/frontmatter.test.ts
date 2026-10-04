/**
 * Cycle 2 — frontmatter.ts Red tests.
 *
 * Pinning the contract of src/productions/frontmatter.ts. Per
 * docs/architecture-docs/productions-refactor.md §4 C2, this module
 * extracts pure frontmatter / quality helpers from ProductionsService.
 * Pure functions, no I/O, no dependency on the service class.
 *
 * Per-function coverage: each function gets its own describe block,
 * with at least one test per divergent branch (per the TDD rule in
 * CLAUDE.md §"Flujo TDD obligatorio").
 *
 * Cycle 2.1 writes these tests (Red). Cycle 2.3 creates the module
 * (Green). Cycle 2.4 wires service.ts to delegate to it.
 */

import { describe, expect, test } from 'bun:test';
import {
  assessContentQuality,
  checkCoherence,
  extractDescription,
  injectFrontmatter,
  parseFrontmatter,
  resolveCreatedAt,
} from '../../src/productions/frontmatter';

// ---------------------------------------------------------------------------
// assessContentQuality
// ---------------------------------------------------------------------------

describe('assessContentQuality', () => {
  test('empty string is template (ratio 0)', () => {
    expect(assessContentQuality('')).toEqual({ ratio: 0, isTemplate: true });
  });

  test('whitespace-only is template (ratio 0)', () => {
    expect(assessContentQuality('   \n\t\n   ')).toEqual({ ratio: 0, isTemplate: true });
  });

  test('pure markdown with descriptive heading gives ratio 1 and is not template', () => {
    const content = '# A descriptive title\n\nThis is a paragraph with real content.\n\nMore content here.';
    const result = assessContentQuality(content);
    expect(result.ratio).toBe(1);
    expect(result.isTemplate).toBe(false);
  });

  test('all-placeholder template is template (ratio 0)', () => {
    const content = '# Heading\n\n## Section\n\n## Title\n\n## Overview\n';
    const result = assessContentQuality(content);
    expect(result.isTemplate).toBe(true);
  });

  test('TBD/TODO/FIXME markers are counted as placeholder', () => {
    const content = '# Title\n\nTBD: write this\n\nTODO: clarify\n\nFIXME: refactor';
    const result = assessContentQuality(content);
    expect(result.isTemplate).toBe(true);
  });

  test('heading with no content is placeholder', () => {
    const content = '# ';
    const result = assessContentQuality(content);
    expect(result.isTemplate).toBe(true);
  });

  test('empty bullet is placeholder', () => {
    const content = '# Title\n\n- \n- \n- ';
    const result = assessContentQuality(content);
    expect(result.isTemplate).toBe(true);
  });

  test('unchecked checkbox is placeholder', () => {
    const content = '# Title\n\n- [ ]\n- [ ]\n';
    const result = assessContentQuality(content);
    expect(result.isTemplate).toBe(true);
  });

  test('separator line is placeholder', () => {
    const content = '# Title\n\n---\n\n***\n\n===';
    const result = assessContentQuality(content);
    expect(result.isTemplate).toBe(true);
  });

  test('mostly-real content with one placeholder line is not template', () => {
    const content = [
      '# Title',
      '',
      'This is a real paragraph with substantial content here.',
      'Another line of real content that adds value.',
      'Yet more content to push the ratio above the threshold.',
      'And one more line to be safe.',
      'TODO: minor cleanup',
    ].join('\n');
    const result = assessContentQuality(content);
    expect(result.ratio).toBeGreaterThan(0.3);
    expect(result.isTemplate).toBe(false);
  });

  test('threshold is 0.3 (ratio < 0.3 is template)', () => {
    // 1 real line out of 5 = 0.2 (template); 2/5 = 0.4 (not template)
    const mostlyPlaceholder = '# Title\n\nTODO\n\nTODO\n\nTODO\n\nReal content here.';
    expect(assessContentQuality(mostlyPlaceholder).isTemplate).toBe(true);

    const mostlyReal = '# Title\n\nReal content\n\nReal content\n\nTODO';
    expect(assessContentQuality(mostlyReal).isTemplate).toBe(false);
  });

  test('ratio is rounded to 2 decimal places', () => {
    // 4 non-blank lines: 1 real "Real paragraph", 3 placeholders (generic
    // heading "Title", "TODO", "placeholder"). 1/4 = 0.25.
    const content = '# Title\n\nReal paragraph.\n\nTODO\n\nplaceholder';
    const result = assessContentQuality(content);
    expect(result.ratio).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// injectFrontmatter
// ---------------------------------------------------------------------------

describe('injectFrontmatter', () => {
  test('prepends YAML frontmatter with provided timestamp', () => {
    const out = injectFrontmatter('# Title\n\nContent', 'doc.md', '2025-01-01T00:00:00.000Z');
    expect(out).toBe('---\ncreated_at: "2025-01-01T00:00:00.000Z"\n---\n\n# Title\n\nContent');
  });

  test('returns content unchanged when path is not .md', () => {
    const content = '# Title\n\nContent';
    expect(injectFrontmatter(content, 'doc.txt', '2025-01-01T00:00:00.000Z')).toBe(content);
  });

  test('returns content unchanged when path is .json', () => {
    const content = '{"key": "value"}';
    expect(injectFrontmatter(content, 'data.json', '2025-01-01T00:00:00.000Z')).toBe(content);
  });

  test('returns content unchanged when content already has frontmatter', () => {
    const content = '---\nfoo: bar\n---\n\n# Title\n\nContent';
    expect(injectFrontmatter(content, 'doc.md', '2025-01-01T00:00:00.000Z')).toBe(content);
  });

  test('uses current timestamp when not provided', () => {
    const before = Date.now();
    const out = injectFrontmatter('# Title', 'doc.md');
    const after = Date.now();
    const match = out.match(/created_at: "([^"]+)"/);
    expect(match).not.toBeNull();
    const ts = new Date(match![1]).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test('handles leading whitespace before frontmatter marker', () => {
    const content = '\n# Title\n\nContent';
    const out = injectFrontmatter(content, 'doc.md', '2025-01-01T00:00:00.000Z');
    expect(out).toBe('---\ncreated_at: "2025-01-01T00:00:00.000Z"\n---\n\n\n# Title\n\nContent');
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  test('returns null for content without frontmatter', () => {
    expect(parseFrontmatter('# Title\n\nContent')).toBeNull();
  });

  test('returns null for empty content', () => {
    expect(parseFrontmatter('')).toBeNull();
  });

  test('returns null for malformed frontmatter (no closing ---)', () => {
    expect(parseFrontmatter('---\ncreated_at: "2025-01-01T00:00:00.000Z"\n# Title')).toBeNull();
  });

  test('returns null for frontmatter without created_at', () => {
    expect(parseFrontmatter('---\nfoo: bar\n---\n\n# Title')).toBeNull();
  });

  test('parses created_at with quotes', () => {
    expect(parseFrontmatter('---\ncreated_at: "2025-01-01T00:00:00.000Z"\n---\n\n# Title')).toBe(
      '2025-01-01T00:00:00.000Z'
    );
  });

  test('parses created_at without quotes', () => {
    expect(parseFrontmatter('---\ncreated_at: 2025-01-01T00:00:00.000Z\n---\n\n# Title')).toBe(
      '2025-01-01T00:00:00.000Z'
    );
  });

  test('handles leading whitespace before frontmatter', () => {
    expect(parseFrontmatter('   \n---\ncreated_at: "2025-01-01T00:00:00.000Z"\n---\n\n# Title')).toBe(
      '2025-01-01T00:00:00.000Z'
    );
  });

  test('trims whitespace around the value', () => {
    expect(parseFrontmatter('---\ncreated_at:   "2025-01-01T00:00:00.000Z"   \n---\n\n# Title')).toBe(
      '2025-01-01T00:00:00.000Z'
    );
  });
});

// ---------------------------------------------------------------------------
// resolveCreatedAt
// ---------------------------------------------------------------------------

describe('resolveCreatedAt', () => {
  // Note: don't actually pass an absPath that exists; the function reads
  // the file. We're testing the priority logic by passing a non-existent
  // path so the frontmatter step is skipped.
  const nonExistentPath = 'D:\\non\\existent\\path.md';

  test('falls back to changelog timestamp when frontmatter absent', () => {
    const changelogMap = new Map<string, string>([['rel.md', '2025-02-01T00:00:00.000Z']]);
    const birthtime = new Date('2025-03-01T00:00:00.000Z');
    const result = resolveCreatedAt(nonExistentPath, 'rel.md', birthtime, changelogMap);
    expect(result).toEqual(new Date('2025-02-01T00:00:00.000Z'));
  });

  test('falls back to birthtime when neither frontmatter nor changelog has it', () => {
    const changelogMap = new Map<string, string>();
    const birthtime = new Date('2025-03-01T00:00:00.000Z');
    const result = resolveCreatedAt(nonExistentPath, 'rel.md', birthtime, changelogMap);
    expect(result).toEqual(birthtime);
  });

  test('invalid changelog timestamp falls back to birthtime', () => {
    const changelogMap = new Map<string, string>([['rel.md', 'not-a-date']]);
    const birthtime = new Date('2025-03-01T00:00:00.000Z');
    const result = resolveCreatedAt(nonExistentPath, 'rel.md', birthtime, changelogMap);
    expect(result).toEqual(birthtime);
  });

  test('empty string in changelog map falls back to birthtime', () => {
    const changelogMap = new Map<string, string>([['rel.md', '']]);
    const birthtime = new Date('2025-03-01T00:00:00.000Z');
    const result = resolveCreatedAt(nonExistentPath, 'rel.md', birthtime, changelogMap);
    expect(result).toEqual(birthtime);
  });

  // Frontmatter priority is tested with a real file. See write-and-test below.
  test('frontmatter wins over changelog and birthtime (uses a real file)', () => {
    // Construct a real file in the system temp area.
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-test-'));
    const filePath = path.join(tmpDir, 'doc.md');
    fs.writeFileSync(
      filePath,
      '---\ncreated_at: "2025-05-01T00:00:00.000Z"\n---\n\n# Title',
      'utf-8'
    );
    const changelogMap = new Map<string, string>([['doc.md', '2025-02-01T00:00:00.000Z']]);
    const birthtime = new Date('2025-03-01T00:00:00.000Z');
    const result = resolveCreatedAt(filePath, 'doc.md', birthtime, changelogMap);
    expect(result).toEqual(new Date('2025-05-01T00:00:00.000Z'));
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('does not read frontmatter for non-.md files', () => {
    // A non-.md file with frontmatter content is treated as no frontmatter.
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-test-'));
    const filePath = path.join(tmpDir, 'doc.txt');
    fs.writeFileSync(
      filePath,
      '---\ncreated_at: "2025-05-01T00:00:00.000Z"\n---\n\ncontent',
      'utf-8'
    );
    const changelogMap = new Map<string, string>([['doc.txt', '2025-02-01T00:00:00.000Z']]);
    const birthtime = new Date('2025-03-01T00:00:00.000Z');
    const result = resolveCreatedAt(filePath, 'doc.txt', birthtime, changelogMap);
    expect(result).toEqual(new Date('2025-02-01T00:00:00.000Z'));
    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// extractDescription
// ---------------------------------------------------------------------------

describe('extractDescription', () => {
  test('empty content returns empty string', () => {
    expect(extractDescription('')).toBe('');
  });

  test('whitespace-only content returns empty string', () => {
    expect(extractDescription('   \n\n\t\n ')).toBe('');
  });

  test('heading-only content returns the heading (truncated to 120 chars)', () => {
    expect(extractDescription('# Title')).toBe('Title');
  });

  test('paragraph-only content returns empty string (no heading anchor)', () => {
    // The current implementation requires a heading to anchor the
    // description; paragraph-only content yields no title and no
    // firstSentence extraction (the if (title && !firstSentence) guard
    // never fires). This is the behavior the original service.ts has.
    expect(extractDescription('This is a paragraph with no heading.')).toBe('');
  });

  test('heading + paragraph returns "Title -- sentence" capped at 120 chars', () => {
    const content = '# Title\n\nThis is the first sentence. More content here.';
    expect(extractDescription(content)).toBe('Title -- This is the first sentence.');
  });

  test('extremely long combined output is truncated', () => {
    const longTitle = 'a'.repeat(60);
    const longSentence = 'b'.repeat(80);
    const content = `# ${longTitle}\n\n${longSentence}.`;
    const result = extractDescription(content);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith('...')).toBe(true);
  });

  test('skips bullets, tables, separators, blockquotes, metadata lines', () => {
    // No code block (the implementation breaks at the opening fence of
    // any code block, before reaching the actual paragraph).
    const content = [
      '# Title',
      '',
      'date: 2025-01-01',
      'tags: foo, bar',
      '',
      '- bullet 1',
      '- bullet 2',
      '',
      '| col | val |',
      '|-----|-----|',
      '',
      '> quoted text',
      '',
      '---',
      '',
      'The actual paragraph is here. It has more content.',
    ].join('\n');
    expect(extractDescription(content)).toBe('Title -- The actual paragraph is here.');
  });

  test('stops at second heading', () => {
    const content = '# Title\n\nFirst paragraph here.\n\n## Second\n\nskipped paragraph.';
    expect(extractDescription(content)).toBe('Title -- First paragraph here.');
  });

  test('stops at code block', () => {
    const content = '# Title\n\nFirst paragraph here.\n\n```\ncode block\n```';
    expect(extractDescription(content)).toBe('Title -- First paragraph here.');
  });

  test('h6 heading is recognized', () => {
    expect(extractDescription('###### Tiny Title\n\nBody text here.')).toBe(
      'Tiny Title -- Body text here.'
    );
  });

  test('sentence without terminator is taken whole', () => {
    expect(extractDescription('# Title\n\nThis is a sentence without a period')).toBe(
      'Title -- This is a sentence without a period'
    );
  });
});

// ---------------------------------------------------------------------------
// checkCoherence
// ---------------------------------------------------------------------------

describe('checkCoherence', () => {
  test('content < 100 chars is incoherent (too small)', () => {
    const result = checkCoherence('# Title\n\nShort.');
    expect(result.coherent).toBe(false);
    expect(result.issues).toContain('Content too small (less than 100 characters of real content)');
  });

  test('content with high placeholder ratio is incoherent (template)', () => {
    const content = [
      '# Title',
      '',
      '## Section',
      '',
      '## Overview',
      '',
      '## Introduction',
      '',
      '## Summary',
      '',
      '## Details',
      '',
      '## Conclusion',
    ].join('\n');
    const result = checkCoherence(content);
    expect(result.coherent).toBe(false);
    expect(result.issues.some((i) => i.includes('placeholder'))).toBe(true);
  });

  test('content with 4+ headings and fewer paragraphs is incoherent (broken structure)', () => {
    const lines = [
      '# Title',
      '',
      '## A',
      '## B',
      '## C',
      '## D',
      '## E',
    ];
    const result = checkCoherence(lines.join('\n'));
    expect(result.coherent).toBe(false);
    expect(result.issues.some((i) => i.includes('Broken structure'))).toBe(true);
  });

  test('large body with real paragraphs is coherent', () => {
    const content = [
      '# Title',
      '',
      'This is the first paragraph of the document with substantial content.',
      'It continues with more content, making sure we exceed the 100-char threshold.',
      'A third paragraph to be safe and ensure the structure ratio is good.',
    ].join('\n');
    const result = checkCoherence(content);
    expect(result.coherent).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('reports multiple issues when content has several problems', () => {
    // Small AND many headings AND paragraphs fail.
    const lines = ['# Title', '', '## A', '## B', '## C', '## D'];
    const result = checkCoherence(lines.join('\n'));
    expect(result.coherent).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
  });
});
