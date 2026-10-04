import { describe, expect, it } from 'bun:test';
import {
  bulkPlan,
  collectVisibleItems,
  deleteLabel,
  matchesProductionFilters,
  prodHash,
  prodRequest,
  productionsBulkBar,
  rangeKeys,
  readFileParam,
  selKey,
} from '../../web/pages/productions-helpers.js';

const file = (path: string, extra: Record<string, unknown> = {}) => ({
  type: 'file',
  name: path.split('/').pop(),
  path,
  ...extra,
});
const dir = (path: string, children: unknown[]) => ({
  type: 'dir',
  name: path.split('/').pop(),
  path,
  children,
});

describe('readFileParam', () => {
  it('reads ?file=', () => {
    expect(readFileParam({ file: 'a.md' })).toBe('a.md');
  });
  it('accepts ?path= as an alias (old Needs You links)', () => {
    expect(readFileParam({ path: 'b.md' })).toBe('b.md');
  });
  it('prefers file over path; empty when neither', () => {
    expect(readFileParam({ file: 'a.md', path: 'b.md' })).toBe('a.md');
    expect(readFileParam({})).toBe('');
    expect(readFileParam(undefined)).toBe('');
  });
});

describe('prodHash', () => {
  it('builds canonical all-bots and single-bot hashes', () => {
    expect(prodHash({ botId: 'b 1', file: 'x/y.md' })).toBe(
      '#/work/productions?bot=b%201&file=x%2Fy.md'
    );
    expect(prodHash({ botId: 'b1', file: 'y.md', single: true })).toBe(
      '#/work/productions/b1?file=y.md'
    );
    expect(prodHash({ botId: 'b1', single: true })).toBe('#/work/productions/b1');
    expect(prodHash({})).toBe('#/work/productions');
  });
});

describe('matchesProductionFilters', () => {
  const approved = file('r/a.md', { evaluation: { status: 'approved' }, entryId: '1' });
  const plain = file('r/b.md', { entryId: '2' });
  const checked = file('c.md', { coherenceCheck: { coherent: true } });
  it('passes everything without filters', () => {
    expect(matchesProductionFilters(plain, {})).toBe(true);
  });
  it('filters by name/path search, case-insensitive', () => {
    expect(matchesProductionFilters(plain, { search: 'B.MD' })).toBe(true);
    expect(matchesProductionFilters(plain, { search: 'r/' })).toBe(true);
    expect(matchesProductionFilters(plain, { search: 'zzz' })).toBe(false);
  });
  it('filters by status', () => {
    expect(matchesProductionFilters(approved, { status: 'approved' })).toBe(true);
    expect(matchesProductionFilters(plain, { status: 'approved' })).toBe(false);
    expect(matchesProductionFilters(plain, { status: 'unreviewed' })).toBe(true);
    expect(matchesProductionFilters(approved, { status: 'unreviewed' })).toBe(false);
    expect(matchesProductionFilters(approved, { status: 'rejected' })).toBe(false);
    expect(matchesProductionFilters(checked, { status: 'checked' })).toBe(true);
    expect(matchesProductionFilters(plain, { status: 'checked' })).toBe(false);
  });
  it('a dir matches when any descendant does', () => {
    const d = dir('r', [plain, approved]);
    expect(matchesProductionFilters(d, { status: 'approved' })).toBe(true);
    expect(matchesProductionFilters(dir('e', [plain]), { status: 'approved' })).toBe(false);
  });
});

describe('collectVisibleItems', () => {
  const always = () => true;
  it('single-bot: dirs and files in order, collapsed dirs hide children, files carry entryId', () => {
    const tree = [dir('r', [file('r/a.md', { entryId: 'e1' })]), file('top.md')];
    const collapsed = collectVisibleItems(tree, {
      botId: 'b1',
      expandedDirs: new Set(),
      matchesFilters: always,
    });
    expect(collapsed).toEqual([
      { botId: 'b1', path: 'r', type: 'dir' },
      { botId: 'b1', path: 'top.md', type: 'file', entryId: undefined },
    ]);
    const open = collectVisibleItems(tree, {
      botId: 'b1',
      expandedDirs: new Set(['r']),
      matchesFilters: always,
    });
    expect(open.map((i) => i.path)).toEqual(['r', 'r/a.md', 'top.md']);
    expect(open[1].entryId).toBe('e1');
  });
  it('all-bots: top-level bot folders are not selectable and set the botId', () => {
    const botFolder = dir('b1', [dir('r', [file('r/a.md')])]);
    const tree = [botFolder];
    const items = collectVisibleItems(tree, {
      botId: null,
      expandedDirs: new Set(['b1', 'b1/r']),
      matchesFilters: always,
      topLevel: tree,
    });
    expect(items).toEqual([
      { botId: 'b1', path: 'r', type: 'dir' },
      { botId: 'b1', path: 'r/a.md', type: 'file', entryId: undefined },
    ]);
  });
  it('skips nodes that fail the filter', () => {
    const tree = [file('a.md'), file('b.md')];
    const items = collectVisibleItems(tree, {
      botId: 'b1',
      expandedDirs: new Set(),
      matchesFilters: (n: { path: string }) => n.path === 'b.md',
    });
    expect(items.map((i) => i.path)).toEqual(['b.md']);
  });
});

describe('rangeKeys', () => {
  const visible = ['a', 'b', 'c', 'd'].map((p) => ({ botId: 'b1', path: p, type: 'file' }));
  it('returns the inclusive range either direction', () => {
    expect(rangeKeys(visible, selKey('b1', 'b'), selKey('b1', 'd'))).toEqual(
      ['b', 'c', 'd'].map((p) => selKey('b1', p))
    );
    expect(rangeKeys(visible, selKey('b1', 'c'), selKey('b1', 'a'))).toEqual(
      ['a', 'b', 'c'].map((p) => selKey('b1', p))
    );
  });
  it('is empty when an end is not visible', () => {
    expect(rangeKeys(visible, selKey('b1', 'zz'), selKey('b1', 'a'))).toEqual([]);
  });
});

describe('deleteLabel', () => {
  it('describes one file, one folder, or a count', () => {
    expect(deleteLabel([{ type: 'file', path: 'a.md' }])).toBe('file "a.md"');
    expect(deleteLabel([{ type: 'dir', path: 'r' }])).toBe('folder "r" and all its contents');
    expect(
      deleteLabel([
        { type: 'file', path: 'a' },
        { type: 'dir', path: 'b' },
      ])
    ).toBe('2 items');
  });
});

describe('bulkPlan', () => {
  const items = [
    { botId: 'b1', path: 'a.md', type: 'file', entryId: 'e1' },
    { botId: 'b1', path: 'b.md', type: 'file' },
    { botId: 'b1', path: 'r', type: 'dir' },
  ];
  it('approve/reject/archive need a tracked file', () => {
    for (const action of ['approve', 'reject', 'archive']) {
      const plan = bulkPlan(items, action);
      expect(plan.targets.map((t) => t.path)).toEqual(['a.md']);
      expect(plan.skipped).toBe(2);
    }
  });
  it('delete works on any file or folder', () => {
    const plan = bulkPlan(items, 'delete');
    expect(plan.targets).toHaveLength(3);
    expect(plan.skipped).toBe(0);
  });
  it('unknown action skips everything', () => {
    expect(bulkPlan(items, 'nope')).toEqual({ targets: [], skipped: 3 });
  });
});

describe('prodRequest', () => {
  it('evaluate posts status (and rating when given)', () => {
    expect(prodRequest('approve', { botId: 'b 1', entryId: 'e/1' })).toEqual({
      url: '/api/productions/b%201/e%2F1/evaluate',
      method: 'POST',
      body: { status: 'approved' },
    });
    expect(prodRequest('reject', { botId: 'b1', entryId: 'e1', rating: 3 }).body).toEqual({
      status: 'rejected',
      rating: 3,
    });
  });
  it('archive posts a reason (default when blank)', () => {
    expect(prodRequest('archive', { botId: 'b1', entryId: 'e1' })).toEqual({
      url: '/api/productions/b1/e1/archive',
      method: 'POST',
      body: { reason: 'Archived from dashboard' },
    });
    expect(prodRequest('archive', { botId: 'b1', entryId: 'e1', reason: ' old ' }).body).toEqual({
      reason: 'old',
    });
  });
  it('delete uses the entry route when tracked, delete-by-path otherwise', () => {
    expect(prodRequest('delete-entry', { botId: 'b1', entryId: 'e1' })).toEqual({
      url: '/api/productions/b1/e1',
      method: 'DELETE',
      body: undefined,
    });
    expect(prodRequest('delete', { botId: 'b1', path: 'r/a.md' })).toEqual({
      url: '/api/productions/b1/delete-by-path',
      method: 'POST',
      body: { path: 'r/a.md' },
    });
  });
  it('null for an unknown action', () => {
    expect(prodRequest('nope', { botId: 'b1' })).toBeNull();
  });
});

describe('productionsBulkBar', () => {
  const ids = ['b/a.md', 'b/b.md', 'b/c.md'];
  it('idle: select-all over the shown files, no actions', () => {
    const html = productionsBulkBar({ visibleIds: ids });
    expect(html).toContain('id="prod-select-all"');
    expect(html).toContain('3 files');
    expect(html).not.toContain('data-bulk="delete"');
    expect(productionsBulkBar({ visibleIds: [] })).toBe('');
  });
  it('lists every bulk action with counts', () => {
    const html = productionsBulkBar({ visibleIds: ids, selected: new Set(ids), tracked: 2 });
    expect(html).toContain('All 3 selected');
    for (const a of ['approve', 'reject', 'archive', 'delete', 'clear']) {
      expect(html).toContain(`data-bulk="${a}"`);
    }
    expect(html).toContain('Approve 2');
    expect(html).toContain('Delete 3');
  });
  it('hides tracked-only actions when nothing selected is tracked', () => {
    const html = productionsBulkBar({ visibleIds: ids, selected: new Set(['b/a.md']), tracked: 0 });
    expect(html).not.toContain('data-bulk="approve"');
    expect(html).toContain('Delete 1');
  });
});
