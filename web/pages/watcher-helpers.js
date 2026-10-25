/**
 * Watcher page, pure half (docs/plans/watcher-implementation-plan.md, phase 1).
 *
 * Everything here is data in, string or number out: no DOM, no Three.js, so
 * `tests/web/watcher-helpers.test.ts` runs it under Bun. The page
 * (`watcher.js`) owns the socket and the sheet, the ball (`watcher-ball.js`)
 * owns WebGL; both read their colours, sizes, positions and replay timing
 * from here.
 *
 * Layout is the server's: a neuron's `pos` (unit ball) is used as is. Only a
 * neuron the server has not placed yet goes on a shell by kind, so live view
 * and replay agree.
 */
import { emptyState, esc } from '../ui/index.js';
import { embeddingStatusHtml, isPassRow, passFoldHtml } from './watcher-ops-helpers.js';
import { whyPanel } from './why-helpers.js';

export const NEURON_KINDS = [
  'entity',
  'person',
  'goal',
  'topic',
  'fact',
  'surprise',
  'question',
  'pattern',
  'insight',
  'contradiction',
  'prediction',
];

/** Hue (degrees) per kind; the origin (watcher vs bot) is carried by saturation and lightness. */
export const KIND_HUES = {
  entity: 215,
  fact: 185,
  pattern: 155,
  goal: 120,
  question: 75,
  insight: 48,
  person: 25,
  contradiction: 0,
  surprise: 330,
  prediction: 300,
  topic: 265,
};

const KIND_PLURALS = {
  entity: 'entities',
  person: 'people',
};

export const LOG_PHASES = ['birth', 'sense', 'notice', 'integrate', 'broadcast', 'sleep'];
/** Rows the page keeps in memory (newest first). */
export const LOG_LIMIT = 500;
/** Edges below this weight are not drawn. */
export const EDGE_MIN_WEIGHT = 0.5;
/** Spawns per second when the ball animates arrivals or a replay. */
export const SPAWN_PACE = 25;
/** Brightness halves every this long without an activation. */
export const BRIGHTNESS_HALF_LIFE_MS = 6 * 3_600_000;

const BRIGHTNESS_FLOOR = 0.3;
const ARCHIVED_BRIGHTNESS = 0.1;
const RADIUS_BASE = 0.018;
const RADIUS_GROW = 0.03;
const RADIUS_CAP_ACTIVATIONS = 64;

export function kindLabel(kind, count = 1) {
  const k = String(kind ?? '');
  if (count === 1) return k;
  return KIND_PLURALS[k] ?? `${k}s`;
}

function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

export function isWatcherMade(neuron) {
  return neuron?.createdBy === 'watcher';
}

/** `#rrggbb`: hue by kind; watcher-made vivid and light, bot-made muted. */
export function neuronColour(neuron) {
  const hue = KIND_HUES[neuron?.kind];
  if (hue === undefined) return hslToHex(0, 0, isWatcherMade(neuron) ? 0.85 : 0.62);
  return isWatcherMade(neuron) ? hslToHex(hue, 1, 0.7) : hslToHex(hue, 0.5, 0.58);
}

/** World-space radius (unit ball): grows with activations, log-scaled, capped. */
export function neuronRadius(neuron) {
  const a = Number(neuron?.activations);
  const acts = Number.isFinite(a) && a > 0 ? a : 0;
  const t = Math.min(1, Math.log1p(acts) / Math.log1p(RADIUS_CAP_ACTIVATIONS));
  return RADIUS_BASE + RADIUS_GROW * t;
}

/** 0–1: full right after an activation, halving every half-life down to a floor; archived dims out. */
export function neuronBrightness(neuron, nowMs = Date.now()) {
  if (neuron?.archivedAt) return ARCHIVED_BRIGHTNESS;
  const t = Date.parse(neuron?.lastActivatedAt ?? '');
  if (!Number.isFinite(t)) return BRIGHTNESS_FLOOR;
  const age = Math.max(0, nowMs - t);
  return BRIGHTNESS_FLOOR + (1 - BRIGHTNESS_FLOOR) * 0.5 ** (age / BRIGHTNESS_HALF_LIFE_MS);
}

function hash32(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fallback for a neuron the server has not placed: its kind's shell, direction from its id. */
export function shellPosition(neuron) {
  const i = NEURON_KINDS.indexOf(neuron?.kind);
  const radius = i < 0 ? 0.98 : 0.62 + 0.035 * i;
  const h = hash32(neuron?.id);
  const u = (h & 0xffff) / 0xffff;
  const v = (h >>> 16) / 0xffff;
  const z = 2 * u - 1;
  const xy = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = 2 * Math.PI * v;
  return [radius * xy * Math.cos(phi), radius * xy * Math.sin(phi), radius * z];
}

export function neuronPosition(neuron) {
  const p = neuron?.pos;
  if (
    Array.isArray(p) &&
    p.length === 3 &&
    p.every((x) => typeof x === 'number' && Number.isFinite(x))
  ) {
    return [p[0], p[1], p[2]];
  }
  return shellPosition(neuron);
}

export function edgeVisible(edge) {
  const w = Number(edge?.weight);
  return Number.isFinite(w) && w >= EDGE_MIN_WEIGHT;
}

/* ── Log ─────────────────────────────────────────────────────────── */

function isRow(row) {
  return !!row && typeof row === 'object' && Number.isFinite(Number(row.seq));
}

/** Merge rows into a newest-first list, deduped by `seq` (incoming wins), capped at LOG_LIMIT. */
export function mergeLogRows(existing, incoming) {
  const bySeq = new Map();
  for (const r of existing ?? []) if (isRow(r)) bySeq.set(Number(r.seq), r);
  for (const r of incoming ?? []) if (isRow(r)) bySeq.set(Number(r.seq), r);
  return [...bySeq.values()].sort((a, b) => Number(b.seq) - Number(a.seq)).slice(0, LOG_LIMIT);
}

export function filterLogRows(rows, neuronId) {
  if (!neuronId) return rows ?? [];
  return (rows ?? []).filter((r) => Array.isArray(r.neuronIds) && r.neuronIds.includes(neuronId));
}

const pad = (n) => String(n).padStart(2, '0');
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function clock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatTokens(n) {
  const t = Number(n);
  if (!Number.isFinite(t)) return '';
  if (t < 1000) return `${Math.round(t)} tokens`;
  return `${(t / 1000).toFixed(1).replace(/\.0$/, '')}k tokens`;
}

export function formatDuration(ms) {
  const d = Number(ms);
  if (!Number.isFinite(d) || d < 0) return '';
  if (d < 1000) return `${Math.round(d)} ms`;
  const s = Math.round(d / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

function rowMeta(row) {
  const bits = [];
  const sal = Number(row.salience);
  if (row.salience != null && Number.isFinite(sal)) bits.push(`salience ${sal.toFixed(2)}`);
  if (row.source) bits.push(esc(row.source));
  if (row.model) bits.push(esc(row.model));
  if (row.tokens != null) bits.push(formatTokens(row.tokens));
  const cost = Number(row.costUsd);
  if (row.costUsd != null && Number.isFinite(cost)) bits.push(`$${cost.toFixed(2)}`);
  if (row.durationMs != null) bits.push(formatDuration(row.durationMs));
  return bits.filter(Boolean);
}

/**
 * One log row. `data-neurons` (space-separated) lets the page highlight them in
 * the ball. A pass row (a model call) gets a "What it saw" fold, open with
 * `openPass.html` inside when `openPass.seq` is its seq.
 */
export function logRowHtml(row, nowMs = Date.now(), { selectedSeq = null, openPass = null } = {}) {
  const phase = LOG_PHASES.includes(row?.phase) ? row.phase : 'other';
  const ids = Array.isArray(row?.neuronIds)
    ? row.neuronIds.filter((x) => typeof x === 'string')
    : [];
  const t = Date.parse(row?.ts ?? '');
  const time = Number.isFinite(t)
    ? `<time class="watcher-row-time" datetime="${esc(row.ts)}" title="${esc(row.ts)}">${
        localDay(t) === localDay(nowMs) ? '' : `${localDay(t)} `
      }${clock(t)}</time>`
    : '<time class="watcher-row-time"></time>';
  const meta = rowMeta(row ?? {});
  if (ids.length) {
    meta.unshift(
      `<span class="watcher-row-neurons">${ids.length} neuron${ids.length === 1 ? '' : 's'}</span>`
    );
  }
  const selected = selectedSeq != null && Number(selectedSeq) === Number(row?.seq);
  return `<li class="watcher-row watcher-phase-${phase}${ids.length ? ' has-neurons' : ''}${
    selected ? ' is-selected' : ''
  }" data-seq="${esc(row?.seq)}"${ids.length ? ` data-neurons="${esc(ids.join(' '))}"` : ''}>${time}<span class="watcher-row-phase">${esc(
    row?.phase ?? ''
  )}</span><span class="watcher-row-text">${esc(row?.text ?? '')}</span>${
    meta.length ? `<span class="watcher-row-meta">${meta.join(' · ')}</span>` : ''
  }${
    isPassRow(row)
      ? passFoldHtml(
          row,
          openPass && Number(openPass.seq) === Number(row.seq) ? openPass.html : null
        )
      : ''
  }</li>`;
}

export function logListHtml(
  rows,
  nowMs = Date.now(),
  { filterId = null, selectedSeq = null, openPass = null } = {}
) {
  const shown = filterLogRows(rows, filterId);
  if (!shown.length) {
    return `<div class="watcher-log-empty">${
      filterId ? 'No row in the recent log touched this neuron.' : 'Nothing logged yet.'
    }</div>`;
  }
  return `<ol class="watcher-log-list">${shown
    .map((r) => logRowHtml(r, nowMs, { selectedSeq, openPass }))
    .join('')}</ol>`;
}

/* ── State strip ─────────────────────────────────────────────────── */

function relTime(iso, nowMs) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, nowMs - t);
  if (diff < 60_000) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(diff / 3_600_000);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(diff / 86_400_000)} d ago`;
}

const fmt = (n) => Number(n).toLocaleString('en-US');
/** No event sensed for this long while awake reads as "fleet quiet". */
const QUIET_AFTER_MS = 30 * 60_000;

const LINK_NOTES = {
  'no-embeddings': 'no embeddings: neurons sit on shells by kind, without related links',
  partial:
    'partly linked: an embedding error stopped the run; the rest get linked at the next start or maintenance',
  pending: 'linking what it knows…',
};

/**
 * The pieces of the state bar, each its own HTML: `main` (dot, phase, ages),
 * `counts`, `notes`, `tiers` (the tier controls) and `button` (Start/Stop).
 * `drawState` updates them in place so a republish never rebuilds the tier
 * inputs under the operator's cursor. `button` is built only when read (the
 * first render, `stateHtml`): afterwards `syncStateButton` updates it in place.
 */
export function stateParts(state, nowMs = Date.now(), { busy = false, embedding = null } = {}) {
  const s = state ?? {};
  const running = !!s.running;
  const main = [
    `<span class="watcher-dot${running ? ' is-awake' : ''}" aria-hidden="true"></span><strong>${
      running ? 'Awake' : 'Asleep'
    }</strong>`,
  ];
  if (s.phase) main.push(`phase <span class="watcher-state-phase">${esc(s.phase)}</span>`);
  main.push(s.bornAt ? `born ${esc(relTime(s.bornAt, nowMs))}` : 'not born yet');
  if (s.lastTickAt) {
    // Sense hears every activity event of the fleet: nothing for a while
    // while awake means the fleet itself was quiet, not that the watcher stalled.
    const gap = nowMs - Date.parse(s.lastTickAt);
    const quiet = running && Number.isFinite(gap) && gap >= QUIET_AFTER_MS ? ' (fleet quiet)' : '';
    main.push(`last event sensed ${esc(relTime(s.lastTickAt, nowMs))}${quiet}`);
  }

  const counts = s.counts && typeof s.counts === 'object' ? s.counts : {};
  const keys = [
    ...NEURON_KINDS.filter((k) => k in counts),
    ...Object.keys(counts).filter((k) => !NEURON_KINDS.includes(k)),
  ];
  const chips = keys
    .filter((k) => Number(counts[k]) > 0)
    .map((k) => {
      const n = Number(counts[k]);
      const colour = neuronColour({ kind: k, createdBy: 'bot:x' });
      return `<span class="watcher-count"><i style="background:${colour}"></i><b>${fmt(n)}</b> ${esc(
        kindLabel(k, n)
      )}</span>`;
    });
  const edges = Number(s.edges);
  if (Number.isFinite(edges)) {
    chips.push(
      `<span class="watcher-count"><b>${fmt(edges)}</b> edge${edges === 1 ? '' : 's'}</span>`
    );
  }

  const notes = [];
  if (LINK_NOTES[s.linkStatus])
    notes.push(`<div class="watcher-note">${LINK_NOTES[s.linkStatus]}</div>`);
  if (s.lastError) notes.push(`<div class="watcher-note is-error">${esc(s.lastError)}</div>`);

  return {
    main: main.join('<span class="watcher-sep">·</span>'),
    counts: chips.join(''),
    notes: notes.join(''),
    embed: embeddingStatusHtml(embedding, nowMs),
    tiers: tierControlsHtml(s.config, { busy }),
    get button() {
      return stateButtonHtml(s, { busy });
    },
  };
}

/** What the Start/Stop button of the state bar shows. */
function stateButtonSpec(state, { busy = false } = {}) {
  const running = !!state?.running;
  return {
    action: running ? 'watcher-stop' : 'watcher-start',
    className: `btn btn-sm${running ? '' : ' btn-primary'}`,
    label: running ? 'Stop' : 'Start',
    disabled: !!busy,
  };
}

/**
 * Update the Start/Stop button in place (action, class, label, disabled),
 * touching only what changed: re-creating it on every `watcher:state`
 * republish lost its focus (an `outerHTML` compare never matched while busy,
 * the DOM serialises `disabled=""`).
 */
export function syncStateButton(button, state, { busy = false } = {}) {
  if (!button) return;
  const b = stateButtonSpec(state, { busy });
  if (button.getAttribute('data-action') !== b.action) button.setAttribute('data-action', b.action);
  if (button.className !== b.className) button.className = b.className;
  if (button.textContent !== b.label) button.textContent = b.label;
  if (button.disabled !== b.disabled) button.disabled = b.disabled;
}

/** The Start/Stop button's HTML, for the first render of the state bar. */
function stateButtonHtml(state, { busy = false } = {}) {
  const b = stateButtonSpec(state, { busy });
  return `<button type="button" class="${b.className}" data-action="${b.action}"${
    b.disabled ? ' disabled' : ''
  }>${b.label}</button>`;
}

/** Running dot, phase, age, counts by kind (non-zero only), edges, Start/Stop. */
export function stateHtml(state, nowMs = Date.now(), { busy = false, embedding = null } = {}) {
  const p = stateParts(state, nowMs, { busy, embedding });
  return `<div class="watcher-state"><div class="watcher-state-main">${p.main}</div><div class="watcher-counts">${p.counts}</div><div class="watcher-notes">${p.notes}</div><div class="watcher-embed">${p.embed}</div><div class="watcher-state-actions"><span class="watcher-tiers-host">${p.tiers}</span>${p.button}</div></div>`;
}

/** What the tier controls show: the server values per tier and whether they are disabled. */
function tierKey(view) {
  const c = view?.config && typeof view.config === 'object' ? view.config : null;
  const tiers = Object.keys(TIER_LABELS).map((t) =>
    c?.[t] ? [!!c[t].enabled, Number(c[t].maxPerDay)] : null
  );
  return JSON.stringify([tiers, !!view?.busy]);
}

/**
 * Rebuild the tier controls? `prev` / `next` are `{ config, busy }` (`prev`
 * null on the first draw). Only when what they show changed and no control has
 * the focus (the operator is typing there); `force` when the page must undo a
 * value it did not send.
 */
export function shouldRedrawTiers(prev, next, focused, { force = false } = {}) {
  if (force) return true;
  if (focused) return false;
  return !prev || tierKey(prev) !== tierKey(next);
}

const TIER_LABELS = { notice: 'Notice', integrate: 'Integrate' };

/**
 * The live switches of the LLM tiers (`POST /api/watcher/config`): per tier
 * an on/off checkbox and its daily call cap. Empty without a config.
 */
export function tierControlsHtml(config, { busy = false } = {}) {
  if (!config || typeof config !== 'object') return '';
  const dis = busy ? ' disabled' : '';
  return `<div class="watcher-tiers">${Object.keys(TIER_LABELS)
    .filter((tier) => config[tier])
    .map((tier) => {
      const t = config[tier];
      const cap = Number.isFinite(Number(t.maxPerDay)) ? Number(t.maxPerDay) : 0;
      return `<label class="watcher-tier"><input type="checkbox" data-tier="${tier}" data-field="enabled"${
        t.enabled ? ' checked' : ''
      }${dis}> ${TIER_LABELS[tier]}</label><label class="watcher-tier-cap" title="${TIER_LABELS[tier]} calls per day"><input type="number" min="0" step="1" data-tier="${tier}" data-field="maxPerDay" value="${cap}"${dis}>/day</label>`;
    })
    .join('')}</div>`;
}

/** The `POST /api/watcher/config` body for one changed control, or null when invalid. */
export function tierPatchFromInput(tier, field, value) {
  if (!(tier in TIER_LABELS)) return null;
  if (field === 'enabled') return { [tier]: { enabled: !!value } };
  if (field === 'maxPerDay') {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) return null;
    return { [tier]: { maxPerDay: Number(text) } };
  }
  return null;
}

/** A new state over the previous one, keeping the tier `config` an event does not carry. */
export function mergeWatcherState(prev, next) {
  const tiers = next?.tiers && typeof next.tiers === 'object' ? next.tiers : null;
  const config = next?.config ?? tiers ?? prev?.config;
  return { ...(next ?? {}), ...(config ? { config } : {}), enabled: true };
}

/**
 * Colour key for the ball: one button per kind (click filters the ball to
 * that kind, `data-legend-kind`; `active` is pressed and, given
 * `activeCount`, shows how many live neurons it lights, zero included),
 * plus the origin pair.
 */
export function legendHtml(active = null, activeCount = null) {
  const count =
    active && activeCount != null && Number.isFinite(Number(activeCount))
      ? `<b class="watcher-legend-count">${Number(activeCount).toLocaleString('en-US')}</b>`
      : '';
  const kinds = NEURON_KINDS.map(
    (k) =>
      `<button type="button" class="watcher-legend-item watcher-legend-kind${
        k === active ? ' is-active' : ''
      }" data-legend-kind="${k}" aria-pressed="${k === active ? 'true' : 'false'}" title="${
        k === active ? 'Show every kind' : `Show only ${esc(kindLabel(k, 2))}`
      }"><i style="background:${neuronColour({ kind: k })}"></i>${esc(k)}${k === active ? count : ''}</button>`
  ).join('');
  const origin = `<span class="watcher-legend-item"><i style="background:${neuronColour({
    kind: 'insight',
    createdBy: 'bot:x',
  })}"></i>from a bot</span><span class="watcher-legend-item"><i class="is-vivid" style="background:${neuronColour(
    {
      kind: 'insight',
      createdBy: 'watcher',
    }
  )}"></i>the watcher's own</span>`;
  return `<div class="watcher-legend${active ? ' is-filtered' : ''}"><div class="watcher-legend-row">${kinds}</div><div class="watcher-legend-row">${origin}</div></div>`;
}

/**
 * The server's answer means the watcher is off: `GET /api/watcher` says
 * `{ enabled: false }` and, while off, every other route 404s with
 * `{ enabled: false, error }`. The page then shows its off state instead of an error.
 */
export function isWatcherOff(res) {
  return !!res && typeof res === 'object' && res.enabled === false;
}

export function watcherDisabledHtml() {
  return emptyState({
    icon: '◌',
    title: 'The watcher is off',
    hint: 'It watches the whole fleet, remembers what every bot learns and shows it here as a ball of neurons. Set watcher.enabled to true in config/config.json and restart, then press Start on this page.',
    action: '<pre class="watcher-config"><code>"watcher": { "enabled": true }</code></pre>',
    class: 'watcher-empty',
  });
}

export function watcherErrorHtml(message = '') {
  return emptyState({
    icon: '⚠',
    title: 'Could not load the watcher',
    hint: message || 'The server did not answer.',
    action:
      '<button type="button" class="btn btn-primary" data-action="watcher-retry">Retry</button>',
  });
}

/* ── Socket + client model ───────────────────────────────────────── */

/** `{ kind: 'history', state, log }` | `{ kind: 'event', event }` | null. */
export function readWatcherMessage(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  if (d.type === 'history') {
    return {
      kind: 'history',
      state: d.state && typeof d.state === 'object' ? d.state : null,
      log: Array.isArray(d.log) ? d.log : [],
    };
  }
  if (d.type === 'watcher' && d.event && typeof d.event.type === 'string') {
    return { kind: 'event', event: d.event };
  }
  return null;
}

export function createWatcherModel({ state = null, graph = null, log = [] } = {}) {
  const neurons = new Map();
  for (const n of graph?.neurons ?? []) if (n && typeof n.id === 'string') neurons.set(n.id, n);
  const edges = new Map();
  for (const e of graph?.edges ?? []) if (e && typeof e.id === 'string') edges.set(e.id, e);
  return {
    state: state && typeof state === 'object' ? state : null,
    neurons,
    edges,
    log: mergeLogRows([], log),
    rev: graph?.rev ?? null,
    linkStatus: graph?.linkStatus ?? null,
  };
}

function bump(model, kind) {
  const counts = model.state?.counts;
  if (!counts || typeof counts !== 'object') return;
  counts[kind] = (Number(counts[kind]) || 0) + 1;
}

const NONE = Object.freeze({ kind: 'none' });

const isVec3 = (p) =>
  Array.isArray(p) && p.length === 3 && p.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * Apply one `watcher:*` event to the model. Updates the model in place (it
 * holds up to `maxNeurons` neurons; copying the maps per event would stall
 * birth) and returns what the ball should do: spawn / update / archive /
 * pulse / edge (with the id), layout (with the ids moved), log (with the
 * row), state, or none.
 */
export function applyWatcherEvent(model, event) {
  if (!model || !event || typeof event.type !== 'string') return NONE;
  const data = event.data;
  if (!data || typeof data !== 'object') return NONE;
  switch (event.type) {
    case 'watcher:neuron': {
      if (typeof data.id !== 'string') return NONE;
      const prev = model.neurons.get(data.id);
      if (!prev) {
        model.neurons.set(data.id, data);
        bump(model, data.kind);
        return { kind: 'spawn', id: data.id };
      }
      const next = { ...prev, ...data };
      model.neurons.set(data.id, next);
      if (!prev.archivedAt && data.archivedAt) return { kind: 'archive', id: data.id };
      if (prev.archivedAt && !next.archivedAt) return { kind: 'revive', id: data.id };
      return { kind: 'update', id: data.id };
    }
    case 'watcher:edge': {
      if (typeof data.id !== 'string') return NONE;
      const isNew = !model.edges.has(data.id);
      model.edges.set(data.id, { ...(model.edges.get(data.id) ?? {}), ...data });
      if (isNew && model.state && Number.isFinite(Number(model.state.edges))) {
        model.state.edges = Number(model.state.edges) + 1;
      }
      return { kind: 'edge', id: data.id };
    }
    case 'watcher:activate': {
      const prev = typeof data.id === 'string' ? model.neurons.get(data.id) : null;
      if (!prev) return NONE;
      const next = { ...prev };
      if (Number.isFinite(Number(data.activations))) next.activations = Number(data.activations);
      if (data.lastActivatedAt) next.lastActivatedAt = data.lastActivatedAt;
      model.neurons.set(data.id, next);
      return { kind: 'pulse', id: data.id };
    }
    case 'watcher:layout': {
      const positions = data.positions;
      if (!positions || typeof positions !== 'object') return NONE;
      const ids = [];
      for (const [id, pos] of Object.entries(positions)) {
        const prev = model.neurons.get(id);
        if (!prev || !isVec3(pos)) continue;
        model.neurons.set(id, { ...prev, pos: [pos[0], pos[1], pos[2]] });
        ids.push(id);
      }
      return ids.length ? { kind: 'layout', ids } : NONE;
    }
    case 'watcher:log': {
      if (!isRow(data)) return NONE;
      model.log = mergeLogRows(model.log, [data]);
      return { kind: 'log', row: data };
    }
    case 'watcher:state':
      model.state = mergeWatcherState(model.state, data);
      return { kind: 'state' };
    default:
      return NONE;
  }
}

/**
 * Did this event name a neuron the page does not have? (An activation or an
 * edge for an id created while the socket was down: the page refetches the
 * graph instead of dropping it.)
 */
export function needsGraphRefetch(model, event) {
  if (!model || !event || typeof event.type !== 'string') return false;
  const d = event.data;
  if (!d || typeof d !== 'object') return false;
  const unknown = (id) => typeof id === 'string' && !model.neurons.has(id);
  if (event.type === 'watcher:activate') return unknown(d.id);
  if (event.type === 'watcher:edge') return unknown(d.from) || unknown(d.to);
  return false;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Bring the model in line with a fresh `GET /api/watcher/graph` (after a
 * socket reconnect, or an event for an unknown id). In place, like
 * `applyWatcherEvent`: neurons the snapshot has and the model does not are
 * added, changed ones replaced, live ones the snapshot lacks are archived
 * (`archivedAt` = `nowIso`); edges follow the snapshot exactly. Returns the
 * ids for the ball: `{ added, updated, archived, edgesChanged }`. A junk
 * snapshot changes nothing.
 */
export function reconcileGraph(model, snapshot, { nowIso = new Date().toISOString() } = {}) {
  const out = { added: [], updated: [], archived: [], revived: [], edgesChanged: false };
  if (!model || !snapshot || !Array.isArray(snapshot.neurons)) return out;
  const seen = new Set();
  for (const n of snapshot.neurons) {
    if (!n || typeof n.id !== 'string') continue;
    seen.add(n.id);
    const prev = model.neurons.get(n.id);
    if (!prev) {
      model.neurons.set(n.id, n);
      out.added.push(n.id);
      continue;
    }
    if (sameJson(prev, n)) continue;
    model.neurons.set(n.id, n);
    if (!prev.archivedAt && n.archivedAt) out.archived.push(n.id);
    else if (prev.archivedAt && !n.archivedAt) out.revived.push(n.id);
    else out.updated.push(n.id);
  }
  for (const [id, n] of model.neurons) {
    if (seen.has(id) || n.archivedAt) continue;
    model.neurons.set(id, { ...n, archivedAt: nowIso });
    out.archived.push(id);
  }
  if (Array.isArray(snapshot.edges)) {
    const edgeIds = new Set();
    for (const e of snapshot.edges) {
      if (!e || typeof e.id !== 'string') continue;
      edgeIds.add(e.id);
      const prev = model.edges.get(e.id);
      if (prev && sameJson(prev, e)) continue;
      model.edges.set(e.id, e);
      out.edgesChanged = true;
    }
    for (const id of [...model.edges.keys()]) {
      if (edgeIds.has(id)) continue;
      model.edges.delete(id);
      out.edgesChanged = true;
    }
  }
  if (snapshot.rev !== undefined) model.rev = snapshot.rev;
  if (snapshot.linkStatus !== undefined) model.linkStatus = snapshot.linkStatus;
  return out;
}

/* ── Replay + spawn pacing ───────────────────────────────────────── */

/**
 * Log rows → timed steps for rebuilding the ball at a readable pace:
 * `{ atMs, type: 'row', row }`, then one `spawn` per neuron the row names
 * for the first time (1000 / pace ms apart), `pulse` for one seen before,
 * `edge` for its edges. A row that spawns nothing still takes `rowGapMs`.
 */
export function replayQueue(rows, pacePerSec = SPAWN_PACE, { rowGapMs = 300 } = {}) {
  const pace = Number.isFinite(pacePerSec) && pacePerSec > 0 ? pacePerSec : SPAWN_PACE;
  const spacing = 1000 / pace;
  const ordered = (rows ?? []).filter(isRow).sort((a, b) => Number(a.seq) - Number(b.seq));
  const seen = new Set();
  const steps = [];
  let t = 0;
  for (const row of ordered) {
    steps.push({ atMs: t, type: 'row', row });
    let spawned = false;
    for (const id of Array.isArray(row.neuronIds) ? row.neuronIds : []) {
      if (seen.has(id)) {
        steps.push({ atMs: t, type: 'pulse', id });
        continue;
      }
      seen.add(id);
      steps.push({ atMs: t, type: 'spawn', id });
      t += spacing;
      spawned = true;
    }
    for (const id of Array.isArray(row.edgeIds) ? row.edgeIds : []) {
      steps.push({ atMs: t, type: 'edge', id });
    }
    if (!spawned) t += Math.max(0, rowGapMs);
  }
  return steps;
}

/** How many queued spawns to release this frame. A frame longer than 1 s counts as 1 s. */
export function drainCount(carry, dtMs, pacePerSec = SPAWN_PACE) {
  const dt = Math.min(1000, Math.max(0, Number(dtMs) || 0));
  const acc = (Number(carry) || 0) + (dt * pacePerSec) / 1000;
  const n = Math.floor(acc + 1e-9);
  return { n, carry: Math.max(0, acc - n) };
}

/** The UTC day of birth (the log files are named by UTC date), or null. */
/**
 * May a replay start now? Needs the ball, no replay running, and none still
 * fetching its day's log (a second click during the fetch used to start two).
 */
export function canStartReplay(page) {
  return !!page?.ball && !page.replay && !page.replayLoading;
}

export function birthDate(state) {
  const b = state?.bornAt;
  if (typeof b !== 'string' || !Number.isFinite(Date.parse(b))) return null;
  return new Date(Date.parse(b)).toISOString().slice(0, 10);
}

/* ── Neuron sheet ────────────────────────────────────────────────── */

const MAX_SHEET_EDGES = 50;

function originText(neuron) {
  if (isWatcherMade(neuron)) return 'the watcher';
  const by = String(neuron?.createdBy ?? '');
  return by.startsWith('bot:') ? by.slice(4) : by || 'unknown';
}

/** Body of the neuron side sheet: text, facts, the shared Why panel, connections. */
export function neuronSheetBody(detail, nowMs = Date.now(), { textOf = () => null } = {}) {
  const n = detail?.neuron ?? {};
  const facts = [];
  const fact = (k, v) => facts.push(`<dt>${k}</dt><dd>${v}</dd>`);
  fact('Made by', esc(originText(n)));
  const bots = Array.isArray(n.support?.bots) ? n.support.bots : [];
  if (bots.length) fact('Supported by', esc(bots.join(', ')));
  const counted = [
    ['cycles', n.support?.cycles],
    ['conversations', n.support?.conversations],
    ['files', n.support?.paths],
  ]
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([label, v]) => `${v.length} ${label}`);
  if (counted.length) fact('Evidence', esc(counted.join(', ')));
  fact('Activations', esc(fmt(Number(n.activations) || 0)));
  if (n.lastActivatedAt) fact('Last active', esc(relTime(n.lastActivatedAt, nowMs)));
  if (n.createdAt) fact('Created', esc(relTime(n.createdAt, nowMs)));
  if (n.confidence) fact('Confidence', esc(n.confidence));
  if (n.archivedAt) fact('Archived', esc(relTime(n.archivedAt, nowMs)));

  const edges = Array.isArray(detail?.edges) ? detail.edges : [];
  const edgeItems = edges.slice(0, MAX_SHEET_EDGES).map((e) => {
    const outgoing = e.from === n.id;
    const other = outgoing ? e.to : e.from;
    const label = textOf(other) ?? other;
    return `<li><button type="button" class="watcher-edge" data-watcher-neuron="${esc(other)}"><span class="watcher-edge-rel">${
      outgoing ? '' : '← '
    }${esc(e.rel)}${outgoing ? ' →' : ''}</span><span class="watcher-edge-text">${esc(label)}</span></button></li>`;
  });
  const more =
    edges.length > MAX_SHEET_EDGES
      ? `<li class="text-dim">+${edges.length - MAX_SHEET_EDGES} more</li>`
      : '';

  return `<div class="watcher-sheet"><div class="watcher-sheet-head"><i class="watcher-kind-dot" style="background:${neuronColour(
    n
  )}"></i><span class="watcher-sheet-kind">${esc(n.kind ?? 'neuron')}</span></div><p class="watcher-sheet-text">${esc(
    n.text ?? ''
  )}</p><dl class="watcher-sheet-facts">${facts.join('')}</dl>${
    detail?.why ? whyPanel(detail.why, { nowMs }) : ''
  }<div class="watcher-sheet-section">Connections (${edges.length})</div>${
    edges.length
      ? `<ul class="watcher-sheet-edges">${edgeItems.join('')}${more}</ul>`
      : '<div class="text-dim">No connections yet.</div>'
  }</div>`;
}

/* ── Activity on the ball ─────────────────────────────────────────── */

/** How long auto-rotation holds still after a pulse, so the eye can find it. */
export const PULSE_ROTATE_PAUSE_MS = 2000;
/** How long the edge from a pulsed neuron to its bot stays brightened. */
export const EDGE_FLASH_MS = 1200;

/**
 * The `owned_by` edge from neuron `id` to the bot (`entity`) that owns it,
 * or null. The server activates that bot with its goal or topic; the page
 * brightens this edge between the two.
 */
/**
 * The vertices of the bright pulsed edges at `nowMs`: `live` (the flashes
 * still lit), and flat `position` / `color` arrays (two vertices per flash,
 * colours scaled by `edgeFlashLevel`). `slotOf` maps neuron id → slot in
 * `arr.position` / `arr.aColor`. No flashes (a cleared ball) → empty arrays,
 * which is what the ball writes on `clear()` so no stale bright edge stays. Pure.
 */
export function flashBuffers(flashes, nowMs, slotOf, arr) {
  const live = (flashes ?? []).filter((f) => edgeFlashLevel(nowMs - f.at) > 0);
  const position = [];
  const color = [];
  for (const f of live) {
    const level = edgeFlashLevel(nowMs - f.at);
    const i = slotOf.get(f.from);
    const j = slotOf.get(f.to);
    if (i === undefined || j === undefined) continue;
    for (const k of [i, j]) {
      position.push(arr.position[k * 3], arr.position[k * 3 + 1], arr.position[k * 3 + 2]);
      color.push(
        Math.min(1, arr.aColor[k * 3] * 0.4 + 0.6) * level,
        Math.min(1, arr.aColor[k * 3 + 1] * 0.4 + 0.6) * level,
        Math.min(1, arr.aColor[k * 3 + 2] * 0.4 + 0.6) * level
      );
    }
  }
  return { live, position, color };
}

export function ownerEdgeOf(model, id) {
  if (!model?.edges || !model.neurons || typeof id !== 'string') return null;
  for (const e of model.edges.values()) {
    if (e?.rel !== 'owned_by' || e.from !== id) continue;
    if (model.neurons.get(e.to)?.kind === 'entity') return e;
  }
  return null;
}

/**
 * What one model effect does to the ball beyond its own bookkeeping: for a
 * pulse, `{ pulse, flashEdge: { from, to } | null, pauseRotateMs }`; null for
 * every effect that touches no neuron the page has (log rows such as the
 * sense summary, state, none).
 */
export function ballPlanFor(model, effect) {
  if (!effect || effect.kind !== 'pulse' || !model?.neurons?.has(effect.id)) return null;
  const edge = ownerEdgeOf(model, effect.id);
  return {
    pulse: effect.id,
    flashEdge: edge ? { from: edge.from, to: edge.to } : null,
    pauseRotateMs: PULSE_ROTATE_PAUSE_MS,
  };
}

/** Auto-rotate this frame? Not while dragging, after recent input, or in a pulse pause. */
export function autoRotates(
  nowMs,
  { lastInputMs = 0, pausedUntilMs = 0, dragging = false, idleMs }
) {
  if (dragging) return false;
  if (nowMs - lastInputMs <= idleMs) return false;
  return nowMs >= pausedUntilMs;
}

/** Brightness (1 → 0, linear) of a flashed edge `elapsedMs` after the flash. */
export function edgeFlashLevel(elapsedMs) {
  if (!(elapsedMs >= 0) || elapsedMs >= EDGE_FLASH_MS) return 0;
  return 1 - elapsedMs / EDGE_FLASH_MS;
}

/**
 * Does the wheel zoom the ball? Only once the ball is engaged (clicked, until
 * the pointer leaves) or with Ctrl/Cmd held; otherwise the page scrolls.
 */
export function wheelZooms(input) {
  if (!input) return false;
  return !!(input.engaged || input.ctrlKey || input.metaKey);
}
