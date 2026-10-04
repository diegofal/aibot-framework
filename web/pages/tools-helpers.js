/**
 * Pure pieces of the merged Tools page (UX overhaul phase 4: Tools + Tool
 * Runner become one list with a Run action per row). No DOM, so
 * `tests/web/tools-helpers.test.ts` covers them; `tools.js` and
 * `tool-runner.js` keep fetching and event wiring.
 */
import { badge, emptyState, esc } from '../ui/index.js';

const STATUS_TONE = { pending: 'warn', approved: 'ok', rejected: 'danger' };

export const TOOL_SOURCES = [
  { id: '', label: 'All sources' },
  { id: 'built-in', label: 'Built-in' },
  { id: 'mcp', label: 'MCP' },
  { id: 'dynamic', label: 'Dynamic' },
  { id: 'pending', label: 'Pending approval' },
];

/**
 * `/api/tools/all` (every tool, with schemas) joined with `/api/tools` (the
 * dynamic store: id, creator, dates) by name. Error payloads count as empty.
 */
export function mergeTools(all, dynamic) {
  const list = Array.isArray(all) ? all : [];
  const byName = new Map((Array.isArray(dynamic) ? dynamic : []).map((d) => [d.name, d]));
  return list.map((t) => {
    const d = t.source === 'dynamic' ? byName.get(t.name) : null;
    if (!d) return { ...t };
    return {
      ...t,
      id: d.id,
      status: t.status ?? d.status,
      createdBy: d.createdBy,
      createdAt: d.createdAt,
    };
  });
}

export function filterTools(tools, { query = '', source = '' } = {}) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  return (tools ?? []).filter((t) => {
    if (source === 'pending') {
      if (!(t.source === 'dynamic' && t.status === 'pending')) return false;
    } else if (source && t.source !== source) return false;
    if (!q) return true;
    return `${t.name ?? ''} ${t.description ?? ''} ${t.category ?? ''}`.toLowerCase().includes(q);
  });
}

/** `[{ key, label, tools }]`: Built-in, one group per MCP server, Dynamic. */
export function groupTools(tools) {
  const list = tools ?? [];
  const groups = [];
  const builtIn = list.filter((t) => t.source === 'built-in');
  if (builtIn.length) groups.push({ key: 'built-in', label: 'Built-in', tools: builtIn });
  const servers = new Map();
  for (const t of list.filter((x) => x.source === 'mcp')) {
    const k = t.category || 'unknown';
    if (!servers.has(k)) servers.set(k, []);
    servers.get(k).push(t);
  }
  for (const k of [...servers.keys()].sort()) {
    groups.push({ key: `mcp:${k}`, label: `MCP · ${k}`, tools: servers.get(k) });
  }
  const dyn = list.filter((t) => t.source === 'dynamic');
  if (dyn.length) groups.push({ key: 'dynamic', label: 'Dynamic', tools: dyn });
  return groups;
}

export function pendingIds(tools) {
  return (tools ?? [])
    .filter((t) => t.source === 'dynamic' && t.status === 'pending' && t.id)
    .map((t) => String(t.id));
}

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function toolRow(t, selected) {
  const isDyn = t.source === 'dynamic';
  const pending = isDyn && t.status === 'pending' && t.id;
  const select = pending
    ? `<input type="checkbox" class="tools-select" data-select="${esc(t.id)}"${
        selected.has(String(t.id)) ? ' checked' : ''
      } aria-label="Select ${esc(t.name)}">`
    : '';
  const name =
    isDyn && t.id
      ? `<a href="#/automations/tools/${encodeURIComponent(t.id)}">${esc(t.name)}</a>`
      : esc(t.name);
  const status = isDyn && t.status ? ` ${badge(t.status, STATUS_TONE[t.status] ?? 'muted')}` : '';
  const creator = isDyn && t.createdBy ? `<span class="text-dim"> by ${esc(t.createdBy)}</span>` : '';
  const actions = [
    `<button class="btn btn-sm" data-action="run" data-name="${esc(t.name)}">Run</button>`,
  ];
  if (pending) {
    actions.push(
      `<button class="btn btn-sm btn-primary" data-action="approve" data-id="${esc(t.id)}">Approve</button>`,
      `<button class="btn btn-sm btn-danger" data-action="reject" data-id="${esc(t.id)}">Reject</button>`
    );
  }
  if (isDyn && t.id) {
    actions.push(
      `<button class="btn btn-sm btn-danger" data-action="delete" data-id="${esc(t.id)}" data-name="${esc(
        t.name
      )}">Delete</button>`
    );
  }
  return `<tr data-name="${esc(t.name)}"><td class="tools-col-select">${select}</td><td class="tools-col-name"><span class="tools-name">${name}</span>${status}${creator}</td><td class="tools-col-desc text-dim" title="${esc(
    t.description ?? ''
  )}">${esc(truncate(t.description, 110))}</td><td class="tools-col-actions">${actions.join('')}</td></tr>`;
}

/** Grouped table of tools; each group gets a heading row. */
export function toolsTable(groups, { selected = new Set(), filtered = false } = {}) {
  const list = groups ?? [];
  if (list.length === 0) {
    return filtered
      ? emptyState({ icon: '⌕', title: 'No tools match', hint: 'Clear the filter to see every tool.' })
      : emptyState({ icon: '⚙', title: 'No tools registered' });
  }
  const body = list
    .map(
      (g) =>
        `<tr class="tools-group-row"><th colspan="4">${esc(g.label)} <span class="text-dim">${g.tools.length}</span></th></tr>${g.tools
          .map((t) => toolRow(t, selected))
          .join('')}`
    )
    .join('');
  return `<div class="table-scroll"><table class="ui-table tools-table"><tbody id="tools-tbody">${body}</tbody></table></div>`;
}

/** Bulk bar for the selected pending dynamic tools; '' when nothing is selected. */
export function toolsBulkBar(count) {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  return `<div class="ops-bulk-bar" role="toolbar" aria-label="Bulk actions">
    <span class="ops-bulk-count">${n} selected</span>
    <button class="btn btn-sm btn-primary" data-bulk="approve">Approve</button>
    <button class="btn btn-sm btn-danger" data-bulk="reject">Reject</button>
    <button class="btn btn-sm" data-bulk="clear">Clear</button>
  </div>`;
}

/** Form fields for a JSON-schema `parameters` object (no inline styles). */
export function paramFormHtml(parameters) {
  const properties = parameters?.properties || {};
  const required = new Set(parameters?.required || []);
  const names = Object.keys(properties);
  if (names.length === 0) return '<p class="text-dim">This tool takes no parameters.</p>';
  return names
    .map((name) => {
      const prop = properties[name] || {};
      const desc = prop.description || '';
      const type = prop.type || 'string';
      const req = required.has(name) ? ' <span class="tool-run-required">*</span>' : '';
      const n = esc(name);
      let control;
      if (type === 'boolean') {
        control = `<label class="tool-run-check"><input type="checkbox" data-param="${n}" data-type="boolean"> ${esc(desc)}</label>`;
      } else if (type === 'number' || type === 'integer') {
        control = `<input type="number" class="tool-run-input" data-param="${n}" data-type="number" placeholder="${esc(desc)}">`;
      } else if (type === 'object' || type === 'array') {
        control = `<textarea class="tool-run-input" data-param="${n}" data-type="${esc(type)}" rows="3" placeholder="${esc(
          desc || `JSON ${type}`
        )}"></textarea>`;
      } else if (Array.isArray(prop.enum)) {
        control = `<select class="tool-run-input" data-param="${n}" data-type="enum"><option value="">-- select --</option>${prop.enum
          .map((v) => `<option value="${esc(String(v))}">${esc(String(v))}</option>`)
          .join('')}</select>`;
      } else {
        control = `<input type="text" class="tool-run-input" data-param="${n}" data-type="string" placeholder="${esc(desc)}">`;
      }
      return `<div class="form-group"><label>${n}${req} <span class="tool-run-type">(${esc(type)})</span></label>${control}</div>`;
    })
    .join('');
}

/**
 * `fields = [{ name, type, value, checked }]` (read off the form) →
 * `{ args, error }`. Blank values are skipped; JSON fields must parse.
 */
export function collectArgs(fields) {
  const args = {};
  for (const f of fields ?? []) {
    const { name, type } = f;
    if (type === 'boolean') {
      args[name] = Boolean(f.checked);
      continue;
    }
    const raw = String(f.value ?? '');
    const val = type === 'enum' ? raw : raw.trim();
    if (val === '') continue;
    if (type === 'number') args[name] = Number(val);
    else if (type === 'object' || type === 'array') {
      try {
        args[name] = JSON.parse(val);
      } catch {
        return { args: null, error: `Invalid JSON for parameter "${name}"` };
      }
    } else args[name] = val;
  }
  return { args, error: null };
}
