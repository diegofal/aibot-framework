/**
 * Watcher page, the Mind panel (pure half): everything the ball holds as
 * dots, readable as lists. One tab per kind with its count, a sentence on
 * what that kind is for, newest first, searchable, 50 rows at a time. Data in,
 * HTML string out: no DOM, no Three.js (`tests/web/watcher-mind-helpers.test.ts`).
 *
 * Sources are what the page already holds: the live graph (`GET
 * /api/watcher/graph`, neurons with `meta`, and edges) and the broadcasts
 * (`GET /api/watcher/broadcasts`). A row's `data-mind-open` names the neuron
 * the page highlights in the ball and opens in the neuron sheet; a Why is
 * only rendered through the shared `whyPanel`; "Open cycle" is the shared
 * `[data-open-cycle]` + `data-bot-id` contract. A fold the page must keep
 * open across a re-render sits in a `[data-open-key]` wrapper.
 */
import { esc } from '../ui/index.js';
import { neuronColour } from './watcher-helpers.js';
import { signalButtonsHtml } from './watcher-metrics-helpers.js';
import { whyPanel } from './why-helpers.js';

export const MIND_PAGE_SIZE = 50;

/** `kind` is the neuron kind the tab lists (`broadcast` is the broadcast list). */
export const MIND_TABS = [
  {
    kind: 'insight',
    label: 'Insights',
    blurb:
      'Connections the watcher drew across bots in its deep (Opus) passes. The ones worth acting on become broadcasts; 👍/👎 teaches it which kind you find useful.',
  },
  {
    kind: 'prediction',
    label: 'Predictions',
    blurb:
      'Forecasts the watcher made about the fleet, scored when their deadline passes. Lower Brier is better; 0.25 is a coin flip.',
  },
  {
    kind: 'pattern',
    label: 'Patterns',
    blurb:
      'Recurring behaviour its quick (notice) pass spotted in one or more bots: an observation, not yet a conclusion.',
  },
  {
    kind: 'broadcast',
    label: 'Broadcasts',
    blurb:
      'What the watcher actually sent: a wake, directive or goal to a bot, or a question to you, and whether a bot cycle acted on it.',
  },
  {
    kind: 'contradiction',
    label: 'Contradictions',
    blurb:
      'Two things the fleet holds that cannot both be true. Confirm a real conflict, dismiss a false alarm; it learns from both.',
  },
  {
    kind: 'surprise',
    label: 'Surprises',
    blurb:
      'Events that broke what a bot or the watcher expected. They raise how closely the watcher looks at what follows.',
  },
  {
    kind: 'question',
    label: 'Questions',
    blurb: 'Open questions the bots are chasing, or that the watcher wants answered.',
  },
  {
    kind: 'topic',
    label: 'Topics',
    blurb:
      'Subjects the bots spend their cycles and memory on; the watcher links them so overlap between bots shows.',
  },
  {
    kind: 'fact',
    label: 'Facts',
    blurb:
      'Things the bots learned and keep in shared memory, mirrored here so the watcher can connect them across bots.',
  },
  {
    kind: 'person',
    label: 'People',
    blurb: 'The humans the bots talk to, from their contact directories (you included).',
  },
  {
    kind: 'goal',
    label: 'Goals',
    blurb: "Every bot's goals, so the watcher can tell who is working on what and who overlaps.",
  },
];

const TAB_BY_KIND = new Map(MIND_TABS.map((t) => [t.kind, t]));

/** The sentence under a tab: what this kind is and why it exists. */
export function mindTabBlurb(kind) {
  return TAB_BY_KIND.get(kind)?.blurb ?? '';
}

const isLive = (n) => !!n && typeof n.id === 'string' && !n.archivedAt;

/** Rows per tab: live neurons by kind, `broadcast` from the broadcast list. */
export function mindCounts(neurons, broadcasts) {
  const counts = Object.fromEntries(MIND_TABS.map((t) => [t.kind, 0]));
  for (const n of neurons ?? []) if (isLive(n) && n.kind in counts) counts[n.kind]++;
  counts.broadcast = Array.isArray(broadcasts) ? broadcasts.length : 0;
  return counts;
}

const newestFirst = (a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));

/** What a tab lists, newest first, narrowed by `query` (text, bots; broadcasts also bot and kind). */
export function mindRows(kind, { neurons = [], broadcasts = [], query = '' } = {}) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  if (kind === 'broadcast') {
    const rows = (Array.isArray(broadcasts) ? broadcasts : []).filter(
      (b) =>
        !q ||
        [b.text, b.botId, b.kind, b.deliveryError]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q))
    );
    return [...rows].sort(newestFirst);
  }
  const rows = (neurons ?? []).filter((n) => {
    if (!isLive(n) || n.kind !== kind) return false;
    if (!q) return true;
    const bots = Array.isArray(n.support?.bots) ? n.support.bots : [];
    return [n.text, ...bots].some((s) =>
      String(s ?? '')
        .toLowerCase()
        .includes(q)
    );
  });
  return rows.sort(newestFirst);
}

/** `pending` until resolved, then `happened` or `missed`. */
export function predictionOutcome(neuron) {
  const m = neuron?.meta ?? {};
  if (!m.resolvedAt) return 'pending';
  return m.happened === 'true' ? 'happened' : 'missed';
}

/** `delivered`, `deferred` (held by the throttle, never attempted) or `failed`. */
export function broadcastStatus(b) {
  if (b?.deliveredAt) return 'delivered';
  return b?.deferred ? 'deferred' : 'failed';
}

/** The neurons a contradiction's `contradicts` edges point at: `[{ id, text }]`. */
export function contradictionSides(id, edges, textOf = () => null) {
  const out = [];
  for (const e of edges ?? []) {
    if (e?.rel !== 'contradicts' || e.from !== id) continue;
    out.push({ id: e.to, text: textOf(e.to) ?? e.to });
  }
  return out;
}

/** Live neuron ids of one kind (the legend's ball filter); no kind → none. */
export function kindFilterIds(neurons, kind) {
  if (!kind) return [];
  const ids = [];
  for (const n of neurons ?? []) if (isLive(n) && n.kind === kind) ids.push(n.id);
  return ids;
}

/**
 * The ball's highlight has one source at a time: a neuron/row selection or a
 * legend kind, never both. Picking a kind clears the selection; selecting a
 * neuron or a log row clears the kind. A row inside a neuron filter keeps the
 * filter (the log stays narrowed to that neuron). Pure state transition:
 * `{ kindFilter, selectedSeq, selectedIds, filterId }` in and out.
 */
export function highlightState(state, action) {
  const s = {
    kindFilter: state?.kindFilter ?? null,
    selectedSeq: state?.selectedSeq ?? null,
    selectedIds: Array.isArray(state?.selectedIds) ? [...state.selectedIds] : [],
    filterId: state?.filterId ?? null,
  };
  const noRow = { selectedSeq: null, selectedIds: [] };
  switch (action?.type) {
    case 'kind':
      if (!action.kind || s.kindFilter === action.kind) return { ...s, kindFilter: null };
      return { kindFilter: action.kind, ...noRow, filterId: null };
    case 'neuron':
      return { kindFilter: null, ...noRow, filterId: action.id ?? null };
    case 'row':
      if (s.selectedSeq === action.seq) return { ...s, ...noRow };
      return {
        ...s,
        kindFilter: null,
        selectedSeq: action.seq,
        selectedIds: Array.isArray(action.ids) ? [...action.ids] : [],
      };
    case 'clear':
      return { ...s, ...noRow, filterId: null };
    default:
      return s;
  }
}

/**
 * Whether a live graph effect changes what a legend kind lights: a spawned
 * or revived neuron of the kind must light, an archived one must go dark.
 */
export function refocusOnEffect(effectKind, kindFilter) {
  return (
    Boolean(kindFilter) &&
    (effectKind === 'spawn' || effectKind === 'archive' || effectKind === 'revive')
  );
}

/**
 * Whether the ball dims what `highlightFor` does not light even when it
 * lights nothing: true while a legend kind is the highlight source, so a kind
 * with no live neurons shows an empty ball instead of every kind.
 */
export function highlightDims({ kindFilter = null, selectedSeq = null, filterId = null } = {}) {
  if (selectedSeq !== null && selectedSeq !== undefined) return false;
  if (filterId) return false;
  return Boolean(kindFilter);
}

/**
 * The ids the ball lights for a `highlightState`: a selected row's neurons,
 * else the filtered neuron, else the legend kind, else what the watcher
 * attends to (`attention.focusNeuronIds`).
 */
export function highlightFor({
  kindFilter = null,
  selectedSeq = null,
  selectedIds = [],
  filterId = null,
  neurons = [],
  attention = null,
} = {}) {
  if (selectedSeq !== null && selectedSeq !== undefined) return [...(selectedIds ?? [])];
  if (filterId) return [filterId];
  if (kindFilter) return kindFilterIds(neurons, kindFilter);
  return Array.isArray(attention?.focusNeuronIds) ? [...attention.focusNeuronIds] : [];
}

/**
 * What each tab shows: kind, formatted count, active. The page renders the
 * strip once (`mindTabsHtml`) and then patches counts and the active tab in
 * place from this, so a redraw keeps the strip's scroll and keyboard focus.
 */
export function mindTabState(counts, active) {
  return MIND_TABS.map((t) => ({
    kind: t.kind,
    count: Number(counts?.[t.kind] ?? 0).toLocaleString('en-US'),
    active: t.kind === active,
  }));
}

/** The tab strip: a button per kind with its colour dot and count. */
export function mindTabsHtml(counts, active) {
  const state = mindTabState(counts, active);
  return `<div class="watcher-mind-tabs" role="tablist" aria-label="What the watcher holds">${MIND_TABS.map(
    (t, i) => {
      const on = state[i].active;
      const dot =
        t.kind === 'broadcast'
          ? '<i class="watcher-mind-dot is-broadcast"></i>'
          : `<i class="watcher-mind-dot" style="background:${neuronColour({ kind: t.kind, createdBy: 'watcher' })}"></i>`;
      return `<button type="button" role="tab" class="watcher-mind-tab${on ? ' is-active' : ''}" data-mind-tab="${t.kind}" aria-selected="${
        on ? 'true' : 'false'
      }">${dot}<span>${t.label}</span><b class="watcher-mind-count">${state[i].count}</b></button>`;
    }
  ).join('')}</div>`;
}

function relTime(iso, nowMs) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const d = nowMs - t;
  const abs = Math.abs(d);
  if (abs < 60_000) return 'just now';
  const unit =
    abs < 3_600_000
      ? `${Math.round(abs / 60_000)} min`
      : abs < 86_400_000
        ? `${Math.round(abs / 3_600_000)} h`
        : `${Math.round(abs / 86_400_000)} d`;
  return d >= 0 ? `${unit} ago` : `in ${unit}`;
}

const bots = (n) => (Array.isArray(n?.support?.bots) ? n.support.bots : []);
const meta = (parts) =>
  `<div class="watcher-mind-meta">${parts.filter(Boolean).join('<span class="watcher-sep">·</span>')}</div>`;
const badge = (text, tone) => `<span class="watcher-mind-badge is-${tone}">${esc(text)}</span>`;
const openText = (id, text) =>
  `<button type="button" class="watcher-mind-text" data-mind-open="${esc(id)}">${esc(text ?? '')}</button>`;
const timeOf = (iso, nowMs) =>
  iso ? `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(relTime(iso, nowMs))}</time>` : '';

/** A fold the page keeps open across re-renders (`open` holds its key). */
function fold(key, summary, body, open) {
  return `<div data-open-key="${esc(key)}"><details class="watcher-mind-fold"${
    open?.has(key) ? ' open' : ''
  }><summary>${esc(summary)}</summary><div class="watcher-mind-fold-body">${body}</div></details></div>`;
}

function predictionRow(n, { nowMs, open }) {
  const m = n.meta ?? {};
  const p = Number(m.probability);
  const outcome = predictionOutcome(n);
  const parts = [];
  if (Number.isFinite(p)) parts.push(`<b class="watcher-mind-prob">${Math.round(p * 100)} %</b>`);
  if (outcome === 'pending') {
    parts.push(badge('pending', 'muted'));
    if (m.dueAt) {
      const overdue = Date.parse(m.dueAt) <= nowMs;
      parts.push(
        `<span title="${esc(m.dueAt)}">${esc(overdue ? `was due ${relTime(m.dueAt, nowMs)}, scoring soon` : `due ${relTime(m.dueAt, nowMs)}`)}</span>`
      );
    }
  } else {
    parts.push(
      outcome === 'happened' ? badge('happened', 'ok') : badge('did not happen', 'danger')
    );
    const brier = Number(m.brier);
    if (m.brier != null && Number.isFinite(brier)) {
      parts.push(
        `<span class="watcher-mind-brier${brier > 0.25 ? ' is-bad' : ''}">Brier ${brier.toFixed(2)}</span>`
      );
    }
    if (m.resolvedAt) parts.push(`scored ${timeOf(m.resolvedAt, nowMs)}`);
  }
  parts.push(`made ${timeOf(n.createdAt, nowMs)}`);
  const evidence =
    outcome !== 'pending' && m.evidence
      ? fold(`${n.id}:evidence`, 'Evidence', `<p>${esc(m.evidence)}</p>`, open)
      : '';
  return `${openText(n.id, n.text)}${meta(parts)}${evidence}${signalButtonsHtml(n.id, m.signal)}`;
}

/**
 * Whether an insight with no broadcast in `broadcasts` may still have one the
 * page never fetched: the list hit `limit` and the insight is older than its
 * oldest record (a broadcast is never older than its insight).
 */
function broadcastUnknown(n, broadcasts, limit) {
  const list = broadcasts ?? [];
  if (!Number.isFinite(Number(limit)) || list.length < Number(limit)) return false;
  let oldest = Number.POSITIVE_INFINITY;
  for (const b of list) {
    const t = Date.parse(b?.createdAt ?? '');
    if (Number.isFinite(t) && t < oldest) oldest = t;
  }
  const created = Date.parse(n?.createdAt ?? '');
  return Number.isFinite(oldest) && (!Number.isFinite(created) || created < oldest);
}

function insightRow(n, { nowMs, broadcasts, broadcastLimit }) {
  const sent = (broadcasts ?? []).filter((b) => b?.insightId === n.id);
  const parts = [];
  const b = bots(n);
  if (b.length) parts.push(esc(b.join(', ')));
  if (n.confidence) parts.push(`${esc(n.confidence)} confidence`);
  parts.push(timeOf(n.createdAt, nowMs));
  let status;
  if (sent.length) {
    status = sent
      .map((s) => `broadcast to ${esc(s.botId)} (${esc(broadcastStatus(s))})`)
      .join(', ');
  } else if (n.meta?.whyNoBroadcast) {
    status = `<span class="text-dim">not broadcast: ${esc(n.meta.whyNoBroadcast)}</span>`;
  } else if (broadcastUnknown(n, broadcasts, broadcastLimit)) {
    status = `<span class="text-dim">broadcast status unknown (older than the last ${esc(
      String(broadcastLimit)
    )} broadcasts)</span>`;
  } else status = '<span class="text-dim">not broadcast</span>';
  return `${openText(n.id, n.text)}${meta(parts)}<div class="watcher-mind-status">${status}</div>${signalButtonsHtml(
    n.id,
    n.meta?.signal
  )}`;
}

const BROADCAST_KIND = {
  wake: 'wake',
  directive: 'directive',
  goal: 'goal',
  question: 'question to you',
};

function broadcastRow(b, { nowMs, open }) {
  const status = broadcastStatus(b);
  const tone = status === 'delivered' ? 'ok' : status === 'deferred' ? 'muted' : 'danger';
  const parts = [
    `<b class="watcher-mind-bot">${esc(b.botId)}</b>`,
    esc(BROADCAST_KIND[b.kind] ?? b.kind ?? ''),
    badge(status, tone),
    timeOf(b.createdAt, nowMs),
  ];
  if (status !== 'delivered' && b.deliveryError)
    parts.push(`<span class="text-dim">${esc(b.deliveryError)}</span>`);
  const served = b.servedByCycle
    ? `served by a cycle <button type="button" class="btn btn-sm" data-open-cycle="${esc(
        b.servedByCycle
      )}" data-bot-id="${esc(b.botId)}">Open cycle</button>`
    : status === 'delivered'
      ? '<span class="text-dim">no cycle has acted on it yet</span>'
      : '';
  const text = b.insightId ? openText(b.insightId, b.text) : `<span>${esc(b.text ?? '')}</span>`;
  const whyKey = `${b.id}:why`;
  const panel = b.why ? whyPanel(b.why, { nowMs, botId: b.botId, open: !!open?.has(whyKey) }) : '';
  const why = panel ? `<div data-open-key="${esc(whyKey)}">${panel}</div>` : '';
  return `${text}${meta(parts)}${served ? `<div class="watcher-mind-status">${served}</div>` : ''}${why}${signalButtonsHtml(
    b.id,
    b.signal
  )}`;
}

function contradictionRow(n, { nowMs, sidesOf }) {
  const sides = sidesOf ? sidesOf(n.id) : [];
  const sideHtml = sides.length
    ? `<ol class="watcher-mind-sides">${sides
        .map((s) => `<li>${openText(s.id, s.text)}</li>`)
        .join('<li class="watcher-mind-vs" aria-hidden="true">vs</li>')}</ol>`
    : '';
  const parts = [bots(n).length ? esc(bots(n).join(', ')) : '', timeOf(n.createdAt, nowMs)];
  return `${openText(n.id, n.text)}${sideHtml}${meta(parts)}${signalButtonsHtml(
    n.id,
    n.meta?.signal,
    {
      up: 'Confirm',
      down: 'Dismiss',
    }
  )}`;
}

function plainRow(n, { nowMs }) {
  const acts = Number(n.activations) || 0;
  const by = n.createdBy === 'watcher' ? 'the watcher' : '';
  const parts = [
    bots(n).length ? esc(bots(n).join(', ')) : '',
    by ? `noted by ${by}` : '',
    timeOf(n.createdAt, nowMs),
    `${acts.toLocaleString('en-US')} activation${acts === 1 ? '' : 's'}`,
  ];
  return `${openText(n.id, n.text)}${meta(parts)}`;
}

const ROW = {
  prediction: predictionRow,
  insight: insightRow,
  broadcast: broadcastRow,
  contradiction: contradictionRow,
};

/**
 * A tab's list: `rows` from `mindRows`, the first `shown` of them, then
 * "Showing N of M" and "Show 50 more". `broadcasts` feeds an insight's
 * broadcast status (`broadcastLimit`: the cap they were fetched with, so an
 * insight older than a capped list reads "unknown", not "not broadcast"), `sidesOf(id)` a contradiction's sides, `open` the fold
 * keys to keep open.
 */
export function mindListHtml(
  kind,
  rows,
  {
    nowMs = Date.now(),
    shown = MIND_PAGE_SIZE,
    query = '',
    broadcasts = [],
    broadcastLimit = null,
    sidesOf = null,
    open = null,
  } = {}
) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    const label = (TAB_BY_KIND.get(kind)?.label ?? 'rows').toLowerCase();
    return `<div class="watcher-mind-empty text-dim">${
      String(query ?? '').trim() ? 'Nothing matches the search.' : `No ${esc(label)} yet.`
    }</div>`;
  }
  const limit = Math.max(MIND_PAGE_SIZE, Number(shown) || MIND_PAGE_SIZE);
  const page = list.slice(0, limit);
  const render = ROW[kind] ?? plainRow;
  const ctx = { nowMs, broadcasts, broadcastLimit, sidesOf, open };
  const colour = kind === 'broadcast' ? null : neuronColour({ kind, createdBy: 'watcher' });
  const items = page.map(
    (r) =>
      `<li class="watcher-mind-row${kind === 'broadcast' ? ' is-broadcast' : ''}" data-kind="${esc(kind)}"${
        colour ? ` style="--mind-kind:${colour}"` : ''
      }>${render(r, ctx)}</li>`
  );
  const more =
    list.length > page.length
      ? `<div class="watcher-mind-pager"><span class="text-dim">Showing ${page.length} of ${list.length.toLocaleString(
          'en-US'
        )}</span><button type="button" class="btn btn-sm" data-action="watcher-mind-more">Show ${Math.min(
          MIND_PAGE_SIZE,
          list.length - page.length
        )} more</button></div>`
      : '';
  return `<ul class="watcher-mind-list">${items.join('')}</ul>${more}`;
}
