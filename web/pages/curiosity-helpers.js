/**
 * Curiosity DNA — pure helpers for the dashboard (step C7 of
 * docs/plans/curiosity-navigator-plan.md).
 *
 * The "Mind" section of Agent Home (Direction, Knowledge, Frontier,
 * Dispatches + the DNA line), the fleet Dispatches inbox, and the Curiosity
 * block of the agent config form. String in, string out: `curiosity.js`,
 * `dispatches.js` and `agents.js` own the DOM and the network;
 * `tests/web/curiosity-helpers.test.ts` covers this file and checks that the
 * copies of the dials, presets and dial meanings below stay identical to
 * `src/bot/curiosity/{types,config,dna}.ts` (the dashboard has no build step,
 * so it cannot import them).
 *
 * Data shape: `GET /api/curiosity/:botId` → CuriositySnapshot
 * (`src/bot/curiosity/service.ts`), `GET /api/curiosity/dispatches` →
 * `{ dispatches: Dispatch & { botName, avatarUrl }[] }`.
 */
import { avatar, badge, card, cx, emptyState, esc } from '../ui/index.js';
import { ago } from './agent-home-helpers.js';

// ── Mirrors of src/bot/curiosity (parity-tested) ────────────────────────

export const LIMIT_DIALS = ['topic', 'purpose', 'instructions', 'method', 'capability', 'identity'];
export const DIAL_LEVELS = ['closed', 'ask', 'open'];
export const CURIOSITY_PRESET_IDS = ['focused', 'explorer', 'wild'];

export const CURIOSITY_PRESETS = {
  focused: {
    topic: 'closed',
    purpose: 'closed',
    instructions: 'closed',
    method: 'open',
    capability: 'closed',
    identity: 'closed',
  },
  explorer: {
    topic: 'open',
    purpose: 'ask',
    instructions: 'ask',
    method: 'open',
    capability: 'ask',
    identity: 'closed',
  },
  wild: {
    topic: 'open',
    purpose: 'open',
    instructions: 'open',
    method: 'open',
    capability: 'open',
    identity: 'ask',
  },
};

export const DIAL_MEANINGS = {
  topic: {
    closed: 'stay within your field and its immediate neighbours.',
    ask: 'neighbouring fields freely; propose far-away subjects to the operator first.',
    open: 'study any subject that could produce an insight worth bringing back.',
  },
  purpose: {
    closed: 'every piece of work must serve your stated purpose.',
    ask: 'you may PROPOSE side quests that do not serve your purpose but would fascinate the operator; start them only once approved.',
    open: 'side quests are allowed when they would interest the operator — your purpose frames why they care, it does not fence you in.',
  },
  instructions: {
    closed: 'follow the operator direction as given.',
    ask: 'follow the operator direction, and say so when you believe something else matters more (with evidence).',
    open: 'you may knowingly deviate from the operator direction when evidence says something else matters more — state the deviation and the reason up front.',
  },
  method: {
    closed: 'use the output forms you already use.',
    ask: 'propose new forms (experiments, code, visualisations, debates with other bots) before using them.',
    open: 'invent the form that fits: experiments, runnable code, visualisations, a debate with another bot.',
  },
  capability: {
    closed: 'work with the tools and skills you have.',
    ask: 'propose new tools, skills or access to the operator before requesting them.',
    open: 'build tools, learn skills and request access when it unlocks something — approval gates still apply.',
  },
  identity: {
    closed: 'your identity and interests stay as written.',
    ask: 'propose interests you are growing into; they become yours once approved.',
    open: 'let your interests evolve with what you learn and record them.',
  },
};

export const CURIOSITY_UI_DEFAULTS = {
  preset: 'explorer',
  exploreRatio: 0.25,
  maxExploreRatio: 0.6,
  dispatchMaxChars: 1200,
  minMaxChars: 200,
  maxMaxChars: 4000,
};

/** One line per dial for the form: what crossing it means. */
export const DIAL_LABEL = {
  topic: 'Topic — subjects outside its field',
  purpose: 'Purpose — side quests that do not serve its job',
  instructions: "Instructions — challenge the operator's direction",
  method: 'Method — new output forms',
  capability: 'Capability — new skills, tools, access',
  identity: 'Identity — interests drift with what it learns',
};

const LEVEL_TONE = { closed: 'muted', ask: 'warn', open: 'ok' };
const MODE_TONE = { explore: 'accent', exploit: 'info' };
const CONFIDENCE_TONE = { high: 'ok', medium: 'info', low: 'muted' };
const STATUS_TONE = { sent: 'ok', held: 'warn', dropped: 'muted' };

const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
const enc = encodeURIComponent;

// ── Signals ─────────────────────────────────────────────────────────────

const SIGNAL_FACE = {
  up: { icon: '👍', label: 'Good' },
  down: { icon: '👎', label: 'Not for me' },
  more: { icon: '✚', label: 'More like this' },
};

/** `{ path, body }` for an operator signal, or null for an unknown kind. */
export function signalRequest(kind, botId, id, signal) {
  const bot = enc(botId ?? '');
  const body = { signal };
  if (kind === 'dispatch')
    return { path: `/api/curiosity/${bot}/dispatches/${enc(id ?? '')}/signal`, body };
  if (kind === 'frontier')
    return { path: `/api/curiosity/${bot}/frontier/${enc(id ?? '')}/signal`, body };
  if (kind === 'direction') return { path: `/api/curiosity/${bot}/direction/signal`, body };
  return null;
}

/**
 * Signal buttons. `labels` overrides the per-signal label (the frontier says
 * "Approve" / "Drop"). The current verdict is `aria-pressed="true"`.
 */
export function signalButtons(kind, botId, id, current, signals, labels = {}) {
  return `<div class="curio-signals">${signals
    .map((s) => {
      const face = SIGNAL_FACE[s] ?? { icon: '', label: s };
      const label = labels[s] ?? face.label;
      const on = current === s;
      return `<button type="button" class="${cx('btn btn-sm curio-signal', on ? 'active' : '')}" data-curio-kind="${esc(
        kind
      )}" data-bot="${esc(botId)}" data-id="${esc(id ?? '')}" data-signal="${esc(s)}" aria-pressed="${on}" title="${esc(
        label
      )}">${face.icon} <span>${esc(label)}</span></button>`;
    })
    .join('')}</div>`;
}

// ── DNA line ────────────────────────────────────────────────────────────

/** Explore vs exploit over the cycle log. */
export function exploreMix(cycleLog) {
  const log = Array.isArray(cycleLog) ? cycleLog : [];
  const explore = log.filter((e) => e?.mode === 'explore').length;
  const exploit = log.filter((e) => e?.mode === 'exploit').length;
  const total = explore + exploit;
  return { explore, exploit, total, exploreShare: total ? explore / total : 0 };
}

/** Preset + six dials + explore target + mix + topic concentration. */
export function dnaLine(snapshot) {
  const cfg = snapshot?.config ?? {};
  if (cfg.enabled === false) {
    return `<div class="curio-dna">${badge('Curiosity off', 'muted')}<span class="text-dim text-sm">This agent runs without the navigator, frontier or dispatches.</span></div>`;
  }
  const limits = cfg.limits ?? {};
  const dials = LIMIT_DIALS.map((d) => {
    const lvl = limits[d] ?? 'closed';
    return `<span class="curio-dial curio-dial-${esc(lvl)}" title="${esc(
      `${d}: ${lvl} — ${DIAL_MEANINGS[d]?.[lvl] ?? ''}`
    )}">${esc(d)} <b>${esc(lvl)}</b></span>`;
  }).join('');
  const mix = exploreMix(snapshot?.navigator?.cycleLog);
  const conc = snapshot?.concentration ?? {};
  const rut = conc.dominantTopic && Number(conc.share) > Number(cfg.maxTopicShare ?? 1);
  const concText = conc.dominantTopic
    ? `<span class="${cx('curio-conc', rut ? 'curio-rut' : '')}" title="${esc(
        rut ? 'Above the topic-share cap: the next strategist run must pick from the frontier' : ''
      )}">top topic ${esc(conc.dominantTopic)} ${esc(pct(conc.share))} of last ${esc(conc.window)}</span>`
    : '';
  const mixText = mix.total
    ? `<span>${mix.explore} explore / ${mix.exploit} exploit</span>`
    : '<span class="text-dim">no cycles yet</span>';
  return `<div class="curio-dna">
    ${badge(cfg.preset ?? 'explorer', 'accent', { title: 'Curiosity preset' })}
    <span class="curio-dials">${dials}</span>
    <span class="curio-dna-stats"><span>explore ${esc(pct(cfg.exploreRatio))} target</span>${mixText}${concText}</span>
  </div>`;
}

// ── Direction ───────────────────────────────────────────────────────────

export function directionPanel(direction, botId, nowMs = Date.now()) {
  if (!direction) {
    return emptyState({
      icon: '➶',
      title: 'No direction yet',
      hint: 'The navigator writes one about once a day, after the agent has run a few cycles.',
    });
  }
  const bets = (direction.bets ?? [])
    .map(
      (b) => `<li class="curio-bet">
        ${badge(b.kind, MODE_TONE[b.kind] ?? 'muted')}
        <div><div class="curio-bet-title">${esc(b.title)}</div>${
          b.rationale ? `<div class="text-dim text-sm">${esc(b.rationale)}</div>` : ''
        }</div>
      </li>`
    )
    .join('');
  const retro = direction.retrospective
    ? `<details class="curio-retro"><summary>Retrospective</summary><div class="curio-pre">${esc(
        direction.retrospective
      )}</div></details>`
    : '';
  return `<div class="curio-direction">
    <p class="curio-summary">${esc(direction.summary)}</p>
    ${bets ? `<ul class="curio-bets">${bets}</ul>` : ''}
    ${retro}
    <div class="curio-foot"><span class="text-dim text-sm">set ${esc(ago(direction.at, nowMs))}</span>${signalButtons(
      'direction',
      botId,
      '',
      direction.operatorSignal,
      ['up', 'down'],
      { up: 'Good direction', down: 'Rethink' }
    )}</div>
  </div>`;
}

// ── Knowledge ───────────────────────────────────────────────────────────

/** Three segments, `depth` of them filled (0 touched … 3 expert). */
export function depthBar(depth) {
  const d = Math.max(0, Math.min(3, Math.round(Number(depth) || 0)));
  const names = ['touched', 'working knowledge', 'solid', 'expert'];
  return `<span class="curio-depth" title="depth ${d}: ${names[d]}">${[0, 1, 2]
    .map((i) => `<span class="${i < d ? 'curio-depth-on' : 'curio-depth-off'}"></span>`)
    .join('')}</span>`;
}

const byNewest = (key) => (a, b) => String(b[key] ?? '').localeCompare(String(a[key] ?? ''));

export function knowledgePanel(map, nowMs = Date.now()) {
  const topics = [...(map?.topics ?? [])].sort(byNewest('lastTouched'));
  if (topics.length === 0) {
    return emptyState({
      icon: '◎',
      title: 'Nothing learned yet',
      hint: 'After each cycle the agent records findings, surprises and open questions here.',
    });
  }
  const rows = topics
    .slice(0, 8)
    .map(
      (t) => `<div class="curio-topic">
        <span class="curio-topic-name">${esc(t.name)}</span>
        ${depthBar(t.depth)}
        <span class="text-dim text-sm">${(t.findings ?? []).length} findings · ${(t.surprises ?? []).length} surprises · ${esc(
          ago(t.lastTouched, nowMs)
        )}</span>
      </div>`
    )
    .join('');
  const findings = topics
    .flatMap((t) => (t.findings ?? []).map((f) => ({ ...f, topic: t.name })))
    .sort(byNewest('at'))
    .slice(0, 4);
  const surprises = topics
    .flatMap((t) => (t.surprises ?? []).map((s) => ({ ...s, topic: t.name })))
    .sort(byNewest('at'))
    .slice(0, 4);
  const questions = topics
    .flatMap((t) => (t.openQuestions ?? []).map((q) => ({ q, topic: t.name })))
    .slice(0, 5);
  const list = (title, items) =>
    items.length
      ? `<div class="curio-sub">${esc(title)}</div><ul class="curio-list">${items.join('')}</ul>`
      : '';
  const interests = (map?.interests ?? []).length
    ? `<div class="curio-sub">Interests it grew into</div><div>${map.interests
        .map((i) => badge(i, 'accent'))
        .join(' ')}</div>`
    : '';
  return `<div class="curio-topics">${rows}</div>
    ${list(
      'Latest findings',
      findings.map(
        (f) =>
          `<li>${badge(f.confidence ?? 'low', CONFIDENCE_TONE[f.confidence] ?? 'muted')} ${esc(f.claim)} <span class="text-dim text-sm">— ${esc(
            f.topic
          )}</span></li>`
      )
    )}
    ${list(
      'Surprises',
      surprises.map(
        (s) => `<li>⚡ ${esc(s.text)} <span class="text-dim text-sm">— ${esc(s.topic)}</span></li>`
      )
    )}
    ${list(
      'Open questions',
      questions.map(
        (x) => `<li>? ${esc(x.q)} <span class="text-dim text-sm">— ${esc(x.topic)}</span></li>`
      )
    )}
    ${interests}`;
}

// ── Frontier ────────────────────────────────────────────────────────────

function distanceLabel(n) {
  const d = Number(n) || 0;
  return d <= 0 ? 'core' : d === 1 ? 'adjacent' : `far (${d})`;
}

export function frontierPanel(frontier, botId) {
  const rank = (s) => (s === 'open' || s === 'exploring' ? 0 : 1);
  const items = (frontier ?? [])
    .filter((f) => f?.item && f.item.status !== 'dropped')
    .sort(
      (a, b) =>
        rank(a.item.status) - rank(b.item.status) ||
        Number(b.item.surpriseScore) - Number(a.item.surpriseScore)
    )
    .slice(0, 8);
  if (items.length === 0) {
    return emptyState({
      icon: '✧',
      title: 'No open questions on the frontier',
      hint: 'Surprises and open questions become candidate directions here.',
    });
  }
  return `<div class="curio-frontier">${items
    .map(({ item, verdict }) => {
      const v = verdict ?? {};
      const badges = [
        badge(distanceLabel(item.distance), Number(item.distance) >= 2 ? 'warn' : 'muted'),
        badge(`surprise ${Number(item.surpriseScore ?? 0).toFixed(2)}`, 'accent'),
        item.status !== 'open' ? badge(item.status, 'info') : '',
        ...(v.crosses ?? []).map((d) => badge(`crosses ${d}`, 'muted')),
        (v.blockedBy ?? []).length ? badge(`blocked: ${v.blockedBy.join(', ')}`, 'danger') : '',
        (v.needsApproval ?? []).length
          ? badge(`needs approval: ${v.needsApproval.join(', ')}`, 'warn')
          : '',
        v.allowed && item.status === 'open' ? badge('free to explore', 'ok') : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<div class="${cx('curio-frontier-item', item.status === 'explored' ? 'curio-done' : '')}">
        <div class="curio-q">${esc(item.question)}</div>
        ${item.whyInteresting ? `<div class="text-sm">${esc(item.whyInteresting)}</div>` : ''}
        ${item.bridge ? `<div class="text-dim text-sm">↳ ${esc(item.bridge)}</div>` : ''}
        <div class="curio-badges">${badges}</div>
        ${signalButtons('frontier', botId, item.id, item.operatorSignal, ['up', 'down'], {
          up: 'Approve',
          down: 'Drop',
        })}
      </div>`;
    })
    .join('')}</div>`;
}

// ── Dispatches ──────────────────────────────────────────────────────────

export const DISPATCH_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'sent', label: 'Sent' },
  { id: 'held', label: 'Held' },
  { id: 'proposals', label: 'Proposals' },
];

/** Dropped dispatches never show; `all` is everything else. */
export function filterDispatches(list, filter = 'all') {
  const visible = (Array.isArray(list) ? list : []).filter((d) => d && d.status !== 'dropped');
  if (filter === 'sent') return visible.filter((d) => d.status === 'sent');
  if (filter === 'held') return visible.filter((d) => d.status === 'held');
  if (filter === 'proposals') return visible.filter((d) => d.kind === 'proposal');
  return visible;
}

export function dispatchCounts(list) {
  const out = {};
  for (const f of DISPATCH_FILTERS) out[f.id] = filterDispatches(list, f.id).length;
  return out;
}

/**
 * One dispatch, hook first. `showBot` adds the bot's face and name (fleet
 * inbox); `avatarSrc` decorates `avatarUrl` (the page adds the auth token).
 */
export function dispatchCard(
  d,
  { showBot = false, avatarSrc = (u) => u, nowMs = Date.now() } = {}
) {
  const botId = d.botId ?? '';
  const who = showBot
    ? `<a class="curio-who" href="#/agents/${esc(enc(botId))}">${avatar({
        seed: botId,
        name: d.botName ?? botId,
        src: d.avatarUrl ? avatarSrc(d.avatarUrl) : undefined,
        size: 28,
      })}<span>${esc(d.botName ?? botId)}</span></a>`
    : '';
  const meta = [
    badge(d.kind ?? 'insight', d.kind === 'proposal' ? 'accent' : 'info'),
    d.status && d.status !== 'sent'
      ? badge(d.status, STATUS_TONE[d.status] ?? 'muted', {
          title: d.status === 'held' ? 'Held by the editor gate: kept for a digest' : '',
        })
      : '',
    d.topic ? `<span class="text-dim text-sm">${esc(d.topic)}</span>` : '',
    `<span class="text-dim text-sm">${esc(ago(d.sentAt ?? d.createdAt, nowMs))}</span>`,
  ]
    .filter(Boolean)
    .join(' ');
  const crossing = (d.crossing ?? []).length
    ? `<div class="curio-badges">${d.crossing.map((c) => badge(`crosses ${c}`, 'warn')).join(' ')}</div>`
    : '';
  return `<article class="${cx('curio-dispatch', `curio-dispatch-${esc(d.status ?? 'sent')}`)}" data-dispatch-id="${esc(d.id)}">
    <div class="curio-dispatch-head">${who}<span class="curio-dispatch-meta">${meta}</span></div>
    <div class="curio-hook">${esc(d.hook)}</div>
    ${d.whyCare ? `<div class="curio-why">${esc(d.whyCare)}</div>` : ''}
    ${
      d.evidence
        ? `<details class="curio-evidence">
      <summary>Evidence</summary><div class="curio-pre">${esc(d.evidence)}</div></details>`
        : ''
    }
    ${d.action ? `<div class="curio-action">→ ${esc(d.action)}</div>` : ''}
    ${d.question ? `<div class="curio-question">${esc(d.question)}</div>` : ''}
    ${crossing}
    ${signalButtons('dispatch', botId, d.id, d.signal, ['up', 'down', 'more'])}
  </article>`;
}

export function dispatchList(list, opts = {}) {
  const items = Array.isArray(list) ? list : [];
  if (items.length === 0) {
    return emptyState({
      icon: '✉',
      title: opts.emptyTitle ?? 'No dispatches yet',
      hint:
        opts.emptyHint ??
        'Dispatches are the findings an agent judged worth your attention: one claim, why it matters, the evidence.',
    });
  }
  return `<div class="curio-dispatches">${items.map((d) => dispatchCard(d, opts)).join('')}</div>`;
}

// ── Mind section (Agent Home) ───────────────────────────────────────────

export function mindSection(snapshot, { nowMs = Date.now() } = {}) {
  const botId = snapshot?.botId ?? '';
  const dispatches = filterDispatches(snapshot?.dispatches).slice(0, 5);
  return `<div class="curio-mind">
    <div class="curio-mind-head"><div class="ui-card-title">Mind</div>${dnaLine(snapshot)}</div>
    <div class="home-grid">
      ${card({
        title: 'Direction',
        subtitle: 'Where it is going and why',
        body: directionPanel(snapshot?.navigator?.direction ?? null, botId, nowMs),
      })}
      ${card({
        title: 'Knowledge',
        subtitle: 'What it has learned',
        body: knowledgePanel(snapshot?.map, nowMs),
      })}
    </div>
    <div class="home-grid" style="margin-top:16px">
      ${card({
        title: 'Frontier',
        subtitle: 'What it does not know yet, by expected surprise',
        body: frontierPanel(snapshot?.frontier, botId),
      })}
      ${card({
        title: 'Dispatches',
        subtitle: 'What it brought back to you',
        body: dispatchList(dispatches, { nowMs }),
        actions: '<a class="btn btn-sm" href="#/work/dispatches">All dispatches</a>',
      })}
    </div>
  </div>`;
}

// ── Config form ─────────────────────────────────────────────────────────

/** The dials the preset gives, overlaid with explicit per-dial overrides. */
export function previewDials(preset, overrides = {}) {
  const base = CURIOSITY_PRESETS[preset] ?? CURIOSITY_PRESETS[CURIOSITY_UI_DEFAULTS.preset];
  const out = { ...base };
  for (const d of LIMIT_DIALS) {
    const v = overrides?.[d];
    if (DIAL_LEVELS.includes(v)) out[d] = v;
  }
  return out;
}

const opt = (value, label, selected) =>
  `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;

/** Markup for the Curiosity block of the agent form; `cur` is `agentLoop.curiosity`. */
export function curiosityFormSection(cur = {}) {
  const c = cur ?? {};
  const preset = c.preset ?? '';
  const effective = previewDials(preset || CURIOSITY_UI_DEFAULTS.preset, {});
  const dials = LIMIT_DIALS.map((d) => {
    const v = c.limits?.[d] ?? '';
    const shown = v || effective[d];
    return `<div class="form-group curio-dial-field">
      <label>${esc(DIAL_LABEL[d])}</label>
      <select name="curiosityDial_${d}" data-dial="${d}">
        ${opt('', `From preset (${effective[d]})`, v === '')}
        ${DIAL_LEVELS.map((l) => opt(l, l, v === l)).join('')}
      </select>
      <span class="text-dim text-sm curio-dial-help" data-dial-help="${d}">${esc(
        DIAL_MEANINGS[d][shown]
      )}</span>
    </div>`;
  }).join('');
  const inherit = c.exploreRatio == null;
  const ratio = inherit ? CURIOSITY_UI_DEFAULTS.exploreRatio : Number(c.exploreRatio);
  const de = c.dispatch?.enabled;
  return `<div class="curio-form">
    <div class="form-row">
      <div class="form-group">
        <label>Curiosity</label>
        <select name="curiosityEnabled">
          ${opt('', 'Inherit global (on)', c.enabled == null)}
          ${opt('true', 'On', c.enabled === true)}
          ${opt('false', 'Off', c.enabled === false)}
        </select>
      </div>
      <div class="form-group">
        <label>Preset</label>
        <select name="curiosityPreset">
          ${opt('', `Inherit global (${CURIOSITY_UI_DEFAULTS.preset})`, preset === '')}
          ${CURIOSITY_PRESET_IDS.map((p) => opt(p, p, preset === p)).join('')}
        </select>
        <span class="text-dim text-sm">focused stays in its lane · explorer roams and asks · wild crosses and reports. Dials below override single limits.</span>
      </div>
    </div>
    <div class="curio-dial-grid">${dials}</div>
    <div class="form-group">
      <label>Exploration share <output name="curiosityExploreOut">${esc(pct(ratio))}</output></label>
      <div class="curio-range-row">
        <input type="range" name="curiosityExploreRatio" min="0" max="${CURIOSITY_UI_DEFAULTS.maxExploreRatio}" step="0.05" value="${esc(
          ratio
        )}"${inherit ? ' disabled' : ''}>
        <label class="curio-inline"><input type="checkbox" name="curiosityExploreInherit"${inherit ? ' checked' : ''}> default (${esc(
          pct(CURIOSITY_UI_DEFAULTS.exploreRatio)
        )})</label>
      </div>
      <span class="text-dim text-sm">Share of cycles spent exploring the frontier; the curiosity trait scales it (0.6×–1.4×), capped at 60%.</span>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Dispatches</label>
        <select name="curiosityDispatchEnabled">
          ${opt('', 'Inherit global (on)', de == null)}
          ${opt('true', 'On', de === true)}
          ${opt('false', 'Off', de === false)}
        </select>
      </div>
      <div class="form-group">
        <label>Dispatch max chars</label>
        <input type="number" name="curiosityDispatchMaxChars" min="${CURIOSITY_UI_DEFAULTS.minMaxChars}" max="${CURIOSITY_UI_DEFAULTS.maxMaxChars}" value="${esc(
          c.dispatch?.maxChars ?? ''
        )}" placeholder="${CURIOSITY_UI_DEFAULTS.dispatchMaxChars}">
      </div>
    </div>
  </div>`;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Read the form values into an `agentLoop.curiosity` override. Keys the form
 * does not show (navigatorEvery, maxTopicShare, dispatch.minEditorScore, …)
 * are kept from `existing`; a field left on "inherit" removes its key.
 * Returns null when nothing is overridden, so the PATCH clears the block.
 *
 * values: { enabled, preset, dials: {dial: ''|level}, exploreInherit,
 *           exploreRatio, dispatchEnabled, dispatchMaxChars } (raw strings)
 */
export function readCuriosityForm(values, existing) {
  const v = values ?? {};
  const out = { ...(existing ?? {}) };
  delete out.enabled;
  delete out.preset;
  delete out.exploreRatio;

  if (v.enabled === 'true') out.enabled = true;
  else if (v.enabled === 'false') out.enabled = false;
  if (CURIOSITY_PRESET_IDS.includes(v.preset)) out.preset = v.preset;

  const limits = { ...(existing?.limits ?? {}) };
  for (const d of LIMIT_DIALS) {
    const lvl = v.dials?.[d];
    if (DIAL_LEVELS.includes(lvl)) limits[d] = lvl;
    else delete limits[d];
  }
  if (Object.keys(limits).length) out.limits = limits;
  else delete out.limits;

  if (!v.exploreInherit && v.exploreRatio !== '' && v.exploreRatio != null) {
    const r = Number.parseFloat(v.exploreRatio);
    if (Number.isFinite(r)) out.exploreRatio = clamp(r, 0, CURIOSITY_UI_DEFAULTS.maxExploreRatio);
  }

  const dispatch = { ...(existing?.dispatch ?? {}) };
  delete dispatch.enabled;
  delete dispatch.maxChars;
  if (v.dispatchEnabled === 'true') dispatch.enabled = true;
  else if (v.dispatchEnabled === 'false') dispatch.enabled = false;
  if (v.dispatchMaxChars !== '' && v.dispatchMaxChars != null) {
    const n = Number.parseInt(v.dispatchMaxChars, 10);
    if (Number.isFinite(n))
      dispatch.maxChars = clamp(
        n,
        CURIOSITY_UI_DEFAULTS.minMaxChars,
        CURIOSITY_UI_DEFAULTS.maxMaxChars
      );
  }
  if (Object.keys(dispatch).length) out.dispatch = dispatch;
  else delete out.dispatch;

  return Object.keys(out).length ? out : null;
}

/** One-line text for the config page: what this agent overrides, or "global defaults". */
export function curiositySummary(cur) {
  const c = cur ?? {};
  if (c.enabled === false) return 'off';
  const parts = [c.preset ? `preset ${c.preset}` : 'preset inherited'];
  for (const d of LIMIT_DIALS) if (c.limits?.[d]) parts.push(`${d} ${c.limits[d]}`);
  if (c.exploreRatio != null) parts.push(`explore ${pct(c.exploreRatio)}`);
  if (c.dispatch?.enabled === false) parts.push('dispatches off');
  if (c.dispatch?.maxChars != null) parts.push(`dispatch ≤ ${c.dispatch.maxChars} chars`);
  return parts.length === 1 && !c.preset && c.enabled == null
    ? 'global defaults'
    : parts.join(' · ');
}
