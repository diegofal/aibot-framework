/**
 * Automations → Cron, the board (prototype: docs/prototypes/automations-cron.html).
 *
 * Pure string helpers, no DOM and no fetch (tests/web/cron-board-helpers.test.ts):
 *   chips      summary that is also the filter (All · On · Paused · Failed · one per agent)
 *   week       the next 7 days, each run on its day (`job.upcoming` from GET /api/cron)
 *   attention  failed jobs, why in words, Run again / Details / Delete
 *   groups     jobs by agent, one row each; paused ones folded at the end
 *   drawer     one job: when, next run, what it does, why it exists, recent runs
 * `cron.js` keeps fetching, the edit modal and event delegation.
 */
import { avatarHue, esc } from '../ui/index.js';
import { cronToHuman } from './automations-helpers.js';
import { displayName, inWords, jobAgentId } from './cron-list-helpers.js';
import { whyPanel } from './why-helpers.js';

const H = 3_600_000;
const D = 24 * H;
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Group key for jobs that belong to no agent. */
export const FLEET_GROUP = '__fleet__';

export const JOB_KINDS = {
  skillJob: { icon: '◆', cls: 'cj-k-skill', label: 'Skill' },
  instruction: { icon: '▸', cls: 'cj-k-instruction', label: 'Instruction' },
  message: { icon: '✉', cls: 'cj-k-message', label: 'Message' },
};
const kindOf = (job) =>
  JOB_KINDS[job?.payload?.kind] ?? { icon: '•', cls: 'cj-k-message', label: 'Job' };

/** A pastel, stable color per agent (the same hue as its avatar). */
export function agentColor(seed) {
  return seed === FLEET_GROUP ? 'var(--text-dim)' : `hsl(${avatarHue(String(seed))} 70% 72%)`;
}

const SKILL_TITLES = {
  'Self-Reflection': 'Reflection',
  'Intelligence Gatherer': 'Intel gathering',
};

/** `{ title, sub }`: "Self-Reflection: nightly-reflection [bot]" → Reflection · nightly reflection. */
export function jobTitle(job) {
  const base = displayName(job);
  const m = base.match(/^(.+?):\s*([a-z0-9]+(?:-[a-z0-9]+)+)$/);
  if (m) return { title: SKILL_TITLES[m[1]] ?? m[1], sub: m[2].replace(/-/g, ' ') };
  return { title: base, sub: '' };
}

/** "America/Argentina/Buenos_Aires" → "Buenos Aires time"; none → "server time". */
export function tzLabel(tz) {
  const t = String(tz ?? '').trim();
  if (!t) return 'server time';
  if (t === 'UTC' || t === 'Etc/UTC') return 'UTC';
  return `${t.split('/').pop().replace(/_/g, ' ')} time`;
}

const hhmm = (d) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** `{ text, tz }`: "Daily at 09:00" / "Buenos Aires time". */
export function scheduleWords(schedule) {
  const s = schedule ?? {};
  if (s.kind === 'at') {
    const d = new Date(s.at);
    return {
      text: 'Once',
      tz: Number.isNaN(d.getTime())
        ? String(s.at ?? '')
        : d.toLocaleString('en-GB', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          }),
    };
  }
  if (s.kind === 'every') {
    const ms = Number(s.everyMs) || 0;
    const anchor = Number.isFinite(s.anchorMs) ? new Date(s.anchorMs) : null;
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const at = anchor ? `${hhmm(anchor)} · ${tzLabel(local)}` : '';
    if (ms > 0 && ms % (7 * D) === 0 && anchor) {
      const n = ms / (7 * D);
      const day = DOW[anchor.getDay()];
      const text = n === 1 ? `${day}s` : n === 2 ? `Every other ${day}` : `Every ${n} weeks`;
      return { text, tz: at };
    }
    if (ms > 0 && ms % D === 0)
      return { text: ms === D ? 'Daily' : `Every ${ms / D} days`, tz: at };
    if (ms >= H) return { text: `Every ${Math.round((ms / H) * 10) / 10}h`, tz: '' };
    return { text: `Every ${Math.max(1, Math.round(ms / 60_000))}m`, tz: '' };
  }
  if (s.kind === 'cron') {
    const text = cronToHuman(String(s.expr ?? '').trim())
      .replace(/^Every day at/, 'Daily at')
      .replace(/^Every (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) at/, '$1s at');
    return { text, tz: tzLabel(s.tz) };
  }
  return { text: '?', tz: '' };
}

/** "19s" / "1.3m" / "2ms". */
export function runDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${Math.round(n / 1000)}s`;
  return `${(n / 60_000).toFixed(1)}m`;
}

export const isFailed = (job) => job?.state?.lastStatus === 'error';
const agentKey = (job) => jobAgentId(job) ?? FLEET_GROUP;
const agentName = (key, names) => (key === FLEET_GROUP ? 'Fleet' : (names?.[key] ?? key));

/**
 * What went wrong, in words, plus a note when the cause is already fixed.
 * `{ text, fixed }`; `fixed` is '' when there is nothing to add.
 */
export function failureWords(job, names = {}) {
  const err = String(job?.state?.lastError ?? '');
  if (/Bot not found/i.test(err)) {
    return {
      text: `${agentName(agentKey(job), names)} has no Telegram connection of its own, so the message had nowhere to go.`,
      fixed: 'Fixed: headless agents now deliver to their dashboard chat. Run it again to send it.',
    };
  }
  return { text: err.replace(/^Error:\s*/, '') || 'The last run failed.', fixed: '' };
}

/** `filter`: all | on | paused | failed | `a:<agentKey>`; `query` matches name, text, agent. */
export function filterBoard(jobs, { filter = 'all', query = '', names = {} } = {}) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  return (jobs ?? []).filter((j) => {
    if (filter === 'on' && j.enabled === false) return false;
    if (filter === 'paused' && j.enabled !== false) return false;
    if (filter === 'failed' && !isFailed(j)) return false;
    if (filter.startsWith('a:') && agentKey(j) !== filter.slice(2)) return false;
    if (!q) return true;
    const p = j.payload ?? {};
    const hay = [j.name, p.text, p.skillId, p.jobId, agentName(agentKey(j), names)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

/** Agent keys in display order (by name; fleet last). */
export function agentOrder(jobs, names = {}) {
  const keys = [...new Set((jobs ?? []).map(agentKey))];
  return keys.sort((a, b) =>
    a === FLEET_GROUP
      ? 1
      : b === FLEET_GROUP
        ? -1
        : agentName(a, names).localeCompare(agentName(b, names))
  );
}

// ── Chips ──

export function chipsHtml(jobs, { filter = 'all', query = '', names = {} } = {}) {
  const list = jobs ?? [];
  const on = list.filter((j) => j.enabled !== false).length;
  const failed = list.filter(isFailed).length;
  const chip = (id, label, n, dot) =>
    `<button type="button" class="cj-chip${filter === id ? ' on' : ''}" data-f="${esc(id)}">${
      dot ? `<span class="cj-dot" style="background:${dot}"></span>` : ''
    }${esc(label)} <b>${n}</b></button>`;
  const agents = agentOrder(list, names)
    .map((k) =>
      chip(
        `a:${k}`,
        agentName(k, names),
        list.filter((j) => agentKey(j) === k).length,
        agentColor(k)
      )
    )
    .join('');
  return `${chip('all', 'All', list.length)}${chip('on', 'On', on, 'var(--ok)')}${chip(
    'paused',
    'Paused',
    list.length - on,
    'var(--text-faint)'
  )}${failed ? chip('failed', 'Failed', failed, 'var(--danger)') : ''}<span class="cj-sep"></span>${agents}<label class="cj-search"><span>⌕</span><input id="cj-q" data-page-filter placeholder="Search jobs" value="${esc(
    query
  )}" aria-label="Search jobs"></label>`;
}

// ── This week ──

/** Runs per local day for the 7 days from `nowMs`'s midnight. */
export function weekDays(jobs, nowMs = Date.now()) {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return { t: d.getTime(), events: [] };
  });
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  for (const job of jobs ?? []) {
    if (job?.enabled === false) continue;
    const runs = Array.isArray(job.upcoming)
      ? job.upcoming
      : job.state?.nextRunAtMs
        ? [job.state.nextRunAtMs]
        : [];
    for (const t of runs) {
      if (t < start.getTime() || t >= end.getTime()) continue;
      const day = [...days].reverse().find((d) => t >= d.t);
      day?.events.push({ job, t });
    }
  }
  for (const d of days) d.events.sort((a, b) => a.t - b.t);
  return days;
}

export function weekHtml(jobs, { nowMs = Date.now() } = {}) {
  const days = weekDays(jobs, nowMs);
  const total = days.reduce((n, d) => n + d.events.length, 0);
  const cells = days
    .map((d, i) => {
      const date = new Date(d.t);
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : DOW[date.getDay()].slice(0, 3);
      const evs = d.events
        .map(({ job, t }) => {
          const { title } = jobTitle(job);
          return `<div class="cj-ev" data-open="${esc(job.id)}" title="${esc(title)}"><span class="cj-dot" style="background:${agentColor(
            agentKey(job)
          )}"></span><time>${hhmm(new Date(t))}</time>${esc(title)}</div>`;
        })
        .join('');
      return `<div class="cj-day${i === 0 ? ' today' : ''}"><div class="cj-day-n"><span>${label}</span><span>${date.getDate()}</span></div>${
        evs || '<div class="cj-none">—</div>'
      }</div>`;
    })
    .join('');
  return `<div class="cj-week-h"><h2>This week</h2><span>${total} run${total === 1 ? '' : 's'} scheduled</span></div><div class="cj-days">${cells}</div>`;
}

// ── Needs attention ──

export function attentionHtml(jobs, { names = {}, nowMs = Date.now() } = {}) {
  const bad = (jobs ?? []).filter(isFailed);
  if (!bad.length) return '';
  const rows = bad
    .map((j) => {
      const { title } = jobTitle(j);
      const why = failureWords(j, names);
      const err = String(j.state?.lastError ?? '').replace(/^Error:\s*/, '');
      const when = inWords(j.state?.lastRunAtMs, nowMs);
      return `<div class="cj-attn-row"><div><div class="cj-attn-t">${esc(title)} <span class="cj-faint">· ${esc(
        agentName(agentKey(j), names)
      )}${when ? ` · failed ${esc(when)}` : ''}</span></div>
        <div class="cj-attn-why">${esc(why.text)}${err && err !== why.text ? ` <code>${esc(err)}</code>` : ''}</div>${
          why.fixed ? `<div class="cj-fixed">✓ ${esc(why.fixed)}</div>` : ''
        }</div>
        <div class="cj-attn-act"><button type="button" class="cj-btn sm primary" data-run="${esc(j.id)}">Run again</button><button type="button" class="cj-btn sm ghost" data-open="${esc(
          j.id
        )}">Details</button><button type="button" class="cj-btn sm ghost danger" data-del="${esc(j.id)}">Delete</button></div></div>`;
    })
    .join('');
  return `<div class="cj-attn-h"><span class="cj-red">●</span><h2>Needs attention</h2><span class="cj-n">${bad.length}</span></div>${rows}`;
}

// ── Groups ──

export function jobRowHtml(job, { selected = false, nowMs = Date.now() } = {}) {
  const k = kindOf(job);
  const { title, sub } = jobTitle(job);
  const w = scheduleWords(job?.schedule);
  const st = job?.state ?? {};
  const off = job?.enabled === false;
  const failed = isFailed(job);
  const p = job?.payload ?? {};
  const does =
    p.kind === 'skillJob' ? `${p.skillId ?? '?'}/${p.jobId ?? '?'}` : String(p.text ?? '');
  const last = st.lastRunAtMs
    ? `<span class="cj-last${failed ? ' err' : ''}"><span class="cj-dot" style="background:${
        failed ? 'var(--danger)' : 'var(--ok)'
      }"></span>${failed ? 'failed' : 'ran'} ${esc(inWords(st.lastRunAtMs, nowMs))}${
        st.lastDurationMs != null ? ` · ${esc(runDuration(st.lastDurationMs))}` : ''
      }</span>`
    : '<span class="cj-last">never ran</span>';
  const next = off
    ? job?.schedule?.kind === 'at' && st.lastRunAtMs
      ? 'done'
      : 'paused'
    : st.nextRunAtMs
      ? `next ${esc(inWords(st.nextRunAtMs, nowMs))}`
      : '—';
  const id = esc(job?.id ?? '');
  return `<div class="cj-job${off ? ' off' : ''}${selected ? ' sel' : ''}" data-open="${id}" data-id="${id}">
    <div class="cj-kind ${k.cls}" title="${k.label}">${k.icon}</div>
    <div class="cj-main"><div class="cj-t">${esc(title)}${sub ? `<span class="cj-sub">${esc(sub)}</span>` : ''}</div><div class="cj-d">${esc(
      does.split('\n')[0]
    )}</div></div>
    <div class="cj-when">${esc(w.text)}${w.tz ? `<span class="cj-tz">${esc(w.tz)}</span>` : ''}</div>
    <div class="cj-run"><div class="cj-next">${next}</div>${last}</div>
    <button type="button" class="cj-tg${off ? '' : ' on'}" data-tg="${id}" aria-label="${off ? 'Turn on' : 'Pause'}" title="${
      off ? 'Paused — click to turn on' : 'On — click to pause'
    }"></button>
    <button type="button" class="cj-kebab" data-open="${id}" aria-label="More">⋯</button>
  </div>`;
}

/**
 * `open`: agent keys whose paused fold is open. Paused jobs show unfolded
 * when filtering by paused/failed, searching, or when a group has nothing on.
 */
export function groupsHtml(
  jobs,
  {
    names = {},
    filter = 'all',
    query = '',
    open = new Set(),
    selected = null,
    nowMs = Date.now(),
  } = {}
) {
  const list = filterBoard(jobs, { filter, query, names });
  if (!list.length) {
    return (jobs ?? []).length
      ? '<div class="cj-empty">No jobs match. <button type="button" class="cj-btn sm ghost" data-f="all">Show all</button></div>'
      : '<div class="cj-empty">No cron jobs yet. Tell an agent what to do and when in the box above.</div>';
  }
  const nextOf = (j) =>
    (j.enabled === false ? null : j.state?.nextRunAtMs) ?? Number.POSITIVE_INFINITY;
  return agentOrder(list, names)
    .map((key) => {
      const js = list.filter((j) => agentKey(j) === key).sort((a, b) => nextOf(a) - nextOf(b));
      const on = js.filter((j) => j.enabled !== false);
      const off = js.filter((j) => j.enabled === false);
      const unfold =
        open.has(key) ||
        filter === 'paused' ||
        filter === 'failed' ||
        String(query).trim() ||
        !on.length;
      const next = on
        .map((j) => j.state?.nextRunAtMs)
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      const name = agentName(key, names);
      const row = (j) => jobRowHtml(j, { selected: selected === j.id, nowMs });
      const head =
        key === FLEET_GROUP
          ? `<h3>${esc(name)}</h3>`
          : `<h3><a href="#/agents/${encodeURIComponent(key)}">${esc(name)}</a></h3>`;
      return `<section class="cj-group"><div class="cj-g-h"><div class="cj-av" style="background:${agentColor(key)}">${esc(
        name.charAt(0).toUpperCase()
      )}</div>${head}<span class="cj-meta">${on.length} on${off.length ? ` · ${off.length} paused` : ''}${
        next ? ` · next run ${esc(inWords(next, nowMs))}` : ''
      }</span></div><div class="cj-list">${on.map(row).join('')}${
        off.length && !unfold
          ? `<button type="button" class="cj-fold" data-fold="${esc(key)}"><span class="cj-car">›</span>${off.length} paused</button>`
          : ''
      }${unfold ? off.map(row).join('') : ''}</div></section>`;
    })
    .join('');
}

// ── Drawer ──

/** `job` is GET /api/cron/:id (runs included, newest first or not — sorted here). */
export function drawerHtml(job, { names = {}, nowMs = Date.now() } = {}) {
  if (!job) return '';
  const k = kindOf(job);
  const { title, sub } = jobTitle(job);
  const w = scheduleWords(job.schedule);
  const st = job.state ?? {};
  const key = agentKey(job);
  const name = agentName(key, names);
  const failed = isFailed(job);
  const status = failed
    ? '<span class="cj-pill err">Failed</span>'
    : job.enabled === false
      ? '<span class="cj-pill off">Paused</span>'
      : '<span class="cj-pill ok">On</span>';
  const p = job.payload ?? {};
  const does =
    p.kind === 'skillJob' ? `${p.skillId ?? '?'}/${p.jobId ?? '?'}` : String(p.text ?? '');
  const nextV =
    job.enabled !== false && st.nextRunAtMs
      ? inWords(st.nextRunAtMs, nowMs)
      : job.schedule?.kind === 'at' && st.lastRunAtMs
        ? 'Already ran'
        : 'Paused';
  const nextS = st.nextRunAtMs
    ? new Date(st.nextRunAtMs).toLocaleString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
  const fail = failed ? failureWords(job, names) : null;
  const runs = (Array.isArray(job.runs) ? job.runs : [])
    .filter((r) => r.action === 'finished' || r.status)
    .sort((a, b) => (b.runAtMs ?? b.ts ?? 0) - (a.runAtMs ?? a.ts ?? 0))
    .slice(0, 6);
  const runRows = runs.length
    ? runs
        .map((r) => {
          const ok = r.status === 'ok';
          const out = ok
            ? String(r.output ?? 'Done').split('\n')[0]
            : String(r.error ?? r.status ?? '');
          return `<div class="cj-r"><span class="cj-dot" style="background:${ok ? 'var(--ok)' : 'var(--danger)'}"></span><span class="cj-r-t">${esc(
            inWords(r.runAtMs ?? r.ts, nowMs)
          )}</span><span class="cj-r-o" title="${esc(out)}">${esc(out || 'Done')}</span></div>`;
        })
        .join('')
    : '<div class="cj-faint">Has not run yet.</div>';
  const doesLabel =
    p.kind === 'skillJob' ? 'Runs' : p.kind === 'message' ? 'Sends' : 'Tells the agent';
  const why = job.why ? whyPanel(job.why, { nowMs, botId: jobAgentId(job) ?? '' }) : '';
  return `<div class="cj-d-head"><div class="cj-d-who"><div class="cj-av sm" style="background:${agentColor(key)}">${esc(
    name.charAt(0).toUpperCase()
  )}</div>${esc(name)} · <span class="cj-kind-pill ${k.cls}">${k.icon} ${k.label}</span><span class="cj-sp"></span>${status}<button type="button" class="cj-x" data-close aria-label="Close">×</button></div>
    <h2 class="cj-d-title">${esc(title)}${sub ? ` <span class="cj-faint">· ${esc(sub)}</span>` : ''}</h2></div>
    <div class="cj-d-body">
      <div class="cj-facts"><div class="cj-fact"><div class="cj-lbl">When</div><div class="cj-v">${esc(w.text)}</div><div class="cj-s">${esc(
        w.tz || '—'
      )}</div></div>
        <div class="cj-fact"><div class="cj-lbl">Next run</div><div class="cj-v">${esc(nextV)}</div><div class="cj-s">${esc(nextS)}</div></div></div>
      ${
        fail
          ? `<div class="cj-attn cj-attn-in"><div class="cj-attn-t cj-red">Last run failed ${esc(
              inWords(st.lastRunAtMs, nowMs)
            )}</div><div class="cj-attn-why">${esc(fail.text)}</div>${fail.fixed ? `<div class="cj-fixed">✓ ${esc(fail.fixed)}</div>` : ''}</div>`
          : ''
      }
      <div><div class="cj-lbl">${doesLabel}</div><div class="cj-instr">${esc(does)}</div></div>
      ${why ? `<div><div class="cj-lbl">Why this exists</div><div class="cj-why">${why}</div></div>` : ''}
      <div><div class="cj-lbl">Recent runs</div><div class="cj-runs">${runRows}</div></div>
    </div>
    <div class="cj-d-foot"><button type="button" class="cj-btn primary" data-run="${esc(job.id)}">Run now</button><button type="button" class="cj-btn" data-edit="${esc(
      job.id
    )}">Edit</button><a class="cj-btn ghost" href="#/automations/cron/${encodeURIComponent(job.id)}">Open page</a><span class="cj-sp"></span><button type="button" class="cj-btn ghost danger" data-del="${esc(
      job.id
    )}">Delete</button></div>`;
}
