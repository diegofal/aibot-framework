import { api, escapeHtml } from './shared.js';

export async function renderToolRunner(el) {
  el.innerHTML =
    '<div class="page-title">Tool Runner</div><p class="text-dim">Loading tools...</p>';

  const tools = await api('/api/tools/all');

  if (tools.error) {
    el.innerHTML = `
      <div class="page-title">Tool Runner</div>
      <p class="text-dim">Tool Runner requires dynamic tools to be enabled. Set <code>dynamicTools.enabled: true</code> in config.</p>
    `;
    return;
  }

  const builtIn = tools.filter((t) => t.source === 'built-in');
  const mcp = tools.filter((t) => t.source === 'mcp');
  const dynamic = tools.filter((t) => t.source === 'dynamic');

  el.innerHTML = `
    <div class="page-title">Tool Runner <span class="count">${tools.length} tools</span></div>

    <div style="display:flex;gap:20px;min-height:400px">
      <!-- Tool selector panel -->
      <div style="width:280px;min-width:280px;display:flex;flex-direction:column">
        <div class="form-group" style="margin-bottom:8px">
          <input type="text" id="tool-search" placeholder="Search tools..." style="width:100%">
        </div>
        <div id="tool-list" style="flex:1;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-card)">
        </div>
      </div>

      <!-- Tool detail + execution panel -->
      <div style="flex:1;min-width:0">
        <div id="tool-detail">
          <div class="detail-card">
            <p class="text-dim">Select a tool from the list to view its details and execute it.</p>
          </div>
        </div>
      </div>
    </div>
  `;

  const toolList = document.getElementById('tool-list');
  const toolDetail = document.getElementById('tool-detail');
  const searchInput = document.getElementById('tool-search');
  let selectedTool = null;

  function renderList(filter = '') {
    const lower = filter.toLowerCase();
    const filteredBuiltIn = builtIn.filter(
      (t) => t.name.toLowerCase().includes(lower) || t.description.toLowerCase().includes(lower)
    );
    const filteredMcp = mcp.filter(
      (t) => t.name.toLowerCase().includes(lower) || t.description.toLowerCase().includes(lower)
    );
    const filteredDynamic = dynamic.filter(
      (t) => t.name.toLowerCase().includes(lower) || t.description.toLowerCase().includes(lower)
    );

    let html = '';

    if (filteredBuiltIn.length > 0) {
      html +=
        '<div style="padding:6px 10px;font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)">Built-in</div>';
      for (const t of filteredBuiltIn) {
        const active =
          selectedTool && selectedTool.name === t.name
            ? ' style="background:var(--bg-hover);border-left:3px solid var(--accent)"'
            : '';
        html += `<div class="tool-list-item" data-name="${escapeHtml(t.name)}"${active}>
          <div style="font-weight:500;font-size:13px">${escapeHtml(t.name)}</div>
          <div style="font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(t.description.slice(0, 80))}</div>
        </div>`;
      }
    }

    if (filteredMcp.length > 0) {
      html +=
        '<div style="padding:6px 10px;font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)">MCP Servers</div>';
      // Group by category (server prefix)
      const byServer = {};
      for (const t of filteredMcp) {
        const key = t.category || 'unknown';
        if (!byServer[key]) byServer[key] = [];
        byServer[key].push(t);
      }
      const sortedServers = Object.keys(byServer).sort();
      for (const server of sortedServers) {
        const serverTools = byServer[server];
        html += `<div style="padding:4px 10px;font-size:11px;display:flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent)"></span>
          <span style="color:var(--text);font-weight:500">${escapeHtml(server)}</span>
          <span style="color:var(--text-dim)">${serverTools.length}</span>
        </div>`;
        for (const t of serverTools) {
          const active =
            selectedTool && selectedTool.name === t.name
              ? ' style="background:var(--bg-hover);border-left:3px solid var(--accent);padding-left:22px"'
              : ' style="padding-left:22px"';
          html += `<div class="tool-list-item" data-name="${escapeHtml(t.name)}"${active}>
            <div style="font-weight:500;font-size:13px">${escapeHtml(t.name)}</div>
            <div style="font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(t.description.slice(0, 80))}</div>
          </div>`;
        }
      }
    }

    if (filteredDynamic.length > 0) {
      html +=
        '<div style="padding:6px 10px;font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)">Dynamic</div>';
      for (const t of filteredDynamic) {
        const statusBadge =
          t.status === 'approved'
            ? '<span class="badge badge-running" style="margin-left:6px;font-size:9px">approved</span>'
            : t.status === 'pending'
              ? '<span class="badge badge-pending" style="margin-left:6px;font-size:9px">pending</span>'
              : `<span class="badge badge-stopped" style="margin-left:6px;font-size:9px">${escapeHtml(t.status)}</span>`;
        const active =
          selectedTool && selectedTool.name === t.name
            ? ' style="background:var(--bg-hover);border-left:3px solid var(--accent)"'
            : '';
        html += `<div class="tool-list-item" data-name="${escapeHtml(t.name)}"${active}>
          <div style="font-weight:500;font-size:13px">${escapeHtml(t.name)}${statusBadge}</div>
          <div style="font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(t.description.slice(0, 80))}</div>
        </div>`;
      }
    }

    if (filteredBuiltIn.length === 0 && filteredMcp.length === 0 && filteredDynamic.length === 0) {
      html =
        '<div style="padding:16px;color:var(--text-dim);text-align:center">No tools match your search.</div>';
    }

    toolList.innerHTML = html;
  }

  function renderDetail(tool) {
    const params = tool.parameters;
    const properties = params?.properties || {};
    const required = new Set(params?.required || []);
    const paramNames = Object.keys(properties);

    let formHtml = '';
    if (paramNames.length === 0) {
      formHtml = '<p class="text-dim">This tool takes no parameters.</p>';
    } else {
      for (const name of paramNames) {
        const prop = properties[name];
        const isRequired = required.has(name);
        const desc = prop.description || '';
        const type = prop.type || 'string';
        const reqMark = isRequired ? ' <span style="color:var(--red)">*</span>' : '';

        formHtml += `<div class="form-group">`;
        formHtml += `<label>${escapeHtml(name)}${reqMark} <span style="text-transform:none;font-weight:400">(${escapeHtml(type)})</span></label>`;

        if (type === 'boolean') {
          formHtml += `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;text-transform:none;font-size:13px">
            <input type="checkbox" data-param="${escapeHtml(name)}" data-type="boolean"> ${escapeHtml(desc)}
          </label>`;
        } else if (type === 'number' || type === 'integer') {
          formHtml += `<input type="number" data-param="${escapeHtml(name)}" data-type="number" placeholder="${escapeHtml(desc)}" style="width:100%">`;
        } else if (type === 'object' || type === 'array') {
          formHtml += `<textarea data-param="${escapeHtml(name)}" data-type="${escapeHtml(type)}" rows="3" placeholder='${escapeHtml(desc || `JSON ${type}`)}'></textarea>`;
        } else if (prop.enum && Array.isArray(prop.enum)) {
          formHtml += `<select data-param="${escapeHtml(name)}" data-type="enum" style="width:100%">`;
          formHtml += `<option value="">-- select --</option>`;
          for (const val of prop.enum) {
            formHtml += `<option value="${escapeHtml(String(val))}">${escapeHtml(String(val))}</option>`;
          }
          formHtml += '</select>';
        } else {
          formHtml += `<input type="text" data-param="${escapeHtml(name)}" data-type="string" placeholder="${escapeHtml(desc)}" style="width:100%">`;
        }

        formHtml += '</div>';
      }
    }

    toolDetail.innerHTML = `
      <div class="detail-card">
        <div class="form-section-title">${escapeHtml(tool.name)}
          <span class="badge ${tool.source === 'mcp' ? 'badge-mcp' : tool.source === 'built-in' ? 'badge-running' : 'badge-pending'}" style="font-size:10px">${tool.source === 'mcp' ? 'mcp: ' + escapeHtml(tool.category || 'unknown') : escapeHtml(tool.source)}</span>
          ${tool.status ? `<span class="badge badge-${tool.status === 'approved' ? 'running' : tool.status === 'pending' ? 'pending' : 'stopped'}" style="font-size:10px">${escapeHtml(tool.status)}</span>` : ''}
        </div>
        <p style="margin-bottom:16px;color:var(--text-dim)">${escapeHtml(tool.description)}</p>

        <div class="form-section-title" style="margin-top:16px">Parameters</div>
        <div id="tool-params-form">
          ${formHtml}
        </div>

        <div style="margin-top:16px">
          <button class="btn btn-primary" id="tool-execute-btn">Execute</button>
        </div>
      </div>

      <div id="tool-result" style="display:none">
        <div class="detail-card" id="tool-result-card">
        </div>
      </div>
    `;

    document.getElementById('tool-execute-btn').addEventListener('click', () => executeTool(tool));
  }

  async function executeTool(tool) {
    const btn = document.getElementById('tool-execute-btn');
    btn.disabled = true;
    btn.textContent = 'Executing...';

    const resultDiv = document.getElementById('tool-result');
    const resultCard = document.getElementById('tool-result-card');
    resultDiv.style.display = 'block';
    resultCard.innerHTML = '<p class="text-dim">Running...</p>';

    // Collect args from form
    const args = {};
    const inputs = document.querySelectorAll('#tool-params-form [data-param]');
    for (const input of inputs) {
      const name = input.dataset.param;
      const type = input.dataset.type;

      if (type === 'boolean') {
        args[name] = input.checked;
      } else if (type === 'number') {
        const val = input.value.trim();
        if (val !== '') args[name] = Number(val);
      } else if (type === 'object' || type === 'array') {
        const val = input.value.trim();
        if (val) {
          try {
            args[name] = JSON.parse(val);
          } catch {
            resultCard.innerHTML = `<span class="badge badge-stopped">Error</span> <span style="margin-left:8px">Invalid JSON for parameter "${escapeHtml(name)}"</span>`;
            resultCard.style.borderLeft = '3px solid var(--red)';
            btn.disabled = false;
            btn.textContent = 'Execute';
            return;
          }
        }
      } else if (type === 'enum') {
        const val = input.value;
        if (val !== '') args[name] = val;
      } else {
        const val = input.value.trim();
        if (val !== '') args[name] = val;
      }
    }

    const data = await api('/api/tools/execute', {
      method: 'POST',
      body: { name: tool.name, args },
    });

    btn.disabled = false;
    btn.textContent = 'Execute';

    if (data.error && !('success' in data)) {
      resultCard.style.borderLeft = '3px solid var(--red)';
      resultCard.innerHTML = `<span class="badge badge-stopped">Error</span> <span style="margin-left:8px">${escapeHtml(data.error)}</span>`;
      return;
    }

    const borderColor = data.success ? 'var(--green)' : 'var(--red)';
    const badge = data.success
      ? '<span class="badge badge-running">Success</span>'
      : '<span class="badge badge-stopped">Failure</span>';
    const duration =
      typeof data.durationMs === 'number'
        ? `<span class="text-dim" style="margin-left:8px;font-size:12px">${data.durationMs}ms</span>`
        : '';

    resultCard.style.borderLeft = `3px solid ${borderColor}`;
    resultCard.innerHTML = `
      <div style="margin-bottom:8px">${badge}${duration}</div>
      <pre class="code-block" style="white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto">${escapeHtml(data.content)}</pre>
    `;
  }

  // Wire search
  searchInput.addEventListener('input', () => renderList(searchInput.value));

  // Wire tool selection via delegation
  toolList.addEventListener('click', (e) => {
    const item = e.target.closest('.tool-list-item');
    if (!item) return;
    const name = item.dataset.name;
    const tool = tools.find((t) => t.name === name);
    if (!tool) return;
    selectedTool = tool;
    renderList(searchInput.value);
    renderDetail(tool);
  });

  // Initial render
  renderList();
}
