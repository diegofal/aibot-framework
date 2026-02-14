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
          <thead><tr><th>Name</th><th>Schedule</th><th>Type</th><th>Enabled</th><th>Next Run</th><th>Last Status</th><th>Actions</th></tr></thead>
          <tbody id="cron-tbody"></tbody>
        </table>`
    }
  `;

  if (jobs.length === 0) return;

  const tbody = document.getElementById('cron-tbody');
  for (const job of jobs) {
    const scheduleText = formatSchedule(job.schedule);
    const typeBadge = job.payload.kind === 'message'
      ? '<span class="badge">message</span>'
      : '<span class="badge">skill</span>';
    const lastStatus = job.state.lastStatus
      ? `<span class="badge badge-${job.state.lastStatus}">${job.state.lastStatus}</span>`
      : '<span class="text-dim">--</span>';
    const nextRun = job.state.nextRunAtMs
      ? timeAgo(new Date(job.state.nextRunAtMs).toISOString(), true)
      : '<span class="text-dim">--</span>';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="#/cron/${job.id}">${escapeHtml(job.name)}</a></td>
      <td class="text-dim text-sm">${escapeHtml(scheduleText)}</td>
      <td>${typeBadge}</td>
      <td>
        <label class="toggle">
          <input type="checkbox" ${job.enabled ? 'checked' : ''} data-action="toggle" data-id="${job.id}">
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td class="text-dim text-sm">${nextRun}</td>
      <td>${lastStatus}</td>
      <td class="actions">
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
    const btn = e.target.closest('button[data-action="delete"]');
    if (!btn) return;
    if (!confirm('Delete this cron job?')) return;
    await api(`/api/cron/${btn.dataset.id}`, { method: 'DELETE' });
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
      <button class="btn" id="btn-edit">Edit</button>
      <button class="btn ${job.enabled ? 'btn-danger' : 'btn-primary'}" id="btn-toggle">${job.enabled ? 'Disable' : 'Enable'}</button>
      <button class="btn btn-danger" id="btn-delete">Delete</button>
    </div>

    ${job.runs?.length ? `
      <h3 class="mb-16">Recent Runs</h3>
      <table>
        <thead><tr><th>Time</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
        <tbody>
          ${job.runs.map((r) => `
            <tr>
              <td class="text-sm">${r.runAtMs ? new Date(r.runAtMs).toLocaleString() : '--'}</td>
              <td><span class="badge badge-${r.status || 'disabled'}">${r.status || '--'}</span></td>
              <td class="text-dim">${r.durationMs != null ? r.durationMs + 'ms' : '--'}</td>
              <td class="text-sm" style="color:var(--red)">${r.error ? escapeHtml(r.error) : ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : ''}
  `;

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
