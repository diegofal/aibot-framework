import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OutcomeLedger } from '../src/bot/outcome-ledger';

const TEST_DIR = join(import.meta.dir, '.tmp-outcome-ledger');
const BOT_ID = 'test-bot';

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
} as any;

describe('outcome-ledger', () => {
  let ledger: OutcomeLedger;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    ledger = new OutcomeLedger(TEST_DIR, nullLogger);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ── Recording ──

  describe('record', () => {
    it('records a production and persists to JSONL', () => {
      const id = ledger.record(
        BOT_ID,
        'Created analysis report',
        ['web_search', 'file_write'],
        'CONTENT'
      );
      expect(id).not.toBeNull();

      const entries = ledger.getAllEntries(BOT_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe('produced');
      expect(entries[0].description).toBe('Created analysis report');
      expect(entries[0].toolCalls).toEqual(['web_search', 'file_write']);
      expect(entries[0].type).toBe('CONTENT');
    });

    it('deduplicates within 5 minute window', () => {
      const id1 = ledger.record(BOT_ID, 'Same description', ['web_search'], 'CONTENT');
      const id2 = ledger.record(BOT_ID, 'Same description', ['web_search'], 'CONTENT');
      expect(id1).not.toBeNull();
      expect(id2).toBeNull();
      expect(ledger.getAllEntries(BOT_ID)).toHaveLength(1);
    });

    it('truncates long descriptions to 200 chars', () => {
      const longDesc = 'x'.repeat(300);
      ledger.record(BOT_ID, longDesc, [], 'CONTENT');
      const entries = ledger.getAllEntries(BOT_ID);
      expect(entries[0].description.length).toBe(200);
    });
  });

  // ── Status transitions ──

  describe('status updates', () => {
    it('marks entry as consumed', () => {
      const id = ledger.record(BOT_ID, 'Report A', [], 'CONTENT')!;
      const result = ledger.markConsumed(BOT_ID, id, 'diego');
      expect(result).toBe(true);

      const entries = ledger.getAllEntries(BOT_ID);
      expect(entries[0].status).toBe('consumed');
      expect(entries[0].consumedBy).toBe('diego');
      expect(entries[0].consumedAt).toBeGreaterThan(0);
    });

    it('marks entry as validated with score', () => {
      const id = ledger.record(BOT_ID, 'Report B', [], 'CONTENT')!;
      ledger.markValidated(BOT_ID, id, 0.9);

      const entries = ledger.getAllEntries(BOT_ID);
      expect(entries[0].status).toBe('validated');
      expect(entries[0].score).toBe(0.9);
    });

    it('marks entry as rejected', () => {
      const id = ledger.record(BOT_ID, 'Bad report', [], 'CONTENT')!;
      ledger.markRejected(BOT_ID, id);

      const entries = ledger.getAllEntries(BOT_ID);
      expect(entries[0].status).toBe('rejected');
    });

    it('returns false for non-existent entry', () => {
      expect(ledger.markConsumed(BOT_ID, 'fake-id')).toBe(false);
    });
  });

  // ── Stale sweep ──

  describe('sweepStale', () => {
    it('marks old produced entries as stale', () => {
      // Record and manually backdate
      ledger.record(BOT_ID, 'Old report', [], 'CONTENT');
      const entries = ledger.getAllEntries(BOT_ID);
      entries[0].timestamp = Date.now() - 80 * 3_600_000; // 80 hours ago
      // Write back manually
      const filePath = join(TEST_DIR, BOT_ID, 'outcomes.jsonl');
      const { writeFileSync } = require('node:fs');
      writeFileSync(filePath, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);

      const count = ledger.sweepStale(BOT_ID, 72 * 3_600_000);
      expect(count).toBe(1);

      const after = ledger.getAllEntries(BOT_ID);
      expect(after[0].status).toBe('stale');
    });

    it('does not mark consumed entries as stale', () => {
      const id = ledger.record(BOT_ID, 'Consumed report', [], 'CONTENT')!;
      ledger.markConsumed(BOT_ID, id);

      // Backdate
      const entries = ledger.getAllEntries(BOT_ID);
      entries[0].timestamp = Date.now() - 80 * 3_600_000;
      const filePath = join(TEST_DIR, BOT_ID, 'outcomes.jsonl');
      const { writeFileSync } = require('node:fs');
      writeFileSync(filePath, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);

      const count = ledger.sweepStale(BOT_ID, 72 * 3_600_000);
      expect(count).toBe(0);
    });
  });

  // ── Stats ──

  describe('getStats', () => {
    it('computes correct stats', () => {
      // Create mix of statuses
      const id1 = ledger.record(BOT_ID, 'A', [], 'CONTENT')!;
      const id2 = ledger.record(BOT_ID, 'B', [], 'OUTREACH')!;
      const id3 = ledger.record(BOT_ID, 'C', [], 'CONTENT')!;
      const id4 = ledger.record(BOT_ID, 'D', [], 'CONTENT')!;

      ledger.markConsumed(BOT_ID, id1);
      ledger.markValidated(BOT_ID, id2, 0.8);
      ledger.markRejected(BOT_ID, id3);
      // id4 stays as 'produced'

      const stats = ledger.getStats(BOT_ID);
      expect(stats.total).toBe(4);
      expect(stats.consumed).toBe(1);
      expect(stats.validated).toBe(1);
      expect(stats.rejected).toBe(1);
      expect(stats.produced).toBe(1);
      expect(stats.consumptionRate).toBe(0.5); // (1 consumed + 1 validated) / 4
      expect(stats.avgScore).toBe(0.8);
    });

    it('returns zeros for empty ledger', () => {
      const stats = ledger.getStats(BOT_ID);
      expect(stats.total).toBe(0);
      expect(stats.consumptionRate).toBe(0);
    });
  });

  // ── Search ──

  describe('findRecentByDescription', () => {
    it('finds matching entry', () => {
      ledger.record(BOT_ID, 'Market analysis Q1', [], 'CONTENT');
      const found = ledger.findRecentByDescription(BOT_ID, 'market analysis');
      expect(found).not.toBeNull();
      expect(found?.description).toContain('Market analysis');
    });

    it('returns null when no match', () => {
      ledger.record(BOT_ID, 'Something else', [], 'CONTENT');
      const found = ledger.findRecentByDescription(BOT_ID, 'nonexistent');
      expect(found).toBeNull();
    });
  });

  // ── Prompt rendering ──

  describe('renderStatsForPrompt', () => {
    it('returns null for empty ledger', () => {
      expect(ledger.renderStatsForPrompt(BOT_ID)).toBeNull();
    });

    it('renders formatted stats', () => {
      ledger.record(BOT_ID, 'A', [], 'CONTENT');
      const result = ledger.renderStatsForPrompt(BOT_ID);
      expect(result).toContain('Production outcomes (7d)');
      expect(result).toContain('1 total');
    });
  });

  describe('renderRecentForPrompt', () => {
    it('returns null for empty ledger', () => {
      expect(ledger.renderRecentForPrompt(BOT_ID)).toBeNull();
    });

    it('renders recent entries with status icons', () => {
      const id = ledger.record(BOT_ID, 'Test report', [], 'CONTENT')!;
      ledger.markConsumed(BOT_ID, id);
      ledger.record(BOT_ID, 'Pending report', [], 'CONTENT');

      // Need a new ledger to bypass dedup for the test
      // Actually the descriptions differ so dedup doesn't trigger
      const result = ledger.renderRecentForPrompt(BOT_ID);
      expect(result).toContain('Recent productions');
      expect(result).toContain('✓'); // consumed
      expect(result).toContain('○'); // produced
    });
  });
});
