import { badge, esc } from '../ui/index.js';
import { api } from './shared.js';
import { collectArgs, filterTools, groupTools, paramFormHtml } from './tools-helpers.js';

const SOURCE_TONE = { mcp: 'info', 'built-in': 'ok', dynamic: 'warn' };
const STATUS_TONE = { approved: 'ok', pending: 'warn' };

/**
 * Parameters form + Execute button + result card for one tool, mounted into
 * `container`. Shared by the merged Tools page (Run action → sheet) and the
 * legacy Tool Runner page.
 */
export function mountToolRunForm(container, tool) {
  const sourceLabel = tool.source === 'mcp' ? `mcp: ${tool.category || 'unknown'}` : tool.source;
  container.innerHTML = `
    <div class="detail-card tool-run-card">
      <div class="form-section-title">${esc(tool.name)}
        ${badge(sourceLabel, SOURCE_TONE[tool.source] ?? 'muted')}
        ${tool.status ? badge(tool.status, STATUS_TONE[tool.status] ?? 'danger') : ''}
      </div>
      <p class="tool-run-desc">${esc(tool.description)}</p>
      <div class="form-section-title tool-run-params-title">Parameters</div>
      <form class="tool-run-form" data-tool-form>${paramFormHtml(tool.parameters)}</form>
      <div class="tool-run-actions">
        <button class="btn btn-primary" data-tool-execute>Execute</button>
      </div>
    </div>
    <div class="detail-card tool-run-result" data-tool-result hidden></div>
  `;
  const form = container.querySelector('[data-tool-form]');
  const btn = container.querySelector('[data-tool-execute]');
  const result = container.querySelector('[data-tool-result]');

  const showResult = (tone, html) => {
    result.hidden = false;
    result.className = `detail-card tool-run-result tool-run-result-${tone}`;
    result.innerHTML = html;
  };

  const execute = async () => {
    const fields = [...form.querySelectorAll('[data-param]')].map((input) => ({
      name: input.dataset.param,
      type: input.dataset.type,
      value: input.value,
      checked: input.checked,
    }));
    const { args, error } = collectArgs(fields);
    if (error) {
      showResult('error', `${badge('Error', 'danger')} <span class="tool-run-msg">${esc(error)}</span>`);
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Executing...';
    showResult('pending', '<p class="text-dim">Running...</p>');
    const data = await api('/api/tools/execute', {
      method: 'POST',
      body: { name: tool.name, args },
    });
    btn.disabled = false;
    btn.textContent = 'Execute';
    if (data.error && !('success' in data)) {
      showResult('error', `${badge('Error', 'danger')} <span class="tool-run-msg">${esc(data.error)}</span>`);
      return;
    }
    const duration =
      typeof data.durationMs === 'number'
        ? `<span class="text-dim tool-run-duration">${data.durationMs}ms</span>`
        : '';
    showResult(
      data.success ? 'ok' : 'error',
      `<div class="tool-run-status">${data.success ? badge('Success', 'ok') : badge('Failure', 'danger')}${duration}</div>
      <pre class="code-block tool-run-output">${esc(data.content)}</pre>`
    );
  };

  btn.addEventListener('click', execute);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    execute();
  });
  return { execute };
}

/**
 * Legacy standalone Tool Runner page. The merged Tools page now has a Run
 * action per row; this stays exported (and working) until the nav drops the
 * `#/automations/tool-runner` tab.
 */
export async function renderToolRunner(el) {
  el.innerHTML =
    '<div class="page-title">Tool Runner</div><p class="text-dim">Loading tools...</p>';

  const tools = await api('/api/tools/all');

  if (!Array.isArray(tools)) {
    el.innerHTML = `
      <div class="page-title">Tool Runner</div>
      <p class="text-dim">Tool Runner requires dynamic tools to be enabled. Set <code>dynamicTools.enabled: true</code> in config.</p>
    `;
    return;
  }

  el.innerHTML = `
    <div class="page-title">Tool Runner <span class="count">${tools.length} tools</span></div>
    <p class="text-dim text-sm">Every tool can now also be run from <a href="#/automations/tools">Tools</a>.</p>
    <div class="tool-runner-layout">
      <div class="tool-runner-side">
        <div class="form-group tool-runner-search">
          <input type="text" id="tool-search" placeholder="Search tools..." data-page-filter>
        </div>
        <div id="tool-list" class="tool-runner-list"></div>
      </div>
      <div class="tool-runner-main">
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
  let selectedName = null;

  function renderList(filter = '') {
    const groups = groupTools(filterTools(tools, { query: filter }));
    if (groups.length === 0) {
      toolList.innerHTML = '<div class="tool-runner-empty">No tools match your search.</div>';
      return;
    }
    toolList.innerHTML = groups
      .map(
        (g) =>
          `<div class="tool-runner-group">${esc(g.label)} <span class="text-dim">${g.tools.length}</span></div>${g.tools
            .map((t) => {
              const status =
                t.source === 'dynamic' && t.status
                  ? ` ${badge(t.status, STATUS_TONE[t.status] ?? 'danger')}`
                  : '';
              return `<div class="tool-list-item${t.name === selectedName ? ' is-active' : ''}" data-name="${esc(t.name)}">
                <div class="tool-list-name">${esc(t.name)}${status}</div>
                <div class="tool-list-desc">${esc(String(t.description ?? '').slice(0, 80))}</div>
              </div>`;
            })
            .join('')}`
      )
      .join('');
  }

  searchInput.addEventListener('input', () => renderList(searchInput.value));
  toolList.addEventListener('click', (e) => {
    const item = e.target.closest('.tool-list-item');
    if (!item) return;
    const tool = tools.find((t) => t.name === item.dataset.name);
    if (!tool) return;
    selectedName = tool.name;
    renderList(searchInput.value);
    mountToolRunForm(toolDetail, tool);
  });

  renderList();
}
