// UX overhaul (wave1-work): Outputs keys, selection, bulk; dispatch keys.
import { describe, expect, it } from 'bun:test';
import {
  DISPATCH_KEYS,
  WORK_KEYS,
  bulkSummary,
  bulkTargets,
  entriesList,
  entryKey,
  entryRow,
  keyAction,
  moveIndex,
  nextDispatchLimit,
  pruneSelection,
  runSequential,
  toggleKey,
  workBulkBar,
} from '../../web/pages/work-helpers.js';

const NOW = 1_700_000_000_000;
const H = 3_600_000;
const names = { b1: 'Bot One', b2: 'Bot Two' };
const unreviewed = {
  id: 'e1',
  timestamp: new Date(NOW - 2 * H).toISOString(),
  botId: 'b1',
  path: 'a.md',
  action: 'create',
};
const approved = { ...unreviewed, id: 'e2', botId: 'b2', evaluation: { status: 'approved' } };
const rejected = { ...unreviewed, id: 'e3', evaluation: { status: 'rejected' } };
const archived = { ...unreviewed, id: 'e4', action: 'archive' };

const ev = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  target: { tagName: 'DIV' },
  ...extra,
});

describe('keyAction', () => {
  it('maps the Outputs keys: j/k move, a approve, x reject, Enter open, space toggle', () => {
    expect(keyAction(ev('j'), WORK_KEYS)).toBe('next');
    expect(keyAction(ev('ArrowDown'), WORK_KEYS)).toBe('next');
    expect(keyAction(ev('k'), WORK_KEYS)).toBe('prev');
    expect(keyAction(ev('ArrowUp'), WORK_KEYS)).toBe('prev');
    expect(keyAction(ev('a'), WORK_KEYS)).toBe('approve');
    expect(keyAction(ev('x'), WORK_KEYS)).toBe('reject');
    expect(keyAction(ev('Enter'), WORK_KEYS)).toBe('open');
    expect(keyAction(ev(' '), WORK_KEYS)).toBe('toggle');
  });
  it('does not claim r (reply in Needs You)', () => {
    expect(keyAction(ev('r'), WORK_KEYS)).toBeNull();
  });
  it('ignores keys while typing and with ctrl/meta/alt', () => {
    expect(keyAction(ev('j', { target: { tagName: 'INPUT' } }), WORK_KEYS)).toBeNull();
    expect(keyAction(ev('j', { target: { tagName: 'TEXTAREA' } }), WORK_KEYS)).toBeNull();
    expect(keyAction(ev('j', { target: { tagName: 'SELECT' } }), WORK_KEYS)).toBeNull();
    expect(
      keyAction(ev('j', { target: { tagName: 'DIV', isContentEditable: true } }), WORK_KEYS)
    ).toBeNull();
    expect(keyAction(ev('a', { ctrlKey: true }), WORK_KEYS)).toBeNull();
    expect(keyAction(ev('a', { metaKey: true }), WORK_KEYS)).toBeNull();
    expect(keyAction(ev('a', { altKey: true }), WORK_KEYS)).toBeNull();
  });
  it('Enter / space on a focused button or link are left to the browser', () => {
    expect(keyAction(ev('Enter', { target: { tagName: 'BUTTON' } }), WORK_KEYS)).toBeNull();
    expect(keyAction(ev(' ', { target: { tagName: 'A' } }), WORK_KEYS)).toBeNull();
    expect(keyAction(ev('j', { target: { tagName: 'BUTTON' } }), WORK_KEYS)).toBe('next');
  });
  it('lets the dispatch keys through with shift (+ needs shift on most layouts)', () => {
    expect(keyAction(ev('+', { shiftKey: true }), DISPATCH_KEYS)).toBe('up');
    expect(keyAction(ev('='), DISPATCH_KEYS)).toBe('up');
    expect(keyAction(ev('-'), DISPATCH_KEYS)).toBe('down');
    expect(keyAction(ev('j'), DISPATCH_KEYS)).toBe('next');
    expect(keyAction(ev('k'), DISPATCH_KEYS)).toBe('prev');
  });
  it('is null for a missing event', () => {
    expect(keyAction(null, WORK_KEYS)).toBeNull();
  });
});

describe('moveIndex', () => {
  it('starts at the first row from nothing focused', () => {
    expect(moveIndex(-1, 1, 3)).toBe(0);
    expect(moveIndex(-1, -1, 3)).toBe(0);
  });
  it('clamps at both ends', () => {
    expect(moveIndex(2, 1, 3)).toBe(2);
    expect(moveIndex(0, -1, 3)).toBe(0);
    expect(moveIndex(1, 1, 3)).toBe(2);
  });
  it('is -1 for an empty list and clamps an out-of-range index', () => {
    expect(moveIndex(0, 1, 0)).toBe(-1);
    expect(moveIndex(9, 0, 3)).toBe(2);
  });
});

describe('selection helpers', () => {
  it('entryKey is unique per bot + id', () => {
    expect(entryKey(unreviewed)).not.toBe(entryKey({ ...unreviewed, botId: 'b2' }));
  });
  it('toggleKey returns a new set', () => {
    const a = new Set<string>();
    const b = toggleKey(a, 'k1');
    expect(a.size).toBe(0);
    expect([...b]).toEqual(['k1']);
    expect(toggleKey(b, 'k1').size).toBe(0);
  });
  it('pruneSelection drops keys no longer in the list', () => {
    const sel = new Set([entryKey(unreviewed), 'gone']);
    expect([...pruneSelection(sel, [unreviewed, approved])]).toEqual([entryKey(unreviewed)]);
  });
});

describe('bulkTargets', () => {
  const all = [unreviewed, approved, rejected, archived];
  const allKeys = new Set(all.map(entryKey));
  it('approve/reject only touch unreviewed entries', () => {
    expect(bulkTargets(all, allKeys, 'approve').map((e) => e.id)).toEqual(['e1']);
    expect(bulkTargets(all, allKeys, 'reject').map((e) => e.id)).toEqual(['e1']);
  });
  it('archive touches everything not already archived', () => {
    expect(bulkTargets(all, allKeys, 'archive').map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });
  it('only selected entries count; null selection means all given', () => {
    expect(bulkTargets(all, new Set([entryKey(approved)]), 'approve')).toEqual([]);
    expect(bulkTargets(all, null, 'approve').map((e) => e.id)).toEqual(['e1']);
  });
  it('unknown action targets nothing', () => {
    expect(bulkTargets(all, allKeys, 'explode')).toEqual([]);
  });
});

describe('runSequential', () => {
  it('runs in order and splits ok / failed (error field or throw)', async () => {
    const order: number[] = [];
    const res = await runSequential([1, 2, 3], async (n: number) => {
      order.push(n);
      if (n === 2) return { error: 'nope' };
      if (n === 3) throw new Error('boom');
      return { ok: true };
    });
    expect(order).toEqual([1, 2, 3]);
    expect(res.ok).toEqual([1]);
    expect(res.failed.map((f: { item: number; error: string }) => [f.item, f.error])).toEqual([
      [2, 'nope'],
      [3, 'boom'],
    ]);
  });
  it('reports progress', async () => {
    const seen: string[] = [];
    await runSequential(
      ['a', 'b'],
      async () => ({}),
      (done: number, total: number) => seen.push(`${done}/${total}`)
    );
    expect(seen).toEqual(['1/2', '2/2']);
  });
});

describe('bulkSummary', () => {
  it('all ok', () => {
    expect(bulkSummary('Approved', { ok: [1, 2], failed: [] })).toEqual({
      text: 'Approved 2',
      tone: 'ok',
    });
  });
  it('partial failure names the first error', () => {
    const s = bulkSummary('Archived', { ok: [1], failed: [{ item: 2, error: 'disk' }] });
    expect(s.tone).toBe('warn');
    expect(s.text).toBe('Archived 1, 1 failed (disk)');
  });
  it('total failure is danger', () => {
    expect(bulkSummary('Rejected', { ok: [], failed: [{ item: 1, error: 'x' }] }).tone).toBe(
      'danger'
    );
  });
});

describe('workBulkBar', () => {
  it('renders nothing with no selection and nothing filtered to review', () => {
    expect(workBulkBar({ selected: 0, filteredUnreviewed: 0 })).toBe('');
  });
  it('offers "approve all filtered" when nothing is selected', () => {
    const html = workBulkBar({ selected: 0, filteredUnreviewed: 7 });
    expect(html).toContain('data-bulk="approve-filtered"');
    expect(html).toContain('Approve all 7');
    expect(html).not.toContain('data-bulk="archive"');
  });
  it('shows counts per action for a selection', () => {
    const html = workBulkBar({ selected: 3, approvable: 2, archivable: 3, filteredUnreviewed: 5 });
    expect(html).toContain('3 selected');
    expect(html).toContain('data-bulk="approve"');
    expect(html).toContain('Approve 2');
    expect(html).toContain('Reject 2');
    expect(html).toContain('Archive 3');
    expect(html).toContain('data-bulk="clear"');
  });
  it('disables approve/reject when no selected entry is reviewable', () => {
    const html = workBulkBar({ selected: 1, approvable: 0, archivable: 1 });
    expect(html).toMatch(/data-bulk="approve"[^>]*disabled/);
    expect(html).toMatch(/data-bulk="reject"[^>]*disabled/);
  });
});

describe('entryRow selection + key hints', () => {
  it('advertises a / x, not r', () => {
    const html = entryRow(unreviewed, { names, nowMs: NOW });
    expect(html).toContain('Approve (a)');
    expect(html).toContain('Reject (x)');
    expect(html).not.toContain('(r)');
  });
  it('renders a checkbox and marks selected / focused rows', () => {
    const html = entryRow(unreviewed, { names, nowMs: NOW, selected: true, focused: true });
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('data-select');
    expect(html).toContain(' checked');
    expect(html).toContain('is-focused');
    expect(html).toContain('is-selected');
    const plain = entryRow(unreviewed, { names, nowMs: NOW });
    expect(plain).not.toContain('is-focused');
    expect(plain).not.toContain(' checked');
  });
  it('entriesList forwards the selection set and focused key', () => {
    const html = entriesList([unreviewed, approved], {
      names,
      nowMs: NOW,
      selected: new Set([entryKey(approved)]),
      focusKey: entryKey(unreviewed),
    });
    const [first, second] = html.split('<li class=').slice(1);
    expect(first).toContain('is-focused');
    expect(first).not.toContain('is-selected');
    expect(second).toContain('is-selected');
  });
});

describe('nextDispatchLimit', () => {
  it('grows by a page up to the server cap', () => {
    expect(nextDispatchLimit(100, 100)).toBe(200);
    expect(nextDispatchLimit(200, 200)).toBeNull();
  });
  it('is null when the last fetch returned less than asked (nothing more)', () => {
    expect(nextDispatchLimit(100, 40)).toBeNull();
  });
});
