/**
 * Sent to you — Work tab (docs/plans/why-everywhere-plan.md, phase 1 row 10):
 * every message an agent chose to send on its own (`send_proactive_message`),
 * newest first, delivered or refused by the throttle or failed, each with
 * its "Why this?" fold. Read-only.
 *
 * Data: `GET /api/proactive?limit=…&before=…`. Markup: sent-helpers.js.
 * "Load more" asks for the next older page with the `nextBefore` cursor.
 */
import { emptyState, showToast, skeleton, tabs } from '../ui/index.js';
import { authedAvatarSrc } from './agent-face.js';
import { SENT_FILTERS, filterSent, mergeSentPage, sentCounts, sentList } from './sent-helpers.js';
import { api } from './shared.js';
import { nextDispatchCursor } from './work-helpers.js';

const PAGE = 100;
const FILTER_KEY = 'aibot.sent.filter';

const EMPTY_HINT = {
  all: 'When an agent decides to message you (or someone else) on its own, it shows up here, delivered or not.',
  delivered: 'No proactive message has been delivered yet.',
  'not-sent': 'Nothing was refused by the throttle or failed to deliver.',
};

function storedFilter() {
  try {
    const f = sessionStorage.getItem(FILTER_KEY);
    return SENT_FILTERS.some((x) => x.id === f) ? f : 'all';
  } catch {
    return 'all';
  }
}

export async function renderSent(el) {
  let filter = storedFilter();
  let items = [];
  let cursor = null;

  const draw = () => {
    const counts = sentCounts(items);
    el.querySelector('#sent-filters').innerHTML = tabs(
      SENT_FILTERS.map((f) => ({ id: f.id, label: f.label, badge: counts[f.id] || '' })),
      filter
    );
    el.querySelector('#sent-feed').innerHTML = sentList(filterSent(items, filter), {
      avatarSrc: authedAvatarSrc,
      emptyTitle: filter === 'all' ? 'No messages yet' : 'Nothing here',
      emptyHint: EMPTY_HINT[filter],
    });
    const moreBtn = el.querySelector('#sent-more');
    if (moreBtn) {
      moreBtn.hidden = !cursor;
      moreBtn.textContent = `Load ${PAGE} older`;
    }
  };

  /** `before` null = first page (Refresh); otherwise append the older page. */
  const load = async (before = null) => {
    const qs = `limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const res = await api(`/api/proactive?${qs}`).catch((err) => ({ error: err?.message }));
    if (!el.isConnected) return;
    if (before && (!res || res.error)) {
      showToast(`Could not load older messages: ${res?.error || 'the server did not answer.'}`, {
        tone: 'danger',
      });
      return;
    }
    if (!res || res.error) {
      el.querySelector('#sent-feed').innerHTML = emptyState({
        icon: '∅',
        title: 'Could not load messages',
        hint: res?.error || 'The server did not answer.',
      });
      return;
    }
    const page = Array.isArray(res.messages) ? res.messages : [];
    items = before ? mergeSentPage(items, page) : page;
    cursor = nextDispatchCursor(res);
    draw();
  };

  el.innerHTML = `
    <div class="curio-inbox">
      <div class="curio-inbox-head">
        <div>
          <div class="page-title">Sent to you</div>
          <div class="text-dim text-sm">Messages your agents chose to send on their own, and the ones the throttle stopped. Open "Why this?" to see the cycle and goal behind each.</div>
        </div>
        <button class="btn btn-sm" id="sent-refresh">Refresh</button>
      </div>
      <div id="sent-filters"></div>
      <div id="sent-feed">${skeleton({ block: true, height: 180 })}</div>
      <div class="dispatch-more-wrap"><button class="btn btn-sm" id="sent-more" hidden>Load more</button></div>
    </div>`;

  el.querySelector('#sent-filters').addEventListener('click', (e) => {
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
  el.querySelector('#sent-refresh').addEventListener('click', () => load());
  el.querySelector('#sent-more').addEventListener('click', () => {
    if (cursor) load(cursor);
  });
  await load();
}
