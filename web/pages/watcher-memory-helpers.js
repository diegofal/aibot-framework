/**
 * Watcher page, memory half (plan `docs/plans/watcher-optimizations-plan.md`,
 * O10: forgetting by importance and nightly consolidation). Pure: no DOM, no
 * fetch, so `tests/web/watcher-memory-helpers.test.ts` runs it under Bun.
 *
 *  - `memoryCountsHtml`: the header's live / archived counts.
 *  - `summaryRowsHtml`: the Summaries list, each `summary` neuron with the
 *    facts it consolidated in a fold (members are archived neurons the page
 *    already holds; one it does not is named by id). Archived summaries
 *    are left out.
 *  - `effectRedrawsThoughts`: whether a live event redraws Insights and
 *    Summaries (an archive too, so an archived summary leaves the list).
 *
 * Why an archived neuron was archived is the Why panel's job
 * (`neuronToWhy` in `src/why/builders/watcher.ts`, note "Why archived").
 */
import { esc } from '../ui/index.js';
import { SIGNAL_NEURON_KINDS } from './watcher-metrics-helpers.js';

const MAX_ROWS = 30;
const fmt = (n) => Number(n).toLocaleString('en-US');

function relTime(iso, nowMs) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const abs = Math.abs(nowMs - t);
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min ago`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} h ago`;
  return `${Math.round(abs / 86_400_000)} d ago`;
}

/** "5 live · 1,200 archived", or '' when the state carries no archived count. */
export function memoryCountsHtml(state) {
  const archived = Number(state?.archived);
  if (!state || state.archived == null || !Number.isFinite(archived)) return '';
  const counts = state.counts && typeof state.counts === 'object' ? state.counts : {};
  const live = Object.values(counts).reduce(
    (s, n) => s + (Number.isFinite(Number(n)) ? Number(n) : 0),
    0
  );
  return `<span class="watcher-count watcher-count-memory" title="Live neurons and the ones forgetting or consolidation archived"><b>${fmt(
    live
  )}</b> live · <b>${fmt(archived)}</b> archived</span>`;
}

const THOUGHT_KINDS = [...SIGNAL_NEURON_KINDS, 'summary'];

/**
 * True when a live effect (`applyWatcherEvent`) on this neuron changes the
 * Insights or Summaries lists: it spawned, changed or was archived, and it is
 * an insight-like neuron or a summary.
 */
export function effectRedrawsThoughts(effect, neuron) {
  if (!effect || !['spawn', 'update', 'archive'].includes(effect.kind)) return false;
  return THOUGHT_KINDS.includes(neuron?.kind);
}

/** Live summaries newest first; each with its facts in a fold. */
export function summaryRowsHtml(neurons, nowMs = Date.now()) {
  const all = Array.isArray(neurons) ? neurons : [];
  const byId = new Map(all.filter((n) => n?.id).map((n) => [n.id, n]));
  const rows = all
    .filter((n) => n?.kind === 'summary' && !n.archivedAt)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, MAX_ROWS);
  if (rows.length === 0) {
    return '<div class="watcher-insights-empty text-dim">No summaries yet. Consolidation writes them at night, while the fleet sleeps.</div>';
  }
  const items = rows.map((n) => {
    const ids = String(n.meta?.members ?? '')
      .split(',')
      .filter(Boolean);
    const bots = Array.isArray(n.support?.bots) ? n.support.bots.join(', ') : '';
    const members = ids
      .map((id) => {
        const m = byId.get(id);
        return m
          ? `<li><button type="button" class="watcher-insight-text" data-watcher-neuron="${esc(id)}">${esc(m.text)}</button></li>`
          : `<li class="text-dim">${esc(id)}</li>`;
      })
      .join('');
    const fold = ids.length
      ? `<details class="watcher-summary-members"><summary>${ids.length} fact${
          ids.length === 1 ? '' : 's'
        }</summary><ul>${members}</ul></details>`
      : '';
    return `<li class="watcher-insight" data-kind="summary"><button type="button" class="watcher-insight-text" data-watcher-neuron="${esc(
      n.id
    )}"><span class="watcher-insight-kind">summary</span> ${esc(n.text)}</button><div class="watcher-insight-meta text-dim">${esc(
      [relTime(n.createdAt, nowMs), bots].filter(Boolean).join(' · ')
    )}</div>${fold}</li>`;
  });
  return `<ul class="watcher-insights watcher-summaries">${items.join('')}</ul>`;
}
