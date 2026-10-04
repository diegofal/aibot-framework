import { describe, expect, it } from 'bun:test';
import { selectAllBox, selectAllState, toggleAll } from '../../web/ui/select-all.js';

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

describe('selectAllBox', () => {
  it('renders an unchecked labelled box with the visible count', () => {
    const html = selectAllBox({ id: 'x-all', state: 'none', count: 12 });
    expect(html).toContain('id="x-all"');
    expect(html).toContain('Select all 12');
    expect(html).not.toContain(' checked');
    expect(html).toContain('data-state="none"');
  });
  it('reads "Unselect all" and is checked when everything is selected', () => {
    const html = selectAllBox({ id: 'x-all', state: 'all', count: 3 });
    expect(html).toContain(' checked');
    expect(html).toContain('Unselect all');
  });
  it('marks the partial state for the indeterminate sync', () => {
    expect(selectAllBox({ id: 'x-all', state: 'some', count: 3 })).toContain('data-state="some"');
  });
  it('renders nothing when there is nothing to select', () => {
    expect(selectAllBox({ id: 'x-all', state: 'none', count: 0 })).toBe('');
  });
});
