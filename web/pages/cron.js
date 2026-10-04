import {
  confirmDialog,
  confirmInline,
  emptyState,
  initMenus,
  showToast,
  undoable,
} from '../ui/index.js';
import { mountAutomationBox } from './automations.js';
import {
  apiList,
  bulkTargets,
  cronBulkBar,
  cronErrorState,
  cronTable,
  cronToolbar,
  filterJobs,
  rerunSummary,
} from './cron-list-helpers.js';
import { api, closeModal, escapeHtml, showModal, timeAgo } from './shared.js';

// Agent filter + search + sort of the jobs table (session S3.5 / UX overhaul);
// survives re-renders. The selection is per visit.
const cronFilter = { botId: '', query: '', sortBy: 'agent' };
let closeCronMenus = null;

export async function renderCron(el) {
  el.innerHTML = '<div class="page-title">Cron Jobs</div><p class="text-dim">Loading...</p>';

  const [jobsRes, skillsRes, agentsRes] = await Promise.all([
    api('/api/cron'),
    api('/api/skills'),
    api('/api/agents'),
  ]);
  const agents = Array.isArray(agentsRes) ? agentsRes : [];
  const skills = Array.isArray(skillsRes) ? skillsRes : [];
  const { list: jobs, error } = apiList(jobsRes);

  if (error) {
    el.innerHTML = `<div class="page-title">Cron Jobs</div>${cronErrorState(error)}`;
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () => renderCron(el));
    return;
  }

  const names = Object.fromEntries(agents.map((a) => [a.id, a.name || a.id]));
  const selected = new Set();

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Cron Jobs <span class="count" id="cron-count">${jobs.length}</span></div>
      <div class="ops-head-actions">
        <span id="cron-rerun-slot"></span>
        <a href="#/automations/cron/new" class="btn btn-primary" data-page-new>+ New Job</a>
      </div>
    </div>
    <div id="automation-box"></div>
    ${jobs.length > 0 ? cronToolbar({ agents, jobs, ...cronFilter }) : ''}
    <div id="cron-bulk-slot"></div>
    <div id="cron-table-wrap"></div>
  `;

  // "Tell an agent what to do and when" (S8): parse -> preview -> the same POST /api/cron.
  mountAutomationBox(document.getElementById('automation-box'), {
    agents,
    onCreated: () => renderCron(el),
  });

  const wrap = document.getElementById('cron-table-wrap');
  const bulkSlot = document.getElementById('cron-bulk-slot');
  const rerunSlot = document.getElementById('cron-rerun-slot');
  const visibleJobs = () => filterJobs(jobs, { ...cronFilter, names });
  const tableOpts = (filtered) => ({
    names,
    nowMs: Date.now(),
    filtered,
    sortBy: cronFilter.sortBy,
    selectable: true,
    selected,
  });

  const drawRerun = () => {
    const failed = jobs.filter((j) => j.enabled !== false && j.state?.lastStatus === 'error');
    rerunSlot.innerHTML =
      failed.length > 0
        ? `<button class="btn btn-sm" id="cron-rerun-failed-btn">Re-run failed (${failed.length})</button>`
        : '';
  };
  const drawBulk = () => {
    // The selection only counts jobs that still exist and are visible.
    const visibleIds = new Set(visibleJobs().map((j) => String(j.id)));
    for (const id of [...selected]) if (!visibleIds.has(id)) selected.delete(id);
    bulkSlot.innerHTML = cronBulkBar(selected.size);
    const all = document.getElementById('cron-select-all');
    if (all) {
      all.checked = visibleIds.size > 0 && selected.size === visibleIds.size;
      all.indeterminate = selected.size > 0 && selected.size < visibleIds.size;
    }
  };
  const drawTable = () => {
    const visible = visibleJobs();
    wrap.innerHTML = cronTable(visible, tableOpts(visible.length !== jobs.length));
    document.getElementById('cron-count').textContent = String(jobs.length);
    drawBulk();
  };
  /** Re-render one row in place (keeps scroll position and the rest of the table). */
  const patchRow = (job) => {
    const row = wrap.querySelector(`tr[data-id="${CSS.escape(String(job.id))}"]`);
    if (!row) return drawTable();
    const tmp = document.createElement('div');
    tmp.innerHTML = cronTable([job], tableOpts(false));
    const fresh = tmp.querySelector('tbody tr');
    if (fresh) row.replaceWith(fresh);
    drawRerun();
  };
  const reloadJob = async (id) => {
    const fresh = await api(`/api/cron/${encodeURIComponent(id)}`);
    if (!fresh || fresh.error) return null;
    const { runs: _runs, ...job } = fresh;
    const i = jobs.findIndex((j) => j.id === id);
    if (i >= 0) jobs[i] = job;
    return job;
  };
  const reloadAll = async () => {
    const fresh = apiList(await api('/api/cron'));
    if (!fresh.error) jobs.splice(0, jobs.length, ...fresh.list);
    drawRerun();
    drawTable();
  };

  drawRerun();
  drawTable();
  closeCronMenus?.();
  closeCronMenus = initMenus(el);

  document.getElementById('cron-filter-agent')?.addEventListener('change', (e) => {
    cronFilter.botId = e.target.value;
    drawTable();
  });
  document.getElementById('cron-filter-query')?.addEventListener('input', (e) => {
    cronFilter.query = e.target.value;
    drawTable();
  });
  document.getElementById('cron-sort')?.addEventListener('change', (e) => {
    cronFilter.sortBy = e.target.value;
    drawTable();
  });
  document.getElementById('cron-select-all')?.addEventListener('change', (e) => {
    selected.clear();
    if (e.target.checked) for (const j of visibleJobs()) selected.add(String(j.id));
    drawTable();
  });

  if (jobs.length === 0) return;

  wrap.addEventListener('change', async (e) => {
    const box = e.target.closest('input[data-select]');
    if (box) {
      if (box.checked) selected.add(box.dataset.select);
      else selected.delete(box.dataset.select);
      drawBulk();
      return;
    }
    const toggle = e.target.closest('input[data-action="toggle"]');
    if (!toggle) return;
    const id = toggle.dataset.id;
    toggle.disabled = true;
    const res = await api(`/api/cron/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { enabled: toggle.checked },
    });
    if (!res || res.error) {
      toggle.checked = !toggle.checked;
      toggle.disabled = false;
      showToast(`Could not update the job: ${res?.error || 'error'}`, { tone: 'danger' });
      return;
    }
    const i = jobs.findIndex((j) => j.id === id);
    if (i >= 0) jobs[i] = { ...jobs[i], ...res };
    patchRow(i >= 0 ? jobs[i] : res);
  });

  wrap.addEventListener('click', async (e) => {
    const runBtn = e.target.closest('button[data-action="run"]');
    if (runBtn) {
      const id = runBtn.dataset.id;
      runBtn.disabled = true;
      runBtn.textContent = 'Running…';
      const res = await api(`/api/cron/${encodeURIComponent(id)}/run`, { method: 'POST' });
      if (res?.ok) showToast('Job ran', { tone: 'ok' });
      else showToast(`Run failed: ${res?.reason || res?.error || 'error'}`, { tone: 'danger' });
      const job = await reloadJob(id);
      if (job) patchRow(job);
      else {
        runBtn.disabled = false;
        runBtn.textContent = 'Run';
      }
      return;
    }

    const editBtn = e.target.closest('button[data-action="edit"]');
    if (editBtn) {
      const job = jobs.find((j) => j.id === editBtn.dataset.id);
      if (job)
        showCronEditModal(job, el, null, skills, async () => {
          const fresh = await reloadJob(job.id);
          if (fresh) patchRow(fresh);
        });
      return;
    }

    const logsBtn = e.target.closest('button[data-action="logs"]');
    if (logsBtn) {
      logsBtn.disabled = true;
      const job = await api(`/api/cron/${encodeURIComponent(logsBtn.dataset.id)}`);
      logsBtn.disabled = false;
      if (job?.error) showToast(job.error, { tone: 'danger' });
      else showRunLogsModal(job);
      return;
    }

    const delBtn = e.target.closest('button[data-action="delete"]');
    if (!delBtn) return;
    const id = delBtn.dataset.id;
    const job = jobs.find((j) => j.id === id);
    const row = wrap.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    if (row) row.hidden = true;
    selected.delete(id);
    drawBulk();
    const { undone, result } = await undoable(`Deleted "${job?.name ?? id}"`, {
      commit: () => api(`/api/cron/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      undo: () => {
        if (row) row.hidden = false;
      },
    }).catch((err) => ({ undone: false, result: { error: err?.message || 'error' } }));
    if (undone) return;
    if (result?.error) {
      if (row) row.hidden = false;
      showToast(`Delete failed: ${result.error}`, { tone: 'danger' });
      return;
    }
    const i = jobs.findIndex((j) => j.id === id);
    if (i >= 0) jobs.splice(i, 1);
    row?.remove();
    const countEl = document.getElementById('cron-count');
    if (countEl) countEl.textContent = String(jobs.length);
    if (rerunSlot.isConnected) drawRerun();
  });

  bulkSlot.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-bulk]');
    if (!btn) return;
    const action = btn.dataset.bulk;
    if (action === 'clear') {
      selected.clear();
      drawTable();
      return;
    }
    const targets = bulkTargets(jobs, selected, action);
    if (targets.length === 0) {
      showToast(`Nothing to ${action} in the selection`, { tone: 'muted' });
      return;
    }
    if (action === 'delete') {
      const ok = await confirmDialog({
        title: `Delete ${targets.length} cron job${targets.length === 1 ? '' : 's'}?`,
        message: 'Their run logs go with them. This cannot be undone.',
        confirmLabel: 'Delete',
      });
      if (!ok) return;
    }
    for (const b of bulkSlot.querySelectorAll('button')) b.disabled = true;
    const call = (j) => {
      const id = encodeURIComponent(j.id);
      if (action === 'delete') return api(`/api/cron/${id}`, { method: 'DELETE' });
      if (action === 'run') return api(`/api/cron/${id}/run`, { method: 'POST' });
      return api(`/api/cron/${id}`, { method: 'PATCH', body: { enabled: action === 'resume' } });
    };
    const results = await Promise.all(
      targets.map((j) => call(j).catch((err) => ({ error: err?.message || 'error' })))
    );
    const failed = results.filter((r) => !r || r.error || r.ok === false).length;
    const done = targets.length - failed;
    const verb = { pause: 'Paused', resume: 'Resumed', run: 'Ran', delete: 'Deleted' }[action];
    showToast(
      failed
        ? `${verb} ${done} of ${targets.length} — ${failed} failed`
        : `${verb} ${done} job${done === 1 ? '' : 's'}`,
      { tone: failed ? 'danger' : 'ok' }
    );
    if (action === 'delete') selected.clear();
    // Refresh the data without a full page render (keeps scroll, filter and selection).
    await reloadAll();
  });

  rerunSlot.addEventListener('click', async (e) => {
    const rerunFailedBtn = e.target.closest('#cron-rerun-failed-btn');
    if (!rerunFailedBtn) return;
    rerunFailedBtn.disabled = true;
    rerunFailedBtn.textContent = 'Re-running…';
    const res = await api('/api/cron/rerun-failed', { method: 'POST' });
    const { text, tone } = rerunSummary(res);
    showToast(text, { tone });
    await reloadAll();
  });
}

export async function renderCronDetail(el, id) {
  el.innerHTML = '<div class="page-title">Cron job</div><p class="text-dim">Loading...</p>';
  const [job, skills] = await Promise.all([
    api(`/api/cron/${encodeURIComponent(id)}`),
    api('/api/skills'),
  ]);
  if (!job || job.error) {
    const notFound = /not found/i.test(job?.error ?? '');
    el.innerHTML = `
      <div class="detail-header">
        <a href="#/automations/cron" class="back">&larr;</a>
        <div class="page-title">Cron job</div>
      </div>
      ${
        notFound
          ? emptyState({
              icon: '◷',
              title: 'Cron job not found',
              hint: 'It may have been deleted. Back to the list to see the jobs that exist.',
              action: '<a href="#/automations/cron" class="btn btn-sm">All cron jobs</a>',
            })
          : cronErrorState(job?.error ?? 'Unexpected response', 'Could not load this cron job')
      }`;
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () =>
      renderCronDetail(el, id)
    );
    return;
  }

  const scheduleText = formatSchedule(job.schedule);
  let payloadHtml;
  if (job.payload.kind === 'message' || job.payload.kind === 'instruction') {
    payloadHtml = `<tr><td class="text-dim">Bot ID</td><td>${escapeHtml(job.payload.botId)}</td></tr>
       <tr><td class="text-dim">Chat ID</td><td>${job.payload.chatId}</td></tr>
       <tr><td class="text-dim">${job.payload.kind === 'instruction' ? 'Instruction' : 'Text'}</td><td><pre style="white-space:pre-wrap;margin:0;font-family:inherit">${escapeHtml(job.payload.text)}</pre></td></tr>`;
  } else {
    const skillDefault = resolveSkillDefault(skills, job.payload.skillId);
    const backendDisplay = job.payload.llmBackend
      ? `${job.payload.llmBackend} (override)`
      : `${skillDefault} (skill default)`;
    payloadHtml = `<tr><td class="text-dim">Skill ID</td><td>${escapeHtml(job.payload.skillId)}</td></tr>
       <tr><td class="text-dim">Job ID</td><td>${escapeHtml(job.payload.jobId)}</td></tr>
       <tr><td class="text-dim">LLM Backend</td><td>${escapeHtml(backendDisplay)}</td></tr>`;
  }

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/automations/cron" class="back">&larr;</a>
      <div class="page-title">${escapeHtml(job.name)}</div>
    </div>
    <div class="detail-card">
      <table>
        <tr><td class="text-dim" style="width:140px">ID</td><td class="text-sm">${escapeHtml(job.id)}</td></tr>
        <tr><td class="text-dim">Schedule</td><td>${escapeHtml(scheduleText)}</td></tr>
        <tr><td class="text-dim">Type</td><td>${job.payload.kind}</td></tr>
        ${payloadHtml}
        <tr><td class="text-dim">Enabled</td><td>${job.enabled ? 'Yes' : 'No'}</td></tr>
        <tr><td class="text-dim">Next Run</td><td>${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toLocaleString() : '--'}</td></tr>
        <tr><td class="text-dim">Last Status</td><td>${
          job.state.lastStatus
            ? `<span class="badge badge-${job.state.lastStatus}">${job.state.lastStatus}</span>`
            : '--'
        }</td></tr>
        ${job.state.lastError ? `<tr><td class="text-dim">Last Error</td><td class="text-sm" style="color:var(--red)">${escapeHtml(job.state.lastError)}</td></tr>` : ''}
        <tr><td class="text-dim">Consecutive Errors</td><td>${job.state.consecutiveErrors}</td></tr>
        <tr><td class="text-dim">Created</td><td class="text-dim">${new Date(job.createdAtMs).toLocaleString()}</td></tr>
      </table>
    </div>

    <div class="actions mb-16">
      <button class="btn btn-primary" id="btn-run">Run Now</button>
      <button class="btn" id="btn-edit">Edit</button>
      <button class="btn ${job.enabled ? 'btn-danger' : 'btn-primary'}" id="btn-toggle">${job.enabled ? 'Disable' : 'Enable'}</button>
      <button class="btn btn-danger" id="btn-delete">Delete</button>
    </div>

    ${
      job.runs?.length
        ? `
      <div class="flex-between mb-16">
        <h3>Recent Runs</h3>
        <button class="btn btn-sm btn-danger" id="btn-clear-logs">Clear Logs</button>
      </div>
      <table id="cron-detail-runs">
        <thead><tr><th>Time</th><th>Status</th><th>Duration</th><th>Output</th><th>Error</th><th></th></tr></thead>
        <tbody>
          ${job.runs
            .map(
              (r) => `
            <tr>
              <td class="text-sm">${r.runAtMs ? new Date(r.runAtMs).toLocaleString() : '--'}</td>
              <td><span class="badge badge-${r.status || 'disabled'}">${r.status || '--'}</span></td>
              <td class="text-dim">${r.durationMs != null ? `${r.durationMs}ms` : '--'}</td>
              <td class="text-sm">${r.output ? formatOutput(r.output) : ''}</td>
              <td class="text-sm" style="color:var(--red)">${r.error ? escapeHtml(r.error) : ''}</td>
              <td><button class="btn btn-sm btn-icon" data-action="delete-run" data-ts="${r.ts}" title="Delete">&times;</button></td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    `
        : ''
    }
  `;

  document.getElementById('btn-run').addEventListener('click', async () => {
    const btn = document.getElementById('btn-run');
    btn.disabled = true;
    btn.textContent = 'Running…';
    try {
      const res = await api(`/api/cron/${id}/run`, { method: 'POST' });
      btn.textContent = res.ok ? 'Done' : `Failed: ${res.reason || 'error'}`;
    } catch {
      btn.textContent = 'Error';
    }
    setTimeout(() => renderCronDetail(el, id), 1500);
  });

  document.getElementById('btn-toggle').addEventListener('click', async () => {
    const res = await api(`/api/cron/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { enabled: !job.enabled },
    });
    if (res?.error) showToast(`Could not update the job: ${res.error}`, { tone: 'danger' });
    renderCronDetail(el, id);
  });

  document.getElementById('btn-delete').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete this cron job?',
      message: `"${job.name}" and its run logs will be removed.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    const res = await api(`/api/cron/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res?.error) {
      showToast(`Delete failed: ${res.error}`, { tone: 'danger' });
      return;
    }
    showToast('Cron job deleted', { tone: 'ok' });
    location.hash = '#/automations/cron';
  });

  document.getElementById('btn-edit').addEventListener('click', () => {
    showCronEditModal(job, el, id, skills, () => renderCronDetail(el, id));
  });

  const clearLogsBtn = document.getElementById('btn-clear-logs');
  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', async () => {
      if (!confirmInline(clearLogsBtn, { label: 'Click again to clear' })) return;
      await api(`/api/cron/${encodeURIComponent(id)}/runs`, { method: 'DELETE' });
      renderCronDetail(el, id);
    });
  }

  // Bound to the runs table (not `el`, which outlives this page and would stack listeners).
  document.getElementById('cron-detail-runs')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action="delete-run"]');
    if (!btn) return;
    const ts = Number(btn.dataset.ts);
    if (!ts) return;
    await api(`/api/cron/${id}/runs/delete`, { method: 'POST', body: { timestamps: [ts] } });
    renderCronDetail(el, id);
  });
}

export async function renderCronCreate(el) {
  const [agents, skills] = await Promise.all([api('/api/agents'), api('/api/skills')]);

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/automations/cron" class="back">&larr;</a>
      <div class="page-title">New Cron Job</div>
    </div>
    <form id="cron-form" class="detail-card">
      <div class="form-group">
        <label>Name</label>
        <input type="text" name="name" required placeholder="Daily reminder">
      </div>
      <div class="form-group">
        <label>Schedule (cron expression)</label>
        <input type="text" name="schedule" required placeholder="0 9 * * *">
        <div class="text-dim text-sm mt-8">e.g. "0 9 * * *" = every day at 9 AM</div>
      </div>
      <div class="form-group">
        <label>Type</label>
        <select name="kind" id="job-kind">
          <option value="message">Message</option>
          <option value="instruction">Instruction</option>
          <option value="skillJob">Skill Job</option>
        </select>
      </div>
      <div id="payload-fields"></div>
      <div class="actions">
        <button type="submit" class="btn btn-primary">Create</button>
        <a href="#/automations/cron" class="btn">Cancel</a>
      </div>
    </form>
  `;

  const kindSelect = document.getElementById('job-kind');
  const payloadFields = document.getElementById('payload-fields');

  function renderPayloadFields() {
    if (kindSelect.value === 'message' || kindSelect.value === 'instruction') {
      const isInstruction = kindSelect.value === 'instruction';
      payloadFields.innerHTML = `
        <div class="form-group">
          <label>Bot ID</label>
          <select name="botId">
            ${agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} (${a.id})</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Chat ID</label>
          <input type="number" name="chatId" required placeholder="e.g. -100123456">
        </div>
        <div class="form-group">
          <label>${isInstruction ? 'Instruction' : 'Message Text'}</label>
          <textarea name="text" required rows="${isInstruction ? 6 : 3}" placeholder="${isInstruction ? 'Instruction to process through LLM pipeline...' : 'Hello!'}"></textarea>
          ${isInstruction ? '<div class="text-dim text-sm mt-8">Instructions are processed through the LLM pipeline (not sent as raw text)</div>' : ''}
        </div>
      `;
    } else {
      const firstSkillDefault = resolveSkillDefault(skills, skills[0]?.id);
      payloadFields.innerHTML = `
        <div class="form-group">
          <label>Skill</label>
          <select name="skillId" id="skill-select">
            ${skills.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Job ID</label>
          <input type="text" name="jobId" required placeholder="e.g. daily-report">
        </div>
        <div class="form-separator"></div>
        <div class="form-group">
          <label>LLM Backend</label>
          <select name="llmBackend" id="create-llmBackend">
            <option value="" id="create-llmBackend-default">Skill default (${firstSkillDefault})</option>
            <option value="ollama">Ollama</option>
            <option value="claude-cli">Claude CLI</option>
          </select>
        </div>
        <div id="create-claude-fields" style="display:none">
          <div class="form-group">
            <label>Claude Path</label>
            <input type="text" name="claudePath" placeholder="claude">
          </div>
          <div class="form-group">
            <label>Claude Timeout (ms)</label>
            <input type="number" name="claudeTimeout" placeholder="90000">
          </div>
        </div>
      `;
      document.getElementById('skill-select').addEventListener('change', (e) => {
        const def = resolveSkillDefault(skills, e.target.value);
        document.getElementById('create-llmBackend-default').textContent = `Skill default (${def})`;
      });
      document.getElementById('create-llmBackend').addEventListener('change', (e) => {
        document.getElementById('create-claude-fields').style.display =
          e.target.value === 'claude-cli' ? 'block' : 'none';
      });
    }
  }

  kindSelect.addEventListener('change', renderPayloadFields);
  renderPayloadFields();

  document.getElementById('cron-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const kind = form.kind.value;

    let payload;
    if (kind === 'message' || kind === 'instruction') {
      payload = {
        kind,
        text: form.text.value,
        chatId: Number(form.chatId.value),
        botId: form.botId.value,
      };
    } else {
      payload = { kind: 'skillJob', skillId: form.skillId.value, jobId: form.jobId.value };
      const backend = form.llmBackend?.value;
      if (backend) {
        payload.llmBackend = backend;
        if (backend === 'claude-cli') {
          if (form.claudePath?.value) payload.claudePath = form.claudePath.value;
          if (form.claudeTimeout?.value) payload.claudeTimeout = Number(form.claudeTimeout.value);
        }
      }
    }

    const created = await api('/api/cron', {
      method: 'POST',
      body: {
        name: form.name.value,
        enabled: true,
        schedule: { kind: 'cron', expr: form.schedule.value },
        payload,
      },
    });
    if (!created || created.error) {
      showToast(`Could not create the job: ${created?.error || 'error'}`, { tone: 'danger' });
      return;
    }
    showToast('Cron job created', { tone: 'ok' });
    location.hash = '#/automations/cron';
  });
}

function showCronEditModal(job, el, id, skills, onSaved) {
  const isMessage = job.payload.kind === 'message' || job.payload.kind === 'instruction';
  const isSkillJob = job.payload.kind === 'skillJob';
  const jobId = id || job.id;
  const scheduleExpr =
    job.schedule.kind === 'cron'
      ? job.schedule.expr
      : job.schedule.kind === 'every'
        ? `every ${job.schedule.everyMs}ms`
        : job.schedule.at || '';

  const currentBackend = isSkillJob ? job.payload.llmBackend || '' : '';
  const currentClaudePath = isSkillJob ? job.payload.claudePath || '' : '';
  const currentClaudeTimeout = isSkillJob ? job.payload.claudeTimeout || '' : '';
  const skillDefault = isSkillJob ? resolveSkillDefault(skills, job.payload.skillId) : 'ollama';

  showModal(`
    <div class="modal-title">Edit Cron Job</div>
    <div class="form-group">
      <label>Name</label>
      <input type="text" id="edit-name" value="${escapeHtml(job.name)}">
    </div>
    <div class="form-group">
      <label>Schedule</label>
      <input type="text" id="edit-schedule" value="${escapeHtml(scheduleExpr)}">
    </div>
    ${
      isMessage
        ? `
      <div class="form-group">
        <label>${job.payload.kind === 'instruction' ? 'Instruction' : 'Text'}</label>
        <textarea id="edit-text" rows="${job.payload.kind === 'instruction' ? 6 : 3}">${escapeHtml(job.payload.text)}</textarea>
      </div>
      <div class="form-group">
        <label>Chat ID</label>
        <input type="number" id="edit-chatId" value="${job.payload.chatId}">
      </div>
    `
        : ''
    }
    ${
      isSkillJob
        ? `
      <div class="form-separator"></div>
      <div class="form-group">
        <label>LLM Backend</label>
        <select id="edit-llmBackend">
          <option value=""${currentBackend === '' ? ' selected' : ''}>Skill default (${skillDefault})</option>
          <option value="ollama"${currentBackend === 'ollama' ? ' selected' : ''}>Ollama</option>
          <option value="claude-cli"${currentBackend === 'claude-cli' ? ' selected' : ''}>Claude CLI</option>
        </select>
      </div>
      <div id="edit-claude-fields" style="display:${currentBackend === 'claude-cli' ? 'block' : 'none'}">
        <div class="form-group">
          <label>Claude Path</label>
          <input type="text" id="edit-claudePath" value="${escapeHtml(currentClaudePath)}" placeholder="claude">
        </div>
        <div class="form-group">
          <label>Claude Timeout (ms)</label>
          <input type="number" id="edit-claudeTimeout" value="${currentClaudeTimeout}" placeholder="90000">
        </div>
      </div>
    `
        : ''
    }
    <div class="modal-actions">
      <button class="btn" id="edit-cancel">Cancel</button>
      <button class="btn btn-primary" id="edit-save">Save</button>
    </div>
  `);

  // Toggle claude fields visibility
  const backendSelect = document.getElementById('edit-llmBackend');
  if (backendSelect) {
    backendSelect.addEventListener('change', () => {
      const claudeFields = document.getElementById('edit-claude-fields');
      if (claudeFields)
        claudeFields.style.display = backendSelect.value === 'claude-cli' ? 'block' : 'none';
    });
  }

  document.getElementById('edit-cancel').addEventListener('click', closeModal);
  document.getElementById('edit-save').addEventListener('click', async () => {
    const patch = { name: document.getElementById('edit-name').value };

    const scheduleVal = document.getElementById('edit-schedule').value.trim();
    if (scheduleVal !== scheduleExpr) {
      patch.schedule = { kind: 'cron', expr: scheduleVal };
    }

    if (isMessage) {
      patch.payload = {
        kind: job.payload.kind,
        text: document.getElementById('edit-text').value,
        chatId: Number(document.getElementById('edit-chatId').value),
      };
    }

    if (isSkillJob) {
      const backend = document.getElementById('edit-llmBackend').value;
      const payloadPatch = { kind: 'skillJob' };
      payloadPatch.llmBackend = backend || null;
      if (backend === 'claude-cli') {
        const cp = document.getElementById('edit-claudePath').value.trim();
        const ct = document.getElementById('edit-claudeTimeout').value.trim();
        payloadPatch.claudePath = cp || null;
        payloadPatch.claudeTimeout = ct ? Number(ct) : null;
      } else {
        payloadPatch.claudePath = null;
        payloadPatch.claudeTimeout = null;
      }
      patch.payload = payloadPatch;
    }

    const saved = await api(`/api/cron/${encodeURIComponent(jobId)}`, {
      method: 'PATCH',
      body: patch,
    });
    if (!saved || saved.error) {
      showToast(`Save failed: ${saved?.error || 'error'}`, { tone: 'danger' });
      return;
    }
    closeModal();
    if (onSaved) onSaved();
  });
}

function showRunLogsModal(job) {
  const runs = job.runs || [];
  const hasRuns = runs.length > 0;
  const rows = !hasRuns
    ? '<tr><td colspan="6" class="text-dim">No run logs yet.</td></tr>'
    : runs
        .map(
          (r) => `
        <tr>
          <td class="text-sm">${r.runAtMs ? new Date(r.runAtMs).toLocaleString() : '--'}</td>
          <td><span class="badge badge-${r.status || 'disabled'}">${r.status || '--'}</span></td>
          <td class="text-dim text-sm">${r.durationMs != null ? formatDuration(r.durationMs) : '--'}</td>
          <td class="text-sm">${r.output ? formatOutput(r.output) : ''}</td>
          <td class="text-sm" style="color:var(--red)">${r.error ? escapeHtml(r.error) : ''}</td>
          <td><button class="btn btn-sm btn-icon" data-action="modal-delete-run" data-ts="${r.ts}" title="Delete">&times;</button></td>
        </tr>
      `
        )
        .join('');

  showModal(`
    <div class="modal-title">${escapeHtml(job.name)} — Run Logs</div>
    <div style="max-height:400px;overflow:auto">
      <table>
        <thead><tr><th>Time</th><th>Status</th><th>Duration</th><th>Output</th><th>Error</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="modal-actions">
      ${hasRuns ? '<button class="btn btn-danger" id="logs-clear-all">Clear All</button>' : ''}
      <button class="btn" id="logs-close">Close</button>
    </div>
  `);

  document.getElementById('logs-close').addEventListener('click', closeModal);

  const clearAllBtn = document.getElementById('logs-clear-all');
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', async () => {
      if (!confirmInline(clearAllBtn, { label: 'Click again to clear' })) return;
      await api(`/api/cron/${job.id}/runs`, { method: 'DELETE' });
      closeModal();
    });
  }

  document.querySelector('.modal')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action="modal-delete-run"]');
    if (!btn) return;
    const ts = Number(btn.dataset.ts);
    if (!ts) return;
    await api(`/api/cron/${job.id}/runs/delete`, { method: 'POST', body: { timestamps: [ts] } });
    const row = btn.closest('tr');
    if (row) row.remove();
  });
}

function resolveSkillDefault(skills, skillId) {
  const skill = (skills || []).find((s) => s.id === skillId);
  return skill?.llmBackend || 'ollama';
}

function formatSchedule(schedule) {
  if (schedule.kind === 'cron') return schedule.expr + (schedule.tz ? ` (${schedule.tz})` : '');
  if (schedule.kind === 'at') return `once at ${schedule.at}`;
  if (schedule.kind === 'every') {
    const ms = schedule.everyMs;
    if (ms >= 3600000) return `every ${ms / 3600000}h`;
    if (ms >= 60000) return `every ${ms / 60000}m`;
    return `every ${ms / 1000}s`;
  }
  return '?';
}

function formatDuration(ms) {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return `${str.slice(0, max)}…`;
}

function formatOutput(output) {
  if (!output) return '';
  const escaped = escapeHtml(output);
  if (output.length <= 200) {
    return `<span class="text-dim">${escaped}</span>`;
  }
  const id = `out-${Math.random().toString(36).slice(2, 8)}`;
  const short = escapeHtml(output.slice(0, 200));
  return `<span class="text-dim"><span id="${id}-short">${short}… <a href="#" onclick="document.getElementById('${id}-short').style.display='none';document.getElementById('${id}-full').style.display='inline';return false">more</a></span><span id="${id}-full" style="display:none">${escaped}</span></span>`;
}
