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

/** The badge on a board task card; '' without an active run. */
export function workerTaskBadge(run, nowMs = Date.now()) {
  if (!run) return '';
  const m = run.sinceMs !== undefined && 'active' in run ? run : workerModel(run);
  if (!m.active) return '';
  const wait = m.status === 'waiting';
  const parts = wait
    ? ['waiting on you', m.question ? `"${m.question}"` : null]
    : [
        m.status === 'queued' ? 'queued' : 'worker',
        m.steps ? `step ${m.step}/${m.steps}` : null,
        m.tool,
        elapsedOf(m, nowMs),
      ];
  const text = parts.filter(Boolean).join(' · ');
  return `<button type="button" class="wk-badge${wait ? ' is-wait' : ''}" data-open-worker="${esc(m.runId)}" title="Open the worker">${pulse(wait)}<span class="wk-badge-text">${esc(text)}</span></button>`;
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

function toolTally(calls) {
  const counts = new Map();
  for (const c of Array.isArray(calls) ? calls : []) {
    const key = c.target ? `${c.name} ${c.target}` : c.name;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(' · ');
}

function stepRow(s, run) {
  const ended = Boolean(s.endedAt);
  const kind = s.error
    ? ['error', 'danger']
    : s.report?.kind
      ? [s.report.kind, s.report.kind === 'blocked' ? 'warn' : 'ok']
      : ended
        ? ['ended', 'muted']
        : run.active
          ? ['running', 'accent']
          : ['cut short', 'muted'];
  const text = s.summary || s.report?.note || (ended ? '' : 'Working…');
  const tools = toolTally(s.toolCalls);
  return `<div class="wk-step">
    <span class="wk-step-n">step ${esc(s.n)}</span>
    <span class="wk-step-body">${esc(text)}${tools ? ` <span class="text-dim">${esc(tools)}</span>` : ''}${s.error ? `<span class="wk-step-error">${esc(s.error)}</span>` : ''}</span>
    ${badge(kind[0], kind[1])}
  </div>`;
}

function usage(run) {
  const b = run.budget ?? {};
  const u = run.used ?? {};
  const parts = [
    `${u.steps ?? 0} / ${b.steps ?? '?'} steps`,
    `${u.toolCalls ?? 0} / ${b.toolCalls ?? '?'} tool calls`,
  ];
  if (b.wallMs) parts.push(`${formatElapsed(u.wallMs ?? 0)} of ${formatElapsed(b.wallMs)}`);
  return parts.join(' · ');
}

/** The worker sheet: header, budget, journal per step, Stop / Retry. */
export function workerSheetBody(detail, nowMs = Date.now()) {
  const raw = detail?.run ?? {};
  const m = workerModel(raw);
  const cycle = m.dispatchCycleId
    ? `<button type="button" class="wk-link" data-open-cycle="${esc(m.dispatchCycleId)}" data-bot-id="${esc(m.botId ?? '')}">dispatched by a cycle</button>`
    : '<span>started by you</span>';
  const actions = m.active
    ? `<button type="button" class="btn btn-sm btn-danger" data-worker-stop="${esc(m.runId)}">Stop</button>`
    : `<button type="button" class="btn btn-sm" data-worker-retry="${esc(m.runId)}">Retry</button>`;
  const steps = Array.isArray(detail?.steps) ? detail.steps : [];
  const outcome = raw.outcome?.note
    ? `<div class="wk-outcome">${badge(raw.outcome.kind ?? m.status, workerStatusTone(m.status))} ${esc(raw.outcome.note)}</div>`
    : '';
  const wait =
    m.status === 'waiting' && m.question
      ? `<div class="wk-wait">${pulse(true)} Waiting on you: ${esc(m.question)}</div>`
      : '';
  return `<div class="wk-sheet">
    <div class="wk-sheet-head">
      <div>
        <div class="wk-sheet-title">${esc(m.taskText || m.taskId || 'Task')}</div>
        <div class="wk-sheet-sub text-dim">${m.goalTitle ? `${esc(m.goalTitle)} · ` : ''}${esc(m.runId)} · attempt ${esc(m.attempt ?? 1)} · ${cycle}${m.sinceMs !== null ? ` · ${esc(elapsedOf(m, nowMs))}` : ''}</div>
      </div>
      <span class="wk-sheet-actions">${badge(m.status, workerStatusTone(m.status), { dot: m.active })}${actions}</span>
    </div>
    <div class="wk-sheet-usage text-dim">Budget used: ${esc(usage(raw))}</div>
    <div class="wk-bar"><i style="width:${pct(m)}%"></i></div>
    ${wait}${outcome}
    <div class="wk-steps">${steps.length ? steps.map((s) => stepRow(s, m)).join('') : '<div class="text-dim wk-empty">No steps yet.</div>'}</div>
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
