/**
 * Watcher page, phase 4 (pure half): the "How I am" and "Attending to"
 * cards, the introspection history with scores, and which neurons the ball
 * highlights. Data in, HTML string out: no DOM, no Three.js, so
 * `tests/web/watcher-self-helpers.test.ts` runs it under Bun. Data comes from
 * `GET /api/watcher/self`.
 */
import { esc } from '../ui/index.js';

const HISTORY_ROWS = 20;
const FIELDS = ['phase', 'tool', 'goal', 'cause'];

function relTime(iso, nowMs) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const abs = Math.abs(nowMs - t);
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min ago`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} h ago`;
  return `${Math.round(abs / 86_400_000)} d ago`;
}

function agoMs(ms) {
  const v = Number(ms);
  if (ms === null || ms === undefined || !Number.isFinite(v)) return 'never';
  if (v < 60_000) return 'just now';
  if (v < 3_600_000) return `${Math.round(v / 60_000)} min ago`;
  if (v < 86_400_000) return `${Math.round(v / 3_600_000)} h ago`;
  return `${Math.round(v / 86_400_000)} d ago`;
}

const pct = (v) => (Number.isFinite(Number(v)) ? `${Math.round(Number(v) * 100)} %` : '—');

function row(label, value, { warn = false } = {}) {
  return `<li class="watcher-self-row${warn ? ' is-warn' : ''}"><span class="watcher-self-label text-dim">${esc(
    label
  )}</span><span class="watcher-self-value">${esc(value)}</span></li>`;
}

/** Each card's title and the sentence that says what it is for (`cardHeadHtml`). */
export const CARD_HEADS = {
  how: {
    title: 'How I am',
    sub: 'What the watcher feels: these variables change how choosy it is (a busy CLI, an open breaker or a spent budget make it wait; a quiet operator raises its bar).',
  },
  attending: {
    title: 'Attending to',
    sub: 'Its working memory: what its last Opus pass focused on (lit in the ball), then the events waiting to be noticed.',
  },
  introspection: {
    title: 'Introspection',
    sub: "We ask it what it's doing and check the answer against the record; green = matched.",
  },
};

/** A card's title with its muted subtitle. */
export function cardHeadHtml(key) {
  const h = CARD_HEADS[key];
  if (!h) return '';
  return `<div class="watcher-card-head"><div class="watcher-log-title">${esc(h.title)}</div><div class="watcher-card-sub">${esc(h.sub)}</div></div>`;
}

/**
 * "How I am": the interoception record in words; missing readings show as a
 * dash. `startedAt` (the state's, when this run woke) dates "no message since
 * the watcher woke".
 */
export function howIAmHtml(intero, { startedAt = null, nowMs = Date.now() } = {}) {
  if (!intero || typeof intero !== 'object') {
    return '<div class="watcher-insights-empty text-dim">No reading yet.</div>';
  }
  const budget = intero.budgetUsedToday ?? {};
  const sem = intero.semaphore;
  const silence = intero.operatorSilenceHours;
  const open = Array.isArray(intero.breakerOpen) ? intero.breakerOpen : [];
  const usd = Number(budget.usd);
  const rows = [
    row(
      'Fleet karma',
      Number.isFinite(Number(intero.fleetKarmaAvg)) && intero.fleetKarmaAvg !== null
        ? String(intero.fleetKarmaAvg)
        : '—'
    ),
    row('Breaker', open.length ? `open: ${open.join(', ')}` : 'closed', { warn: open.length > 0 }),
    row(
      'Claude CLI',
      sem
        ? `${sem.active}/${sem.limit} busy, ${sem.queued} waiting (${sem.activeWatcher} mine)`
        : '—'
    ),
    row(
      'Spent today',
      `${budget.notice ?? 0} notice · ${budget.integrate ?? 0} integrate · ${Number(budget.tokens ?? 0).toLocaleString('en-US')} tokens · $${Number.isFinite(usd) ? usd.toFixed(2) : '0.00'}`
    ),
    row(
      'Operator',
      silence === null || silence === undefined || !Number.isFinite(Number(silence))
        ? `no message since the watcher woke${startedAt && relTime(startedAt, nowMs) ? ` (${relTime(startedAt, nowMs)})` : ''}`
        : `silent for ${Number(silence) < 1 ? 'under an hour' : `${Math.round(Number(silence))} h`}`
    ),
    row('Buffer salience', String(intero.bufferSalience ?? 0)),
    row('Last thought', agoMs(intero.lastIntegrateAgoMs)),
  ];
  return `<ul class="watcher-self-list">${rows.join('')}</ul>`;
}

/** "Attending to": the phase, the neurons the last pass named (clickable) and the top events. */
export function attendingHtml(attention, nowMs = Date.now()) {
  if (!attention || typeof attention !== 'object') {
    return '<div class="watcher-insights-empty text-dim">Nothing yet.</div>';
  }
  const focus = Array.isArray(attention.focus) ? attention.focus : [];
  const items = Array.isArray(attention.items) ? attention.items : [];
  const since = attention.attendingAt ? ` · named ${relTime(attention.attendingAt, nowMs)}` : '';
  const head = `<div class="watcher-self-phase text-dim">Phase: <strong>${esc(
    attention.phase ?? 'unknown'
  )}</strong>${esc(since)}</div>`;
  const focusHtml = focus.length
    ? `<ul class="watcher-insights">${focus
        .map(
          (n) =>
            `<li class="watcher-insight is-focus"><button type="button" class="watcher-insight-text" data-watcher-neuron="${esc(
              n.id
            )}"><span class="watcher-insight-kind">${esc(n.kind)}</span> ${esc(n.text)}</button></li>`
        )
        .join('')}</ul>`
    : '<div class="watcher-insights-empty text-dim">No focus named yet. The next integration pass names one.</div>';
  const itemsHtml = items.length
    ? `<ul class="watcher-self-events">${items
        .map(
          (i) =>
            `<li class="watcher-self-event"><span>${esc(i.what)}</span> <span class="text-dim">salience ${esc(
              String(Math.round(Number(i.salience) * 100) / 100)
            )}</span></li>`
        )
        .join('')}</ul>`
    : '';
  return `${head}${focusHtml}${itemsHtml}`;
}

function fieldChips(fields) {
  return FIELDS.map((f) => {
    const v = fields?.[f];
    const state = v === 'match' ? 'is-match' : v === 'miss' ? 'is-miss' : 'is-unknown';
    return `<span class="watcher-field ${state}" title="${esc(`${f}: ${v ?? 'unknown'}`)}">${esc(f)}</span>`;
  }).join('');
}

/**
 * Introspection history: one summary per subject (mean score, rows, field
 * match shares), then the latest answers with their field verdicts, and the
 * "Ask me now" button (`data-action="watcher-introspect"`).
 */
export function introspectionHtml(rows, subjects, nowMs = Date.now(), { busy = false } = {}) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, HISTORY_ROWS);
  const subs = Array.isArray(subjects) ? subjects : [];
  const button = `<button type="button" class="btn btn-sm" data-action="watcher-introspect"${
    busy ? ' disabled' : ''
  }>${busy ? 'Asking…' : 'Ask me now'}</button>`;
  const summary = subs.length
    ? `<div class="watcher-self-legend text-dim">Per subject: mean score over n answers; phase · tool · goal · cause = how often each part of its answer matched.</div><ul class="watcher-self-list">${subs
        .map((s) => {
          const shares = FIELDS.map(
            (f) => `${f} ${s.fields?.[f] === null ? '—' : pct(s.fields?.[f])}`
          ).join(' · ');
          return `<li class="watcher-self-row"><span class="watcher-self-label">${esc(
            s.subject
          )}</span><span class="watcher-self-value">${esc(pct(s.score))} over ${esc(
            String(s.n)
          )}</span><span class="watcher-self-sub text-dim">${esc(shares)}</span></li>`;
        })
        .join('')}</ul>`
    : '<div class="watcher-insights-empty text-dim">Not asked yet. Ask me what I am doing, or wait for the daily samples.</div>';
  const history = list.length
    ? `<ul class="watcher-self-history">${list
        .map(
          (r) =>
            `<li class="watcher-self-answer"><span class="watcher-self-score">${esc(
              r.parsed === false ? 'unreadable' : pct(r.score)
            )}</span> <span>${esc(r.subject ?? 'unknown')}</span> <span class="text-dim">${esc(
              [relTime(r.ts, nowMs), r.trigger].filter(Boolean).join(' · ')
            )}</span><span class="watcher-fields">${fieldChips(r.fields)}</span></li>`
        )
        .join('')}</ul>`
    : '';
  return `<div class="watcher-self-actions">${button}</div>${summary}${history}`;
}

/**
 * What the ball highlights: the neurons the watcher attends to, unless the
 * operator selected a log row or filtered on a neuron (their choice wins:
 * null = leave the highlight alone).
 */
export function focusHighlightIds(attention, { selectedSeq = null, filterId = null } = {}) {
  if (selectedSeq !== null && selectedSeq !== undefined) return null;
  if (filterId) return null;
  return Array.isArray(attention?.focusNeuronIds) ? [...attention.focusNeuronIds] : [];
}
