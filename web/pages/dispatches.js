/**
 * Dispatches — the fleet inbox of insights (step C7 of
 * docs/plans/curiosity-navigator-plan.md). Every accessible agent's
 * dispatches, newest first, filterable by sent / held / proposals, with the
 * same 👍 / 👎 / "more like this" signals as Agent Home. Signals teach each
 * agent's taste model and earn (or cost) it dispatch frequency.
 *
 * Data: `GET /api/curiosity/dispatches?limit=…`. Markup: curiosity-helpers.js.
 */
import { emptyState, skeleton, tabs } from '../ui/index.js';
import { authedAvatarSrc } from './agent-face.js';
import {
  DISPATCH_FILTERS,
  dispatchCounts,
  dispatchList,
  filterDispatches,
} from './curiosity-helpers.js';
import { wireCuriositySignals } from './curiosity.js';
import { api } from './shared.js';

const LIMIT = 100;
const FILTER_KEY = 'aibot.dispatches.filter';

const EMPTY_HINT = {
  all: 'When an agent finds something worth your attention it lands here: one non-obvious claim, why it matters to you, the evidence, what to do.',
  sent: 'Nothing has passed the editor gate yet.',
  held: 'Nothing is being held back for a digest.',
  proposals: 'No agent is asking to cross one of its limits right now.',
};

function storedFilter() {
  try {
    const f = sessionStorage.getItem(FILTER_KEY);
    return DISPATCH_FILTERS.some((x) => x.id === f) ? f : 'all';
  } catch {
    return 'all';
  }
}

export async function renderDispatches(el) {
  let filter = storedFilter();
  let items = [];

  const draw = () => {
    const counts = dispatchCounts(items);
    const strip = tabs(
      DISPATCH_FILTERS.map((f) => ({ id: f.id, label: f.label, badge: counts[f.id] || '' })),
      filter
    );
    el.querySelector('#dispatch-filters').innerHTML = strip;
    el.querySelector('#dispatch-feed').innerHTML = dispatchList(filterDispatches(items, filter), {
      showBot: true,
      avatarSrc: authedAvatarSrc,
      emptyTitle: filter === 'all' ? 'No dispatches yet' : `No ${filter} dispatches`,
      emptyHint: EMPTY_HINT[filter],
    });
  };

  const load = async () => {
    const res = await api(`/api/curiosity/dispatches?limit=${LIMIT}`).catch((err) => ({
      error: err?.message,
    }));
    if (!el.isConnected) return;
    if (!res || res.error) {
      el.querySelector('#dispatch-feed').innerHTML = emptyState({
        icon: '∅',
        title: 'Could not load dispatches',
        hint: res?.error || 'The server did not answer.',
      });
      return;
    }
    items = Array.isArray(res.dispatches) ? res.dispatches : [];
    draw();
  };

  el.innerHTML = `
    <div class="curio-inbox">
      <div class="curio-inbox-head">
        <div>
          <div class="page-title">Dispatches</div>
          <div class="text-dim text-sm">What your agents found worth your attention. 👍 / 👎 / "more like this" shape what each one brings back, and how often.</div>
        </div>
        <button class="btn btn-sm" id="dispatch-refresh">Refresh</button>
      </div>
      <div id="dispatch-filters"></div>
      <div id="dispatch-feed">${skeleton({ block: true, height: 180 })}</div>
    </div>`;

  el.querySelector('#dispatch-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    filter = btn.dataset.tab;
    try {
      sessionStorage.setItem(FILTER_KEY, filter);
    } catch {
      /* private mode */
    }
    draw();
  });
  el.querySelector('#dispatch-refresh').addEventListener('click', load);
  wireCuriositySignals(el.querySelector('#dispatch-feed'), {
    onSignal: (kind, res) => {
      if (kind !== 'dispatch' || !res?.dispatch) return;
      const i = items.findIndex((d) => d.id === res.dispatch.id && d.botId === res.dispatch.botId);
      if (i !== -1) items[i] = { ...items[i], ...res.dispatch };
    },
  });
  await load();
}
