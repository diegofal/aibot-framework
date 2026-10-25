/**
 * Watcher page, memory half (plan `docs/plans/watcher-optimizations-plan.md`,
 * O10: forgetting by importance and nightly consolidation). Pure: no DOM, no
 * fetch, so `tests/web/watcher-memory-helpers.test.ts` runs it under Bun.
 *
 *  - `memoryCountsHtml`: the header's live / archived counts.
 *  - `summaryMemberIds` / `summaryMembersHtml`: the facts a `summary` neuron
 *    consolidated, for the Mind panel's Summaries tab
 *    (`watcher-mind-helpers.js`), which puts them in a fold. Members are
 *    archived neurons the page already holds; one it does not is named by id.
 *
 * Why an archived neuron was archived is the Why panel's job
 * (`neuronToWhy` in `src/why/builders/watcher.ts`, note "Why archived").
 */
import { esc } from '../ui/index.js';

const fmt = (n) => Number(n).toLocaleString('en-US');

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

/** The ids a summary consolidated (`meta.members`, comma separated). */
export function summaryMemberIds(summary) {
  return String(summary?.meta?.members ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * The facts a summary consolidated, as a list: each member the page holds is
 * a button that opens it (`data-mind-open`), one it does not hold is named by
 * id. '' when the summary names no members. `neuronOf(id)` looks a neuron up.
 */
export function summaryMembersHtml(summary, neuronOf = () => null) {
  const ids = summaryMemberIds(summary);
  if (!ids.length) return '';
  const items = ids.map((id) => {
    const m = neuronOf(id);
    return m
      ? `<li><button type="button" class="watcher-mind-text" data-mind-open="${esc(id)}">${esc(m.text ?? '')}</button></li>`
      : `<li class="text-dim">${esc(id)}</li>`;
  });
  return `<ul class="watcher-summary-members">${items.join('')}</ul>`;
}
