import { showModal, closeModal, api, escapeHtml } from './shared.js';

export async function renderAgents(el) {
  el.innerHTML = '<div class="page-title">Agents</div><p class="text-dim">Loading...</p>';

  const [agents, skills] = await Promise.all([
    api('/api/agents'),
    api('/api/skills'),
  ]);

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Agents <span class="count">${agents.length}</span></div>
      <button class="btn btn-primary" id="btn-new-agent">+ New Agent</button>
    </div>
    <table>
      <thead><tr><th>Name</th><th>ID</th><th>Status</th><th>Skills</th><th>Actions</th></tr></thead>
      <tbody id="agents-tbody"></tbody>
    </table>
  `;

  const tbody = document.getElementById('agents-tbody');
  for (const agent of agents) {
    const statusBadge = agent.running
      ? '<span class="badge badge-running">Running</span>'
      : '<span class="badge badge-stopped">Stopped</span>';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="#/agents/${agent.id}">${escapeHtml(agent.name)}</a></td>
      <td class="text-dim">${escapeHtml(agent.id)}</td>
      <td>${statusBadge}</td>
      <td class="text-dim">${agent.skills.length}</td>
      <td class="actions">
        ${agent.running
          ? `<button class="btn btn-sm btn-danger" data-action="stop" data-id="${agent.id}">Stop</button>`
          : `<button class="btn btn-sm" data-action="start" data-id="${agent.id}">Start</button>`
        }
        <button class="btn btn-sm" data-action="edit" data-id="${agent.id}">Edit</button>
        <button class="btn btn-sm" data-action="clone" data-id="${agent.id}">Clone</button>
        <button class="btn btn-sm btn-danger" data-action="delete" data-id="${agent.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // Event delegation
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'start') {
      btn.disabled = true;
      btn.textContent = 'Starting...';
      await api(`/api/agents/${id}/start`, { method: 'POST' });
      renderAgents(el);
    } else if (action === 'stop') {
      btn.disabled = true;
      btn.textContent = 'Stopping...';
      await api(`/api/agents/${id}/stop`, { method: 'POST' });
      renderAgents(el);
    } else if (action === 'edit') {
      location.hash = `#/agents/${id}/edit`;
    } else if (action === 'clone') {
      showCloneModal(id, el);
    } else if (action === 'delete') {
      if (confirm(`Delete agent "${id}"? This cannot be undone.`)) {
        await api(`/api/agents/${id}`, { method: 'DELETE' });
        renderAgents(el);
      }
    }
  });

  document.getElementById('btn-new-agent').addEventListener('click', () => {
    showNewAgentModal(skills, el);
  });
}

export async function renderAgentDetail(el, id) {
  const [agent, skills] = await Promise.all([
    api(`/api/agents/${id}`),
    api('/api/skills'),
  ]);

  if (agent.error) {
    el.innerHTML = `<p>Agent not found.</p>`;
    return;
  }

  const statusBadge = agent.running
    ? '<span class="badge badge-running">Running</span>'
    : '<span class="badge badge-stopped">Stopped</span>';

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/agents" class="back">&larr;</a>
      <div class="page-title">${escapeHtml(agent.name)} ${statusBadge}</div>
    </div>
    <div class="detail-card">
      <table>
        <tr><td class="text-dim" style="width:140px">ID</td><td>${escapeHtml(agent.id)}</td></tr>
        <tr><td class="text-dim">Token</td><td><code>${escapeHtml(agent.token)}</code></td></tr>
        <tr><td class="text-dim">Enabled</td><td>${agent.enabled ? 'Yes' : 'No'}</td></tr>
        <tr><td class="text-dim">Skills</td><td>${agent.skills.map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join(' ')}</td></tr>
        <tr><td class="text-dim">Allowed Users</td><td>${agent.allowedUsers?.length ? agent.allowedUsers.join(', ') : '<span class="text-dim">All</span>'}</td></tr>
        <tr><td class="text-dim">Mention Patterns</td><td>${agent.mentionPatterns?.length ? agent.mentionPatterns.join(', ') : '<span class="text-dim">None</span>'}</td></tr>
      </table>
    </div>
    <div class="actions">
      ${agent.running
        ? `<button class="btn btn-danger" id="btn-toggle">Stop</button>`
        : `<button class="btn btn-primary" id="btn-toggle">Start</button>`
      }
      <a href="#/agents/${agent.id}/edit" class="btn">Edit</a>
      <button class="btn" id="btn-clone">Clone</button>
    </div>
  `;

  document.getElementById('btn-toggle').addEventListener('click', async (e) => {
    e.target.disabled = true;
    if (agent.running) {
      await api(`/api/agents/${id}/stop`, { method: 'POST' });
    } else {
      await api(`/api/agents/${id}/start`, { method: 'POST' });
    }
    renderAgentDetail(el, id);
  });

  document.getElementById('btn-clone').addEventListener('click', () => {
    showCloneModal(id, el, () => renderAgentDetail(el, id));
  });
}

export async function renderAgentEdit(el, id) {
  const [agent, skills] = await Promise.all([
    api(`/api/agents/${id}`),
    api('/api/skills'),
  ]);

  if (agent.error) {
    el.innerHTML = `<p>Agent not found.</p>`;
    return;
  }

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/agents/${id}" class="back">&larr;</a>
      <div class="page-title">Edit ${escapeHtml(agent.name)}</div>
    </div>
    <form id="edit-form" class="detail-card">
      <div class="form-group">
        <label>Name</label>
        <input type="text" name="name" value="${escapeHtml(agent.name)}">
      </div>
      <div class="form-group">
        <label>Token</label>
        <input type="password" name="token" value="" placeholder="Leave blank to keep current">
      </div>
      <div class="form-group">
        <label>Enabled</label>
        <label class="toggle">
          <input type="checkbox" name="enabled" ${agent.enabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="form-group">
        <label>Skills</label>
        <div class="checkbox-group" id="skills-group">
          ${skills.map((s) => `
            <label class="${agent.skills.includes(s.id) ? 'checked' : ''}">
              <input type="checkbox" name="skills" value="${s.id}" ${agent.skills.includes(s.id) ? 'checked' : ''}>
              ${escapeHtml(s.name)}
            </label>
          `).join('')}
        </div>
      </div>
      <div class="form-group">
        <label>Mention Patterns (comma-separated)</label>
        <input type="text" name="mentionPatterns" value="${(agent.mentionPatterns || []).join(', ')}">
      </div>
      <div class="actions">
        <button type="submit" class="btn btn-primary">Save</button>
        <a href="#/agents/${id}" class="btn">Cancel</a>
      </div>
    </form>
  `;

  // Toggle checkbox styling
  el.querySelectorAll('.checkbox-group input').forEach((inp) => {
    inp.addEventListener('change', () => {
      inp.parentElement.classList.toggle('checked', inp.checked);
    });
  });

  document.getElementById('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const patch = { name: form.name.value, enabled: form.enabled.checked };

    if (form.token.value) patch.token = form.token.value;

    patch.skills = Array.from(form.querySelectorAll('input[name="skills"]:checked')).map((i) => i.value);
    patch.mentionPatterns = form.mentionPatterns.value.split(',').map((s) => s.trim()).filter(Boolean);

    await api(`/api/agents/${id}`, { method: 'PATCH', body: patch });
    location.hash = `#/agents/${id}`;
  });
}

function showCloneModal(sourceId, el, onDone) {
  showModal(`
    <div class="modal-title">Clone Agent</div>
    <div class="form-group">
      <label>New ID</label>
      <input type="text" id="clone-id" placeholder="e.g. my-new-bot">
    </div>
    <div class="form-group">
      <label>New Name</label>
      <input type="text" id="clone-name" placeholder="e.g. My New Bot">
    </div>
    <div class="modal-actions">
      <button class="btn" id="clone-cancel">Cancel</button>
      <button class="btn btn-primary" id="clone-confirm">Clone</button>
    </div>
  `);

  document.getElementById('clone-cancel').addEventListener('click', closeModal);
  document.getElementById('clone-confirm').addEventListener('click', async () => {
    const id = document.getElementById('clone-id').value.trim();
    const name = document.getElementById('clone-name').value.trim();
    if (!id || !name) return;

    await api(`/api/agents/${sourceId}/clone`, { method: 'POST', body: { id, name } });
    closeModal();
    if (onDone) onDone(); else renderAgents(el);
  });
}

function showNewAgentModal(skills, el) {
  showModal(`
    <div class="modal-title">New Agent</div>
    <div class="form-group">
      <label>ID</label>
      <input type="text" id="new-id" placeholder="e.g. my-bot">
    </div>
    <div class="form-group">
      <label>Name</label>
      <input type="text" id="new-name" placeholder="e.g. My Bot">
    </div>
    <div class="form-group">
      <label>Token</label>
      <input type="password" id="new-token" placeholder="Telegram bot token">
    </div>
    <div class="modal-actions">
      <button class="btn" id="new-cancel">Cancel</button>
      <button class="btn btn-primary" id="new-confirm">Create</button>
    </div>
  `);

  document.getElementById('new-cancel').addEventListener('click', closeModal);
  document.getElementById('new-confirm').addEventListener('click', async () => {
    const id = document.getElementById('new-id').value.trim();
    const name = document.getElementById('new-name').value.trim();
    const token = document.getElementById('new-token').value.trim();
    if (!id || !name) return;

    await api('/api/agents', { method: 'POST', body: { id, name, token, skills: [], enabled: false } });
    closeModal();
    renderAgents(el);
  });
}
