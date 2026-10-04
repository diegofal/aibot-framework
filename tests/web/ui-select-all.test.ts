import { describe, expect, it } from 'bun:test';
import { bulkToolbar, selectAllState, toggleAll } from '../../web/ui/select-all.js';

describe('selectAllState', () => {
  it('is none when nothing visible is selected', () => {
    expect(selectAllState(['a', 'b'], [])).toBe('none');
    expect(selectAllState(['a', 'b'], new Set(['z']))).toBe('none');
  });
  it('is some when part of the visible rows are selected', () => {
    expect(selectAllState(['a', 'b'], ['a'])).toBe('some');
  });
  it('is all when every visible row is selected, ignoring hidden extras', () => {
    expect(selectAllState(['a', 'b'], new Set(['a', 'b', 'z']))).toBe('all');
  });
  it('is none for an empty list', () => {
    expect(selectAllState([], ['a'])).toBe('none');
  });
});

describe('toggleAll', () => {
  it('selects every visible row when not all are selected, keeping others', () => {
    expect([...toggleAll(['a', 'b'], ['a', 'z'])].sort()).toEqual(['a', 'b', 'z']);
  });
  it('unselects the visible rows when all are selected, keeping others', () => {
    expect([...toggleAll(['a', 'b'], new Set(['a', 'b', 'z']))]).toEqual(['z']);
  });
});

describe('bulkToolbar', () => {
  const actions = [
    { id: 'approve', label: 'Approve', count: 2, tone: 'primary' },
    { id: 'reject', label: 'Reject', count: 0 },
    { id: 'delete', label: 'Delete', count: 1, tone: 'danger' },
  ];

  it('idle: an unchecked box, "Select all · N items" and the idle markup, no actions', () => {
    const html = bulkToolbar({ id: 'x', visibleIds: ['a', 'b'], actions, idle: '<i>idle</i>' });
    expect(html).toContain('id="x-all"');
    expect(html).toContain('data-state="none"');
    expect(html).toContain('Select all');
    expect(html).toContain('2 items');
    expect(html).toContain('<i>idle</i>');
    expect(html).not.toContain('data-bulk=');
    expect(html).not.toContain('has-selection');
  });

  it('with a selection: count, the actions that apply (count > 0) and Clear', () => {
    const html = bulkToolbar({ id: 'x', visibleIds: ['a', 'b'], selected: ['a'], actions });
    expect(html).toContain('data-state="some"');
    expect(html).toContain('1 of 2 selected');
    expect(html).toContain('has-selection');
    expect(html).toContain('data-bulk="approve"');
    expect(html).toContain('Approve 2');
    expect(html).toContain('btn-danger" data-bulk="delete"');
    expect(html).not.toContain('data-bulk="reject"');
    expect(html).toContain('data-bulk="clear"');
  });

  it('everything selected: checked, "All N selected", ignores selected ids not shown', () => {
    const html = bulkToolbar({
      id: 'x',
      visibleIds: new Set(['a']),
      selected: new Set(['a', 'z']),
      noun: 'tool',
    });
    expect(html).toContain(' checked');
    expect(html).toContain('All 1 selected');
  });

  it('renders nothing for an empty list', () => {
    expect(bulkToolbar({ id: 'x', visibleIds: [] })).toBe('');
  });
});
