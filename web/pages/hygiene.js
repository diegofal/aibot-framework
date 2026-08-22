import { api, escapeHtml } from './shared.js';
import {
  formatDuration,
  formatNumber,
  groupFindings,
  optionsFromChecked,
  relativeTime,
  routineOptions,
  severityRank,
} from './stats-helpers.js';

// Fallback when /api/hygiene/routines is unavailable — keeps the bot page usable.
export const FALLBACK_ROUTINES = [
  { id: 'goal-lint', name: 'Goal lint', scope: 'bot', canApply: true, description: '' },
  { id: 'memory-hygiene', name: 'Memory hygiene', scope: 'bot', canApply: true, description: '' },
  { id: 'soul-structure', name: 'Soul structure', scope: 'bot', canApply: true, description: '' },
  {
    id: 'productions-triage',
    name: 'Productions triage',
    scope: 'bot',
    canApply: true,
    description: '',
  },
];

const SEVERITY_CLASS = {
  critical: 'badge-error',
  warn: 'stats-badge-amber',
  info: 'badge-disabled',
};

export function severityBadge(severity, count) {
  const cls = SEVERITY_CLASS[severity] || 'badge-disabled';
  const label = count != null ? `${count} ${severity}` : severity;
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

export async function loadRoutines() {
  const res = await api('/api/hygiene/routines');
  if (Array.isArray(res) && res.length > 0) return { routines: res, fallback: false };
  return { routines: FALLBACK_ROUTINES, fallback: true, error: res?.error };
}

export async function loadAgents() {
  const res = await api('/api/agents');
  return Array.isArray(res) ? res : [];
}

export function runHygiene({ routine, botId, apply = false, options }) {
  const body = { routine, apply };
  if (botId) body.botId = botId;
  if (options) body.options = options;
  return api('/api/hygiene/run', { method: 'POST', body });
}

export function countBySeverity(findings) {
  const counts = { critical: 0, warn: 0, info: 0 };
  for (const f of findings || []) {
    if (counts[f.severity] == null) counts[f.severity] = 0;
    counts[f.severity]++;
  }
  return counts;
}

function findingRow(f) {
  const loc = f.file ? `${f.file}${f.line != null ? `:${f.line}` : ''}` : '';
  const fix = f.fix
    ? `<div class="hyg-fix"><span class="hyg-fix-action">${escapeHtml(f.fix.action || 'fix')}</span>${
        f.fix.details ? ` <span class="text-dim">${escapeHtml(String(f.fix.details))}</span>` : ''
      }</div>`
    : '';
  return `<div class="hyg-finding" data-finding-id="${escapeHtml(f.id || '')}">
    <span class="hyg-dot ${escapeHtml(f.severity || 'info')}" title="${escapeHtml(f.severity || '')}"></span>
    <div class="hyg-finding-body">
      ${loc ? `<span class="hyg-finding-loc">${escapeHtml(loc)}</span>` : ''}
      <span class="hyg-finding-msg">${escapeHtml(f.message || '')}</span>
      ${f.fixable ? '<span class="badge badge-ok hyg-fixable">fixable</span>' : ''}
      ${fix}
    </div>
  </div>`;
}

/**
 * Render a HygieneRun into a container. If `onApply` is given and the run is a
 * preview with fixable findings, an inline two-step "Apply N fixes" → "Confirm apply"
 * control is shown (no confirm()/alert()).
 */
export function renderHygieneRun(container, run, { onApply, title } = {}) {
  if (!container) return;
  if (!run || (run.error && !Array.isArray(run.findings))) {
    container.innerHTML = `<div class="hyg-result">
      <div class="hyg-summary"><span class="badge badge-error">Error</span> <span>${escapeHtml(
        run?.error || 'Hygiene run failed'
      )}</span></div>
    </div>`;
    return;
  }

  const findings = run.findings || [];
  const counts = countBySeverity(findings);
  const fixable = findings.filter((f) => f.fixable);
  const groups = groupFindings(findings);
  const duration =
    run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
  const modeBadge = run.dryRun
    ? '<span class="badge badge-disabled">preview</span>'
    : '<span class="badge badge-ok">applied</span>';

  const sevBadges = ['critical', 'warn', 'info']
    .filter((s) => counts[s] > 0)
    .map((s) => severityBadge(s, counts[s]))
    .join(' ');

  const groupsHtml =
    groups.length === 0
      ? '<p class="text-dim text-sm">No findings. Clean.</p>'
      : groups
          .map(
            (g) => `<div class="hyg-sev-group">
            <div class="hyg-sev-title ${escapeHtml(g.severity)}">${escapeHtml(g.severity)} <span class="count">${g.count}</span></div>
            ${g.kinds
              .map(
                (k) => `<div class="hyg-kind">
                <div class="hyg-kind-title">${escapeHtml(k.kind || 'general')} <span class="count">${k.findings.length}</span></div>
                ${k.findings.map(findingRow).join('')}
              </div>`
              )
              .join('')}
          </div>`
          )
          .join('');

  const applied = run.applied || [];
  const skipped = run.skipped || [];
  const backups = run.backups || [];
  const appliedHtml = applied.length
    ? `<div class="hyg-sub"><div class="stats-section-title">Applied <span class="count">${applied.length}</span></div>
      ${applied
        .map(
          (a) =>
            `<div class="hyg-applied"><span class="hyg-finding-loc">${escapeHtml(a.findingId || '')}</span> <span>${escapeHtml(a.action || '')}</span> <span class="text-dim">${escapeHtml(String(a.result ?? ''))}</span></div>`
        )
        .join('')}</div>`
    : '';
  const skippedHtml = skipped.length
    ? `<div class="hyg-sub"><div class="stats-section-title">Skipped <span class="count">${skipped.length}</span></div>
      ${skipped
        .map(
          (s) =>
            `<div class="hyg-applied"><span class="hyg-finding-loc">${escapeHtml(s.findingId || '')}</span> <span class="text-dim">${escapeHtml(s.reason || '')}</span></div>`
        )
        .join('')}</div>`
    : '';
  const backupsHtml = backups.length
    ? `<div class="hyg-sub"><div class="stats-section-title">Backups <span class="count">${backups.length}</span></div>
      ${backups.map((b) => `<div class="hyg-finding-loc">${escapeHtml(typeof b === 'string' ? b : JSON.stringify(b))}</div>`).join('')}</div>`
    : '';

  const canApply = Boolean(onApply && run.dryRun && fixable.length > 0);

  container.innerHTML = `<div class="hyg-result">
    <div class="hyg-summary">
      <strong>${escapeHtml(title || run.routine || 'run')}</strong>
      ${run.botId ? `<span class="stats-chip">${escapeHtml(run.botId)}</span>` : '<span class="stats-chip">fleet</span>'}
      ${modeBadge}
      ${sevBadges || '<span class="badge badge-ok">clean</span>'}
      <span class="text-dim text-sm">${relativeTime(run.startedAt)}${duration != null ? ` · ${formatDuration(duration)}` : ''}</span>
      ${run.error ? `<span class="badge badge-error" title="${escapeHtml(run.error)}">error</span>` : ''}
      ${canApply ? `<span class="hyg-apply-slot"><button class="btn btn-sm btn-primary hyg-apply-btn">Apply ${fixable.length} fix${fixable.length === 1 ? '' : 'es'}</button></span>` : ''}
    </div>
    ${run.error ? `<div class="hyg-error text-sm">${escapeHtml(run.error)}</div>` : ''}
    <div class="hyg-groups">${groupsHtml}</div>
    ${appliedHtml}${skippedHtml}${backupsHtml}
  </div>`;

  if (canApply) {
    const slot = container.querySelector('.hyg-apply-slot');
    wireTwoStep(slot, {
      label: `Apply ${fixable.length} fix${fixable.length === 1 ? '' : 'es'}`,
      onConfirm: async () => {
        slot.innerHTML = '<span class="text-dim text-sm">Applying...</span>';
        await onApply();
      },
    });
  }
}

/**
 * Inline two-step confirmation: [label] → [Confirm label] [Cancel].
 * The slot's content is replaced; `onConfirm` runs on the second click.
 */
export function wireTwoStep(slot, { label, confirmLabel = 'Confirm apply', onConfirm, danger }) {
  if (!slot) return;
  const render = (armed) => {
    slot.innerHTML = armed
      ? `<button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'} hyg-confirm-btn">${escapeHtml(confirmLabel)}</button>
         <button class="btn btn-sm hyg-cancel-btn">Cancel</button>`
      : `<button class="btn btn-sm btn-primary hyg-apply-btn">${escapeHtml(label)}</button>`;
    if (armed) {
      slot.querySelector('.hyg-confirm-btn').addEventListener('click', () => onConfirm());
      slot.querySelector('.hyg-cancel-btn').addEventListener('click', () => render(false));
    } else {
      slot.querySelector('.hyg-apply-btn').addEventListener('click', () => render(true));
    }
  };
  render(false);
}

/**
 * Run a routine (preview) and render it into `target`, wiring the apply step.
 */
export async function runAndRender(target, { routine, botId, options, title }) {
  target.innerHTML = `<div class="hyg-result"><p class="text-dim text-sm">Running ${escapeHtml(routine)}...</p></div>`;
  const run = await runHygiene({ routine, botId, apply: false, options });
  renderHygieneRun(target, run, {
    title,
    onApply: async () => {
      const applied = await runHygiene({ routine, botId, apply: true, options });
      renderHygieneRun(target, applied, { title });
    },
  });
  return run;
}

function historyRow(run) {
  const counts = countBySeverity(run.findings);
  const worst = (run.findings || []).reduce(
    (acc, f) => (severityRank(f.severity) < severityRank(acc) ? f.severity : acc),
    'none'
  );
  return `<tr class="hyg-history-row" data-run-id="${escapeHtml(run.runId || '')}">
    <td class="text-dim">${relativeTime(run.startedAt)}</td>
    <td>${escapeHtml(run.routine || '')}</td>
    <td>${run.botId ? escapeHtml(run.botId) : '<span class="text-dim">fleet</span>'}</td>
    <td>${run.dryRun ? '<span class="badge badge-disabled">preview</span>' : '<span class="badge badge-ok">applied</span>'}</td>
    <td class="num ${counts.critical ? 'stats-bad' : 'text-dim'}">${counts.critical}</td>
    <td class="num ${counts.warn ? 'stats-warn' : 'text-dim'}">${counts.warn}</td>
    <td class="num text-dim">${counts.info}</td>
    <td class="num">${formatNumber((run.applied || []).length)}</td>
    <td>${run.error ? `<span class="badge badge-error" title="${escapeHtml(run.error)}">error</span>` : worst === 'none' ? '<span class="badge badge-ok">clean</span>' : ''}</td>
  </tr>`;
}

export function renderHistoryTable(container, runs, { onSelect } = {}) {
  if (!container) return;
  const list = [...(Array.isArray(runs) ? runs : [])].sort(
    (a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0)
  );
  if (list.length === 0) {
    container.innerHTML = '<p class="text-dim text-sm">No hygiene runs yet.</p>';
    return;
  }
  container.innerHTML = `<table class="stats-table">
    <thead><tr><th>When</th><th>Routine</th><th>Bot</th><th>Mode</th><th class="num">Crit</th><th class="num">Warn</th><th class="num">Info</th><th class="num">Applied</th><th></th></tr></thead>
    <tbody>${list.map(historyRow).join('')}</tbody>
  </table>`;
  container.querySelectorAll('.hyg-history-row').forEach((tr) => {
    tr.addEventListener('click', () => {
      const run = list.find((r) => r.runId === tr.dataset.runId);
      if (run && onSelect) onSelect(run);
      container.querySelectorAll('.hyg-history-row').forEach((r) => r.classList.remove('selected'));
      tr.classList.add('selected');
    });
  });
}

export async function loadHistory({ botId, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (botId) params.set('botId', botId);
  params.set('limit', String(limit));
  const res = await api(`/api/hygiene/history?${params}`);
  return Array.isArray(res) ? res : [];
}

/**
 * Hygiene tab body. `el` is the body container inside the stats page shell.
 */
export async function renderHygienePanel(el) {
  el.innerHTML = '<p class="text-dim">Loading routines...</p>';
  const [{ routines, fallback, error }, agents] = await Promise.all([loadRoutines(), loadAgents()]);

  const botOptions = agents
    .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || a.id)}</option>`)
    .join('');

  const routineCards = routines
    .map(
      (r) => `<div class="hyg-routine" data-routine="${escapeHtml(r.id)}">
      <div class="hyg-routine-head">
        <div>
          <div class="hyg-routine-name">${escapeHtml(r.name || r.id)} <span class="badge ${r.scope === 'fleet' ? 'badge-mcp' : 'badge-disabled'}">${escapeHtml(r.scope || 'bot')}</span>${
            r.canApply
              ? ''
              : ' <span class="badge badge-disabled" title="Preview only">read-only</span>'
          }</div>
          ${r.description ? `<div class="text-dim text-sm">${escapeHtml(r.description)}</div>` : ''}
          ${
            routineOptions(r.id).length
              ? `<div class="hyg-options">${routineOptions(r.id)
                  .map(
                    (o) =>
                      `<label class="hyg-option"><input type="checkbox" data-option="${escapeHtml(o.key)}"> ${escapeHtml(o.label)}</label>`
                  )
                  .join('')}</div>`
              : ''
          }
        </div>
        <div class="hyg-actions">
          <button class="btn btn-sm hyg-preview-btn" data-routine="${escapeHtml(r.id)}" data-scope="${escapeHtml(r.scope || 'bot')}">Preview</button>
          ${r.canApply ? `<span class="hyg-apply-slot" data-routine="${escapeHtml(r.id)}" data-scope="${escapeHtml(r.scope || 'bot')}"></span>` : ''}
        </div>
      </div>
      <div class="hyg-routine-result" data-routine="${escapeHtml(r.id)}"></div>
    </div>`
    )
    .join('');

  el.innerHTML = `
    ${fallback ? `<div class="soul-banner soul-banner-warn"><span class="soul-banner-icon">!</span><span class="soul-banner-text">Routine list unavailable${error ? ` (${escapeHtml(error)})` : ''} — showing defaults.</span></div>` : ''}
    <div class="stats-toolbar">
      <label class="text-dim text-sm" for="hyg-bot">Bot for bot-scoped routines</label>
      <select id="hyg-bot" class="stats-select">${botOptions || '<option value="">(no agents)</option>'}</select>
      <span class="hyg-run-all-slot"><button class="btn btn-sm" id="hyg-run-all">Run all (preview)</button></span>
    </div>
    <div class="hyg-routines">${routineCards}</div>
    <div id="hyg-run-all-results"></div>
    <div class="detail-card">
      <div class="stats-section-title">History</div>
      <div id="hyg-history"></div>
    </div>
    <div class="detail-card" id="hyg-history-detail-card" style="display:none">
      <div class="stats-section-title">Selected run</div>
      <div id="hyg-history-detail"></div>
    </div>`;

  const botSel = el.querySelector('#hyg-bot');
  const currentBot = () => botSel?.value || '';

  const refreshHistory = async () => {
    const runs = await loadHistory({ limit: 50 });
    renderHistoryTable(el.querySelector('#hyg-history'), runs, {
      onSelect: (run) => {
        const card = el.querySelector('#hyg-history-detail-card');
        card.style.display = '';
        renderHygieneRun(el.querySelector('#hyg-history-detail'), run);
        card.scrollIntoView({ block: 'nearest' });
      },
    });
  };

  const targetFor = (routine) =>
    el.querySelector(`.hyg-routine-result[data-routine="${CSS.escape(routine)}"]`);

  /** Options the operator ticked on this routine's card, if any. */
  const optionsFor = (routine) => {
    const card = el.querySelector(`.hyg-routine[data-routine="${CSS.escape(routine)}"]`);
    if (!card) return undefined;
    const checked = [...card.querySelectorAll('input[data-option]:checked')].map(
      (i) => i.dataset.option
    );
    return optionsFromChecked(routine, checked);
  };

  el.querySelectorAll('.hyg-preview-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const routine = btn.dataset.routine;
      const botId = btn.dataset.scope === 'bot' ? currentBot() : undefined;
      btn.disabled = true;
      await runAndRender(targetFor(routine), { routine, botId, options: optionsFor(routine) });
      btn.disabled = false;
      refreshHistory();
    });
  });

  el.querySelectorAll('.hyg-apply-slot[data-routine]').forEach((slot) => rewireApply(slot));

  function rewireApply(slot) {
    const routine = slot.dataset.routine;
    wireTwoStep(slot, {
      label: 'Apply',
      onConfirm: async () => {
        const botId = slot.dataset.scope === 'bot' ? currentBot() : undefined;
        const target = targetFor(routine);
        target.innerHTML =
          '<div class="hyg-result"><p class="text-dim text-sm">Applying...</p></div>';
        slot.innerHTML = '<span class="text-dim text-sm">Applying...</span>';
        const run = await runHygiene({ routine, botId, apply: true, options: optionsFor(routine) });
        renderHygieneRun(target, run);
        rewireApply(slot);
        refreshHistory();
      },
    });
  }

  el.querySelector('#hyg-run-all')?.addEventListener('click', async () => {
    const btn = el.querySelector('#hyg-run-all');
    const out = el.querySelector('#hyg-run-all-results');
    btn.disabled = true;
    btn.textContent = 'Running...';
    out.innerHTML = '';
    const jobs = [];
    for (const r of routines) {
      if (r.scope === 'fleet') jobs.push({ routine: r.id, title: r.name || r.id });
      else
        for (const a of agents)
          jobs.push({ routine: r.id, botId: a.id, title: `${r.name || r.id} · ${a.name || a.id}` });
    }
    if (jobs.length === 0) {
      out.innerHTML = '<p class="text-dim text-sm">Nothing to run.</p>';
    }
    for (const job of jobs) {
      const slot = document.createElement('div');
      out.appendChild(slot);
      await runAndRender(slot, job);
    }
    btn.disabled = false;
    btn.textContent = 'Run all (preview)';
    refreshHistory();
  });

  refreshHistory();
}
