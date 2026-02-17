import { showModal, closeModal, api, escapeHtml, timeAgo } from './shared.js';

export async function renderCron(el) {
  el.innerHTML = '<div class="page-title">Cron Jobs</div><p class="text-dim">Loading...</p>';

  const jobs = await api('/api/cron');

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Cron Jobs <span class="count">${jobs.length}</span></div>
      <a href="#/cron/new" class="btn btn-primary">+ New Job</a>
    </div>
    ${jobs.length === 0
      ? '<p class="text-dim">No cron jobs configured.</p>'
      : `<table>
          <thead><tr><th>Name</th><th>Schedule</th><th>Enabled</th><th>Next Run</th><th>Last Run</th><th>Actions</th></tr></thead>
          <tbody id="cron-tbody"></tbody>
        </table>`
    }
  `;

  if (jobs.length === 0) return;

  const tbody = document.getElementById('cron-tbody');
  for (const job of jobs) {
    const scheduleText = formatSchedule(job.schedule);
    const nextRun = job.state.nextRunAtMs
      ? timeAgo(new Date(job.state.nextRunAtMs).toISOString(), true)
      : '<span class="text-dim">--</span>';

    let lastRunHtml = '<span class="text-dim">--</span>';
    if (job.state.lastStatus) {
      const badge = `<span class="badge badge-${job.state.lastStatus}">${job.state.lastStatus}</span>`;
      const ago = job.state.lastRunAtMs ? ` <span class="text-dim text-sm">${timeAgo(new Date(job.state.lastRunAtMs).toISOString())}</span>` : '';
      const dur = job.state.lastDurationMs != null ? ` <span class="text-dim text-sm">(${formatDuration(job.state.lastDurationMs)})</span>` : '';
      const err = job.state.lastError ? `<div class="text-sm" style="color:var(--red);margin-top:2px">${escapeHtml(truncate(job.state.lastError, 80))}</div>` : '';
      lastRunHtml = `${badge}${ago}${dur}${err}`;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="#/cron/${job.id}">${escapeHtml(job.name)}</a></td>
      <td class="text-dim text-sm">${escapeHtml(scheduleText)}</td>
      <td>
        <label class="toggle">
          <input type="checkbox" ${job.enabled ? 'checked' : ''} data-action="toggle" data-id="${job.id}">
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td class="text-dim text-sm">${nextRun}</td>
      <td>${lastRunHtml}</td>
      <td class="actions">
        <button class="btn btn-sm" data-action="run" data-id="${job.id}">Run</button>
        <button class="btn btn-sm" data-action="logs" data-id="${job.id}">Logs</button>
        <a href="#/cron/${job.id}" class="btn btn-sm">View</a>
        <button class="btn btn-sm btn-danger" data-action="delete" data-id="${job.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.addEventListener('change', async (e) => {
    const toggle = e.target.closest('input[data-action="toggle"]');
    if (!toggle) return;
    await api(`/api/cron/${toggle.dataset.id}`, { method: 'PATCH', body: { enabled: toggle.checked } });
    renderCron(el);
  });

  tbody.addEventListener('click', async (e) => {
    const runBtn = e.target.closest('button[data-action="run"]');
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = 'Running…';
      try {
        const res = await api(`/api/cron/${runBtn.dataset.id}/run`, { method: 'POST' });
        runBtn.textContent = res.ok ? 'Done' : `Failed: ${res.reason || 'error'}`;
      } catch {
        runBtn.textContent = 'Error';
      }
      setTimeout(() => renderCron(el), 1500);
      return;
    }

    const logsBtn = e.target.closest('button[data-action="logs"]');
    if (logsBtn) {
      logsBtn.disabled = true;
      const job = await api(`/api/cron/${logsBtn.dataset.id}`);
      logsBtn.disabled = false;
      showRunLogsModal(job);
      return;
    }

    const delBtn = e.target.closest('button[data-action="delete"]');
    if (!delBtn) return;
    if (!confirm('Delete this cron job?')) return;
    await api(`/api/cron/${delBtn.dataset.id}`, { method: 'DELETE' });
    renderCron(el);
  });
}

export async function renderCronDetail(el, id) {
  const job = await api(`/api/cron/${id}`);
  if (job.error) {
    el.innerHTML = '<p>Cron job not found.</p>';
    return;
  }

  const scheduleText = formatSchedule(job.schedule);
  const payloadHtml = job.payload.kind === 'message'
    ? `<tr><td class="text-dim">Bot ID</td><td>${escapeHtml(job.payload.botId)}</td></tr>
       <tr><td class="text-dim">Chat ID</td><td>${job.payload.chatId}</td></tr>
       <tr><td class="text-dim">Text</td><td>${escapeHtml(job.payload.text)}</td></tr>`
    : `<tr><td class="text-dim">Skill ID</td><td>${escapeHtml(job.payload.skillId)}</td></tr>
       <tr><td class="text-dim">Job ID</td><td>${escapeHtml(job.payload.jobId)}</td></tr>`;

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/cron" class="back">&larr;</a>
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
        <tr><td class="text-dim">Last Status</td><td>${job.state.lastStatus
          ? `<span class="badge badge-${job.state.lastStatus}">${job.state.lastStatus}</span>`
          : '--'}</td></tr>
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

    ${job.runs?.length ? `
      <div class="flex-between mb-16">
        <h3>Recent Runs</h3>
        <button class="btn btn-sm btn-danger" id="btn-clear-logs">Clear Logs</button>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Status</th><th>Duration</th><th>Output</th><th>Error</th><th></th></tr></thead>
        <tbody>
          ${job.runs.map((r) => `
            <tr>
              <td class="text-sm">${r.runAtMs ? new Date(r.runAtMs).toLocaleString() : '--'}</td>
              <td><span class="badge badge-${r.status || 'disabled'}">${r.status || '--'}</span></td>
              <td class="text-dim">${r.durationMs != null ? r.durationMs + 'ms' : '--'}</td>
              <td class="text-sm">${r.output ? formatOutput(r.output) : ''}</td>
              <td class="text-sm" style="color:var(--red)">${r.error ? escapeHtml(r.error) : ''}</td>
              <td><button class="btn btn-sm btn-icon" data-action="delete-run" data-ts="${r.ts}" title="Delete">&times;</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : ''}
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
    await api(`/api/cron/${id}`, { method: 'PATCH', body: { enabled: !job.enabled } });
    renderCronDetail(el, id);
  });

  document.getElementById('btn-delete').addEventListener('click', async () => {
    if (!confirm('Delete this cron job?')) return;
    await api(`/api/cron/${id}`, { method: 'DELETE' });
    location.hash = '#/cron';
  });

  document.getElementById('btn-edit').addEventListener('click', () => {
    showCronEditModal(job, el, id);
  });

  const clearLogsBtn = document.getElementById('btn-clear-logs');
  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', async () => {
      if (!confirm('Clear all run logs for this job?')) return;
      await api(`/api/cron/${id}/runs`, { method: 'DELETE' });
      renderCronDetail(el, id);
    });
  }

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action="delete-run"]');
    if (!btn) return;
    const ts = Number(btn.dataset.ts);
    if (!ts) return;
    await api(`/api/cron/${id}/runs/delete`, { method: 'POST', body: { timestamps: [ts] } });
    renderCronDetail(el, id);
  });
}

export async function renderCronCreate(el) {
  const [agents, skills] = await Promise.all([
    api('/api/agents'),
    api('/api/skills'),
  ]);

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/cron" class="back">&larr;</a>
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
          <option value="skillJob">Skill Job</option>
        </select>
      </div>
      <div id="payload-fields"></div>
      <div class="actions">
        <button type="submit" class="btn btn-primary">Create</button>
        <a href="#/cron" class="btn">Cancel</a>
      </div>
    </form>
  `;

  const kindSelect = document.getElementById('job-kind');
  const payloadFields = document.getElementById('payload-fields');

  function renderPayloadFields() {
    if (kindSelect.value === 'message') {
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
          <label>Message Text</label>
          <textarea name="text" required placeholder="Hello!"></textarea>
        </div>
      `;
    } else {
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
      `;
    }
  }

  kindSelect.addEventListener('change', renderPayloadFields);
  renderPayloadFields();

  document.getElementById('cron-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const kind = form.kind.value;

    const payload = kind === 'message'
      ? { kind: 'message', text: form.text.value, chatId: Number(form.chatId.value), botId: form.botId.value }
      : { kind: 'skillJob', skillId: form.skillId.value, jobId: form.jobId.value };

    await api('/api/cron', {
      method: 'POST',
      body: {
        name: form.name.value,
        enabled: true,
        schedule: { kind: 'cron', expr: form.schedule.value },
        payload,
      },
    });

    location.hash = '#/cron';
  });
}

function showCronEditModal(job, el, id) {
  const isMessage = job.payload.kind === 'message';
  const scheduleExpr = job.schedule.kind === 'cron' ? job.schedule.expr
    : job.schedule.kind === 'every' ? `every ${job.schedule.everyMs}ms`
    : job.schedule.at || '';

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
    ${isMessage ? `
      <div class="form-group">
        <label>Text</label>
        <textarea id="edit-text">${escapeHtml(job.payload.text)}</textarea>
      </div>
      <div class="form-group">
        <label>Chat ID</label>
        <input type="number" id="edit-chatId" value="${job.payload.chatId}">
      </div>
    ` : ''}
    <div class="modal-actions">
      <button class="btn" id="edit-cancel">Cancel</button>
      <button class="btn btn-primary" id="edit-save">Save</button>
    </div>
  `);

  document.getElementById('edit-cancel').addEventListener('click', closeModal);
  document.getElementById('edit-save').addEventListener('click', async () => {
    const patch = { name: document.getElementById('edit-name').value };

    const scheduleVal = document.getElementById('edit-schedule').value.trim();
    if (scheduleVal !== scheduleExpr) {
      patch.schedule = { kind: 'cron', expr: scheduleVal };
    }

    if (isMessage) {
      patch.payload = {
        kind: 'message',
        text: document.getElementById('edit-text').value,
        chatId: Number(document.getElementById('edit-chatId').value),
      };
    }

    await api(`/api/cron/${id}`, { method: 'PATCH', body: patch });
    closeModal();
    renderCronDetail(el, id);
  });
}

function showRunLogsModal(job) {
  const runs = job.runs || [];
  const hasRuns = runs.length > 0;
  const rows = !hasRuns
    ? '<tr><td colspan="6" class="text-dim">No run logs yet.</td></tr>'
    : runs.map((r) => `
        <tr>
          <td class="text-sm">${r.runAtMs ? new Date(r.runAtMs).toLocaleString() : '--'}</td>
          <td><span class="badge badge-${r.status || 'disabled'}">${r.status || '--'}</span></td>
          <td class="text-dim text-sm">${r.durationMs != null ? formatDuration(r.durationMs) : '--'}</td>
          <td class="text-sm">${r.output ? formatOutput(r.output) : ''}</td>
          <td class="text-sm" style="color:var(--red)">${r.error ? escapeHtml(r.error) : ''}</td>
          <td><button class="btn btn-sm btn-icon" data-action="modal-delete-run" data-ts="${r.ts}" title="Delete">&times;</button></td>
        </tr>
      `).join('');

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
      if (!confirm('Clear all run logs for this job?')) return;
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
  return str.slice(0, max) + '…';
}

function formatOutput(output) {
  if (!output) return '';
  const escaped = escapeHtml(output);
  if (output.length <= 200) {
    return `<span class="text-dim">${escaped}</span>`;
  }
  const id = 'out-' + Math.random().toString(36).slice(2, 8);
  const short = escapeHtml(output.slice(0, 200));
  return `<span class="text-dim"><span id="${id}-short">${short}… <a href="#" onclick="document.getElementById('${id}-short').style.display='none';document.getElementById('${id}-full').style.display='inline';return false">more</a></span><span id="${id}-full" style="display:none">${escaped}</span></span>`;
}
