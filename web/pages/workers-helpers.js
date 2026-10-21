/**
 * Task workers in the dashboard (C20 of docs/plans/goal-tasks-architecture-plan.md):
 * the live badge on a board task, the "Active workers" strip on Agent Home,
 * the fleet Workers view, the worker sheet and the Needs You section.
 *
 * Pure markup. Runs come from `GET /api/agents/:id/workers` / `GET /api/workers`
 * (`WorkerRunView`) or from presence (`LiveWorker`); `workerModel` reads both.
 * `[data-open-worker]` opens the sheet (one delegated listener, worker-sheet.js).
 */
import { badge, emptyState, esc } from '../ui/index.js';
import { whyPanel } from './why-helpers.js';

const ACTIVE = new Set(['queued', 'running', 'waiting', 'interrupted']);

const STATUS_TONE = {
  queued: 'muted',
  running: 'accent',
  waiting: 'warn',
  interrupted: 'warn',
  done: 'ok',
  blocked: 'warn',
  failed: 'danger',
  stopped: 'muted',
};

export function workerStatusTone(status) {
  return STATUS_TONE[status] ?? 'muted';
}

export function workerDetailUrl(runId) {
  return `/api/workers/${encodeURIComponent(runId)}`;
}

/** @param {'stop' | 'retry'} action */
export function workerActionPath(runId, action) {
  return `${workerDetailUrl(runId)}/${action}`;
}

/** `worker:*` and `task:changed` events (of `botId` when given). */
export function isWorkerEvent(event, botId) {
  if (!event || typeof event.type !== 'string') return false;
  if (botId && event.botId !== botId) return false;
  return event.type.startsWith('worker:') || event.type === 'task:changed';
}

/**
 * What an activity event refreshes on the Agent Home: the workers strip and
 * task badges, the rest of the home (timeline, Needs You, board), or both.
 * Worker progress (a tool, a step, a worker's own tool:* events) changes only
 * the badges; a full home refresh for each of them would refetch the home on
 * every tool call a worker makes.
 */
export function homeEventEffects(event) {
  if (!event || typeof event.type !== 'string') return { workers: false, home: false };
  const workers = isWorkerEvent(event);
  if (event.data?.runId && event.type.startsWith('tool:')) return { workers, home: false };
  if (event.type === 'worker:tool' || event.type === 'worker:step') return { workers, home: false };
  return { workers, home: true };
}

/** False once `GET /api/agents/:id/workers` says workers are off; a failed request keeps polling. */
export function workersPollingWanted(res) {
  return !(res && res.enabled === false);
}

/** "<1 min", "6 min", "2 h", "3 d"; '' for a non-number. */
export function formatElapsed(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '';
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

function ms(v) {
  if (typeof v === 'number') return v;
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
}

/** One shape for a run view or a live presence worker. */
export function workerModel(r) {
  const status = String(r?.status ?? 'running');
  const question = r?.question ?? r?.wait?.question ?? null;
  return {
    runId: String(r?.runId ?? ''),
    botId: r?.botId ?? null,
    taskId: r?.taskId ?? null,
    taskText: r?.taskText ?? null,
    goalTitle: r?.goalTitle ?? null,
    dispatchCycleId: r?.dispatchCycleId ?? null,
    attempt: r?.attempt ?? null,
    status,
    step: Number(r?.step) || 0,
    steps: Number(r?.budget?.steps) || 0,
    tool: r?.tool ?? r?.currentTool ?? null,
    question: question || null,
    sinceMs: ms(r?.since ?? r?.startedAt ?? r?.createdAt),
    endedAt: r?.endedAt ?? null,
    outcome: r?.outcome ?? null,
    active: ACTIVE.has(status),
  };
}

function elapsedOf(m, nowMs) {
  return m.sinceMs === null ? '' : formatElapsed(nowMs - m.sinceMs);
}

function pct(m) {
  if (!m.steps) return 0;
  return Math.min(100, Math.round((m.step / m.steps) * 100));
}

/** Map task id → the active run working it (later runs win). */
export function activeWorkersByTask(runs) {
  const map = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    const m = workerModel(r);
    if (m.active && m.taskId) map.set(m.taskId, m);
  }
  return map;
}

const pulse = (wait) =>
  `<span class="wk-pulse${wait ? ' is-wait' : ''}" aria-hidden="true"></span>`;

/**
 * The badge on a board task; '' without an active run. `compact` (the inline
 * task rows of a board card): only step n/budget and the tool, or "waiting on you".
 */
export function workerTaskBadge(run, nowMs = Date.now(), { compact = false } = {}) {
  if (!run) return '';
  const m = run.sinceMs !== undefined && 'active' in run ? run : workerModel(run);
  if (!m.active) return '';
  const wait = m.status === 'waiting';
  const step = m.steps ? `step ${m.step}/${m.steps}` : null;
  const parts = wait
    ? ['waiting on you', compact ? null : m.question ? `"${m.question}"` : null]
    : compact
      ? m.status === 'queued'
        ? ['queued']
        : step || m.tool
          ? [step, m.tool]
          : ['worker']
      : [m.status === 'queued' ? 'queued' : 'worker', step, m.tool, elapsedOf(m, nowMs)];
  const text = parts.filter(Boolean).join(' · ');
  const title = wait && m.question ? `Waiting on you: ${m.question}` : 'Open the worker';
  return `<button type="button" class="wk-badge${compact ? ' is-compact' : ''}${wait ? ' is-wait' : ''}" data-open-worker="${esc(m.runId)}" title="${esc(title)}">${pulse(wait)}<span class="wk-badge-text">${esc(text)}</span></button>`;
}

function stripCard(m, nowMs) {
  const wait = m.status === 'waiting';
  const meta = wait
    ? [m.goalTitle, `waiting on you${m.question ? `: "${m.question}"` : ''}`, elapsedOf(m, nowMs)]
    : [
        m.goalTitle,
        m.steps ? `step ${m.step} / ${m.steps}` : null,
        m.status === 'queued' ? 'queued' : m.tool,
        elapsedOf(m, nowMs),
      ];
  return `<button type="button" class="wk-card${wait ? ' is-wait' : ''}" data-open-worker="${esc(m.runId)}">
    <span class="wk-card-head">${pulse(wait)}<span class="wk-card-title">${esc(m.taskText || m.taskId || m.runId)}</span></span>
    <span class="wk-card-meta">${esc(meta.filter(Boolean).join(' · '))}</span>
    <span class="wk-bar"><i style="width:${pct(m)}%"></i></span>
  </button>`;
}

/** Agent Home strip above the board; '' when nothing is active. */
export function workersStrip(runs, { nowMs = Date.now() } = {}) {
  const active = (Array.isArray(runs) ? runs : []).map(workerModel).filter((m) => m.active);
  if (!active.length) return '';
  return `<div class="wk-strip" aria-label="Active workers">
    <div class="wk-strip-head">Active workers <span class="home-board-count">${active.length}</span></div>
    <div class="wk-strip-cards">${active.map((m) => stripCard(m, nowMs)).join('')}</div>
  </div>`;
}

/** One chip per tool name (×n), the targets it touched in the tooltip. */
function toolChips(calls) {
  const byName = new Map();
  for (const c of Array.isArray(calls) ? calls : []) {
    const e = byName.get(c.name) ?? { n: 0, failed: 0, targets: [] };
    e.n += 1;
    if (c.ok === false) e.failed += 1;
    if (c.target && !e.targets.includes(c.target)) e.targets.push(c.target);
    byName.set(c.name, e);
  }
  return [...byName]
    .map(([name, e]) => {
      const title = e.targets.length ? ` title="${esc(e.targets.join('\n'))}"` : '';
      const cls = e.failed ? ' is-failed' : '';
      return `<span class="wk-tool${cls}"${title}>${esc(name)}${e.n > 1 ? `<b>×${e.n}</b>` : ''}</span>`;
    })
    .join('');
}

const STEP_KIND = {
  progress: ['progress', 'accent'],
  done: ['done', 'ok'],
  blocked: ['blocked', 'warn'],
};

function stepRow(s, run, nowMs) {
  const ended = Boolean(s.endedAt);
  const [label, tone] = s.error
    ? ['error', 'danger']
    : s.report?.kind
      ? (STEP_KIND[s.report.kind] ?? [s.report.kind, 'muted'])
      : ended
        ? ['no report', 'muted']
        : run.active
          ? ['working', 'accent']
          : ['cut short', 'muted'];
  const live = !ended && run.active && !s.error;
  const text = s.report?.note || (ended ? s.summary || '' : 'Working…');
  const start = ms(s.startedAt);
  const end = ms(s.endedAt) ?? (live ? nowMs : null);
  const took = start !== null && end !== null ? formatElapsed(end - start) : '';
  const tools = toolChips(s.toolCalls);
  const calls = Array.isArray(s.toolCalls) ? s.toolCalls.length : 0;
  return `<li class="wk-step is-${esc(tone)}${live ? ' is-live' : ''}">
    <span class="wk-step-dot" aria-hidden="true">${esc(s.n)}</span>
    <div class="wk-step-card">
      <div class="wk-step-head">
        <span class="wk-step-n">step ${esc(s.n)}</span>
        ${badge(label, tone)}
        <span class="wk-step-meta">${esc([took, calls ? `${calls} tool call${calls === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '))}</span>
      </div>
      ${text ? `<p class="wk-step-text">${esc(text)}</p>` : ''}
      ${tools ? `<div class="wk-tools">${tools}</div>` : ''}
      ${s.error ? `<div class="wk-step-error">${esc(s.error)}</div>` : ''}
    </div>
  </li>`;
}

function meter(label, used, total, fmt = String) {
  const has = typeof total === 'number' && total > 0;
  const p = has ? Math.min(100, Math.round(((used ?? 0) / total) * 100)) : 0;
  const tone = p >= 90 ? ' is-hot' : p >= 70 ? ' is-warm' : '';
  return `<div class="wk-meter${tone}">
    <span class="wk-meter-label">${esc(label)}</span>
    <span class="wk-meter-value">${esc(fmt(used ?? 0))}<span class="wk-meter-of"> / ${esc(has ? fmt(total) : '?')}</span></span>
    <span class="wk-bar"><i style="width:${p}%"></i></span>
  </div>`;
}

function budgetMeters(run) {
  const b = run.budget ?? {};
  const u = run.used ?? {};
  return `<div class="wk-meters" aria-label="Budget used">
    ${meter('Steps', u.steps, b.steps)}
    ${meter('Tool calls', u.toolCalls, b.toolCalls)}
    ${b.wallMs ? meter('Time', u.wallMs, b.wallMs, formatElapsed) : ''}
  </div>`;
}

/** Where the operator answers what a waiting run asked. */
function answerHref(kind) {
  return kind === 'approval' ? '#/needs/permissions' : '#/needs/inbox';
}

/** The worker sheet: header, budget, the question it waits on, journal per step, Stop / Retry. */
export function workerSheetBody(detail, nowMs = Date.now()) {
  const raw = detail?.run ?? {};
  const m = workerModel(raw);
  const origin = m.dispatchCycleId
    ? `<button type="button" class="wk-link" data-open-cycle="${esc(m.dispatchCycleId)}" data-bot-id="${esc(m.botId ?? '')}">Dispatched by a cycle</button>`
    : '<span>Started by you</span>';
  const actions = m.active
    ? `<button type="button" class="btn btn-sm btn-danger" data-worker-stop="${esc(m.runId)}">Stop</button>`
    : `<button type="button" class="btn btn-sm" data-worker-retry="${esc(m.runId)}">Retry</button>`;
  const steps = Array.isArray(detail?.steps) ? detail.steps : [];
  const facts = [
    origin,
    `<span>Attempt ${esc(m.attempt ?? 1)}</span>`,
    m.sinceMs !== null
      ? `<span>${m.active ? 'Running for' : 'Started'} ${esc(elapsedOf(m, nowMs))}${m.active ? '' : ' ago'}</span>`
      : '',
  ].filter(Boolean);
  const outcome = raw.outcome?.note
    ? `<div class="wk-callout is-${esc(workerStatusTone(m.status))}">
        <div class="wk-callout-head">${badge(raw.outcome.kind ?? m.status, workerStatusTone(m.status))} How it ended</div>
        <p>${esc(raw.outcome.note)}</p>
      </div>`
    : '';
  const waitKind = raw.wait?.kind ?? 'ask';
  const clipped = typeof m.question === 'string' && m.question.length >= 300;
  const wait =
    m.status === 'waiting' && m.question
      ? `<div class="wk-callout is-warn">
          <div class="wk-callout-head">${pulse(true)} ${waitKind === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer'}</div>
          <p>${esc(m.question)}${clipped ? '…' : ''}</p>
          <a class="btn btn-sm" href="${answerHref(waitKind)}">${waitKind === 'approval' ? 'Decide in Needs You' : 'Answer in Needs You'} →</a>
        </div>`
      : '';
  const done = steps.filter((s) => s.endedAt).length;
  return `<div class="wk-sheet">
    <p class="wk-sheet-intro">A worker takes one task off a goal and works it in short steps until it is done, blocked, or out of budget.</p>
    <div class="wk-sheet-head">
      <div class="wk-sheet-main">
        ${m.goalTitle ? `<div class="wk-sheet-goal" title="${esc(m.goalTitle)}"><span>Goal</span>${esc(m.goalTitle)}</div>` : ''}
        <h3 class="wk-sheet-title">${esc(m.taskText || m.taskId || 'Task')}</h3>
        <div class="wk-sheet-facts">${facts.join('<span class="wk-sep" aria-hidden="true">·</span>')}</div>
      </div>
      <span class="wk-sheet-actions">${badge(m.status, workerStatusTone(m.status), { dot: m.active })}${actions}</span>
    </div>
    ${wait}${outcome}
    ${budgetMeters(raw)}
    ${whyPanel(detail?.why, { nowMs, botId: m.botId ?? undefined })}
    <div class="wk-section-head wk-steps-head">Steps <span class="home-board-count">${done}${m.steps ? ` / ${m.steps}` : ''}</span></div>
    ${steps.length ? `<ol class="wk-steps">${steps.map((s) => stepRow(s, m, nowMs)).join('')}</ol>` : '<div class="text-dim wk-empty">No steps yet.</div>'}
    <div class="wk-sheet-id" title="Run id">${esc(m.runId)}</div>
  </div>`;
}

function listRow(m, names, nowMs) {
  const bot = names?.[m.botId] ?? m.botId ?? '';
  const when = m.active
    ? elapsedOf(m, nowMs)
    : m.endedAt
      ? `${formatElapsed(nowMs - (ms(m.endedAt) ?? nowMs))} ago`
      : '';
  const detail = m.active
    ? m.status === 'waiting'
      ? `waiting on you${m.question ? `: "${m.question}"` : ''}`
      : [m.steps ? `step ${m.step}/${m.steps}` : null, m.tool].filter(Boolean).join(' · ')
    : (m.outcome?.note ?? '');
  return `<button type="button" class="wk-row" data-open-worker="${esc(m.runId)}">
    <span class="wk-row-status">${m.active ? pulse(m.status === 'waiting') : ''}${badge(m.status, workerStatusTone(m.status))}</span>
    <span class="wk-row-main"><span class="wk-row-task">${esc(m.taskText || m.taskId || m.runId)}</span><span class="text-dim wk-row-sub">${esc(bot)}${m.goalTitle ? ` · ${esc(m.goalTitle)}` : ''}${detail ? ` · ${esc(detail)}` : ''}</span></span>
    <span class="text-dim wk-row-when">${esc(when)}</span>
  </button>`;
}

/** Fleet Workers view: Active, then Recent. */
export function workersList(runs, { nowMs = Date.now(), names = {}, enabled = true } = {}) {
  const all = (Array.isArray(runs) ? runs : []).map(workerModel);
  if (!all.length) {
    return enabled
      ? emptyState({
          icon: '⚙',
          title: 'No worker runs yet',
          hint: 'When a cycle hands a task to a worker, it shows up here while it runs and after it ends.',
        })
      : emptyState({
          icon: '⚙',
          title: 'Workers are off',
          hint: 'Task workers are not enabled for any of your agents.',
        });
  }
  const active = all.filter((m) => m.active);
  const recent = all.filter((m) => !m.active);
  const section = (title, list) =>
    `<div class="wk-section"><div class="wk-section-head">${title} <span class="home-board-count">${list.length}</span></div>${
      list.length
        ? list.map((m) => listRow(m, names, nowMs)).join('')
        : '<div class="text-dim wk-empty">None right now.</div>'
    }</div>`;
  return `${section('Active', active)}${section('Recent', recent)}`;
}

/** Needs You: runs waiting on an answer (the answer goes through the ask / permission item). */
export function waitingWorkersSection(list, nowMs = Date.now()) {
  if (!Array.isArray(list) || !list.length) return '';
  const rows = list
    .map((w) => {
      const since = ms(w.since);
      return `<button type="button" class="wk-row is-wait" data-open-worker="${esc(w.runId)}">
      <span class="wk-row-status">${pulse(true)}${badge('waiting', 'warn')}</span>
      <span class="wk-row-main"><span class="wk-row-task">${esc(w.question || 'Waiting on you')}</span><span class="text-dim wk-row-sub">${esc(w.botName ?? w.botId)} · ${esc(w.taskText)}${w.stepsBudget ? ` · step ${esc(w.step)}/${esc(w.stepsBudget)}` : ''}${w.itemId ? ' · answer it below' : ''}</span></span>
      <span class="text-dim wk-row-when">${since === null ? '' : esc(formatElapsed(nowMs - since))}</span>
    </button>`;
    })
    .join('');
  return `<div class="wk-section wk-needs"><div class="wk-section-head">Workers waiting on you <span class="home-board-count">${list.length}</span></div>${rows}</div>`;
}
