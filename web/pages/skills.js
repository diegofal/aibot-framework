import { confirmDialog, emptyState, showToast } from '../ui/index.js';
import { api, closeModal, escapeHtml, showModal } from './shared.js';
import {
  applyToggleResult,
  filterSkills,
  skillsBulkBar,
  skillsToolbar,
  toggleSummary,
  toggleTargets,
  validateSkillCreate,
} from './skills-helpers.js';

// Search + type/status filter of the skills list; survives re-renders.
const skillsFilter = { query: '', type: '', status: '' };

function typeBadge(type) {
  return type === 'builtin'
    ? '<span class="badge badge-ok">Built-in</span>'
    : '<span class="badge badge-medium">External</span>';
}

function enabledBadge(skill) {
  if (skill.type !== 'builtin') return '';
  return skill.enabled
    ? ' <span class="badge badge-ok">Enabled</span>'
    : ' <span class="badge" style="opacity:0.5">Disabled</span>';
}

function botNameBadge(skill) {
  if (!skill.botName) return '';
  return ` <span class="badge" style="background:var(--surface-2);color:var(--text-secondary)">${escapeHtml(skill.botName)}</span>`;
}

// ─── List Page ──────────────────────────────────────────────────────
export async function renderSkills(el) {
  el.innerHTML = '<div class="page-title">Skills</div><p class="text-dim">Loading...</p>';

  let skills = await api('/api/skills');
  if (!Array.isArray(skills)) {
    el.innerHTML = `<div class="page-title">Skills</div>${emptyState({
      icon: '!',
      title: 'Could not load skills',
      hint: skills?.error || 'The server returned an unexpected response.',
      action: '<button class="btn btn-sm" id="skills-retry">Retry</button>',
    })}`;
    document.getElementById('skills-retry')?.addEventListener('click', () => renderSkills(el));
    return;
  }

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Skills <span class="count" id="skills-count">${skills.length}</span></div>
      <a href="#/automations/skills/new" class="btn btn-primary" data-page-new>+ Create Skill</a>
    </div>
    ${skillsToolbar(skillsFilter)}
    <p class="text-dim text-sm skills-note">Enabling or disabling a built-in skill updates <code>config.skills.enabled</code>; it takes effect after a restart. External skills are always live.</p>
    <div id="skills-bulk"></div>
    <div id="skills-table-wrap"></div>
  `;

  const wrap = document.getElementById('skills-table-wrap');
  const bulk = document.getElementById('skills-bulk');
  // Selected built-in ids; survives filtering, cleared after a toggle.
  const selected = new Set();

  function drawBulk() {
    bulk.innerHTML = skillsBulkBar({
      selected: selected.size,
      enable: toggleTargets(skills, selected, true).length,
      disable: toggleTargets(skills, selected, false).length,
    });
  }

  async function toggle(ids, enabled, btn) {
    if (ids.length === 0) return;
    if (btn) btn.disabled = true;
    const res = await api('/api/skills/toggle', {
      method: 'POST',
      body: { ids, enabled },
    }).catch((err) => ({ error: err?.message }));
    if (!res || res.error) {
      showToast(`Could not update skills: ${res?.error || 'the server did not answer.'}`, {
        tone: 'danger',
      });
      if (btn) btn.disabled = false;
      return;
    }
    skills = applyToggleResult(skills, res);
    selected.clear();
    draw();
    const { text, tone } = toggleSummary(res, enabled);
    showToast(text, { tone, duration: 6000 });
  }

  function rowHtml(skill) {
    const countLabel =
      skill.type === 'builtin'
        ? `${(skill.commands || []).length} cmds`
        : `${skill.toolCount || 0} tools`;
    const warningBadge = skill.warnings?.length
      ? `<span class="badge badge-error">${skill.warnings.length}</span>`
      : '<span class="text-dim">--</span>';
    const actions =
      skill.type === 'external'
        ? `<a href="#/automations/skills/${encodeURIComponent(skill.id)}/edit" class="btn btn-sm">Edit</a>
         <button class="btn btn-sm btn-danger" data-action="delete" data-id="${escapeHtml(skill.id)}">Delete</button>`
        : `<button class="btn btn-sm" data-action="toggle" data-id="${escapeHtml(skill.id)}" data-enable="${skill.enabled ? 'false' : 'true'}">${skill.enabled ? 'Disable' : 'Enable'}</button>`;
    const muted =
      skill.type === 'builtin' && skill.enabled === false ? ' class="skills-row-off"' : '';
    const pick =
      skill.type === 'builtin'
        ? `<input type="checkbox" data-select="${escapeHtml(skill.id)}" aria-label="Select ${escapeHtml(skill.name)}"${selected.has(skill.id) ? ' checked' : ''}>`
        : '';
    return `<tr${muted} data-id="${escapeHtml(skill.id)}">
      <td>${pick}</td>
      <td><a href="#/automations/skills/${encodeURIComponent(skill.id)}">${escapeHtml(skill.name)}</a></td>
      <td>${typeBadge(skill.type)}${enabledBadge(skill)}${botNameBadge(skill)}</td>
      <td class="text-dim">${escapeHtml(skill.version || '--')}</td>
      <td class="text-dim">${countLabel}</td>
      <td>${warningBadge}</td>
      <td class="actions">${actions}</td>
    </tr>`;
  }

  function draw() {
    drawBulk();
    const visible = filterSkills(skills, skillsFilter);
    const countEl = document.getElementById('skills-count');
    if (countEl)
      countEl.textContent =
        visible.length === skills.length
          ? String(skills.length)
          : `${visible.length}/${skills.length}`;
    if (visible.length === 0) {
      wrap.innerHTML =
        skills.length === 0
          ? emptyState({
              icon: '◇',
              title: 'No skills yet',
              hint: 'Create one to give agents new tools.',
            })
          : emptyState({
              icon: '⌕',
              title: 'No skills match',
              hint: 'Clear the filter to see every skill.',
            });
      return;
    }
    wrap.innerHTML = `<table>
      <thead><tr><th aria-label="Select"></th><th>Name</th><th>Type</th><th>Version</th><th>Commands / Tools</th><th>Warnings</th><th>Actions</th></tr></thead>
      <tbody id="skills-tbody">${visible.map(rowHtml).join('')}</tbody>
    </table>`;
  }
  draw();

  document.getElementById('skills-filter-query')?.addEventListener('input', (e) => {
    skillsFilter.query = e.target.value;
    draw();
  });
  document.getElementById('skills-filter-type')?.addEventListener('change', (e) => {
    skillsFilter.type = e.target.value;
    draw();
  });
  document.getElementById('skills-filter-status')?.addEventListener('change', (e) => {
    skillsFilter.status = e.target.value;
    draw();
  });

  wrap.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-select]');
    if (!box) return;
    if (box.checked) selected.add(box.dataset.select);
    else selected.delete(box.dataset.select);
    drawBulk();
  });
  bulk.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-bulk]');
    if (!btn) return;
    if (btn.dataset.bulk === 'clear') {
      selected.clear();
      draw();
      return;
    }
    const enabled = btn.dataset.bulk === 'enable';
    toggle(toggleTargets(skills, selected, enabled), enabled, btn);
  });

  wrap.addEventListener('click', async (e) => {
    const toggleBtn = e.target.closest('button[data-action="toggle"]');
    if (toggleBtn) {
      toggle([toggleBtn.dataset.id], toggleBtn.dataset.enable === 'true', toggleBtn);
      return;
    }
    const btn = e.target.closest('button[data-action="delete"]');
    if (!btn) return;
    const id = btn.dataset.id;
    const ok = await confirmDialog({
      title: 'Delete skill?',
      message: `Delete external skill "${id}"? The skill directory is removed from disk. This cannot be undone.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = 'Deleting...';
    const res = await api(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.error) {
      showToast(`Delete failed: ${res.error}`, { tone: 'danger' });
      btn.disabled = false;
      btn.textContent = 'Delete';
      return;
    }
    const idx = skills.findIndex((s) => s.id === id);
    if (idx >= 0) skills.splice(idx, 1);
    draw();
    showToast(`Deleted skill "${id}"`, { tone: 'ok' });
  });
}

// ─── Detail Page ────────────────────────────────────────────────────
export async function renderSkillDetail(el, id) {
  el.innerHTML = '<div class="page-title">Skill Detail</div><p class="text-dim">Loading...</p>';

  const skill = await api(`/api/skills/${encodeURIComponent(id)}`);
  if (skill.error) {
    el.innerHTML = `<div class="detail-header"><a href="#/automations/skills" class="back">&larr;</a><div class="page-title">Skill not found</div></div>`;
    return;
  }

  const isExternal = skill.type === 'external';

  let detailHtml = `
    <div class="detail-header">
      <a href="#/automations/skills" class="back">&larr;</a>
      <div class="page-title">${escapeHtml(skill.name)} ${typeBadge(skill.type)}${enabledBadge(skill)}${botNameBadge(skill)}</div>
    </div>
    <div class="detail-card">
      <table>
        <tr><td class="text-dim" style="width:140px">ID</td><td>${escapeHtml(skill.id)}</td></tr>
        <tr><td class="text-dim">Version</td><td>${escapeHtml(skill.version || '--')}</td></tr>
        <tr><td class="text-dim">Description</td><td>${escapeHtml(skill.description || '--')}</td></tr>
        ${isExternal && skill.dir ? `<tr><td class="text-dim">Directory</td><td><code>${escapeHtml(skill.dir)}</code></td></tr>` : ''}
        ${isExternal && skill.botName ? `<tr><td class="text-dim">Bot Origin</td><td>${escapeHtml(skill.botName)}</td></tr>` : ''}
        ${!isExternal && skill.enabled !== false ? `<tr><td class="text-dim">LLM Backend</td><td>${escapeHtml(skill.llmBackend || '--')}</td></tr>` : ''}
        ${!isExternal ? `<tr><td class="text-dim">Status</td><td>${skill.enabled ? '<span class="badge badge-ok">Enabled</span>' : '<span class="badge" style="opacity:0.5">Disabled</span>'}</td></tr>` : ''}
      </table>
    </div>
  `;

  // Built-in: commands and jobs
  if (!isExternal) {
    if (skill.commands?.length) {
      detailHtml += `
        <div class="detail-card" style="margin-top:16px">
          <h4 style="margin:0 0 12px">Commands</h4>
          <div>${skill.commands.map((cmd) => `<span class="badge" style="margin:2px">/${escapeHtml(cmd)}</span>`).join('')}</div>
        </div>
      `;
    }
    if (skill.jobs?.length) {
      detailHtml += `
        <div class="detail-card" style="margin-top:16px">
          <h4 style="margin:0 0 12px">Jobs</h4>
          <table>
            <thead><tr><th>ID</th><th>Schedule</th></tr></thead>
            <tbody>${skill.jobs.map((j) => `<tr><td>${escapeHtml(j.id)}</td><td class="text-dim">${escapeHtml(j.schedule)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      `;
    }
    if (skill.hasOnMessage) {
      detailHtml += `<div class="detail-card" style="margin-top:16px"><p class="text-dim">This skill has an <code>onMessage</code> handler.</p></div>`;
    }
  }

  // External: tools, requirements, warnings
  if (isExternal) {
    if (skill.requires) {
      const reqs = [];
      if (skill.requires.bins?.length) reqs.push(`Binaries: ${skill.requires.bins.join(', ')}`);
      if (skill.requires.env?.length) reqs.push(`Env vars: ${skill.requires.env.join(', ')}`);
      if (reqs.length) {
        detailHtml += `
          <div class="detail-card" style="margin-top:16px">
            <h4 style="margin:0 0 12px">Requirements</h4>
            <ul style="margin:0;padding-left:20px">${reqs.map((r) => `<li class="text-dim">${escapeHtml(r)}</li>`).join('')}</ul>
          </div>
        `;
      }
    }

    if (skill.warnings?.length) {
      detailHtml += `
        <div class="detail-card" style="margin-top:16px;border-color:var(--red)">
          <h4 style="margin:0 0 12px;color:var(--red)">Warnings</h4>
          <ul style="margin:0;padding-left:20px">${skill.warnings.map((w) => `<li style="color:var(--red)">${escapeHtml(w)}</li>`).join('')}</ul>
        </div>
      `;
    }

    if (skill.tools?.length) {
      detailHtml += `
        <div class="detail-card" style="margin-top:16px">
          <h4 style="margin:0 0 12px">Tools (${skill.tools.length})</h4>
          <table>
            <thead><tr><th>Name</th><th>Description</th><th>Parameters</th></tr></thead>
            <tbody>${skill.tools
              .map((t) => {
                const paramKeys = t.parameters?.properties
                  ? Object.keys(t.parameters.properties).join(', ')
                  : '--';
                return `<tr>
                <td><code>${escapeHtml(t.name)}</code></td>
                <td class="text-dim">${escapeHtml(t.description || '')}</td>
                <td class="text-dim">${escapeHtml(paramKeys)}</td>
              </tr>`;
              })
              .join('')}</tbody>
          </table>
        </div>
      `;
    }

    // Source code
    detailHtml += `<div class="detail-card" style="margin-top:16px" id="source-card"><h4 style="margin:0 0 12px">Handler Code</h4><p class="text-dim">Loading...</p></div>`;
  }

  // Actions
  if (isExternal) {
    detailHtml += `
      <div class="actions">
        <a href="#/automations/skills/${encodeURIComponent(id)}/edit" class="btn">Edit</a>
        <button class="btn btn-danger" id="btn-delete-skill">Delete</button>
      </div>
    `;
  }

  el.innerHTML = detailHtml;

  // Load source code for external skills
  if (isExternal) {
    const sourceRes = await api(`/api/skills/${encodeURIComponent(id)}/source`);
    const sourceCard = document.getElementById('source-card');
    if (sourceCard) {
      if (sourceRes.source) {
        sourceCard.innerHTML = `<h4 style="margin:0 0 12px">Handler Code</h4><pre class="code-block" style="max-height:400px;overflow:auto">${escapeHtml(sourceRes.source)}</pre>`;
      } else {
        sourceCard.innerHTML = `<h4 style="margin:0 0 12px">Handler Code</h4><p class="text-dim">Unable to load source.</p>`;
      }
    }

    const deleteBtn = document.getElementById('btn-delete-skill');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Delete skill?',
          message: `Delete external skill "${id}"? This cannot be undone.`,
          confirmLabel: 'Delete',
        });
        if (!ok) return;
        deleteBtn.disabled = true;
        deleteBtn.textContent = 'Deleting...';
        const res = await api(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (res.error) {
          showToast(`Delete failed: ${res.error}`, { tone: 'danger' });
          deleteBtn.disabled = false;
          deleteBtn.textContent = 'Delete';
        } else {
          showToast(`Deleted skill "${id}"`, { tone: 'ok' });
          location.hash = '#/automations/skills';
        }
      });
    }
  }
}

// ─── Edit Page ──────────────────────────────────────────────────────
export async function renderSkillEdit(el, id) {
  el.innerHTML = '<div class="page-title">Edit Skill</div><p class="text-dim">Loading...</p>';

  const [skill, sourceRes] = await Promise.all([
    api(`/api/skills/${encodeURIComponent(id)}`),
    api(`/api/skills/${encodeURIComponent(id)}/source`),
  ]);

  if (skill.error || skill.type !== 'external') {
    el.innerHTML = `<div class="detail-header"><a href="#/automations/skills" class="back">&larr;</a><div class="page-title">Cannot edit this skill</div></div><p class="text-dim">Only external skills can be edited.</p>`;
    return;
  }

  const tools = skill.tools || [];
  const source = sourceRes.source || '';

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/automations/skills/${encodeURIComponent(id)}" class="back">&larr;</a>
      <div class="page-title">Edit ${escapeHtml(skill.name)}</div>
    </div>
    <form id="edit-skill-form" class="detail-card">
      <div class="form-group">
        <label>Name</label>
        <input type="text" name="name" value="${escapeHtml(skill.name || '')}">
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea name="description" rows="2">${escapeHtml(skill.description || '')}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Version</label>
          <input type="text" name="version" value="${escapeHtml(skill.version || '1.0.0')}">
        </div>
      </div>
      <div class="form-separator"></div>
      <div class="form-section-title">Requirements <span class="text-dim text-sm">(comma-separated)</span></div>
      <div class="form-row">
        <div class="form-group">
          <label>Required Binaries</label>
          <input type="text" name="bins" value="${escapeHtml((skill.requires?.bins || []).join(', '))}" placeholder="e.g. ffmpeg, curl">
        </div>
        <div class="form-group">
          <label>Required Env Vars</label>
          <input type="text" name="env" value="${escapeHtml((skill.requires?.env || []).join(', '))}" placeholder="e.g. API_KEY">
        </div>
      </div>
      <div class="form-separator"></div>
      <div class="form-section-title">Tools</div>
      <div id="tools-container">
        ${tools.map((t, i) => renderToolForm(t, i)).join('')}
      </div>
      <button type="button" class="btn btn-sm" id="btn-add-tool" style="margin-top:8px">+ Add Tool</button>
      <div class="form-separator"></div>
      <div class="form-section-title">Handler Code</div>
      <div class="form-group">
        <textarea name="handlerCode" rows="16" style="font-family:monospace;font-size:13px">${escapeHtml(source)}</textarea>
      </div>
      <div class="actions">
        <button type="submit" class="btn btn-primary">Save</button>
        <a href="#/automations/skills/${encodeURIComponent(id)}" class="btn">Cancel</a>
      </div>
    </form>
    <div id="save-notice" style="display:none;margin-top:12px;padding:12px;background:var(--surface-2);border-radius:6px;color:var(--orange)">
      Restart required to apply changes.
    </div>
  `;

  let toolIndex = tools.length;

  document.getElementById('btn-add-tool').addEventListener('click', () => {
    const container = document.getElementById('tools-container');
    const div = document.createElement('div');
    div.innerHTML = renderToolForm(
      { name: '', description: '', parameters: { type: 'object', properties: {}, required: [] } },
      toolIndex
    );
    container.appendChild(div.firstElementChild);
    toolIndex++;
  });

  document.getElementById('edit-skill-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;

    const toolForms = form.querySelectorAll('.tool-form');
    const updatedTools = [];
    for (const err of form.querySelectorAll('.field-error')) err.remove();
    for (const tf of toolForms) {
      const name = tf.querySelector('[name="toolName"]').value.trim();
      const desc = tf.querySelector('[name="toolDesc"]').value.trim();
      const paramsRaw = tf.querySelector('[name="toolParams"]').value.trim();
      if (!name) continue;
      let parameters;
      try {
        parameters = paramsRaw ? JSON.parse(paramsRaw) : { type: 'object', properties: {} };
      } catch (err) {
        const area = tf.querySelector('[name="toolParams"]');
        area.insertAdjacentHTML(
          'afterend',
          `<div class="field-error" role="alert">Invalid JSON: ${escapeHtml(err.message || 'parse error')}</div>`
        );
        area.focus();
        return;
      }
      updatedTools.push({ name, description: desc, parameters });
    }

    const bins = form.bins.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const envVars = form.env.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const skillJson = {
      id: skill.id,
      name: form.name.value.trim(),
      version: form.version.value.trim(),
      description: form.description.value.trim(),
      tools: updatedTools,
    };
    if (bins.length || envVars.length) {
      skillJson.requires = {};
      if (bins.length) skillJson.requires.bins = bins;
      if (envVars.length) skillJson.requires.env = envVars;
    }

    const handlerCode = form.handlerCode.value;

    const res = await api(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { skillJson, handlerCode },
    });

    if (res.error) {
      showToast(`Save failed: ${res.error}`, { tone: 'danger' });
    } else {
      document.getElementById('save-notice').style.display = '';
      showToast('Skill saved — restart required to apply.', { tone: 'ok' });
    }
  });
}

function renderToolForm(tool, index) {
  const params = tool.parameters
    ? JSON.stringify(tool.parameters, null, 2)
    : '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}';

  return `
    <div class="tool-form" style="border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:8px">
      <div class="form-row">
        <div class="form-group" style="flex:1">
          <label>Tool Name</label>
          <input type="text" name="toolName" value="${escapeHtml(tool.name || '')}" placeholder="tool_name">
        </div>
        <div class="form-group" style="flex:2">
          <label>Description</label>
          <input type="text" name="toolDesc" value="${escapeHtml(tool.description || '')}">
        </div>
      </div>
      <div class="form-group">
        <label>Parameters (JSON)</label>
        <textarea name="toolParams" rows="4" style="font-family:monospace;font-size:12px">${escapeHtml(params)}</textarea>
      </div>
      <button type="button" class="btn btn-sm btn-danger" onclick="this.closest('.tool-form').remove()">Remove Tool</button>
    </div>
  `;
}

// ─── Create Page ────────────────────────────────────────────────────
export async function renderSkillCreate(el) {
  el.innerHTML = '<div class="page-title">Create Skill</div><p class="text-dim">Loading...</p>';

  const foldersRes = await api('/api/settings/skills-folders');
  const folders = foldersRes.paths || [];

  if (folders.length === 0) {
    el.innerHTML = `
      <div class="detail-header">
        <a href="#/automations/skills" class="back">&larr;</a>
        <div class="page-title">Create Skill</div>
      </div>
      <div class="detail-card">
        <p>No skills folders configured. Add at least one folder in <a href="#/settings">Settings</a> before creating skills.</p>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/automations/skills" class="back">&larr;</a>
      <div class="page-title">Create Skill</div>
    </div>
    <form id="create-skill-form" class="detail-card">
      <div class="form-row">
        <div class="form-group">
          <label>ID (slug)</label>
          <input type="text" name="id" placeholder="my-skill" required>
        </div>
        <div class="form-group">
          <label>Name</label>
          <input type="text" name="name" placeholder="My Skill" required>
        </div>
      </div>
      <div class="form-group">
        <label>Description</label>
        <input type="text" name="description" placeholder="What this skill does" required>
      </div>
      <div class="form-group">
        <label>Purpose / Requirements</label>
        <textarea name="purpose" rows="4" placeholder="Describe what tools this skill should provide, what APIs it interacts with, what parameters each tool needs..."></textarea>
      </div>
      <div class="form-group">
        <label>Target Folder</label>
        <select name="targetFolder">
          ${folders.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('')}
        </select>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-primary" id="btn-generate">Generate with AI</button>
        <button type="button" class="btn" id="btn-manual">Create Manually</button>
      </div>
    </form>
  `;

  const form = document.getElementById('create-skill-form');
  // `form.id` / `form.name` are the form's own properties, not the inputs.
  const readFields = () => {
    const v = (n) => String(form.elements.namedItem(n)?.value ?? '').trim();
    return {
      id: v('id'),
      name: v('name'),
      description: v('description'),
      purpose: v('purpose'),
      targetFolder: form.elements.namedItem('targetFolder')?.value ?? '',
    };
  };
  /** Inline errors under each field; returns true when the form is valid. */
  const showErrors = (errors) => {
    for (const e of form.querySelectorAll('.field-error')) e.remove();
    for (const i of form.querySelectorAll('[aria-invalid]')) i.removeAttribute('aria-invalid');
    let first = null;
    for (const [field, msg] of Object.entries(errors)) {
      const input = form.elements.namedItem(field);
      if (!input) continue;
      input.setAttribute('aria-invalid', 'true');
      input.insertAdjacentHTML(
        'afterend',
        `<div class="field-error" role="alert">${escapeHtml(msg)}</div>`
      );
      first ??= input;
    }
    first?.focus();
    return !first;
  };
  form.addEventListener('input', (e) => {
    if (e.target.getAttribute('aria-invalid') !== 'true') return;
    e.target.removeAttribute('aria-invalid');
    const next = e.target.nextElementSibling;
    if (next?.classList.contains('field-error')) next.remove();
  });

  document.getElementById('btn-generate').addEventListener('click', async () => {
    const { id, name, description, purpose, targetFolder } = readFields();
    if (!showErrors(validateSkillCreate({ id, name, description, purpose }, 'ai'))) return;

    const btn = document.getElementById('btn-generate');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    try {
      const result = await api('/api/skills/generate', {
        method: 'POST',
        body: { id, name, description, purpose },
      });

      if (result.error) {
        showToast(`Generation failed: ${result.error}`, { tone: 'danger', duration: 6000 });
        btn.disabled = false;
        btn.textContent = 'Generate with AI';
        return;
      }

      btn.disabled = false;
      btn.textContent = 'Generate with AI';
      showSkillPreviewModal(result, { id, name, targetFolder }, el);
    } catch (err) {
      showToast(`Generation failed: ${err.message || err}`, { tone: 'danger', duration: 6000 });
      btn.disabled = false;
      btn.textContent = 'Generate with AI';
    }
  });

  document.getElementById('btn-manual').addEventListener('click', () => {
    const { id, name, description, targetFolder } = readFields();
    if (!showErrors(validateSkillCreate({ id, name }, 'manual'))) return;

    const skillJson = {
      id,
      name,
      version: '1.0.0',
      description,
      tools: [
        {
          name: 'example_tool',
          description: 'An example tool — replace with your implementation',
          parameters: {
            type: 'object',
            properties: {
              input: { type: 'string', description: 'Input value' },
            },
            required: ['input'],
          },
        },
      ],
    };

    const handlerCode = `export const handlers = {
  example_tool: async (args, ctx) => {
    const { input } = args;
    ctx.logger.info({ input }, 'example_tool called');
    return { success: true, result: \`Processed: \${input}\` };
  },
};
`;

    showSkillPreviewModal({ skillJson, handlerCode }, { id, name, targetFolder }, el);
  });
}

function showSkillPreviewModal(generated, meta, parentEl) {
  const { skillJson, handlerCode } = generated;
  const { id, name, targetFolder } = meta;

  closeModal();
  showModal(`
    <div class="modal-title">Skill Preview: ${escapeHtml(name)}</div>
    <div style="max-height:60vh;overflow-y:auto">
      <h4>skill.json</h4>
      <pre class="code-block">${escapeHtml(JSON.stringify(skillJson, null, 2))}</pre>
      <h4>index.ts</h4>
      <pre class="code-block">${escapeHtml(handlerCode)}</pre>
    </div>
    <div class="modal-actions">
      <button class="btn" id="preview-cancel">Cancel</button>
      <button class="btn" id="preview-regenerate">Regenerate</button>
      <button class="btn btn-primary" id="preview-apply">Apply</button>
    </div>
  `);

  document.getElementById('preview-cancel').addEventListener('click', closeModal);

  document.getElementById('preview-regenerate').addEventListener('click', async () => {
    const btn = document.getElementById('preview-regenerate');
    btn.disabled = true;
    btn.textContent = 'Regenerating...';

    const form = document.getElementById('create-skill-form');
    const description = form?.description?.value?.trim() || '';
    const purpose = form?.purpose?.value?.trim() || '';

    try {
      const result = await api('/api/skills/generate', {
        method: 'POST',
        body: { id, name, description, purpose },
      });

      if (result.error) {
        showToast(`Regeneration failed: ${result.error}`, { tone: 'danger', duration: 6000 });
        btn.disabled = false;
        btn.textContent = 'Regenerate';
        return;
      }

      showSkillPreviewModal(result, meta, parentEl);
    } catch (err) {
      showToast(`Regeneration failed: ${err.message || err}`, { tone: 'danger', duration: 6000 });
      btn.disabled = false;
      btn.textContent = 'Regenerate';
    }
  });

  document.getElementById('preview-apply').addEventListener('click', async () => {
    const btn = document.getElementById('preview-apply');
    btn.disabled = true;
    btn.textContent = 'Applying...';

    try {
      const res = await api('/api/skills/generate/apply', {
        method: 'POST',
        body: { id, targetFolder, skillJson, handlerCode },
      });

      if (res.error) {
        showToast(`Apply failed: ${res.error}`, { tone: 'danger', duration: 6000 });
        btn.disabled = false;
        btn.textContent = 'Apply';
        return;
      }

      closeModal();
      showToast(`Skill "${name}" created`, { tone: 'ok' });
      location.hash = '#/automations/skills';
    } catch (err) {
      showToast(`Apply failed: ${err.message || err}`, { tone: 'danger', duration: 6000 });
      btn.disabled = false;
      btn.textContent = 'Apply';
    }
  });
}
