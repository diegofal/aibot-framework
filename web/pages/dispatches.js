/**
 * Dispatches — the fleet inbox of insights (step C7 of
 * docs/plans/curiosity-navigator-plan.md). Every accessible agent's
 * dispatches, newest first, filterable by sent / held / proposals, with the
 * same 👍 / 👎 / "more like this" signals as Agent Home. Signals teach each
 * agent's taste model and earn (or cost) it dispatch frequency.
 *
 * Data: `GET /api/curiosity/dispatches?limit=…&before=…`. Markup: curiosity-helpers.js.
 * Keys: j/k move the focus, + (or =) / - give the focused dispatch 👍 / 👎.
 * "Load more" asks for the next older page with the `nextBefore` cursor and appends it.
 */
import { emptyState, showToast, skeleton, tabs } from '../ui/index.js';
import { authedAvatarSrc } from './agent-face.js';
import {
  DISPATCH_FILTERS,
  dispatchCounts,
  dispatchList,
  filterDispatches,
} from './curiosity-helpers.js';
import { wireCuriositySignals } from './curiosity.js';
import { api } from './shared.js';
import {
  DISPATCH_KEYS,
  DISPATCH_PAGE,
  keyAction,
  mergeDispatchPage,
  moveIndex,
  nextDispatchCursor,
} from './work-helpers.js';

/** Keydown listener lives on document: abort it when the page is left. */
let listeners = null;

export function destroyDispatches() {
  listeners?.abort();
  listeners = null;
}
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
  destroyDispatches();
  listeners = new AbortController();
  const { signal } = listeners;
  let filter = storedFilter();
  let items = [];
  let cursor = null;
  let focus = -1;

  const cards = () => [...el.querySelectorAll('#dispatch-feed .curio-dispatch')];
  const paintFocus = (scroll = false) => {
    const list = cards();
    list.forEach((c, i) => c.classList.toggle('is-focused', i === focus));
    if (scroll) list[focus]?.scrollIntoView?.({ block: 'nearest' });
  };

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
    const moreBtn = el.querySelector('#dispatch-more');
    if (moreBtn) {
      moreBtn.hidden = !cursor;
      moreBtn.textContent = `Load ${DISPATCH_PAGE} older`;
    }
    focus = Math.min(focus, cards().length - 1);
    paintFocus();
  };

  /** `before` null = first page (Refresh); otherwise append the older page. */
  const load = async (before = null) => {
    const qs = `limit=${DISPATCH_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const res = await api(`/api/curiosity/dispatches?${qs}`).catch((err) => ({
      error: err?.message,
    }));
    if (!el.isConnected) return;
    if (before && (!res || res.error)) {
      showToast(`Could not load older dispatches: ${res?.error || 'the server did not answer.'}`, {
        tone: 'danger',
      });
      return;
    }
    if (!res || res.error) {
      el.querySelector('#dispatch-feed').innerHTML = emptyState({
        icon: '∅',
        title: 'Could not load dispatches',
        hint: res?.error || 'The server did not answer.',
      });
      return;
    }
    const page = Array.isArray(res.dispatches) ? res.dispatches : [];
    items = before ? mergeDispatchPage(items, page) : page;
    cursor = nextDispatchCursor(res);
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
      <div class="dispatch-more-wrap"><button class="btn btn-sm" id="dispatch-more" hidden>Load more</button></div>
      <div class="text-dim text-sm dispatch-keys-hint">j/k move · + 👍 · - 👎</div>
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
  el.querySelector('#dispatch-refresh').addEventListener('click', () => load());
  el.querySelector('#dispatch-more').addEventListener('click', () => {
    if (cursor) load(cursor);
  });
  el.querySelector('#dispatch-feed').addEventListener('click', (e) => {
    const card = e.target.closest('.curio-dispatch');
    if (!card) return;
    focus = cards().indexOf(card);
    paintFocus();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      // The page root outlives this page: once the feed is gone, unhook.
      if (!el.querySelector('#dispatch-feed')) {
        destroyDispatches();
        return;
      }
      if (document.getElementById('ui-dialog-root')) return;
      const action = keyAction(e, DISPATCH_KEYS);
      if (!action) return;
      const list = cards();
      if (action === 'next' || action === 'prev') {
        if (!list.length) return;
        e.preventDefault();
        focus = moveIndex(focus, action === 'next' ? 1 : -1, list.length);
        paintFocus(true);
        return;
      }
      const card = list[focus];
      if (!card) return;
      const btn = card.querySelector(`button.curio-signal[data-signal="${action}"]`);
      if (!btn || btn.disabled) return;
      e.preventDefault();
      btn.click();
    },
    { signal }
  );
  wireCuriositySignals(el.querySelector('#dispatch-feed'), {
    onSignal: (kind, res) => {
      if (kind !== 'dispatch' || !res?.dispatch) return;
      const i = items.findIndex((d) => d.id === res.dispatch.id && d.botId === res.dispatch.botId);
      if (i !== -1) items[i] = { ...items[i], ...res.dispatch };
    },
  });
  await load();
}
