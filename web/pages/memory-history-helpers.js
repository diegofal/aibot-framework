/**
 * Memory history — pure helpers for the Agent Home "Memory history" card
 * (docs/plans/why-everywhere-plan.md, phase 3 row 20): edits to the agent's
 * memory and soul files that happen out of sight — consolidation of daily
 * logs into MEMORY.md, facts saved from conversations, hygiene fixes.
 * String in, string out; `agent-home.js` owns the DOM and the network.
 *
 * Data: `GET /api/agents/:id/memory-history?limit=` → `{ botId, events, total }`,
 * newest first, each event a `soul-events.jsonl` row plus its `why`
 * (`src/web/routes/agent-home.ts`). The fold is the shared `whyPanel`.
 */
import { badge, emptyState, esc } from '../ui/index.js';
import { ago } from './agent-home-helpers.js';
import { whyPanel } from './why-helpers.js';

export const MEMORY_HISTORY_LIMIT = 30;

const OP_BADGE = {
  consolidate: ['consolidated', 'info'],
  'consolidate-rejected': ['rejected', 'warn'],
  'facts-saved': ['facts saved', 'ok'],
  'hygiene-fix': ['hygiene', 'accent'],
};

export function memoryHistoryUrl(botId, limit = MEMORY_HISTORY_LIMIT) {
  return `/api/agents/${encodeURIComponent(botId)}/memory-history?limit=${limit}`;
}

export function memoryHistoryRow(e, { nowMs = Date.now(), botId } = {}) {
  const [label, tone] = OP_BADGE[e?.op] ?? [String(e?.op ?? 'edit'), 'muted'];
  const title = e?.why?.what || label;
  return `<div class="home-mem-row">
    <div class="home-mem-head">
      <span class="home-mem-title">${esc(title)}</span>
      ${badge(label, tone)}
      <span class="text-dim text-sm">${esc(ago(e?.ts, nowMs))}</span>
    </div>
    ${e?.summary ? `<div class="home-mem-summary">${esc(e.summary)}</div>` : ''}
    ${whyPanel(e?.why, { nowMs, botId })}
  </div>`;
}

export function memoryHistoryBody(res, { nowMs = Date.now(), botId } = {}) {
  if (res?.error) {
    return `<div class="text-dim text-sm">Could not load the memory history: ${esc(res.error)}</div>`;
  }
  const events = Array.isArray(res?.events) ? res.events : [];
  if (events.length === 0) {
    return emptyState({
      icon: '◫',
      title: 'No memory edits yet',
      hint: 'Consolidations of daily logs, facts saved from conversations and hygiene fixes show up here, each with why it happened.',
    });
  }
  const more =
    typeof res.total === 'number' && res.total > events.length
      ? `<div class="text-dim text-sm home-mem-more">Showing the latest ${events.length} of ${res.total}.</div>`
      : '';
  return `<div class="home-mem-list">${events
    .map((e) => memoryHistoryRow(e, { nowMs, botId }))
    .join('')}</div>${more}`;
}
