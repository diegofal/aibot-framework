/**
 * Cycle 3 — summary.ts Red tests.
 *
 * Pinning the contract of src/productions/summary.ts. Per
 * docs/architecture-docs/productions-refactor.md §4 C3, this module
 * extracts readSummary and writeSummary from ProductionsService.
 *
 * Pure functions that take a directory and return SummaryData. No
 * dependency on Config or ProductionsService.
 *
 * SummaryData has NO `plan` field — the plan field is being deleted
 * along with the LLM generation that produced it.
 *
 * Cycle 3.1 writes these tests (Red). Cycle 3.3 creates the module
 * (Green). Cycle 3.5 removes the `plan` field from SummaryData so
 * the type contract here matches the new reality.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readSummary, writeSummary } from '../../src/productions/summary';

const TEMP_DIR = join(process.cwd(), '.test-productions-summary');

beforeEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// readSummary
// ---------------------------------------------------------------------------

describe('readSummary', () => {
  test('returns null when no summary.json exists', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(readSummary(dir)).toBeNull();
  });

  test('parses a valid summary.json', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    const data = {
      summary: 'A summary of the bot work',
      generatedAt: '2025-01-01T00:00:00.000Z',
    };
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(data), 'utf-8');
    expect(readSummary(dir)).toEqual(data);
  });

  test('returns null on corrupt JSON (no throw)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.json'), '{ not valid json', 'utf-8');
    expect(readSummary(dir)).toBeNull();
  });

  test('returns null when the directory itself does not exist', () => {
    // No mkdirSync — the dir doesn't exist.
    const dir = join(TEMP_DIR, 'nonexistent');
    expect(readSummary(dir)).toBeNull();
  });

  test('returns parsed object even with extra fields (forward compatibility)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    const data = {
      summary: 'text',
      error: 'something',
      generatedAt: '2025-01-01T00:00:00.000Z',
      // extra unknown field
      futureField: 'preserved',
    };
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(data), 'utf-8');
    expect(readSummary(dir)).toEqual(data);
  });
});

// ---------------------------------------------------------------------------
// writeSummary
// ---------------------------------------------------------------------------

describe('writeSummary', () => {
  test('creates summary.json in the given dir', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    const data = {
      summary: 'A summary',
      generatedAt: '2025-01-01T00:00:00.000Z',
    };
    writeSummary(dir, data);
    expect(existsSync(join(dir, 'summary.json'))).toBe(true);
  });

  test('writes valid JSON', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    const data = {
      summary: 'A summary',
      generatedAt: '2025-01-01T00:00:00.000Z',
    };
    writeSummary(dir, data);
    const content = readFileSync(join(dir, 'summary.json'), 'utf-8');
    expect(JSON.parse(content)).toEqual(data);
  });

  test('writes pretty-printed JSON (2-space indent)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    const data = {
      summary: 'text',
      generatedAt: '2025-01-01T00:00:00.000Z',
    };
    writeSummary(dir, data);
    const content = readFileSync(join(dir, 'summary.json'), 'utf-8');
    expect(content).toContain('  "summary"');
  });

  test('overwrites existing summary.json', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeSummary(dir, { summary: 'first', generatedAt: '2025-01-01T00:00:00.000Z' });
    writeSummary(dir, { summary: 'second', generatedAt: '2025-02-01T00:00:00.000Z' });
    expect(readSummary(dir)).toEqual({
      summary: 'second',
      generatedAt: '2025-02-01T00:00:00.000Z',
    });
  });

  test('does not include a `plan` field in the output (the field is deleted)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    // Even if the caller passes a plan field (which they shouldn't), the
    // module must not preserve it. The SummaryData type does not include
    // plan, so this is also a compile-time check.
    writeSummary(dir, {
      summary: 'text',
      generatedAt: '2025-01-01T00:00:00.000Z',
    });
    const content = readFileSync(join(dir, 'summary.json'), 'utf-8');
    expect(content).not.toContain('"plan"');
  });

  test('round-trips: writeSummary then readSummary returns the same data', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    const data = {
      summary: 'A complete summary',
      error: 'previous error',
      generatedAt: '2025-01-01T00:00:00.000Z',
    };
    writeSummary(dir, data);
    expect(readSummary(dir)).toEqual(data);
  });
});
