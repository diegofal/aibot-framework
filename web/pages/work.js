/**
 * Work → Outputs (session S3.5 of docs/plans/jarvis-fleet-plan.md).
 *
 * The Work landing: every file the agents created or edited, newest first,
 * with the review verdict inline. Approve/Reject post the same
 * `POST /api/productions/:botId/:id/evaluate` the explorer uses, so karma and
 * the Needs You badge move exactly as before. The file tree stays under the
 * Productions tab; a title click opens the file there.
 */
import { showToast, skeleton } from '../ui/index.js';
import { authedAvatarSrc } from './agent-face.js';
import { api } from './shared.js';
import {
  entriesList,
  filterEntries,
  sortEntries,
  workFilters,
  workSummary,
} from './work-helpers.js';

const ENTRIES_LIMIT = 200;

/** Filter survives navigation within the session so "To review" stays picked. */
const workFilter = { status: 'unreviewed', botId: '' };
/** Listeners sit on the page root, which outlives this page: abort them on leave. */
let listeners = null;

export function destroyWork() {
  listeners?.abort();
  listeners = null;
}

export async function renderWork(el) {
  destroyWork();
  listeners = new AbortController();
  const { signal } = listeners;
  el.innerHTML = `<div class="page-title">Work</div>${skeleton({ lines: 6 })}`;

  const [entriesRes, agentsRes] = await Promise.all([
    api(`/api/productions/all-entries?limit=${ENTRIES_LIMIT}`).catch(() => null),
    api('/api/agents').catch(() => []),
  ]);
  const agents = Array.isArray(agentsRes) ? agentsRes : [];
  const names = Object.fromEntries(agents.map((a) => [a.id, a.name || a.id]));

  if (!entriesRes || entriesRes.error) {
    el.innerHTML = `
      <div class="page-title">Work</div>
      <p class="text-dim">Productions are not enabled. Set <code>productions.enabled: true</code> in config.</p>
    `;
    return;
  }

  let entries = sortEntries(Array.isArray(entriesRes.entries) ? entriesRes.entries : []);
  // Nothing to review yet: open on everything instead of an empty "To review".
  if (workFilter.status === 'unreviewed' && workSummary(entries).unreviewed === 0) {
    workFilter.status = 'all';
  }

  const draw = () => {
    const counts = workSummary(filterEntries(entries, { botId: workFilter.botId }));
    const visible = filterEntries(entries, workFilter);
    const filtered = visible.length !== entries.length;
    el.innerHTML = `
      <div class="flex-between mb-16 work-head">
        <div>
          <div class="page-title" style="margin-bottom:2px">Work <span class="count">${entries.length}</span></div>
          <div class="text-dim work-sub">${counts.unreviewed} to review · ${counts.approved} approved · ${counts.rejected} rejected</div>
        </div>
        <div class="work-head-actions">
          <a class="btn btn-sm" href="#/work/productions">Browse files</a>
          <a class="btn btn-sm btn-primary" href="#/needs">Needs You</a>
        </div>
      </div>
      ${workFilters({ ...workFilter, agents, counts })}
      <div id="work-list-wrap">${entriesList(visible, {
        names,
        nowMs: Date.now(),
        avatarSrc: authedAvatarSrc,
        filtered,
      })}</div>
    `;
  };
  draw();

  el.addEventListener(
    'click',
    async (e) => {
      const chip = e.target.closest('.work-chip[data-status]');
      if (chip) {
        workFilter.status = chip.dataset.status;
        draw();
        return;
      }
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action !== 'approve' && action !== 'reject') return;
      const { id, botId } = btn.dataset;
      const status = action === 'approve' ? 'approved' : 'rejected';
      const row = btn.closest('.work-item');
      for (const b of row?.querySelectorAll('button') ?? []) b.disabled = true;
      const res = await api(
        `/api/productions/${encodeURIComponent(botId)}/${encodeURIComponent(id)}/evaluate`,
        { method: 'POST', body: { status } }
      );
      if (res?.error) {
        showToast(`Could not ${action}: ${res.error}`, { tone: 'danger' });
        for (const b of row?.querySelectorAll('button') ?? []) b.disabled = false;
        return;
      }
      entries = entries.map((en) =>
        en.id === id && en.botId === botId
          ? { ...en, evaluation: { ...en.evaluation, status } }
          : en
      );
      showToast(`${names[botId] ?? botId}: ${status}`, {
        tone: status === 'approved' ? 'ok' : 'warn',
      });
      window.dispatchEvent(new CustomEvent('badges:refresh'));
      draw();
    },
    { signal }
  );

  el.addEventListener(
    'change',
    (e) => {
      if (e.target.id !== 'work-filter-agent') return;
      workFilter.botId = e.target.value;
      draw();
    },
    { signal }
  );
}
