import { describe, expect, it } from 'bun:test';
import { dataTable, initMenus, rowMenu } from '../../web/ui/index.js';

describe('rowMenu', () => {
  it('renders a details element with one button per action item', () => {
    const html = rowMenu([
      { label: 'Edit', action: 'edit', id: 'b1' },
      { label: 'Delete', action: 'delete', id: 'b1', danger: true },
    ]);
    expect(html).toContain('<details class="ui-menu">');
    expect(html).toContain('<summary');
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('data-action="edit"');
    expect(html).toContain('data-id="b1"');
    expect(html).toContain('ui-menu-item ui-menu-danger');
    expect((html.match(/role="menuitem"/g) ?? []).length).toBe(2);
  });

  it('renders link items as anchors and skips falsy entries', () => {
    const html = rowMenu([null, { label: 'View', href: '#/x/1' }, false, undefined]);
    expect(html).toContain('<a class="ui-menu-item" role="menuitem" href="#/x/1">View</a>');
    expect(html).not.toContain('<button');
  });

  it('escapes labels, ids and hrefs', () => {
    const html = rowMenu([
      { label: '<b>x</b>', action: 'a', id: '"q"' },
      { label: 'l', href: '#/a"b' },
    ]);
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('data-id="&quot;q&quot;"');
    expect(html).toContain('href="#/a&quot;b"');
  });

  it('supports separators, titles and disabled items', () => {
    const html = rowMenu([
      { label: 'A', action: 'a', id: '1', title: 'Does A' },
      { separator: true },
      { label: 'B', action: 'b', id: '1', disabled: true },
    ]);
    expect(html).toContain('<hr class="ui-menu-sep">');
    expect(html).toContain('title="Does A"');
    expect(html).toContain('disabled');
  });

  it('returns an empty string when there is nothing to show', () => {
    expect(rowMenu([])).toBe('');
    expect(rowMenu([null, { separator: true }])).toBe('');
    expect(rowMenu(undefined)).toBe('');
  });

  it('accepts a custom trigger label', () => {
    expect(rowMenu([{ label: 'A', action: 'a' }], { label: 'Job actions' })).toContain(
      'aria-label="Job actions"'
    );
  });

  it('initMenus is a no-op without a document', () => {
    expect(typeof initMenus()).toBe('function');
    expect(() => initMenus()()).not.toThrow();
  });
});

describe('dataTable', () => {
  const columns = ['Name', { label: 'Karma', align: 'right' }, { label: '', width: '40px' }];

  it('wraps the table in a horizontal scroll container', () => {
    const html = dataTable({ columns, rows: [['a', '1', '']] });
    expect(html.startsWith('<div class="table-scroll">')).toBe(true);
    expect(html).toContain('<table class="ui-table">');
  });

  it('renders escaped column labels with alignment and width', () => {
    const html = dataTable({ columns: [...columns, '<x>'], rows: [] });
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<th class="ui-td-right">Karma</th>');
    expect(html).toContain('style="width:40px"');
    expect(html).toContain('&lt;x&gt;');
  });

  it('renders cells as trusted HTML and applies row attributes', () => {
    const html = dataTable({
      columns,
      rows: [{ cells: ['<b>bold</b>', '2', ''], attrs: { 'data-id': 'x"y', class: 'row-x' } }],
    });
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('<tr data-id="x&quot;y" class="row-x">');
  });

  it('right-aligns body cells of right-aligned columns', () => {
    const html = dataTable({ columns, rows: [['a', '1', '']] });
    expect(html).toContain('<td class="ui-td-right">1</td>');
  });

  it('renders the empty markup instead of a table when there are no rows', () => {
    expect(dataTable({ columns, rows: [], empty: '<p>none</p>' })).toBe('<p>none</p>');
    expect(dataTable({ columns, rows: [] })).toContain('<tbody></tbody>');
  });

  it('adds extra class names and an id', () => {
    const html = dataTable({ columns, rows: [], className: 'agents-table', id: 'agents-tbody' });
    expect(html).toContain('class="ui-table agents-table"');
    expect(html).toContain('<tbody id="agents-tbody">');
  });
});
