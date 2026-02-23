import { showModal, closeModal, api, escapeHtml } from './shared.js';

function typeBadge(type) {
  return type === 'builtin'
    ? '<span class="badge badge-ok">Built-in</span>'
    : '<span class="badge badge-medium">External</span>';
}

// ─── List Page ──────────────────────────────────────────────────────
export async function renderSkills(el) {
  el.innerHTML = '<div class="page-title">Skills</div><p class="text-dim">Loading...</p>';

  const skills = await api('/api/skills');
  if (skills.error) {
    el.innerHTML = `<p style="color:var(--red)">${escapeHtml(skills.error)}</p>`;
    return;
  }

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Skills <span class="count">${skills.length}</span></div>
      <a href="#/skills/new" class="btn btn-primary">+ Create Skill</a>
    </div>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Version</th>
          <th>Commands / Tools</th>
          <th>Warnings</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="skills-tbody"></tbody>
    </table>
  `;

  const tbody = document.getElementById('skills-tbody');
  for (const skill of skills) {
    const tr = document.createElement('tr');
    const countLabel = skill.type === 'builtin'
      ? `${(skill.commands || []).length} cmds`
      : `${skill.toolCount || 0} tools`;

    const warningBadge = skill.warnings?.length
      ? `<span class="badge badge-error">${skill.warnings.length}</span>`
      : '<span class="text-dim">--</span>';

    const actions = skill.type === 'external'
      ? `<a href="#/skills/${encodeURIComponent(skill.id)}/edit" class="btn btn-sm">Edit</a>
         <button class="btn btn-sm btn-danger" data-action="delete" data-id="${escapeHtml(skill.id)}">Delete</button>`
      : '';

    tr.innerHTML = `
      <td><a href="#/skills/${encodeURIComponent(skill.id)}">${escapeHtml(skill.name)}</a></td>
      <td>${typeBadge(skill.type)}</td>
      <td class="text-dim">${escapeHtml(skill.version || '--')}</td>
      <td class="text-dim">${countLabel}</td>
      <td>${warningBadge}</td>
      <td class="actions">${actions}</td>
    `;
    tbody.appendChild(tr);
  }

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'delete') {
      if (!confirm(`Delete external skill "${id}"? The skill directory will be removed from disk. This cannot be undone.`)) return;
      btn.disabled = true;
      btn.textContent = 'Deleting...';
      const res = await api(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.error) {
        alert(`Delete failed: ${res.error}`);
        btn.disabled = false;
        btn.textContent = 'Delete';
      } else {
        renderSkills(el);
      }
    }
  });
}

// ─── Detail Page ────────────────────────────────────────────────────
export async function renderSkillDetail(el, id) {
  el.innerHTML = '<div class="page-title">Skill Detail</div><p class="text-dim">Loading...</p>';

  const skill = await api(`/api/skills/${encodeURIComponent(id)}`);
  if (skill.error) {
    el.innerHTML = `<div class="detail-header"><a href="#/skills" class="back">&larr;</a><div class="page-title">Skill not found</div></div>`;
    return;
  }

  const isExternal = skill.type === 'external';

  let detailHtml = `
    <div class="detail-header">
      <a href="#/skills" class="back">&larr;</a>
      <div class="page-title">${escapeHtml(skill.name)} ${typeBadge(skill.type)}</div>
    </div>
    <div class="detail-card">
      <table>
        <tr><td class="text-dim" style="width:140px">ID</td><td>${escapeHtml(skill.id)}</td></tr>
        <tr><td class="text-dim">Version</td><td>${escapeHtml(skill.version || '--')}</td></tr>
        <tr><td class="text-dim">Description</td><td>${escapeHtml(skill.description || '--')}</td></tr>
        ${isExternal ? `<tr><td class="text-dim">Directory</td><td><code>${escapeHtml(skill.dir)}</code></td></tr>` : ''}
        ${!isExternal ? `<tr><td class="text-dim">LLM Backend</td><td>${escapeHtml(skill.llmBackend || '--')}</td></tr>` : ''}
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
            <tbody>${skill.tools.map((t) => {
              const paramKeys = t.parameters?.properties ? Object.keys(t.parameters.properties).join(', ') : '--';
              return `<tr>
                <td><code>${escapeHtml(t.name)}</code></td>
                <td class="text-dim">${escapeHtml(t.description || '')}</td>
                <td class="text-dim">${escapeHtml(paramKeys)}</td>
              </tr>`;
            }).join('')}</tbody>
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
        <a href="#/skills/${encodeURIComponent(id)}/edit" class="btn">Edit</a>
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
        if (!confirm(`Delete external skill "${id}"? This cannot be undone.`)) return;
        deleteBtn.disabled = true;
        deleteBtn.textContent = 'Deleting...';
        const res = await api(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (res.error) {
          alert(`Delete failed: ${res.error}`);
          deleteBtn.disabled = false;
          deleteBtn.textContent = 'Delete';
        } else {
          location.hash = '#/skills';
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
    el.innerHTML = `<div class="detail-header"><a href="#/skills" class="back">&larr;</a><div class="page-title">Cannot edit this skill</div></div><p class="text-dim">Only external skills can be edited.</p>`;
    return;
  }

  const tools = skill.tools || [];
  const source = sourceRes.source || '';

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/skills/${encodeURIComponent(id)}" class="back">&larr;</a>
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
        <a href="#/skills/${encodeURIComponent(id)}" class="btn">Cancel</a>
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
    div.innerHTML = renderToolForm({ name: '', description: '', parameters: { type: 'object', properties: {}, required: [] } }, toolIndex);
    container.appendChild(div.firstElementChild);
    toolIndex++;
  });

  document.getElementById('edit-skill-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;

    const toolForms = form.querySelectorAll('.tool-form');
    const updatedTools = [];
    for (const tf of toolForms) {
      const name = tf.querySelector('[name="toolName"]').value.trim();
      const desc = tf.querySelector('[name="toolDesc"]').value.trim();
      const paramsRaw = tf.querySelector('[name="toolParams"]').value.trim();
      if (!name) continue;
      let parameters;
      try {
        parameters = paramsRaw ? JSON.parse(paramsRaw) : { type: 'object', properties: {} };
      } catch {
        alert(`Invalid JSON in parameters for tool "${name}"`);
        return;
      }
      updatedTools.push({ name, description: desc, parameters });
    }

    const bins = form.bins.value.split(',').map((s) => s.trim()).filter(Boolean);
    const envVars = form.env.value.split(',').map((s) => s.trim()).filter(Boolean);

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
      alert(`Save failed: ${res.error}`);
    } else {
      document.getElementById('save-notice').style.display = '';
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
        <a href="#/skills" class="back">&larr;</a>
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
      <a href="#/skills" class="back">&larr;</a>
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

  document.getElementById('btn-generate').addEventListener('click', async () => {
    const form = document.getElementById('create-skill-form');
    const id = form.id.value.trim();
    const name = form.name.value.trim();
    const description = form.description.value.trim();
    const purpose = form.purpose.value.trim();
    const targetFolder = form.targetFolder.value;

    if (!id || !name || !description || !purpose) {
      alert('All fields are required for AI generation.');
      return;
    }

    const btn = document.getElementById('btn-generate');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    try {
      const result = await api('/api/skills/generate', {
        method: 'POST',
        body: { id, name, description, purpose },
      });

      if (result.error) {
        alert(`Generation failed: ${result.error}`);
        btn.disabled = false;
        btn.textContent = 'Generate with AI';
        return;
      }

      showSkillPreviewModal(result, { id, name, targetFolder }, el);
    } catch (err) {
      alert(`Generation failed: ${err.message || err}`);
      btn.disabled = false;
      btn.textContent = 'Generate with AI';
    }
  });

  document.getElementById('btn-manual').addEventListener('click', () => {
    const form = document.getElementById('create-skill-form');
    const id = form.id.value.trim();
    const name = form.name.value.trim();
    const description = form.description.value.trim();
    const targetFolder = form.targetFolder.value;

    if (!id || !name) {
      alert('ID and Name are required.');
      return;
    }

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
        alert(`Regeneration failed: ${result.error}`);
        btn.disabled = false;
        btn.textContent = 'Regenerate';
        return;
      }

      showSkillPreviewModal(result, meta, parentEl);
    } catch (err) {
      alert(`Regeneration failed: ${err.message || err}`);
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
        alert(`Apply failed: ${res.error}`);
        btn.disabled = false;
        btn.textContent = 'Apply';
        return;
      }

      closeModal();
      location.hash = '#/skills';
    } catch (err) {
      alert(`Apply failed: ${err.message || err}`);
      btn.disabled = false;
      btn.textContent = 'Apply';
    }
  });
}
