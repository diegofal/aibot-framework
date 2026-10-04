import {
  HISTORY_PAGE,
  cleanedByBot,
  cleanupHeadline,
  historyHasMore,
  nextHistoryLimit,
  openFindings,
} from './hygiene-helpers.js';
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

/** One-shot cleanup: `all`, applied, every opt-in fix on. */
export function runCleanup() {
  return api('/api/hygiene/cleanup', { method: 'POST' });
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

  // For an apply run this is the post-apply preview (what is *still* open),
  // never the pre-apply findings, which made an apply look like it did nothing.
  const findings = openFindings(run);
  const counts = countBySeverity(findings);
  const fixable = findings.filter((f) => f.fixable);
  const groups = groupFindings(findings);
  const applyRun = !run.dryRun;
  const duration =
    run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
  const modeBadge = run.dryRun
    ? '<span class="badge badge-disabled">preview</span>'
    : `<span class="badge badge-ok">${run.cleanup ? 'cleanup' : 'applied'}</span>`;

  const sevBadges = ['critical', 'warn', 'info']
    .filter((s) => counts[s] > 0)
    .map((s) => severityBadge(s, counts[s]))
    .join(' ');

  const groupsHtml =
    groups.length === 0
      ? `<p class="text-dim text-sm">${applyRun ? 'Nothing left open.' : 'No findings. Clean.'}</p>`
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
  const cleaned = cleanedByBot(run);
  const appliedHtml = applyRun
    ? `<div class="hyg-sub"><div class="stats-section-title">Cleaned up <span class="count">${applied.length}</span></div>
      ${
        cleaned.length === 0
          ? '<p class="text-dim text-sm">Nothing needed fixing.</p>'
          : cleaned
              .map(
                (g) => `<div class="hyg-kind">
          <div class="hyg-kind-title">${escapeHtml(g.botId)} <span class="count">${g.items.length}</span></div>
          ${g.items
            .map(
              (i) =>
                `<div class="hyg-applied"><span class="hyg-fix-action">${escapeHtml(i.action || '')}</span>${
                  i.file ? ` <span class="hyg-finding-loc">${escapeHtml(i.file)}</span>` : ''
                } <span class="text-dim">${escapeHtml(String(i.result ?? ''))}</span></div>`
            )
            .join('')}
        </div>`
              )
              .join('')
      }</div>`
    : '';
  // Collapsed: on a fleet run this is every report-only finding, and it used
  // to push the actual result off screen.
  const skippedHtml = skipped.length
    ? `<details class="hyg-sub"><summary class="stats-section-title">Not changed <span class="count">${skipped.length}</span></summary>
      ${skipped
        .map(
          (s) =>
            `<div class="hyg-applied"><span class="hyg-finding-loc">${escapeHtml(s.findingId || '')}</span> <span class="text-dim">${escapeHtml(s.reason || '')}</span></div>`
        )
        .join('')}</details>`
    : '';
  const backupsHtml = backups.length
    ? `<details class="hyg-sub"><summary class="stats-section-title">Backups <span class="count">${backups.length}</span></summary>
      ${backups.map((b) => `<div class="hyg-finding-loc">${escapeHtml(typeof b === 'string' ? b : JSON.stringify(b))}</div>`).join('')}</details>`
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
    ${applyRun ? `<div class="hyg-headline">${escapeHtml(cleanupHeadline(run))}</div>` : ''}
    ${run.error ? `<div class="hyg-error text-sm">${escapeHtml(run.error)}</div>` : ''}
    ${appliedHtml}
    ${applyRun && groups.length ? '<div class="stats-section-title">Still open (needs you)</div>' : ''}
    <div class="hyg-groups">${groupsHtml}</div>
    ${skippedHtml}${backupsHtml}
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
  const open = openFindings(run);
  const counts = countBySeverity(open);
  const worst = open.reduce(
    (acc, f) => (severityRank(f.severity) < severityRank(acc) ? f.severity : acc),
    'none'
  );
  return `<tr class="hyg-history-row" data-run-id="${escapeHtml(run.runId || '')}">
    <td class="text-dim">${relativeTime(run.startedAt)}</td>
    <td>${escapeHtml(run.routine || '')}</td>
    <td>${run.botId ? escapeHtml(run.botId) : '<span class="text-dim">fleet</span>'}</td>
    <td>${run.dryRun ? '<span class="badge badge-disabled">preview</span>' : `<span class="badge badge-ok">${run.cleanup ? 'cleanup' : 'applied'}</span>`}</td>
    <td class="num ${counts.critical ? 'stats-bad' : 'text-dim'}">${counts.critical}</td>
    <td class="num ${counts.warn ? 'stats-warn' : 'text-dim'}">${counts.warn}</td>
    <td class="num text-dim">${counts.info}</td>
    <td class="num">${formatNumber((run.applied || []).length)}</td>
    <td>${run.error ? `<span class="badge badge-error" title="${escapeHtml(run.error)}">error</span>` : worst === 'none' ? '<span class="badge badge-ok">clean</span>' : ''}</td>
  </tr>`;
}

/**
 * `onLoadMore` + `limit` add a "Load more" button under the table when the
 * last fetch came back full (the API only pages by `limit`).
 */
export function renderHistoryTable(container, runs, { onSelect, onLoadMore, limit } = {}) {
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
  </table>${
    onLoadMore && limit && historyHasMore(list.length, limit)
      ? '<div class="hyg-load-more"><button class="btn btn-sm" data-hyg-load-more>Load more</button></div>'
      : ''
  }`;
  container.querySelector('[data-hyg-load-more]')?.addEventListener('click', (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Loading…';
    onLoadMore();
  });
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
    </div>
    <div class="detail-card hyg-cleanup-card">
      <div class="hyg-routine-head">
        <div>
          <div class="hyg-routine-name">Clean up everything</div>
          <div class="text-dim text-sm">Runs every routine for every agent and applies every safe fix: prunes changelog entries for missing files, archives stale unreviewed productions, redacts PII, moves orphaned data to the trash. Rewritten files are backed up; nothing is deleted. Shows what it cleaned and what still needs you.</div>
        </div>
        <div class="hyg-actions"><span class="hyg-cleanup-slot"></span></div>
      </div>
      <div id="hyg-cleanup-result"></div>
    </div>
    <div class="hyg-routines">${routineCards}</div>
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

  let historyLimit = HISTORY_PAGE;
  const refreshHistory = async () => {
    const runs = await loadHistory({ limit: historyLimit });
    renderHistoryTable(el.querySelector('#hyg-history'), runs, {
      limit: historyLimit,
      onLoadMore: () => {
        historyLimit = nextHistoryLimit(historyLimit);
        refreshHistory();
      },
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
        // Everything's Apply is the cleanup: a fleet apply without the opt-in
        // fixes skipped every orphan and looked like it had done nothing.
        const run =
          routine === 'all'
            ? await runCleanup()
            : await runHygiene({ routine, botId, apply: true, options: optionsFor(routine) });
        renderHygieneRun(target, run);
        rewireApply(slot);
        refreshHistory();
      },
    });
  }

  // One button for the whole fleet. Replaces the old "Run all (preview)",
  // which fired one preview per routine per agent; Everything → Preview covers that.
  const cleanupSlot = el.querySelector('.hyg-cleanup-slot');
  const wireCleanup = () =>
    wireTwoStep(cleanupSlot, {
      label: 'Clean up everything',
      confirmLabel: 'Confirm cleanup',
      onConfirm: async () => {
        const out = el.querySelector('#hyg-cleanup-result');
        cleanupSlot.innerHTML = '<span class="text-dim text-sm">Cleaning up...</span>';
        out.innerHTML = '<p class="text-dim text-sm">Cleaning up every agent...</p>';
        const run = await runCleanup();
        renderHygieneRun(out, run, { title: 'Clean up everything' });
        wireCleanup();
        refreshHistory();
      },
    });
  wireCleanup();

  refreshHistory();
}
