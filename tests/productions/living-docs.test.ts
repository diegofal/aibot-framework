/**
 * Living documents: in an agent-loop cycle a goal keeps one document that the
 * agent updates and keeps short, instead of a new file per cycle; explore
 * cycles write to memory, never to productions. Live, jarvis-factory had 12
 * files for one research thread (two of them numbered 08) and job-seeker a new
 * "swe_trends" file every day.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIVING_DOC_DEFAULTS,
  documentsSection,
  listDocuments,
  type LivingDocCheck,
  goalDocuments,
  isDocumentPath,
  livingDocRefusal,
} from '../../src/productions/living-docs';
import type { ProductionEntry } from '../../src/productions/types';

const entry = (over: Partial<ProductionEntry>): ProductionEntry => ({
  id: `e-${Math.random()}`,
  timestamp: '2026-10-12T10:00:00.000Z',
  botId: 'b1',
  tool: 'file_write',
  path: 'x.md',
  action: 'create',
  description: 'd',
  size: 10,
  trackOnly: false,
  ...over,
});

describe('isDocumentPath', () => {
  test('write-ups are documents; code, data and scratch are not', () => {
    for (const p of ['01_brief.md', '02_page.html', 'notes.txt']) expect(isDocumentPath(p)).toBe(true);
    for (const p of ['probe.sh', 'sim.ts', 'data.csv', '_scratch.md', 'index.html', 'archived/01_old.md'])
      expect(isDocumentPath(p)).toBe(false);
  });
});

describe('goalDocuments', () => {
  test('the live documents whose latest write served the goal', () => {
    const entries = [
      entry({ path: '01_a.md', goalId: 'g-1' }),
      entry({ path: '02_b.md', goalId: 'g-2' }),
      entry({ path: '03_c.md', goalId: 'g-1' }),
      entry({ path: '03_c.md', action: 'edit', goalId: 'g-2' }),
      entry({ path: '04_d.md', goalId: 'g-1' }),
      entry({ path: 'archived/04_d.md', action: 'archive', archivedFrom: '04_d.md' }),
      entry({ path: '05_gone.md', goalId: 'g-1' }),
      entry({ path: '06_probe.sh', goalId: 'g-1' }),
    ];
    const exists = (p: string) => p !== '05_gone.md';
    expect(goalDocuments(entries, 'g-1', exists)).toEqual(['01_a.md']);
    expect(goalDocuments(entries, 'g-2', exists)).toEqual(['02_b.md', '03_c.md']);
  });

  test('an edit without a goal keeps the goal of the earlier write', () => {
    const entries = [entry({ path: '01_a.md', goalId: 'g-1' }), entry({ path: '01_a.md', action: 'edit' })];
    expect(goalDocuments(entries, 'g-1', () => true)).toEqual(['01_a.md']);
  });
});

describe('livingDocRefusal', () => {
  const files: Record<string, string> = { '01_brief.md': 'x'.repeat(1000) };
  const base = (over: Partial<LivingDocCheck> = {}): LivingDocCheck => ({
    tool: 'file_write',
    relPath: '02_new.md',
    args: { content: 'short' },
    exploring: false,
    goalId: 'g-1',
    entries: [entry({ path: '01_brief.md', goalId: 'g-1' })],
    exists: (p) => p in files,
    read: (p) => files[p] ?? null,
    maxChars: 2000,
    ...over,
  });

  test('a new document for a goal that has one is refused, naming the document to update', () => {
    const msg = livingDocRefusal(base());
    expect(msg).toContain('01_brief.md');
    expect(msg).toContain('file_edit');
  });

  test('a first document for a goal, or one written outside any goal, is fine', () => {
    expect(livingDocRefusal(base({ goalId: 'g-2' }))).toBeUndefined();
    expect(livingDocRefusal(base({ goalId: null }))).toBeUndefined();
  });

  test('rewriting or editing the goal document is fine, and so is code or scratch', () => {
    expect(livingDocRefusal(base({ relPath: '01_brief.md' }))).toBeUndefined();
    expect(
      livingDocRefusal(
        base({ tool: 'file_edit', relPath: '01_brief.md', args: { old_text: 'xx', new_text: 'yy' } })
      )
    ).toBeUndefined();
    expect(livingDocRefusal(base({ relPath: 'probe.sh' }))).toBeUndefined();
    expect(livingDocRefusal(base({ relPath: '_notes.md' }))).toBeUndefined();
  });

  test('an explore cycle writes no document at all: findings go to memory', () => {
    const msg = livingDocRefusal(base({ exploring: true, goalId: null }));
    expect(msg).toContain('exploration');
    expect(msg).toContain('memory');
    expect(livingDocRefusal(base({ exploring: true, relPath: '_sim.ts' }))).toBeUndefined();
  });

  test('a write that leaves the document over the cap is refused with the sizes', () => {
    const msg = livingDocRefusal(
      base({ relPath: '01_brief.md', args: { content: 'y'.repeat(2500) } })
    );
    expect(msg).toContain('2500');
    expect(msg).toContain('2000');
    expect(msg).toContain('cut');
  });

  test('append and edit are measured on the resulting document', () => {
    expect(
      livingDocRefusal(
        base({ relPath: '01_brief.md', args: { content: 'z'.repeat(1200), append: true } })
      )
    ).toContain('2200');
    expect(
      livingDocRefusal(
        base({
          tool: 'file_edit',
          relPath: '01_brief.md',
          args: { old_text: 'x', new_text: 'w'.repeat(1500) },
        })
      )
    ).toContain('2499');
  });

  test('a document already over the cap may be edited as long as it does not grow', () => {
    const big = { '01_brief.md': 'x'.repeat(5000) };
    const over = base({
      tool: 'file_edit',
      relPath: '01_brief.md',
      exists: (p) => p in big,
      read: (p) => big[p as keyof typeof big] ?? null,
    });
    expect(livingDocRefusal({ ...over, args: { old_text: 'xxxx', new_text: 'yy' } })).toBeUndefined();
    expect(livingDocRefusal({ ...over, args: { old_text: 'x', new_text: 'yy' } })).toContain('cut');
  });

  // Deliberately changed: 6000 (one page) was a guess; a pilot design with its
  // gold set, metrics and rollback runs to two pages and kept bouncing off it.
  test('defaults: on, about two pages', () => {
    expect(LIVING_DOC_DEFAULTS).toEqual({ enabled: true, maxChars: 12000 });
  });
});

describe('what the agent is told about its documents', () => {
  test('listDocuments: each document at the productions root with its size and goal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'living-docs-list-'));
    try {
      writeFileSync(join(dir, '01_brief.md'), 'x'.repeat(5000));
      writeFileSync(join(dir, '02_notes.md'), 'y'.repeat(40));
      writeFileSync(join(dir, '_sim.ts'), 'code');
      writeFileSync(join(dir, 'index.html'), '<html>');
      const docs = listDocuments(dir, [entry({ path: '01_brief.md', goalId: 'g-1' })]);
      expect(docs).toEqual([
        { path: '01_brief.md', chars: 5000, goalId: 'g-1' },
        { path: '02_notes.md', chars: 40 },
      ]);
      expect(listDocuments(join(dir, 'missing'), [])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('documentsSection: the cap, each size against it and the room left', () => {
    const text = documentsSection(
      [
        { path: '06_rules.md', chars: 11_500, goalId: 'g-1' },
        { path: '02_notes.md', chars: 400 },
      ],
      12_000
    );
    expect(text).toContain('12,000 characters');
    expect(text).toContain('06_rules.md (goal g-1): 11,500 / 12,000 — 500 left, cut before you add');
    expect(text).toContain('02_notes.md: 400 / 12,000');
    expect(documentsSection([], 12_000)).toContain('No documents yet');
  });

  test('documentsSection: a document already over the cap must shrink', () => {
    expect(documentsSection([{ path: 'big.md', chars: 13_000 }], 12_000)).toContain(
      'big.md: 13,000 / 12,000 — over the limit: it can only get shorter'
    );
  });
});
