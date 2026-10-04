import { badge, esc } from '../ui/index.js';
import { api } from './shared.js';
import { collectArgs, paramFormHtml } from './tools-helpers.js';

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
      showResult(
        'error',
        `${badge('Error', 'danger')} <span class="tool-run-msg">${esc(error)}</span>`
      );
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
      showResult(
        'error',
        `${badge('Error', 'danger')} <span class="tool-run-msg">${esc(data.error)}</span>`
      );
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
