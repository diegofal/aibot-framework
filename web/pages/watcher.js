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
 *
 * The pure half lives in `watcher-helpers.js`; WebGL in `watcher-ball.js`.
 */
import { closeSheet, openSheet, showToast, skeleton } from '../ui/index.js';
import { api, escapeHtml, getAuthToken } from './shared.js';
import { mountBall } from './watcher-ball.js';
import {
  SPAWN_PACE,
  applyWatcherEvent,
  birthDate,
  createWatcherModel,
  legendHtml,
  logListHtml,
  mergeLogRows,
  neuronSheetBody,
  readWatcherMessage,
  replayQueue,
  stateHtml,
  watcherDisabledHtml,
  watcherErrorHtml,
} from './watcher-helpers.js';
import { dashboardSocketUrl, openReconnectingSocket } from './ws-reconnect.js';

const CLOCK_MS = 30_000;
const LOG_PAGE = 1000;
const LOG_MAX_PAGES = 20;
const TITLE = '<div class="page-title">Watcher</div>';

let page = null;
/** Bumped on every destroy: a render whose awaits resolve after it gives up. */
let generation = 0;

export function destroyWatcher() {
  generation++;
  if (!page) return;
  page.stopped = true;
  page.socket?.close();
  page.ball?.dispose();
  clearInterval(page.clock);
  clearTimeout(page.replay?.timer);
  page = null;
}

function $(sel) {
  return page?.el.querySelector(sel) ?? null;
}

/* ── Rendering ───────────────────────────────────────────────────── */

function drawState() {
  const host = $('#watcher-state');
  if (host) host.innerHTML = stateHtml(page.model.state, Date.now(), { busy: page.busy });
}

function drawLog() {
  const body = $('#watcher-log-body');
  if (!body) return;
  if (page.replay) {
    body.innerHTML = logListHtml(page.replay.shown, Date.now());
    return;
  }
  body.innerHTML = logListHtml(page.model.log, Date.now(), {
    filterId: page.filterId,
    selectedSeq: page.selectedSeq,
  });
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
    <section class="watcher-stage" aria-label="The watcher's graph">
      <div class="watcher-ball" id="watcher-ball"></div>
      <div class="watcher-ball-fallback" id="watcher-ball-fallback" hidden>The 3D view could not start in this browser (WebGL unavailable). The log below still updates live.</div>
      <div class="watcher-overlay watcher-overlay-top" id="watcher-state"></div>
      <div class="watcher-overlay watcher-overlay-controls">
        <button type="button" class="btn btn-sm" data-action="watcher-replay-birth" data-replay-start>Replay birth</button>
        <span class="watcher-replay-day"><input type="date" class="watcher-date" id="watcher-replay-date" aria-label="Day to replay"><button type="button" class="btn btn-sm" data-action="watcher-replay-day" data-replay-start>Replay day</button></span>
      </div>
      <div class="watcher-overlay watcher-overlay-bottom">${legendHtml()}<div class="watcher-hint">drag to orbit · scroll to zoom · click a neuron</div></div>
      <div class="watcher-replay" id="watcher-replay" hidden><span data-replay-label></span><button type="button" class="btn btn-sm" data-action="watcher-replay-stop">Stop replay</button></div>
    </section>
    <section class="watcher-log">
      <div class="watcher-log-head"><div class="watcher-log-title">Log</div><div id="watcher-log-filter" class="watcher-log-filter"></div><button type="button" class="btn btn-sm" data-action="watcher-pause">Pause</button></div>
      <div id="watcher-log-body" class="watcher-log-body"></div>
    </section>
  </div>`;
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
      if (ballLive) page.ball.update(effect.id);
      break;
    case 'pulse':
      if (ballLive) page.ball.pulse(effect.id);
      break;
    case 'edge':
      if (ballLive) page.ball.edgesChanged();
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
    return;
  }
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
  if (!res || res.error)
    showToast(`Could not ${action} the watcher: ${res?.error || 'no response'}`, {
      tone: 'danger',
    });
  else if (res.enabled !== false) page.model.state = { ...res, enabled: true };
  drawState();
}

function selectRow(li) {
  const seq = Number(li.dataset.seq);
  const ids = (li.dataset.neurons || '').split(' ').filter(Boolean);
  if (page.selectedSeq === seq) {
    page.selectedSeq = null;
    page.ball?.highlight(page.filterId ? [page.filterId] : []);
  } else {
    page.selectedSeq = seq;
    page.ball?.highlight(ids);
  }
  drawLog();
}

function clearFilter() {
  page.filterId = null;
  page.selectedSeq = null;
  page.ball?.highlight([]);
  drawLogHead();
  drawLog();
}

async function openNeuron(id) {
  page.filterId = id;
  page.selectedSeq = null;
  page.ball?.highlight([id]);
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
  if (!page?.ball || page.replay) return;
  if (!date) {
    showToast(birthOnly ? 'The watcher has not been born yet.' : 'Pick a day to replay.');
    return;
  }
  let rows;
  try {
    rows = await fetchDay(date);
  } catch (err) {
    showToast(`Could not load the log of ${date}: ${err.message}`, { tone: 'danger' });
    return;
  }
  if (!page) return;
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
  page.ball?.highlight(page.filterId ? [page.filterId] : []);
  drawReplayBar();
  drawLogHead();
  drawLog();
}

/* ── Wiring ──────────────────────────────────────────────────────── */

function wire(el) {
  el.addEventListener('click', (e) => {
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
        return startReplay({ date: birthDate(page.model.state), birthOnly: true, label: 'birth' });
      case 'watcher-replay-day': {
        const date = $('#watcher-replay-date')?.value || '';
        return startReplay({ date, birthOnly: false, label: date });
      }
      case 'watcher-replay-stop':
        return endReplay();
      default:
        break;
    }
    const li = e.target.closest('li.watcher-row');
    if (li && !page.replay && li.dataset.neurons) selectRow(li);
  });
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
  if (state.enabled === false) {
    el.innerHTML = `${TITLE}${watcherDisabledHtml()}`;
    return;
  }

  const [graph, log] = await Promise.all([
    api('/api/watcher/graph').catch(() => null),
    api('/api/watcher/log?limit=200').catch(() => null),
  ]);
  if (gen !== generation) return;
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
    replay: null,
    stopped: false,
  };
  el.innerHTML = shell();
  const dateInput = $('#watcher-replay-date');
  if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
  drawState();
  drawLogHead();
  drawLog();
  drawReplayBar();
  wire(el);

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
