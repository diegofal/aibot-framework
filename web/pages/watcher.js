/**
 * Watcher page (`#/watcher`, phase 1 of docs/plans/watcher-implementation-plan.md).
 *
 * The ball on top, the watcher's first-person log below, one `/ws/watcher`
 * socket feeding both. Data: `GET /api/watcher` (state, or `{ enabled:
 * false }`), `/api/watcher/graph`, `/api/watcher/log`; a click on a neuron
 * loads `/api/watcher/neurons/:id` into a side sheet with the shared Why
 * panel. Start / Stop post to `/api/watcher/start|stop`. "Replay birth"
 * rebuilds the ball from the birth day's log at a readable pace
 * (`replayQueue`); the date field replays any other day.
 * A pass row's "What it saw" fold loads its record (`/api/watcher/passes`);
 * the header shows the embedding service (`/api/stats/infra`, ollama row);
 * "Clean the graph" previews and applies hygiene `watcher-graph`.
 * The Mind panel under the ball lists what the ball holds, one tab per kind
 * (`watcher-mind-helpers.js`); a row opens its neuron, a legend kind filters
 * the ball to that kind.
 *
 * The pure half lives in `watcher-helpers.js`; WebGL in `watcher-ball.js`.
 */
import { closeSheet, confirmDialog, openSheet, showToast, skeleton } from '../ui/index.js';
import { api, escapeHtml, getAuthToken } from './shared.js';
import { mountBall } from './watcher-ball.js';
import {
  SPAWN_PACE,
  applyWatcherEvent,
  ballPlanFor,
  birthDate,
  canStartReplay,
  createWatcherModel,
  isWatcherOff,
  legendHtml,
  logListHtml,
  mergeLogRows,
  mergeWatcherState,
  needsGraphRefetch,
  neuronSheetBody,
  readWatcherMessage,
  reconcileGraph,
  replayQueue,
  shouldRedrawTiers,
  stateHtml,
  stateParts,
  syncStateButton,
  tierPatchFromInput,
  watcherDisabledHtml,
  watcherErrorHtml,
} from './watcher-helpers.js';
import { metricsStripHtml } from './watcher-metrics-helpers.js';
import {
  MIND_PAGE_SIZE,
  contradictionSides,
  highlightDims,
  highlightFor,
  highlightState,
  kindFilterIds,
  mindCounts,
  mindListHtml,
  mindRows,
  mindTabBlurb,
  mindTabState,
  mindTabsHtml,
  refocusOnEffect,
} from './watcher-mind-helpers.js';
import {
  graphCleanSummary,
  logView,
  matchPassRecord,
  passRecordBodyHtml,
} from './watcher-ops-helpers.js';
import {
  attendingHtml,
  cardHeadHtml,
  howIAmHtml,
  introspectionHtml,
} from './watcher-self-helpers.js';
import { dashboardSocketUrl, openReconnectingSocket } from './ws-reconnect.js';

const CLOCK_MS = 30_000;
/** Metrics and broadcasts are re-read this often (they come from records, not the socket). */
const SLOW_CLOCK_MS = 60_000;
const LOG_PAGE = 1000;
const LOG_MAX_PAGES = 20;
const TITLE = '<div class="page-title">Watcher</div>';
/** Events for unknown ids (or a reconnect) within this window share one graph refetch. */
const GRAPH_REFETCH_DEBOUNCE_MS = 1500;
/** Neuron events (thousands at birth) redraw the Mind panel at most this often. */
const MIND_REDRAW_MS = 800;
/** Broadcasts the Mind panel holds (the route's maximum). */
const BROADCAST_LIMIT = 200;

let page = null;
/** Bumped on every destroy: a render whose awaits resolve after it gives up. */
let generation = 0;

export function destroyWatcher() {
  generation++;
  if (!page) return;
  page.stopped = true;
  page.listeners?.abort();
  page.socket?.close();
  page.ball?.dispose();
  clearInterval(page.clock);
  clearInterval(page.slowClock);
  clearTimeout(page.replay?.timer);
  clearTimeout(page.graphRefetch);
  clearTimeout(page.mindTimer);
  page = null;
}

function $(sel) {
  return page?.el.querySelector(sel) ?? null;
}

/** The watcher went off under the page (any route answered `enabled: false`): show the off state. */
function showOff() {
  const el = page?.el;
  destroyWatcher();
  closeSheet();
  if (el) el.innerHTML = `${TITLE}${watcherDisabledHtml()}`;
}

/* ── Rendering ───────────────────────────────────────────────────── */

/**
 * The state bar. First draw builds it; afterwards counts, phase, notes and the
 * button are updated in place and the tier controls are rebuilt only when
 * their values changed and none has the focus (`shouldRedrawTiers`): the ≤ 5 s
 * `watcher:state` republish never wipes a cap being typed. `forceTiers` puts
 * the controls back to the last known state (a change the page did not send).
 */
function drawState({ forceTiers = false } = {}) {
  const host = $('#watcher-state');
  if (!host) return;
  const state = page.model.state;
  const view = { config: state?.config ?? null, busy: !!page.busy };
  const bar = host.querySelector('.watcher-state');
  const opts = { busy: page.busy, embedding: page.embedding };
  if (!bar) {
    host.innerHTML = stateHtml(state, Date.now(), opts);
    page.tierView = view;
    return;
  }
  const parts = stateParts(state, Date.now(), opts);
  const set = (sel, html) => {
    const node = bar.querySelector(sel);
    if (node && node.innerHTML !== html) node.innerHTML = html;
  };
  set('.watcher-state-main', parts.main);
  set('.watcher-counts', parts.counts);
  set('.watcher-notes', parts.notes);
  set('.watcher-embed', parts.embed);
  const button = bar.querySelector('[data-action="watcher-start"], [data-action="watcher-stop"]');
  syncStateButton(button, state, { busy: page.busy });
  const tiers = bar.querySelector('.watcher-tiers-host');
  const focused = !!tiers?.contains(document.activeElement);
  if (tiers && shouldRedrawTiers(page.tierView, view, focused, { force: forceTiers })) {
    tiers.innerHTML = parts.tiers;
    page.tierView = view;
  }
}

function drawLog() {
  const body = $('#watcher-log-body');
  if (!body) return;
  const { rows, options } = logView(page);
  body.innerHTML = logListHtml(rows, Date.now(), options);
}

function drawLogHead() {
  const filter = $('#watcher-log-filter');
  if (filter) {
    const n = page.filterId ? page.model.neurons.get(page.filterId) : null;
    filter.innerHTML = page.filterId
      ? `<span class="watcher-filter">Rows that touched “${escapeHtml(
          String(n?.text ?? page.filterId).slice(0, 60)
        )}” <button type="button" class="btn btn-sm" data-action="watcher-clear-filter">Show all</button></span>`
      : '';
  }
  const pause = $('[data-action="watcher-pause"]');
  if (pause) {
    pause.textContent = page.paused
      ? `Resume${page.pending ? ` (${page.pending} new)` : ''}`
      : 'Pause';
    pause.disabled = !!page.replay;
  }
}

function drawReplayBar() {
  const bar = $('#watcher-replay');
  if (!bar) return;
  const r = page.replay;
  bar.hidden = !r;
  if (r) {
    bar.querySelector('[data-replay-label]').textContent =
      `Replaying ${r.label} · ${r.shown.length} / ${r.rowCount} rows`;
  }
  for (const b of page.el.querySelectorAll('[data-replay-start]')) b.disabled = !!r || !page.ball;
}

function shell() {
  return `${TITLE}<div class="watcher-page">
    <div id="watcher-metrics"></div>
    <section class="watcher-stage" aria-label="The watcher's graph">
      <div class="watcher-ball" id="watcher-ball"></div>
      <div class="watcher-ball-fallback" id="watcher-ball-fallback" hidden>The 3D view could not start in this browser (WebGL unavailable). The log below still updates live.</div>
      <div class="watcher-overlay watcher-overlay-top" id="watcher-state"></div>
      <div class="watcher-overlay watcher-overlay-controls">
        <button type="button" class="btn btn-sm" data-action="watcher-replay-birth" data-replay-start>Replay birth</button>
        <button type="button" class="btn btn-sm" data-action="watcher-clean-graph" title="Archive bookkeeping facts and merge near-duplicates (hygiene: watcher-graph)">Clean the graph</button>
        <span class="watcher-replay-day"><input type="date" class="watcher-date" id="watcher-replay-date" aria-label="Day to replay"><button type="button" class="btn btn-sm" data-action="watcher-replay-day" data-replay-start>Replay day</button></span>
      </div>
      <div class="watcher-overlay watcher-overlay-bottom"><div id="watcher-legend">${legendHtml()}</div><div class="watcher-hint">drag to orbit · click the ball, then scroll to zoom · click a neuron</div></div>
      <div class="watcher-replay" id="watcher-replay" hidden><span data-replay-label></span><button type="button" class="btn btn-sm" data-action="watcher-replay-stop">Stop replay</button></div>
    </section>
    <section class="watcher-mind" aria-label="What the watcher holds">
      <div class="watcher-mind-head"><div class="watcher-log-title">Mind</div><div class="watcher-card-sub">Everything in the ball, readable: pick a kind, search, click a row to light it in the ball and see where it came from.</div></div>
      <div id="watcher-mind-tabs"></div>
      <div class="watcher-mind-bar"><p id="watcher-mind-blurb" class="watcher-mind-blurb"></p><input type="search" id="watcher-mind-search" class="watcher-mind-search" placeholder="Search this tab" aria-label="Search this tab"></div>
      <div id="watcher-mind-list" class="watcher-mind-body"></div>
    </section>
    <section class="watcher-log">
      <div class="watcher-log-head"><div class="watcher-log-title">Log</div><div id="watcher-log-filter" class="watcher-log-filter"></div><button type="button" class="btn btn-sm" data-action="watcher-pause">Pause</button></div>
      <div id="watcher-log-body" class="watcher-log-body"></div>
    </section>
    <section class="watcher-thoughts watcher-self" aria-label="The watcher's self-model">
      <div class="watcher-thoughts-col">${cardHeadHtml('how')}<div id="watcher-how"></div></div>
      <div class="watcher-thoughts-col">${cardHeadHtml('attending')}<div id="watcher-attending"></div></div>
      <div class="watcher-thoughts-col">${cardHeadHtml('introspection')}<div id="watcher-introspection"></div></div>
    </section>
  </div>`;
}

function drawMetrics() {
  const host = $('#watcher-metrics');
  if (host && page.metrics) host.innerHTML = metricsStripHtml(page.metrics);
}

/** Tabs, blurb and the active tab's list. Open folds (`[data-open-key]`) stay open. */
function drawMind() {
  if (!page) return;
  clearTimeout(page.mindTimer);
  page.mindTimer = null;
  if (page.mindRefocus) {
    page.mindRefocus = false;
    drawLegend();
    applyFocus();
  }
  const m = page.mind;
  const neurons = [...page.model.neurons.values()];
  const tabs = $('#watcher-mind-tabs');
  if (tabs) drawMindTabs(tabs, mindCounts(neurons, page.broadcasts), m.tab);
  const blurb = $('#watcher-mind-blurb');
  if (blurb) blurb.textContent = mindTabBlurb(m.tab);
  const list = $('#watcher-mind-list');
  if (!list) return;
  const rows = mindRows(m.tab, { neurons, broadcasts: page.broadcasts, query: m.query });
  const edges = [...page.model.edges.values()];
  list.innerHTML = mindListHtml(m.tab, rows, {
    nowMs: Date.now(),
    shown: m.shown,
    query: m.query,
    broadcasts: page.broadcasts,
    broadcastLimit: BROADCAST_LIMIT,
    sidesOf: (id) =>
      contradictionSides(id, edges, (other) => page?.model.neurons.get(other)?.text ?? null),
    open: m.open,
  });
}

/**
 * The tab strip is rendered once; later redraws patch each tab's count and
 * active state in place, so its horizontal scroll and keyboard focus survive.
 */
function drawMindTabs(host, counts, active) {
  const buttons = host.querySelectorAll('[data-mind-tab]');
  const state = mindTabState(counts, active);
  if (buttons.length !== state.length) {
    host.innerHTML = mindTabsHtml(counts, active);
    return;
  }
  for (const t of state) {
    const btn = host.querySelector(`[data-mind-tab="${t.kind}"]`);
    if (!btn) continue;
    btn.classList.toggle('is-active', t.active);
    btn.setAttribute('aria-selected', t.active ? 'true' : 'false');
    const count = btn.querySelector('.watcher-mind-count');
    if (count && count.textContent !== t.count) count.textContent = t.count;
  }
}

/** A neuron event: redraw the Mind panel soon, once per burst. */
function scheduleMind() {
  if (!page || page.mindTimer) return;
  page.mindTimer = setTimeout(() => drawMind(), MIND_REDRAW_MS);
}

function drawLegend() {
  const host = $('#watcher-legend');
  if (!host) return;
  const count = page.kindFilter
    ? kindFilterIds(page.model.neurons.values(), page.kindFilter).length
    : null;
  host.innerHTML = legendHtml(page.kindFilter, count);
}

/**
 * Move the ball's one highlight source (`highlightState`): a legend kind
 * clears the neuron/row selection and a selection clears the kind.
 */
function setHighlight(action) {
  const next = highlightState(page, action);
  page.kindFilter = next.kindFilter;
  page.selectedSeq = next.selectedSeq;
  page.selectedIds = next.selectedIds;
  page.filterId = next.filterId;
  drawLegend();
  applyFocus();
}

/** Click a legend kind: light only that kind in the ball; click it again to clear. */
function toggleKindFilter(kind) {
  const hadSelection = page.filterId || page.selectedSeq != null;
  setHighlight({ type: 'kind', kind });
  if (hadSelection && !page.filterId && page.selectedSeq == null) {
    drawLogHead();
    drawLog();
  }
}

function drawSelf() {
  const self = page.self;
  const how = $('#watcher-how');
  if (how) {
    how.innerHTML = howIAmHtml(self?.interoception, {
      startedAt: page.model.state?.startedAt ?? null,
      nowMs: Date.now(),
    });
  }
  const att = $('#watcher-attending');
  if (att) att.innerHTML = attendingHtml(self?.attention, Date.now());
  const intro = $('#watcher-introspection');
  if (intro) {
    intro.innerHTML = introspectionHtml(self?.introspection, self?.subjects, Date.now(), {
      busy: page.introspecting,
    });
  }
}

/** Light what `highlightFor` picks: the selection, else the legend kind, else attention. */
function applyFocus() {
  const source = {
    kindFilter: page.kindFilter,
    selectedSeq: page.selectedSeq,
    selectedIds: page.selectedIds,
    filterId: page.filterId,
  };
  page.ball?.highlight(
    highlightFor({
      ...source,
      neurons: page.model.neurons.values(),
      attention: page.self?.attention,
    }),
    { dim: highlightDims(source) }
  );
}

async function refreshSelf() {
  const mine = page;
  const self = await api('/api/watcher/self').catch(() => null);
  if (page !== mine || !page) return;
  if (self && !self.error) page.self = self;
  drawSelf();
  applyFocus();
}

async function askIntrospection() {
  if (page.introspecting) return;
  page.introspecting = true;
  drawSelf();
  const res = await api('/api/watcher/introspect', { method: 'POST' }).catch((err) => ({
    error: err?.message || 'Request failed',
  }));
  if (!page) return;
  page.introspecting = false;
  if (!res || res.error || res.status !== 'scored') {
    showToast(`Could not ask the watcher: ${res?.reason ?? res?.error ?? 'no answer'}`, {
      tone: 'danger',
    });
  } else {
    showToast(`Introspection score: ${Math.round(Number(res.record?.score ?? 0) * 100)} %`);
  }
  await refreshSelf();
}

async function refreshSlow() {
  const mine = page;
  const [metrics, broadcasts] = await Promise.all([
    api('/api/watcher/metrics?window=7d').catch(() => null),
    api(`/api/watcher/broadcasts?limit=${BROADCAST_LIMIT}`).catch(() => null),
    refreshEmbedding(),
  ]);
  if (page !== mine || !page) return;
  if (metrics && !metrics.error) page.metrics = metrics;
  if (Array.isArray(broadcasts?.broadcasts)) page.broadcasts = broadcasts.broadcasts;
  drawMetrics();
  drawMind();
  await refreshSelf();
}

/** The embedding service, from the infra ollama row (probed server-side, cached 5 min). */
async function refreshEmbedding() {
  const mine = page;
  const infra = await api('/api/stats/infra').catch(() => null);
  if (page !== mine || !page || !Array.isArray(infra?.backends)) return;
  page.embedding = infra.backends.find((b) => b.name === 'ollama')?.embedding ?? null;
  drawState();
}

/** Open or close a pass row's "What it saw" fold, loading its record on open. */
async function togglePass(seq) {
  if (page.openPass && Number(page.openPass.seq) === Number(seq)) {
    page.openPass = null;
    return drawLog();
  }
  const rows = page.replay ? page.replay.shown : page.model.log;
  const row = rows.find((r) => Number(r.seq) === Number(seq));
  if (!row) return;
  const mine = page;
  page.openPass = { seq, html: '<div class="text-dim">Loading…</div>' };
  drawLog();
  let match = matchPassRecord(row, page.passes);
  if (!match) {
    const list = await api('/api/watcher/passes?limit=500').catch(() => null);
    if (page !== mine || !page) return;
    if (Array.isArray(list?.passes)) page.passes = list.passes;
    match = matchPassRecord(row, page.passes);
  }
  const res = match
    ? await api(`/api/watcher/passes/${encodeURIComponent(match.id)}`).catch(() => null)
    : null;
  if (page !== mine || !page || Number(page.openPass?.seq) !== Number(seq)) return;
  page.openPass = { seq, html: passRecordBodyHtml(res?.pass ?? null) };
  drawLog();
}

/** "Clean the graph": preview hygiene `watcher-graph`, confirm, apply. */
async function cleanGraph() {
  if (page.cleaning) return;
  const mine = page;
  page.cleaning = true;
  try {
    const run = (body) =>
      api('/api/hygiene/run', { method: 'POST', body }).catch((err) => ({
        error: err?.message || 'request failed',
      }));
    const preview = await run({ routine: 'watcher-graph' });
    if (page !== mine || !page) return;
    const summary = graphCleanSummary(preview);
    const fixable = Array.isArray(preview?.findings) && preview.findings.some((f) => f.fixable);
    if (preview?.error || !fixable)
      return showToast(summary, { tone: preview?.error ? 'danger' : undefined });
    const ok = await confirmDialog({
      title: 'Clean the graph',
      message: `${summary} Archived neurons stay in the graph and come back if they fire again.`,
      confirmLabel: 'Clean',
      tone: 'accent',
    });
    if (!ok || page !== mine || !page) return;
    const applied = await run({ routine: 'watcher-graph', apply: true });
    if (page !== mine || !page) return;
    showToast(graphCleanSummary(applied), { tone: applied?.error ? 'danger' : undefined });
    if (!applied?.error) await refetchGraph();
  } finally {
    if (page === mine && page) page.cleaning = false;
  }
}

async function sendSignal(id, signal) {
  const res = await api(`/api/watcher/neurons/${encodeURIComponent(id)}/signal`, {
    method: 'POST',
    body: { signal },
  }).catch((err) => ({ error: err?.message || 'Request failed' }));
  if (!page) return;
  if (!res || res.error) {
    showToast(`Could not save the signal: ${res?.error ?? 'no answer'}`, { tone: 'danger' });
    return;
  }
  if (res.neuron) page.model.neurons.set(res.neuron.id, res.neuron);
  if (res.broadcast) {
    page.broadcasts = (page.broadcasts ?? []).map((b) =>
      b.id === res.broadcast.id ? { ...b, ...res.broadcast } : b
    );
  }
  if (res.neuron || res.broadcast) drawMind();
}

/* ── Live events ─────────────────────────────────────────────────── */

function onEffect(effect) {
  const ballLive = page.ball && !page.replay;
  switch (effect.kind) {
    case 'spawn':
      if (ballLive) page.ball.spawn(effect.id);
      break;
    case 'update':
    case 'archive':
    case 'revive':
      if (ballLive) page.ball.update(effect.id);
      break;
    case 'pulse': {
      const plan = ballLive ? ballPlanFor(page.model, effect) : null;
      if (plan) {
        page.ball.pulse(plan.pulse);
        if (plan.flashEdge) page.ball.flashEdge(plan.flashEdge.from, plan.flashEdge.to);
        page.ball.pauseRotation(plan.pauseRotateMs);
      }
      break;
    }
    case 'edge':
      if (ballLive) page.ball.edgesChanged();
      break;
    case 'layout':
      if (ballLive) page.ball.move(effect.ids);
      break;
    case 'log':
      if (page.paused) {
        page.pending++;
        drawLogHead();
      } else if (!page.replay) drawLog();
      drawState();
      break;
    case 'state':
      drawState();
      break;
    default:
      return;
  }
  if (effect.kind === 'spawn' || effect.kind === 'edge') drawState();
  if (ballLive && refocusOnEffect(effect.kind, page.kindFilter)) page.mindRefocus = true;
  if (['spawn', 'update', 'archive', 'revive', 'edge'].includes(effect.kind)) scheduleMind();
}

/**
 * Refetch the graph and reconcile the model (debounced): neurons and edges
 * created while the socket was down never come as events.
 */
function scheduleGraphRefetch() {
  if (!page || page.graphRefetch) return;
  page.graphRefetch = setTimeout(() => void refetchGraph(), GRAPH_REFETCH_DEBOUNCE_MS);
}

async function refetchGraph() {
  const snap = await api('/api/watcher/graph').catch(() => null);
  if (!page || page.stopped) return;
  page.graphRefetch = null;
  if (!snap || snap.error || isWatcherOff(snap)) return;
  const out = reconcileGraph(page.model, snap);
  if (page.ball && !page.replay) {
    for (const id of out.added) page.ball.spawn(id);
    for (const id of [...out.updated, ...out.archived, ...out.revived]) page.ball.update(id);
    if (out.edgesChanged) page.ball.edgesChanged();
  }
  if (
    out.added.length ||
    out.updated.length ||
    out.archived.length ||
    out.revived.length ||
    out.edgesChanged
  ) {
    const kindChanged =
      (out.added.length && refocusOnEffect('spawn', page.kindFilter)) ||
      (out.archived.length && refocusOnEffect('archive', page.kindFilter)) ||
      (out.revived.length && refocusOnEffect('revive', page.kindFilter));
    if (page.ball && !page.replay && kindChanged) page.mindRefocus = true;
    drawState();
    drawMind();
  }
}

function onMessage(e) {
  if (!page || page.stopped) return;
  const msg = readWatcherMessage(e.data);
  if (!msg) return;
  if (msg.kind === 'history') {
    if (msg.state) page.model.state = { ...msg.state, enabled: true };
    page.model.log = mergeLogRows(page.model.log, msg.log);
    drawState();
    if (!page.paused && !page.replay) drawLog();
    // Every history after the first is a reconnect: what changed meanwhile
    // only exists in the graph.
    if (page.historySeen) scheduleGraphRefetch();
    page.historySeen = true;
    return;
  }
  if (needsGraphRefetch(page.model, msg.event)) scheduleGraphRefetch();
  onEffect(applyWatcherEvent(page.model, msg.event));
}

/* ── Actions ─────────────────────────────────────────────────────── */

async function setRunning(action) {
  if (page.busy) return;
  page.busy = true;
  drawState();
  const res = await api(`/api/watcher/${action}`, { method: 'POST' }).catch((err) => ({
    error: err?.message || 'Request failed',
  }));
  if (!page) return;
  page.busy = false;
  if (isWatcherOff(res)) return showOff();
  if (!res || res.error)
    showToast(`Could not ${action} the watcher: ${res?.error || 'no response'}`, {
      tone: 'danger',
    });
  else page.model.state = mergeWatcherState(page.model.state, res);
  drawState();
}

async function setTiers(patch) {
  // A change while another request is out is not sent: put the controls back
  // to the last known state instead of leaving the unsent value showing.
  if (page.busy) return drawState({ forceTiers: true });
  page.busy = true;
  drawState({ forceTiers: true });
  const res = await api('/api/watcher/config', { method: 'POST', body: patch }).catch((err) => ({
    error: err?.message || 'Request failed',
  }));
  if (!page) return;
  page.busy = false;
  if (isWatcherOff(res)) return showOff();
  if (!res || res.error)
    showToast(`Could not change the watcher: ${res?.error || 'no response'}`, { tone: 'danger' });
  else page.model.state = mergeWatcherState(page.model.state, res);
  drawState({ forceTiers: true });
}

function selectRow(li) {
  const seq = Number(li.dataset.seq);
  const ids = (li.dataset.neurons || '').split(' ').filter(Boolean);
  setHighlight({ type: 'row', seq, ids });
  drawLog();
}

function clearFilter() {
  setHighlight({ type: 'clear' });
  drawLogHead();
  drawLog();
}

async function openNeuron(id) {
  setHighlight({ type: 'neuron', id });
  drawLogHead();
  drawLog();

  const n = page.model.neurons.get(id);
  const body = openSheet({
    title: n?.kind ? `${n.kind[0].toUpperCase()}${n.kind.slice(1)}` : 'Neuron',
    body: '<div class="text-dim">Loading…</div>',
  });
  if (!body) return;
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-watcher-neuron]');
    if (b && page) openNeuron(b.dataset.watcherNeuron);
  });
  const detail = await api(`/api/watcher/neurons/${encodeURIComponent(id)}`).catch((err) => ({
    error: err?.message || 'Request failed',
  }));
  if (!body.isConnected || !page) return;
  if (isWatcherOff(detail)) return showOff();
  if (!detail || detail.error || !detail.neuron) {
    body.innerHTML = `<div class="text-dim">Could not load this neuron: ${escapeHtml(
      detail?.error || 'not found'
    )}</div>`;
    return;
  }
  body.innerHTML = neuronSheetBody(detail, Date.now(), {
    textOf: (other) => page?.model.neurons.get(other)?.text ?? null,
  });
  const why = body.querySelector('details');
  if (why) why.open = true;
}

/* ── Replay ──────────────────────────────────────────────────────── */

async function fetchDay(date) {
  let rows = [];
  let before = null;
  for (let i = 0; i < LOG_MAX_PAGES; i++) {
    const q = new URLSearchParams({ date, limit: String(LOG_PAGE) });
    if (before != null) q.set('before', String(before));
    const res = await api(`/api/watcher/log?${q}`);
    if (isWatcherOff(res)) return null;
    const got = Array.isArray(res?.rows) ? res.rows : [];
    if (res?.error) throw new Error(res.error);
    rows = rows.concat(got);
    if (got.length < LOG_PAGE) break;
    before = Math.min(...got.map((r) => Number(r.seq)).filter(Number.isFinite));
    if (!Number.isFinite(before)) break;
  }
  return rows;
}

async function startReplay({ date, birthOnly, label }) {
  if (!canStartReplay(page)) return;
  if (!date) {
    showToast(birthOnly ? 'The watcher has not been born yet.' : 'Pick a day to replay.');
    return;
  }
  const mine = page;
  mine.replayLoading = true;
  let rows;
  try {
    rows = await fetchDay(date);
    if (rows === null) return showOff();
  } catch (err) {
    showToast(`Could not load the log of ${date}: ${err.message}`, { tone: 'danger' });
    return;
  } finally {
    mine.replayLoading = false;
  }
  if (!page || page !== mine || page.replay) return;
  if (birthOnly) rows = rows.filter((r) => r.phase === 'birth');
  const steps = replayQueue(rows, SPAWN_PACE);
  if (!steps.length) {
    showToast(`Nothing logged ${birthOnly ? 'at birth' : `on ${date}`}.`);
    return;
  }
  page.ball.clear();
  page.replay = {
    label,
    steps,
    index: 0,
    shown: [],
    rowCount: steps.filter((s) => s.type === 'row').length,
    startedAt: performance.now(),
    timer: null,
  };
  drawReplayBar();
  drawLogHead();
  drawLog();
  replayTick();
}

function replayTick() {
  const r = page?.replay;
  if (!r) return;
  const elapsed = performance.now() - r.startedAt;
  let rowsChanged = false;
  while (r.index < r.steps.length && r.steps[r.index].atMs <= elapsed) {
    const step = r.steps[r.index++];
    if (step.type === 'row') {
      r.shown = [step.row, ...r.shown];
      rowsChanged = true;
    } else if (step.type === 'spawn') page.ball.add(step.id);
    else if (step.type === 'pulse') page.ball.pulse(step.id);
    else if (step.type === 'edge') page.ball.edgesChanged();
  }
  if (rowsChanged) {
    drawLog();
    drawReplayBar();
  }
  if (r.index >= r.steps.length) {
    r.timer = setTimeout(() => endReplay(), 1500);
    return;
  }
  r.timer = setTimeout(replayTick, 40);
}

function endReplay() {
  if (!page?.replay) return;
  clearTimeout(page.replay.timer);
  page.replay = null;
  page.ball?.sync();
  applyFocus();
  drawReplayBar();
  drawLogHead();
  drawLog();
}

/* ── Wiring ──────────────────────────────────────────────────────── */

/** One delegated click listener per render, removed by `destroyWatcher` (`page.listeners`). */
function wire(el, signal) {
  el.addEventListener(
    'click',
    (e) => {
      if (!page) return;
      const action = e.target.closest('[data-action]')?.dataset.action;
      switch (action) {
        case 'watcher-start':
          return setRunning('start');
        case 'watcher-stop':
          return setRunning('stop');
        case 'watcher-clear-filter':
          return clearFilter();
        case 'watcher-pause':
          page.paused = !page.paused;
          if (!page.paused) {
            page.pending = 0;
            drawLog();
          }
          return drawLogHead();
        case 'watcher-replay-birth':
          return startReplay({
            date: birthDate(page.model.state),
            birthOnly: true,
            label: 'birth',
          });
        case 'watcher-replay-day': {
          const date = $('#watcher-replay-date')?.value || '';
          return startReplay({ date, birthOnly: false, label: date });
        }
        case 'watcher-replay-stop':
          return endReplay();
        case 'watcher-introspect':
          return askIntrospection();
        case 'watcher-pass':
          e.preventDefault();
          return togglePass(e.target.closest('[data-seq]')?.dataset.seq);
        case 'watcher-clean-graph':
          return cleanGraph();
        default:
          break;
      }
      const signal = e.target.closest('[data-watcher-signal]');
      if (signal) {
        return sendSignal(signal.dataset.signalId, signal.dataset.watcherSignal);
      }
      const tab = e.target.closest('[data-mind-tab]');
      if (tab) {
        page.mind.tab = tab.dataset.mindTab;
        page.mind.shown = MIND_PAGE_SIZE;
        return drawMind();
      }
      if (action === 'watcher-mind-more') {
        page.mind.shown += MIND_PAGE_SIZE;
        return drawMind();
      }
      const legend = e.target.closest('[data-legend-kind]');
      if (legend) return toggleKindFilter(legend.dataset.legendKind);
      const mindOpen = e.target.closest('[data-mind-open]');
      if (mindOpen) return openNeuron(mindOpen.dataset.mindOpen);
      const neuronLink = e.target.closest('[data-watcher-neuron]');
      if (neuronLink) return openNeuron(neuronLink.dataset.watcherNeuron);
      const li = e.target.closest('li.watcher-row');
      if (li && !page.replay && li.dataset.neurons) selectRow(li);
    },
    { signal }
  );
  el.addEventListener(
    'input',
    (e) => {
      if (!page || e.target?.id !== 'watcher-mind-search') return;
      page.mind.query = e.target.value;
      page.mind.shown = MIND_PAGE_SIZE;
      drawMind();
    },
    { signal }
  );
  // `toggle` does not bubble: capture it to remember which Mind folds are open.
  el.addEventListener(
    'toggle',
    (e) => {
      const key = e.target?.closest?.('[data-open-key]')?.dataset.openKey;
      if (!page || !key || !e.target.closest('#watcher-mind-list')) return;
      if (e.target.open) page.mind.open.add(key);
      else page.mind.open.delete(key);
    },
    { signal, capture: true }
  );
  // Notice / Integrate switches and daily caps (`POST /api/watcher/config`).
  el.addEventListener(
    'change',
    (e) => {
      if (!page) return;
      const input = e.target.closest?.('[data-tier][data-field]');
      if (!input) return;
      const value = input.dataset.field === 'enabled' ? input.checked : input.value;
      const patch = tierPatchFromInput(input.dataset.tier, input.dataset.field, value);
      if (!patch) {
        showToast('A daily cap is a whole number, 0 or more.', { tone: 'danger' });
        return drawState({ forceTiers: true });
      }
      return setTiers(patch);
    },
    { signal }
  );
}

async function mountTheBall() {
  const mine = page;
  const host = $('#watcher-ball');
  const ball = await mountBall(host, mine.model, {
    onPick: (id) => {
      if (!page) return;
      if (id) openNeuron(id);
      else if (page.filterId || page.selectedSeq != null) {
        closeSheet();
        clearFilter();
      }
    },
  });
  if (page !== mine || mine.stopped) {
    ball?.dispose();
    return;
  }
  if (!ball) {
    const fb = $('#watcher-ball-fallback');
    if (fb) fb.hidden = false;
    return;
  }
  page.ball = ball;
  ball.place([...page.model.neurons.keys()]);
  applyFocus();
  drawReplayBar();
}

export async function renderWatcher(el) {
  destroyWatcher();
  const gen = generation;
  el.innerHTML = `${TITLE}${skeleton({ lines: 6 })}`;
  const state = await api('/api/watcher').catch((err) => ({
    error: err?.message || 'Request failed',
  }));
  if (gen !== generation) return;
  if (!state || state.error) {
    el.innerHTML = `${TITLE}${watcherErrorHtml(state?.error)}`;
    el.querySelector('[data-action="watcher-retry"]')?.addEventListener('click', () =>
      renderWatcher(el)
    );
    return;
  }
  if (isWatcherOff(state)) {
    el.innerHTML = `${TITLE}${watcherDisabledHtml()}`;
    return;
  }

  const [graph, log, metrics, broadcasts, self] = await Promise.all([
    api('/api/watcher/graph').catch(() => null),
    api('/api/watcher/log?limit=200').catch(() => null),
    api('/api/watcher/metrics?window=7d').catch(() => null),
    api(`/api/watcher/broadcasts?limit=${BROADCAST_LIMIT}`).catch(() => null),
    api('/api/watcher/self').catch(() => null),
  ]);
  if (gen !== generation) return;
  if (isWatcherOff(graph) || isWatcherOff(log)) {
    el.innerHTML = `${TITLE}${watcherDisabledHtml()}`;
    return;
  }
  if (graph?.error) showToast(`Could not load the graph: ${graph.error}`, { tone: 'danger' });

  page = {
    el,
    model: createWatcherModel({
      state: { ...state, enabled: true },
      graph: graph?.error ? null : graph,
      log: Array.isArray(log?.rows) ? log.rows : [],
    }),
    ball: null,
    socket: null,
    clock: null,
    busy: false,
    paused: false,
    pending: 0,
    filterId: null,
    selectedSeq: null,
    selectedIds: [],
    replay: null,
    stopped: false,
    metrics: metrics && !metrics.error ? metrics : null,
    broadcasts: Array.isArray(broadcasts?.broadcasts) ? broadcasts.broadcasts : [],
    self: self && !self.error ? self : null,
    introspecting: false,
    slowClock: null,
    listeners: new AbortController(),
    replayLoading: false,
    historySeen: false,
    graphRefetch: null,
    embedding: null,
    passes: [],
    openPass: null,
    cleaning: false,
    mind: { tab: 'insight', query: '', shown: MIND_PAGE_SIZE, open: new Set() },
    mindTimer: null,
    kindFilter: null,
  };
  el.innerHTML = shell();
  const dateInput = $('#watcher-replay-date');
  if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
  drawState();
  drawLogHead();
  drawLog();
  drawReplayBar();
  drawMetrics();
  drawMind();
  drawSelf();
  void refreshEmbedding();
  wire(el, page.listeners.signal);
  page.slowClock = setInterval(() => {
    if (page) void refreshSlow();
  }, SLOW_CLOCK_MS);

  page.socket = openReconnectingSocket({
    url: () => dashboardSocketUrl(location, '/ws/watcher', { token: getAuthToken() }),
    onMessage,
  });
  page.clock = setInterval(() => {
    if (!page) return;
    drawState();
    if (!page.paused) drawLog();
  }, CLOCK_MS);

  await mountTheBall();
}
