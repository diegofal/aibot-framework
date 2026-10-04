import { describe, expect, it } from 'bun:test';
import {
  collectArgs,
  filterTools,
  groupTools,
  mergeTools,
  paramFormHtml,
  pendingIds,
  toolsBulkBar,
  toolsTable,
} from '../../web/pages/tools-helpers.js';

const all = [
  { name: 'web_fetch', description: 'Fetch a URL', parameters: {}, source: 'built-in' },
  {
    name: 'mcp_github_issue',
    description: 'Open an issue',
    parameters: {},
    source: 'mcp',
    category: 'github',
  },
  { name: 'calc', description: 'Do <math>', parameters: {}, source: 'dynamic', status: 'pending' },
  {
    name: 'joke',
    description: 'Tell a joke',
    parameters: {},
    source: 'dynamic',
    status: 'approved',
  },
];
const dynamic = [
  {
    id: 'd1',
    name: 'calc',
    createdBy: 'bot-a',
    createdAt: '2026-01-01T00:00:00Z',
    status: 'pending',
  },
  {
    id: 'd2',
    name: 'joke',
    createdBy: 'bot-b',
    createdAt: '2026-01-02T00:00:00Z',
    status: 'approved',
  },
];

describe('mergeTools', () => {
  it('attaches dynamic metadata (id, creator) by name', () => {
    const merged = mergeTools(all, dynamic);
    const calc = merged.find((t) => t.name === 'calc');
    expect(calc.id).toBe('d1');
    expect(calc.createdBy).toBe('bot-a');
    expect(merged.find((t) => t.name === 'web_fetch').id).toBeUndefined();
  });
  it('tolerates error payloads', () => {
    expect(mergeTools({ error: 'x' }, { error: 'y' })).toEqual([]);
    expect(mergeTools(all, { error: 'y' })).toHaveLength(4);
  });
});

describe('filterTools / groupTools / pendingIds', () => {
  const merged = mergeTools(all, dynamic);
  it('filters by query over name and description, and by source', () => {
    expect(filterTools(merged, { query: 'ISSUE' }).map((t) => t.name)).toEqual([
      'mcp_github_issue',
    ]);
    expect(filterTools(merged, { source: 'dynamic' })).toHaveLength(2);
    expect(filterTools(merged, { source: 'pending' }).map((t) => t.name)).toEqual(['calc']);
    expect(filterTools(merged, {})).toHaveLength(4);
  });
  it('groups built-in, each MCP server and dynamic, skipping empty groups', () => {
    const groups = groupTools(merged);
    expect(groups.map((g) => g.label)).toEqual(['Built-in', 'MCP · github', 'Dynamic']);
    expect(groupTools(filterTools(merged, { source: 'mcp' })).map((g) => g.label)).toEqual([
      'MCP · github',
    ]);
  });
  it('pendingIds lists the ids of pending dynamic tools', () => {
    expect(pendingIds(merged)).toEqual(['d1']);
  });
});

describe('toolsTable / toolsBulkBar', () => {
  const merged = mergeTools(all, dynamic);
  it('renders a Run action on every row and approve/reject only on pending ones', () => {
    const html = toolsTable(groupTools(merged), { selected: new Set(['d1']) });
    expect(html.match(/data-action="run"/g)).toHaveLength(4);
    expect(html).toContain('data-action="approve" data-id="d1"');
    expect(html).not.toContain('data-action="approve" data-id="d2"');
    expect(html).toContain('href="#/automations/tools/d2"');
    expect(html).toContain('data-select="d1" checked');
    expect(html).toContain('Do &lt;math&gt;');
  });
  it('shows an empty state when nothing matches', () => {
    expect(toolsTable([], { filtered: true })).toContain('No tools match');
  });
  it('toolsBulkBar is empty without a selection', () => {
    expect(toolsBulkBar(0)).toBe('');
    const html = toolsBulkBar(2);
    expect(html).toContain('2 selected');
    expect(html).toContain('data-bulk="approve"');
    expect(html).toContain('data-bulk="reject"');
  });
});

describe('paramFormHtml / collectArgs', () => {
  const params = {
    properties: {
      url: { type: 'string', description: 'The <url>' },
      n: { type: 'integer' },
      on: { type: 'boolean', description: 'flag' },
      opts: { type: 'object' },
      mode: { type: 'string', enum: ['a', 'b'] },
    },
    required: ['url'],
  };
  it('renders one field per parameter with the right control and a required mark', () => {
    const html = paramFormHtml(params);
    expect(html).toContain('data-param="url" data-type="string"');
    expect(html).toContain('data-param="n" data-type="number"');
    expect(html).toContain('data-param="on" data-type="boolean"');
    expect(html).toContain('data-param="opts" data-type="object"');
    expect(html).toContain('data-param="mode" data-type="enum"');
    expect(html).toContain('tool-run-required');
    expect(html).toContain('The &lt;url&gt;');
    expect(html).not.toContain('style=');
  });
  it('says so when there are no parameters', () => {
    expect(paramFormHtml({})).toContain('takes no parameters');
  });
  it('collectArgs converts typed fields and skips blanks', () => {
    const res = collectArgs([
      { name: 'url', type: 'string', value: ' x ' },
      { name: 'n', type: 'number', value: '3' },
      { name: 'on', type: 'boolean', checked: true },
      { name: 'opts', type: 'object', value: '{"a":1}' },
      { name: 'mode', type: 'enum', value: '' },
      { name: 'blank', type: 'string', value: '  ' },
    ]);
    expect(res).toEqual({ args: { url: 'x', n: 3, on: true, opts: { a: 1 } }, error: null });
  });
  it('collectArgs reports invalid JSON by parameter name', () => {
    const res = collectArgs([{ name: 'opts', type: 'array', value: '[1,' }]);
    expect(res.error).toContain('opts');
  });
});
