/**
 * "Why this?" — the one fold every surface uses to say where something came
 * from. Renders the `Why` model (`src/why/types.ts`, built server-side by
 * `src/why/builders/`) in a fixed row order; rows without data are left out.
 * "Open cycle" buttons carry `data-open-cycle` + `data-bot-id`; app.js opens
 * the cycle sheet (`cycle-sheet.js`) for any of them. Pure: string in, string out.
 * Plan: docs/plans/why-everywhere-plan.md.
 */
import { esc } from '../ui/index.js';
import { ago } from './agent-home-helpers.js';

export const WHY_ROW_ORDER = [
  'what',
  'by',
  'goal',
  'cycle',
  'mode',
  'reason',
  'rule',
  'related',
  'outcome',
  'notes',
];

const ACTOR_TEXT = {
  agent: 'the agent itself',
  strategist: 'the strategist',
  navigator: 'the navigator',
  curiosity: 'its curiosity',
  reflection: 'its reflection',
  lint: 'goal lint',
  hygiene: 'a hygiene routine',
  operator: 'you',
  cron: 'a scheduled job',
  peer: 'another agent',
  system: 'the system',
  watcher: 'the watcher',
};

/** The folded line keeps a short head: goal titles are often whole briefs. */
const GIST_CHARS = 60;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const enc = encodeURIComponent;

const row = (key, value) =>
  `<div class="why-row"><span class="why-key">${esc(key)}</span><span>${value}</span></div>`;

function cycleRow(cycle) {
  const open = `<button type="button" class="why-open-cycle" data-open-cycle="${esc(cycle.id)}" data-bot-id="${esc(cycle.botId)}">Open cycle</button>`;
  return row('Working on', `${cycle.plan ? `${esc(cycle.plan)} ` : ''}${open}`);
}

function modeRow(cycle) {
  if (cycle.mode !== 'explore') return '';
  const why = cycle.modeReason ? `: ${esc(cycle.modeReason)}` : '';
  const chasing = cycle.chasing ? `. Chasing: “${esc(cycle.chasing)}”` : '';
  return row('Mode', `Exploration cycle${why}${chasing}`);
}

function relatedRow(related, nowMs) {
  const items = related.items
    .map((it) => {
      const text = it.href ? `<a href="${esc(it.href)}">${esc(it.text)}</a>` : esc(it.text);
      const meta = [it.at ? ago(it.at, nowMs) : '', it.detail ?? ''].filter(Boolean);
      return `<li>${text}${meta.length ? ` <span class="text-dim text-sm">· ${esc(meta.join(' · '))}</span>` : ''}</li>`;
    })
    .join('');
  const note = related.note ? `<div class="text-dim text-sm">${esc(related.note)}</div>` : '';
  return row(related.label, `<ul class="why-list">${items}</ul>${note}`);
}

function gist(why) {
  const head = why.goal?.title
    ? `goal: ${why.goal.title}`
    : (why.rule ?? (why.by ? `by ${ACTOR_TEXT[why.by] ?? why.by}` : ''));
  return head ? ` · ${esc(clip(head, GIST_CHARS))}` : '';
}

/**
 * The fold. `opts.botId` links the goal when the why has no cycle;
 * `opts.nowMs` anchors relative times.
 */
export function whyPanel(why, { nowMs = Date.now(), botId } = {}) {
  if (!why?.what) return '';
  const agentId = why.cycle?.botId ?? botId;
  const rows = [row('What', esc(why.what))];
  if (why.by) rows.push(row('By', esc(ACTOR_TEXT[why.by] ?? why.by)));
  if (why.goal?.title) {
    rows.push(
      row(
        'Goal',
        agentId
          ? `<a href="#/agents/${esc(enc(agentId))}">${esc(why.goal.title)}</a>`
          : esc(why.goal.title)
      )
    );
  }
  if (why.cycle?.id) rows.push(cycleRow(why.cycle), modeRow(why.cycle));
  if (why.reason?.text) {
    rows.push(
      row(
        'Reason',
        `${esc(why.reason.text)} <span class="text-dim">— ${esc(why.reason.source)}</span>`
      )
    );
  }
  if (why.rule) rows.push(row('Rule', esc(why.rule)));
  if (why.related?.items?.length) rows.push(relatedRow(why.related, nowMs));
  if (why.outcome) rows.push(row('Outcome', esc(why.outcome)));
  for (const n of why.notes ?? []) rows.push(row(n.label, esc(n.text)));
  const foot = [
    why.cycle?.inferred ? 'Cycle matched by time, not recorded at the moment.' : '',
    why.missing ?? '',
  ]
    .filter(Boolean)
    .map((t) => `<div class="why-foot">${esc(t)}</div>`)
    .join('');
  return `<details class="why"><summary>Why this?<span class="text-dim">${gist(why)}</span></summary><div class="why-body">${rows.join('')}${foot}</div></details>`;
}
