import { api, escapeHtml, getAuthContext, resolveTenantId } from './shared.js';

/**
 * Chip-based list editor helper.
 * Returns { el, getItems } where el is the DOM container and getItems() returns current items.
 */
function createListEditor(containerId, items, placeholder) {
  const current = [...items];

  function render(container) {
    container.innerHTML = `
      <div class="list-editor-items">${current
        .map(
          (item, i) =>
            `<span class="list-editor-chip">${escapeHtml(item)}<button class="remove-chip" data-idx="${i}">&times;</button></span>`
        )
        .join('')}${current.length === 0 ? '<span class="text-dim text-sm">None</span>' : ''}</div>
      <div class="input-with-btn" style="margin-top:6px">
        <input type="text" class="list-editor-input" placeholder="${escapeHtml(placeholder || 'Add item...')}">
        <button class="btn btn-sm list-editor-add">Add</button>
      </div>`;

    container.querySelector('.list-editor-add').addEventListener('click', () => {
      const input = container.querySelector('.list-editor-input');
      const val = input.value.trim();
      if (val && !current.includes(val)) {
        current.push(val);
        render(container);
      }
    });

    container.querySelector('.list-editor-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        container.querySelector('.list-editor-add').click();
      }
    });

    container.querySelectorAll('.remove-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        current.splice(Number.parseInt(btn.dataset.idx), 1);
        render(container);
      });
    });
  }

  return {
    render(container) {
      render(container);
    },
    getItems() {
      return [...current];
    },
  };
}

/**
 * #/baas/customizations — Per-bot customization overlays
 */
export async function renderBaasCustomizations(el) {
  el.innerHTML =
    '<div class="page-title">Customizations</div><div id="cust-tenant-picker"></div><p class="text-dim">Loading...</p>';

  const tenantId = await resolveTenantId(el.querySelector('#cust-tenant-picker'), () =>
    renderBaasCustomizations(el)
  );
  if (!tenantId) return;

  const [data, botsData] = await Promise.all([
    api(`/api/baas/customizations/${encodeURIComponent(tenantId)}`),
    api('/api/agents'),
  ]);

  if (data.error) {
    el.innerHTML = `<div class="page-title">Customizations</div><p class="text-dim">${escapeHtml(data.error)}</p>`;
    return;
  }

  const customs = Array.isArray(data) ? data : [];
  const allBots = Array.isArray(botsData) ? botsData : [];
  const customizedBotIds = new Set(customs.map((c) => c.botId));
  const availableBots = allBots.filter((b) => !customizedBotIds.has(b.id));

  const newCustButton =
    availableBots.length > 0
      ? '<button class="btn btn-primary" id="new-cust-btn">+ New Customization</button>'
      : '';

  function newCustPickerHtml() {
    if (availableBots.length === 0) return '';
    return `
      <div id="new-cust-picker" style="display:none;margin-bottom:16px">
        <label>Select bot:</label>
        <select id="new-cust-select" style="margin-left:8px">
          <option value="">-- choose a bot --</option>
          ${availableBots.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name || b.id)}</option>`).join('')}
        </select>
      </div>`;
  }

  function attachNewCustListeners(pageEl) {
    const btn = pageEl.querySelector('#new-cust-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const picker = pageEl.querySelector('#new-cust-picker');
      picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
    });
    pageEl.querySelector('#new-cust-select').addEventListener('change', (e) => {
      const botId = e.target.value;
      if (!botId) return;
      const bot = availableBots.find((b) => b.id === botId);
      const empty = {
        botId,
        tenantId,
        displayName: bot?.name || '',
        identityOverride: '',
        knowledge: [],
        goals: [],
        rules: [],
        welcomeMessage: '',
        brandColor: '#6c8cff',
        avatarUrl: '',
      };
      renderEditView(pageEl, tenantId, empty);
    });
  }

  if (customs.length === 0) {
    el.innerHTML = `
      <div class="flex-between mb-16">
        <div class="page-title">Customizations</div>
        ${newCustButton}
      </div>
      ${newCustPickerHtml()}
      <p class="text-dim">No bot customizations found for this tenant.</p>
      <div id="custom-edit-area"></div>`;
    attachNewCustListeners(el);
    return;
  }

  // Card view of all customizations
  let html = `
    <div class="flex-between mb-16">
      <div class="page-title">Customizations <span class="count">${customs.length}</span></div>
      ${newCustButton}
    </div>`;
  html += newCustPickerHtml();
  html += '<div style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:20px">';

  for (const c of customs) {
    const knowledgeCount = (c.knowledge || []).length;
    const goalsCount = (c.goals || []).length;
    const rulesCount = (c.rules || []).length;
    const color = c.brandColor || '#6c8cff';

    html += `
      <div class="custom-card" data-bot-id="${escapeHtml(c.botId)}">
        <div class="custom-card-info">
          <div class="custom-card-name">${escapeHtml(c.displayName || c.botId)}</div>
          <div class="custom-card-meta">
            ${c.identityOverride ? `<span class="text-dim">${escapeHtml(c.identityOverride.slice(0, 60))}${c.identityOverride.length > 60 ? '...' : ''}</span>` : ''}
          </div>
          <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">
            <span class="badge badge-mcp">${knowledgeCount} knowledge</span>
            <span class="badge badge-mcp">${goalsCount} goals</span>
            <span class="badge badge-mcp">${rulesCount} rules</span>
          </div>
        </div>
        <div class="color-swatch" style="background:${escapeHtml(color)}" title="${escapeHtml(color)}"></div>
      </div>`;
  }

  html += '</div>';
  html += '<div id="custom-edit-area"></div>';
  el.innerHTML = html;

  attachNewCustListeners(el);

  // Click card to edit inline
  el.querySelectorAll('.custom-card').forEach((card) => {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      const botId = card.dataset.botId;
      const custom = customs.find((c) => c.botId === botId);
      if (custom) renderEditView(el, tenantId, custom);
    });
  });
}

function renderEditView(pageEl, tenantId, custom) {
  const editArea = pageEl.querySelector('#custom-edit-area');
  if (!editArea) return;

  const knowledgeEditor = createListEditor(
    'knowledge',
    custom.knowledge || [],
    'Add knowledge item...'
  );
  const goalsEditor = createListEditor('goals', custom.goals || [], 'Add a goal...');
  const rulesEditor = createListEditor('rules', custom.rules || [], 'Add a rule...');

  editArea.innerHTML = `
    <div class="detail-card">
      <div class="form-section-title">Editing: ${escapeHtml(custom.displayName || custom.botId)}</div>
      <div class="form-group"><label>Display Name</label><input type="text" id="ce-displayname" value="${escapeHtml(custom.displayName || '')}"></div>
      <div class="form-group"><label>Identity Override</label><textarea id="ce-identity" rows="3">${escapeHtml(custom.identityOverride || '')}</textarea></div>
      <div class="form-group"><label>Knowledge</label><div id="ce-knowledge"></div></div>
      <div class="form-group"><label>Goals</label><div id="ce-goals"></div></div>
      <div class="form-group"><label>Rules</label><div id="ce-rules"></div></div>
      <div class="form-group"><label>Welcome Message</label><textarea id="ce-welcome" rows="2">${escapeHtml(custom.welcomeMessage || '')}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label>Brand Color</label><input type="color" id="ce-color" value="${custom.brandColor || '#6c8cff'}" style="width:60px;height:34px;padding:2px"></div>
        <div class="form-group"><label>Avatar URL</label><input type="text" id="ce-avatar" value="${escapeHtml(custom.avatarUrl || '')}"></div>
      </div>
      <div class="actions" style="margin-top:16px">
        <button class="btn btn-primary" id="ce-save">Save</button>
        <button class="btn" id="ce-cancel">Cancel</button>
      </div>
    </div>`;

  knowledgeEditor.render(editArea.querySelector('#ce-knowledge'));
  goalsEditor.render(editArea.querySelector('#ce-goals'));
  rulesEditor.render(editArea.querySelector('#ce-rules'));

  editArea.querySelector('#ce-cancel').addEventListener('click', () => {
    editArea.innerHTML = '';
  });

  editArea.querySelector('#ce-save').addEventListener('click', async () => {
    const body = {
      displayName: editArea.querySelector('#ce-displayname').value.trim(),
      identityOverride: editArea.querySelector('#ce-identity').value,
      knowledge: knowledgeEditor.getItems(),
      goals: goalsEditor.getItems(),
      rules: rulesEditor.getItems(),
      welcomeMessage: editArea.querySelector('#ce-welcome').value,
      brandColor: editArea.querySelector('#ce-color').value,
      avatarUrl: editArea.querySelector('#ce-avatar').value.trim(),
    };

    const res = await api(
      `/api/baas/customizations/${encodeURIComponent(tenantId)}/${encodeURIComponent(custom.botId)}`,
      {
        method: 'PUT',
        body,
      }
    );

    if (res.error) {
      alert(`Error: ${res.error}`);
    } else {
      renderBaasCustomizations(pageEl);
    }
  });
}
