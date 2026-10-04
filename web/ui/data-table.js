/**
 * Compact data table (session S3.5 of docs/plans/jarvis-fleet-plan.md).
 *
 * `columns`: strings or `{ label, align: 'right' | 'center', width }`.
 * `rows`: arrays of cell HTML (trusted: callers escape user text), or
 * `{ cells, attrs }` where `attrs` are escaped `<tr>` attributes.
 * Always wrapped in `.table-scroll`, so wide tables scroll instead of
 * squeezing their last column into a tall stack of buttons.
 */
import { esc } from './escape.js';

const ALIGN_CLASS = { right: 'ui-td-right', center: 'ui-td-center' };

function col(c) {
  return typeof c === 'string' ? { label: c } : (c ?? { label: '' });
}

function alignClass(c) {
  return ALIGN_CLASS[c.align] ?? '';
}

function attrString(attrs) {
  return Object.entries(attrs ?? {})
    .filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join('');
}

export function dataTable({ columns = [], rows = [], className = '', id = '', empty = '' } = {}) {
  const cols = columns.map(col);
  if (rows.length === 0 && empty) return empty;
  const head = cols
    .map((c) => {
      const cls = alignClass(c);
      const width = c.width ? ` style="width:${esc(String(c.width))}"` : '';
      return `<th${cls ? ` class="${cls}"` : ''}${width}>${esc(c.label ?? '')}</th>`;
    })
    .join('');
  const body = rows
    .map((r) => {
      const cells = Array.isArray(r) ? r : (r?.cells ?? []);
      const attrs = Array.isArray(r) ? '' : attrString(r?.attrs);
      const tds = cells
        .map((cell, i) => {
          const cls = alignClass(cols[i] ?? {});
          return `<td${cls ? ` class="${cls}"` : ''}>${cell ?? ''}</td>`;
        })
        .join('');
      return `<tr${attrs}>${tds}</tr>`;
    })
    .join('');
  const tableClass = className ? `ui-table ${className}` : 'ui-table';
  const tbodyId = id ? ` id="${esc(id)}"` : '';
  return `<div class="table-scroll"><table class="${tableClass}"><thead><tr>${head}</tr></thead><tbody${tbodyId}>${body}</tbody></table></div>`;
}
