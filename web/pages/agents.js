import { registerNavGuard } from '../nav-guard.js';
import { confirmDialog, emptyState, initMenus, showToast } from '../ui/index.js';
import { CUSTOM_VOICE, resolveVoiceChoice, voiceOptions } from './agent-face-helpers.js';
import { authedAvatarSrc, wireFaceControl, wireSpeakButton } from './agent-face.js';
import {
  claudeModelSelect,
  editReturnHash,
  editSectionNav,
  effectiveModelLabel,
  isSaveShortcut,
  showClaudeModelSelect,
  snapshotForm,
  tokenCell,
} from './agent-form-helpers.js';
import { applyPresence, homeTabs, presenceHeader } from './agent-home-helpers.js';
import {
  agentsTable,
  bulkPlan,
  bulkSummary,
  filterAgents,
  listFilterBar,
  readListPrefs,
  sortAgents,
  statusCounts,
  writeListPrefs,
} from './agents-list-helpers.js';
import {
  DIAL_MEANINGS,
  LIMIT_DIALS,
  curiosityFormSection,
  curiositySummary,
  previewDials,
  readCuriosityForm,
} from './curiosity-helpers.js';
import { watchAgent } from './live-presence.js';
import { api, closeModal, escapeHtml, getAuthToken, showModal, timeAgo } from './shared.js';

// Row menus of the agents list (session S3.5): one click-away handler per render.
let closeAgentMenus = null;

// Live presence header (session S1): one activity link per open agent page.
let presenceWatch = null;

let detailSpeaker = null;

// Previous hash, so the edit form's Save / Cancel return where the user came
// from. Capture phase: runs before app.js's router listener sees the change.
let prevHash = '';
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener(
    'hashchange',
    (e) => {
      try {
        prevHash = new URL(e.oldURL).hash;
      } catch {
        prevHash = '';
      }
    },
    true
  );
}

// Dirty guard of the open edit form (hashchange / beforeunload / Ctrl+S).
let editGuard = null;

function teardownEditGuard() {
  editGuard?.teardown();
  editGuard = null;
}

/**
 * While `isDirty()`, navigation away asks first: the app-wide nav guard
 * (web/nav-guard.js) puts the old hash back and follows the new one only
 * after the operator confirms.
 */
function installEditGuard(form, { isDirty, onSave }) {
  teardownEditGuard();
  let bypass = false;
  const offNavGuard = registerNavGuard(() => {
    if (!form.isConnected || bypass || !isDirty()) return null;
    return {
      title: 'Discard unsaved changes?',
      message: 'This agent has edits that were not saved.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
    };
  });
  const onUnload = (e) => {
    if (form.isConnected && !bypass && isDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  const onKey = (e) => {
    if (!form.isConnected) return teardownEditGuard();
    if (isSaveShortcut(e)) {
      e.preventDefault();
      onSave();
    }
  };
  window.addEventListener('beforeunload', onUnload);
  document.addEventListener('keydown', onKey);
  editGuard = {
    /** Leave without asking (after a successful save). */
    release() {
      bypass = true;
    },
    teardown() {
      offNavGuard();
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('keydown', onKey);
    },
  };
  return editGuard;
}

export function destroyAgentDetail() {
  teardownEditGuard();
  presenceWatch?.stop();
  presenceWatch = null;
  detailSpeaker?.stop();
  detailSpeaker = null;
}

function startPresenceLive(el, id, home) {
  destroyAgentDetail();
  if (!home || home.error) return;
  const identity = home.identity;
  presenceWatch = watchAgent(id, { onPresence: (p) => applyPresence(el, p, identity) });
  // Face and voice (session S4): "Change face" inside the avatar, play button
  // next to the now-line. A removed face re-renders so the seed avatar returns.
  wireFaceControl(el, id, {
    onChanged: (avatarUrl) => {
      identity.avatarUrl = avatarUrl;
      if (!avatarUrl) renderAgentDetail(el, id);
    },
  });
  detailSpeaker = wireSpeakButton(el, id, () => el.querySelector('#presence-now')?.textContent);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function statusBadge(status) {
  const cls =
    status === 'completed' ? 'badge-ok' : status === 'error' ? 'badge-error' : 'badge-disabled';
  return `<span class="badge ${cls}">${status}</span>`;
}

function formatTokenCount(n) {
  if (n == null || n === 0) return '--';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function karmaScoreColor(score) {
  if (score >= 70) return 'var(--green)';
  if (score >= 40) return 'var(--orange)';
  return 'var(--red)';
}

function karmaTrendBadge(trend) {
  if (trend === 'rising') return '<span class="badge badge-ok">&#8593; rising</span>';
  if (trend === 'falling') return '<span class="badge badge-error">&#8595; falling</span>';
  return '<span class="badge badge-disabled">&#8594; stable</span>';
}

function renderPermissionMatrixRows(defaults, agent) {
  const levels = defaults.permissionLevels;
  const overrides = agent.toolPermissions || {};
  return Object.keys(defaults.defaultToolPermissions)
    .sort()
    .map((tool) => {
      const def = defaults.defaultToolPermissions[tool];
      const ov = overrides[tool] || {};
      const modes = [
        { key: 'agentLoop', def: def.agentLoop, ov: ov.agentLoop },
        { key: 'conversation', def: def.conversation, ov: ov.conversation },
      ];
      const cells = modes
        .map((m) => {
          const hasOverride = m.ov !== undefined && m.ov !== null;
          const style = `font-size:0.85em${hasOverride ? ';font-weight:bold;color:var(--accent)' : ''}`;
          const options = levels
            .map((l) => {
              const sel = (hasOverride ? m.ov : m.def) === l ? ' selected' : '';
              return `<option value="${l}"${sel}>${l}</option>`;
            })
            .join('');
          return `<td style="padding:4px;text-align:center"><select data-tool="${escapeHtml(tool)}" data-mode="${m.key}" data-default="${m.def}" style="${style}">${options}</select></td>`;
        })
        .join('');
      return `<tr><td style="padding:4px;font-family:monospace">${escapeHtml(tool)}</td>${cells}</tr>`;
    })
    .join('');
}

function renderAgentLoopResult(r) {
  const sections = [];

  sections.push(`<div class="flex-between mb-16">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-weight:600;font-size:14px">Agent Loop Result</span>
      ${statusBadge(r.status)}
    </div>
    <span class="text-dim text-sm">${formatDuration(r.durationMs)}</span>
  </div>`);

  if (r.plannerReasoning) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Planner Reasoning</div>
      <pre>${escapeHtml(r.plannerReasoning)}</pre>
    </div>`);
  }

  if (r.plan && r.plan.length > 0) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Plan</div>
      <ol style="margin:0;padding-left:20px;font-size:13px">${r.plan.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
    </div>`);
  }

  if (r.toolCalls && r.toolCalls.length > 0) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Tool Calls (${r.toolCalls.length})</div>
      ${r.toolCalls
        .map((tc) => {
          const badge = tc.success
            ? '<span class="badge badge-ok">OK</span>'
            : '<span class="badge badge-error">FAIL</span>';
          const argsStr = JSON.stringify(tc.args || {}, null, 2);
          return `<div class="tool-call-item">
          <div class="tool-call-header">
            <span style="font-family:monospace;font-weight:600">${escapeHtml(tc.name)}</span> ${badge}
          </div>
          <details class="tool-call-details">
            <summary class="text-dim text-sm">Args</summary>
            <pre>${escapeHtml(argsStr)}</pre>
          </details>
          <details class="tool-call-details" ${!tc.success ? 'open' : ''}>
            <summary class="text-dim text-sm">Result</summary>
            <pre>${escapeHtml(tc.result || '')}</pre>
          </details>
        </div>`;
        })
        .join('')}
    </div>`);
  }

  if (r.tokenUsage && r.tokenUsage.total > 0) {
    const modelRows = Object.entries(r.tokenUsage.models)
      .map(
        ([model, u]) =>
          `<tr><td style="font-family:monospace;font-size:12px">${escapeHtml(model)}</td><td style="text-align:right">${formatTokenCount(u.promptTokens)}</td><td style="text-align:right">${formatTokenCount(u.completionTokens)}</td><td style="text-align:right;font-weight:600">${formatTokenCount(u.promptTokens + u.completionTokens)}</td></tr>`
      )
      .join('');
    sections.push(`<div class="result-section">
      <div class="result-section-title">Token Usage (${formatTokenCount(r.tokenUsage.total)} total)</div>
      <table style="width:100%;font-size:13px">
        <thead><tr><th style="text-align:left">Model</th><th style="text-align:right">In</th><th style="text-align:right">Out</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${modelRows}</tbody>
      </table>
    </div>`);
  }

  sections.push(`<div class="result-section">
    <div class="result-section-title">Summary</div>
    <pre>${escapeHtml(r.summary || '')}</pre>
  </div>`);

  return sections.join('');
}

/** Show a loop / reflection result in the legacy modal (read-only content, not a confirmation). */
function showResultModal(title, bodyHtml) {
  showModal(`
    <div class="modal-title">${escapeHtml(title)}</div>
    <div style="max-height:60vh;overflow-y:auto">${bodyHtml}</div>
    <div class="modal-actions">
      <button class="btn" id="result-modal-close">Close</button>
    </div>
  `);
  document.getElementById('modal').style.maxWidth = '700px';
  document.getElementById('result-modal-close').addEventListener('click', () => {
    document.getElementById('modal').style.maxWidth = '';
    closeModal();
  });
}

/** POST /api/agent-loop/run/:id and show the cycle result; failures toast. */
async function runLoopNow(id) {
  const res = await api(`/api/agent-loop/run/${encodeURIComponent(id)}`, { method: 'POST' });
  if (!res || res.error) {
    showToast(`Run failed: ${res?.error || 'request failed'}`, { tone: 'danger', duration: 8000 });
    return false;
  }
  showResultModal('Agent Loop Result', renderAgentLoopResult(res.result));
  return true;
}

async function reflectNow(id) {
  const res = await api(`/api/agents/${encodeURIComponent(id)}/skills/reflection/reflect`, {
    method: 'POST',
  });
  if (!res || res.error) {
    showToast(`Reflect failed: ${res?.error || 'request failed'}`, {
      tone: 'danger',
      duration: 8000,
    });
    return;
  }
  showResultModal(
    'Reflection Result',
    `<div style="white-space:pre-wrap;font-size:13px;line-height:1.5">${escapeHtml(res.result || '')}</div>
     <div style="margin-top:8px;font-size:12px;color:var(--text-dim)">Completed in ${((res.durationMs || 0) / 1000).toFixed(1)}s</div>`
  );
}

const RESET_MESSAGE =
  'This fully resets the agent to its original state: all conversations, memory, goals and learned facts are cleared, and soul files are restored to their generated baseline. This cannot be undone.';

/** confirmDialog + POST reset. Resolves true when the agent was reset. */
async function confirmAndReset(id, name) {
  const ok = await confirmDialog({
    title: `Reset ${name || id}?`,
    message: RESET_MESSAGE,
    confirmLabel: 'Reset agent',
  });
  if (!ok) return false;
  const res = await api(`/api/agents/${encodeURIComponent(id)}/reset`, { method: 'POST' });
  if (!res || res.error) {
    showToast(`Reset failed: ${res?.error || 'request failed'}`, {
      tone: 'danger',
      duration: 8000,
    });
    return false;
  }
  showToast(`${name || id} was reset`, { tone: 'ok' });
  return true;
}

/** DELETE one agent. `{ ok, error }`; never throws. */
async function deleteAgent(id) {
  const res = await api(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res || res.error) return { ok: false, error: res?.error || 'request failed' };
  return { ok: true };
}

/** confirmDialog + DELETE. Resolves true when the agent is gone. */
async function confirmAndDelete(id, name) {
  const ok = await confirmDialog({
    title: `Delete ${name || id}?`,
    message: `The agent "${id}" is removed from the fleet. Its soul files stay on disk, but this cannot be undone from the dashboard.`,
    confirmLabel: 'Delete agent',
  });
  if (!ok) return false;
  const r = await deleteAgent(id);
  if (!r.ok) {
    showToast(`Could not delete ${name || id}: ${r.error}`, { tone: 'danger', duration: 8000 });
    return false;
  }
  showToast(`Deleted ${name || id}`, { tone: 'ok' });
  return true;
}

/** Start (optionally enabling) or stop one agent. `{ ok, error }`. */
async function setRunning(id, action) {
  const path =
    action === 'stop'
      ? `/api/agents/${encodeURIComponent(id)}/stop`
      : `/api/agents/${encodeURIComponent(id)}/start${action === 'enable-start' ? '?enable=true' : ''}`;
  const res = await api(path, { method: 'POST' });
  if (!res || res.error) return { ok: false, error: res?.error || 'request failed' };
  return { ok: true };
}

const BULK_VERBS = {
  start: { verb: 'Started', progress: 'Starting' },
  stop: { verb: 'Stopped', progress: 'Stopping' },
  enable: { verb: 'Enabled', progress: 'Enabling' },
  disable: { verb: 'Disabled', progress: 'Disabling' },
  export: { verb: 'Exported', progress: 'Exporting' },
  delete: { verb: 'Deleted', progress: 'Deleting' },
};

// Per-render state of the agents list (search / chips / sort / selection).
let listState = null;

export async function renderAgents(el) {
  el.innerHTML = '<div class="page-title">Agents</div><p class="text-dim">Loading...</p>';

  const [agents, karmaScores, loopState, defaults, llmStatsRes] = await Promise.all([
    api('/api/agents'),
    api('/api/karma'),
    api('/api/agent-loop'),
    api('/api/agents/defaults'),
    api('/api/agent-loop/llm-stats'),
  ]);

  if (!Array.isArray(agents)) {
    el.innerHTML = `<div class="page-title">Agents</div>${emptyState({
      icon: '⚠',
      title: 'Could not load agents',
      hint: agents?.error || 'The server did not answer.',
      action: '<button type="button" class="btn btn-primary" id="agents-retry">Retry</button>',
    })}`;
    el.querySelector('#agents-retry')?.addEventListener('click', () => renderAgents(el));
    return;
  }

  // Build karma lookup by botId (graceful if karma is disabled)
  const karmaMap = {};
  if (Array.isArray(karmaScores)) {
    for (const k of karmaScores) karmaMap[k.botId] = k;
  }

  // Build LLM stats lookup by botId
  const llmStatsMap = {};
  if (Array.isArray(llmStatsRes?.stats)) {
    for (const s of llmStatsRes.stats) llmStatsMap[s.botId] = s;
  }

  // Build executing lookup from loop state
  const executingMap = {};
  if (loopState?.botSchedules) {
    for (const s of loopState.botSchedules) executingMap[s.botId] = s.isExecutingLoop;
  }

  const defs = defaults && !defaults.error ? defaults : {};
  const storage = typeof localStorage !== 'undefined' ? localStorage : null;
  listState = {
    el,
    agents,
    prefs: readListPrefs(storage),
    selected: new Set(),
    maps: { karmaMap, llmStatsMap, executingMap },
  };
  const st = listState;

  // Same option list the per-row selector uses, so a bulk edit and a single edit
  // mean exactly the same thing. 'claude-cli' is included by /api/agents/defaults.
  const bulkModelOptions = (defs.availableModels || [])
    .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
    .join('');

  el.innerHTML = `
    <div class="flex-between mb-16 agents-head">
      <div class="page-title">Agents <span class="count" id="agents-count">${agents.length}</span></div>
      <div class="agents-head-actions">
        <button class="btn" id="btn-start-all">Start All</button>
        <button class="btn" id="btn-import-agent">Import Agent</button>
        <button class="btn btn-primary" id="btn-new-agent" data-page-new>+ New Agent</button>
      </div>
    </div>
    <div id="agents-filter-slot"></div>
    <div id="bulk-bar" class="bulk-bar mb-16" style="display:none">
      <span id="bulk-count"></span>
      <span class="bulk-group">
        <button class="btn btn-sm" data-bulk="start">Start</button>
        <button class="btn btn-sm" data-bulk="stop">Stop</button>
        <button class="btn btn-sm" data-bulk="enable">Enable</button>
        <button class="btn btn-sm" data-bulk="disable">Disable</button>
        <button class="btn btn-sm" data-bulk="export">Export</button>
        <button class="btn btn-sm btn-danger" data-bulk="delete">Delete</button>
      </span>
      <span class="bulk-group">
        <select id="bulk-model" style="font-size:12px;padding:2px 4px;max-width:220px" aria-label="Model for selected agents">
          <option value="">Global (${escapeHtml(defs.model ?? '')})</option>
          ${bulkModelOptions}
        </select>
        <button class="btn btn-sm btn-primary" id="bulk-apply">Set model</button>
      </span>
      <button class="btn btn-sm" id="bulk-clear">Clear selection</button>
      <span id="bulk-status" class="text-dim"></span>
    </div>
    <div id="agents-table-wrap"></div>
  `;

  closeAgentMenus?.();
  closeAgentMenus = initMenus(el);

  const wrap = el.querySelector('#agents-table-wrap');
  const filterSlot = el.querySelector('#agents-filter-slot');
  const bulkBar = el.querySelector('#bulk-bar');
  const bulkCount = el.querySelector('#bulk-count');
  const bulkStatus = el.querySelector('#bulk-status');

  const visibleAgents = () =>
    sortAgents(filterAgents(st.agents, st.prefs, st.maps), st.prefs, st.maps);

  function savePrefs() {
    writeListPrefs(storage, st.prefs);
  }

  function paintFilters() {
    filterSlot.innerHTML = listFilterBar(st.prefs, statusCounts(st.agents, st.maps));
  }

  /** Repaint the chip counts without rebuilding the search input (keeps focus/caret). */
  function refreshChipCounts() {
    const counts = statusCounts(st.agents, st.maps);
    for (const chip of filterSlot.querySelectorAll('[data-status-filter]')) {
      const n = chip.querySelector('.agents-chip-n');
      if (n) n.textContent = String(counts[chip.dataset.statusFilter] ?? 0);
      const on = chip.dataset.statusFilter === st.prefs.status;
      chip.classList.toggle('agents-chip-active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const count = el.querySelector('#agents-count');
    if (count) count.textContent = String(st.agents.length);
  }

  function paintTable() {
    const filtered = Boolean(st.prefs.query.trim()) || st.prefs.status !== 'all';
    const rows = visibleAgents();
    wrap.innerHTML = agentsTable(rows, {
      defaults: defs,
      ...st.maps,
      avatarSrc: authedAvatarSrc,
      sort: st.prefs,
      filtered: filtered && st.agents.length > 0,
    });
    // Selection survives repaints; hidden rows drop out of it.
    const shown = new Set(rows.map((a) => a.id));
    for (const id of [...st.selected]) if (!shown.has(id)) st.selected.delete(id);
    for (const cb of wrap.querySelectorAll('.bulk-select'))
      cb.checked = st.selected.has(cb.dataset.id);
    refreshBulkBar();
  }

  function refreshBulkBar() {
    const n = st.selected.size;
    bulkBar.style.display = n > 0 ? 'flex' : 'none';
    bulkCount.textContent = `${n} selected`;
    const boxes = wrap.querySelectorAll('.bulk-select');
    const selectAll = wrap.querySelector('#bulk-select-all');
    if (!selectAll) return;
    selectAll.checked = n > 0 && n === boxes.length;
    selectAll.indeterminate = n > 0 && n < boxes.length;
  }

  /** Re-read one agent after a change and repaint the table from memory (no page reload). */
  async function refreshAgent(id) {
    const fresh = await api(`/api/agents/${encodeURIComponent(id)}`);
    if (fresh && !fresh.error) {
      const i = st.agents.findIndex((a) => a.id === id);
      if (i !== -1) st.agents[i] = { ...st.agents[i], ...fresh };
    }
    if (listState !== st) return;
    refreshChipCounts();
    paintTable();
  }

  function agentName(id) {
    return st.agents.find((a) => a.id === id)?.name || id;
  }

  paintFilters();
  paintTable();

  // --- Search, chips, sorting ------------------------------------------------
  filterSlot.addEventListener('input', (e) => {
    if (!e.target.matches('[data-page-filter]')) return;
    st.prefs = { ...st.prefs, query: e.target.value };
    savePrefs();
    paintTable();
  });
  filterSlot.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.matches('[data-page-filter]') && e.target.value) {
      e.preventDefault();
      e.target.value = '';
      st.prefs = { ...st.prefs, query: '' };
      savePrefs();
      paintTable();
    }
  });
  filterSlot.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-status-filter]');
    if (!chip) return;
    st.prefs = { ...st.prefs, status: chip.dataset.statusFilter };
    savePrefs();
    refreshChipCounts();
    paintTable();
  });

  // --- Row actions (delegated on the wrapper so repaints keep working) -------
  wrap.addEventListener('click', async (e) => {
    const sortBtn = e.target.closest('[data-sort-btn]');
    if (sortBtn) {
      const key = sortBtn.dataset.sortBtn;
      const dir =
        st.prefs.sort === key
          ? st.prefs.dir === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'name'
            ? 'asc'
            : 'desc';
      st.prefs = { ...st.prefs, sort: key, dir };
      savePrefs();
      paintTable();
      return;
    }
    if (e.target.closest('[data-action="clear-filters"]')) {
      st.prefs = { ...st.prefs, query: '', status: 'all' };
      savePrefs();
      paintFilters();
      paintTable();
      return;
    }
    const btn = e.target.closest('button[data-action]');
    if (!btn || !btn.dataset.id) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const name = agentName(id);

    if (action === 'start' || action === 'enable-start' || action === 'stop') {
      btn.disabled = true;
      btn.textContent = action === 'stop' ? 'Stopping...' : 'Starting...';
      // ?enable=true is what makes the button honest: a disabled agent is
      // refused by the server, so this path enables it (persisted) first.
      const r = await setRunning(id, action);
      if (r.ok) showToast(`${name} ${action === 'stop' ? 'stopped' : 'started'}`, { tone: 'ok' });
      else
        showToast(`Could not ${action === 'stop' ? 'stop' : 'start'} ${name}: ${r.error}`, {
          tone: 'danger',
          duration: 8000,
        });
      await refreshAgent(id);
    } else if (action === 'run-loop') {
      btn.disabled = true;
      await runLoopNow(id);
      btn.disabled = false;
    } else if (action === 'reflect') {
      btn.disabled = true;
      await reflectNow(id);
      btn.disabled = false;
    } else if (action === 'edit') {
      location.hash = `#/agents/${encodeURIComponent(id)}/edit`;
    } else if (action === 'clone') {
      showCloneModal(id, el);
    } else if (action === 'reset') {
      if (await confirmAndReset(id, name)) await refreshAgent(id);
    } else if (action === 'export') {
      showExportModal(id);
    } else if (action === 'toggle-loop') {
      const agent = st.agents.find((a) => a.id === id);
      // Cycle: Auto → On → Off → Auto
      const current = agent?.agentLoop?.enabled;
      const next = current == null ? true : current === true ? false : undefined;
      const patch = { agentLoop: { ...agent?.agentLoop, enabled: next ?? null } };
      btn.disabled = true;
      const res = await api(`/api/agents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
      });
      btn.disabled = false;
      if (!res || res.error) {
        showToast(`Could not update the loop: ${res?.error || 'request failed'}`, {
          tone: 'danger',
          duration: 8000,
        });
        return;
      }
      if (agent) {
        if (!agent.agentLoop) agent.agentLoop = {};
        agent.agentLoop.enabled = next;
      }
      btn.className = `btn btn-sm${next === false ? ' btn-danger' : ''}`;
      btn.title = next == null ? 'Inherit global' : next ? 'On' : 'Off';
      btn.innerHTML =
        next === false ? 'Off' : next === true ? 'On' : '<span class="text-dim">Auto</span>';
      showToast(
        `${name}: agent loop ${next == null ? 'follows the global setting' : next ? 'on' : 'off'}`,
        {
          tone: 'ok',
        }
      );
    } else if (action === 'toggle-productions') {
      const agent = st.agents.find((a) => a.id === id);
      const next = !(agent?.productions?.enabled !== false);
      const patch = { productions: { ...agent?.productions, enabled: next } };
      btn.disabled = true;
      const res = await api(`/api/agents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
      });
      btn.disabled = false;
      if (!res || res.error) {
        showToast(`Could not update productions: ${res?.error || 'request failed'}`, {
          tone: 'danger',
          duration: 8000,
        });
        return;
      }
      if (agent) {
        if (!agent.productions) agent.productions = {};
        agent.productions.enabled = next;
      }
      showToast(`${name}: productions ${next ? 'on' : 'off'}`, { tone: 'ok' });
      paintTable();
    } else if (action === 'delete') {
      if (await confirmAndDelete(id, name)) {
        st.agents = st.agents.filter((a) => a.id !== id);
        st.selected.delete(id);
        refreshChipCounts();
        paintTable();
      }
    }
  });

  // Enabled switch, model select, selection checkboxes
  wrap.addEventListener('change', async (e) => {
    if (e.target.id === 'bulk-select-all') {
      for (const cb of wrap.querySelectorAll('.bulk-select')) {
        cb.checked = e.target.checked;
        if (cb.checked) st.selected.add(cb.dataset.id);
        else st.selected.delete(cb.dataset.id);
      }
      refreshBulkBar();
      return;
    }
    if (e.target.classList.contains('bulk-select')) {
      if (e.target.checked) st.selected.add(e.target.dataset.id);
      else st.selected.delete(e.target.dataset.id);
      refreshBulkBar();
      return;
    }

    const toggle = e.target.closest('[data-action="toggle-enabled"]');
    if (toggle) {
      const id = toggle.dataset.id;
      const enabled = toggle.checked;
      toggle.disabled = true;
      const res = await api(`/api/agents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { enabled },
      });
      toggle.disabled = false;
      if (!res || res.error) {
        showToast(`Could not update ${agentName(id)}: ${res?.error || 'request failed'}`, {
          tone: 'danger',
          duration: 8000,
        });
        toggle.checked = !enabled;
        return;
      }
      const agent = st.agents.find((a) => a.id === id);
      if (agent) agent.enabled = enabled;
      showToast(`${agentName(id)} ${enabled ? 'enabled' : 'disabled'}`, { tone: 'ok' });
      refreshChipCounts();
      paintTable();
      return;
    }

    const select = e.target.closest('.inline-model-select');
    if (!select) return;
    const agentId = select.dataset.agentId;
    const selectedModel = select.value.trim();
    const patch =
      selectedModel === 'claude-cli'
        ? { model: null, llmBackend: 'claude-cli' }
        : { model: selectedModel || null, llmBackend: null };

    select.disabled = true;
    const res = await api(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: patch,
    });
    select.disabled = false;
    if (!res || res.error) {
      showToast(`Could not change the model: ${res?.error || 'request failed'}`, {
        tone: 'danger',
        duration: 8000,
      });
      await refreshAgent(agentId);
      return;
    }
    const agent = st.agents.find((a) => a.id === agentId);
    if (agent) Object.assign(agent, patch);
    showToast(`${agentName(agentId)} now uses ${selectedModel || 'the global model'}`, {
      tone: 'ok',
    });
  });

  // --- Bulk actions ---------------------------------------------------------
  el.querySelector('#bulk-clear').addEventListener('click', () => {
    st.selected.clear();
    for (const cb of wrap.querySelectorAll('.bulk-select')) cb.checked = false;
    refreshBulkBar();
  });

  /** One sequential bulk run with a live progress toast and a summary toast. */
  async function runBulk(action) {
    const ids = [...st.selected];
    const { apply, skip } = bulkPlan(action, st.agents, ids);
    const words = BULK_VERBS[action];
    if (action === 'delete') {
      if (apply.length === 0) return;
      const names = apply.map(agentName);
      const ok = await confirmDialog({
        title: `Delete ${apply.length} agent${apply.length === 1 ? '' : 's'}?`,
        message: `${names.join(', ')}. This cannot be undone from the dashboard.`,
        confirmLabel: `Delete ${apply.length}`,
      });
      if (!ok) return;
    }
    if (apply.length === 0) {
      const s = bulkSummary(words.verb, [], skip.length);
      showToast(s.text, { tone: s.tone });
      return;
    }
    for (const b of bulkBar.querySelectorAll('button')) b.disabled = true;
    const progress = showToast(`${words.progress} 0 / ${apply.length}…`, { duration: 0 });
    const progressText = (t) => {
      if (progress) progress.textContent = t;
    };
    const results = [];
    for (const [i, id] of apply.entries()) {
      progressText(`${words.progress} ${agentName(id)} (${i + 1} / ${apply.length})…`);
      let r;
      if (action === 'start') {
        const agent = st.agents.find((a) => a.id === id);
        r = await setRunning(id, agent?.enabled === false ? 'enable-start' : 'start');
      } else if (action === 'stop') r = await setRunning(id, 'stop');
      else if (action === 'enable' || action === 'disable') {
        const res = await api(`/api/agents/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: { enabled: action === 'enable' },
        });
        r = !res || res.error ? { ok: false, error: res?.error || 'request failed' } : { ok: true };
      } else if (action === 'export') r = await downloadExport(id, new URLSearchParams());
      else if (action === 'delete') r = await deleteAgent(id);
      results.push({ id, ...r });
    }
    progress?.dismiss?.();
    for (const b of bulkBar.querySelectorAll('button')) b.disabled = false;
    const s = bulkSummary(words.verb, results, skip.length);
    showToast(s.text, { tone: s.tone, duration: s.tone === 'ok' ? 4000 : 10000 });
    if (action === 'export') return;
    if (action === 'delete') {
      const gone = new Set(results.filter((r) => r.ok).map((r) => r.id));
      st.agents = st.agents.filter((a) => !gone.has(a.id));
      for (const id of gone) st.selected.delete(id);
      refreshChipCounts();
      paintTable();
      return;
    }
    // Re-read the whole list once (one request) instead of one per agent.
    const fresh = await api('/api/agents');
    if (listState !== st) return;
    if (Array.isArray(fresh)) st.agents = fresh;
    refreshChipCounts();
    paintTable();
  }

  bulkBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bulk]');
    if (b) runBulk(b.dataset.bulk);
  });

  // The per-row selector conflates backend and model ('claude-cli' is offered as
  // if it were a model), so the same mapping is used here: picking claude-cli
  // switches the backend and clears the per-agent model override.
  el.querySelector('#bulk-apply').addEventListener('click', async (ev) => {
    const ids = [...st.selected];
    if (ids.length === 0) return;
    const value = el.querySelector('#bulk-model').value.trim();
    const patch =
      value === 'claude-cli'
        ? { model: null, llmBackend: 'claude-cli' }
        : { model: value || null, llmBackend: null };
    const label = value || 'the global default';
    const ok = await confirmDialog({
      title: `Change the model of ${ids.length} agent${ids.length === 1 ? '' : 's'}?`,
      message: `${ids.map(agentName).join(', ')} will use ${label}.`,
      confirmLabel: 'Set model',
      tone: 'accent',
    });
    if (!ok) return;

    ev.target.disabled = true;
    bulkStatus.textContent = 'Applying...';
    const res = await api('/api/agents/bulk', { method: 'PATCH', body: { ids, patch } });
    ev.target.disabled = false;
    bulkStatus.textContent = '';
    if (!res || res.error) {
      showToast(`Bulk update failed: ${res?.error || 'request failed'}`, {
        tone: 'danger',
        duration: 8000,
      });
      return;
    }
    // Unknown ids are reported rather than fatal, so surface them instead of
    // letting a partially-applied edit look like a clean success.
    if (res.notFound?.length) {
      showToast(`Updated ${res.updated?.length ?? 0}. Not found: ${res.notFound.join(', ')}`, {
        tone: 'warn',
        duration: 10000,
      });
    } else {
      showToast(`Set ${ids.length} agent${ids.length === 1 ? '' : 's'} to ${label}`, {
        tone: 'ok',
      });
    }
    for (const id of ids) {
      const agent = st.agents.find((a) => a.id === id);
      if (agent) Object.assign(agent, patch);
    }
    paintTable();
  });

  el.querySelector('#btn-start-all').addEventListener('click', async () => {
    const stoppedAgents = st.agents.filter((a) => a.enabled && !a.running);
    if (stoppedAgents.length === 0) {
      showToast(
        'All enabled agents are already running. Disabled agents are skipped — use "Enable & Start" on a row.',
        { tone: 'muted', duration: 6000 }
      );
      return;
    }
    const btn = el.querySelector('#btn-start-all');
    btn.disabled = true;
    btn.textContent = `Starting ${stoppedAgents.length}...`;
    const results = [];
    for (const agent of stoppedAgents) {
      const r = await setRunning(agent.id, 'start');
      results.push({ id: agent.name || agent.id, ...r });
    }
    btn.disabled = false;
    btn.textContent = 'Start All';
    const s = bulkSummary('Started', results);
    showToast(s.text, { tone: s.tone, duration: s.tone === 'ok' ? 4000 : 10000 });
    const fresh = await api('/api/agents');
    if (listState !== st) return;
    if (Array.isArray(fresh)) st.agents = fresh;
    refreshChipCounts();
    paintTable();
  });

  el.querySelector('#btn-new-agent').addEventListener('click', () => {
    showNewAgentModal();
  });

  el.querySelector('#btn-import-agent').addEventListener('click', () => {
    showImportModal(el);
  });
}

export async function renderAgentDetail(el, id) {
  const [agent, skills, defaults, karmaData, loopState, llmStatsRes, reflections, evoState, home] =
    await Promise.all([
      api(`/api/agents/${id}`),
      api('/api/skills'),
      api('/api/agents/defaults'),
      api(`/api/karma/${encodeURIComponent(id)}`),
      api('/api/agent-loop'),
      api(`/api/agent-loop/llm-stats/${encodeURIComponent(id)}`),
      api(`/api/agents/${encodeURIComponent(id)}/reflections`).catch(() => ({
        entries: [],
        motivationsVersions: [],
      })),
      api(`/api/agent-loop/evolution/${encodeURIComponent(id)}`).catch(() => null),
      api(`/api/agents/${encodeURIComponent(id)}/home`).catch(() => null),
    ]);

  const llmStats = llmStatsRes?.stats;

  // Find this bot's schedule info
  const botSchedule = loopState.botSchedules?.find((s) => s.botId === id);
  const isExecutingLoop = botSchedule?.isExecutingLoop ?? false;

  if (agent.error) {
    el.innerHTML = '<p>Agent not found.</p>';
    return;
  }

  const statusBadge = agent.running
    ? '<span class="badge badge-running">Running</span>'
    : '<span class="badge badge-stopped">Stopped</span>';

  const modelLabel = effectiveModelLabel(agent, defaults);
  const modelDisplay = modelLabel.global
    ? `<span class="text-dim">${escapeHtml(modelLabel.text)} (global)</span>`
    : escapeHtml(modelLabel.text);

  const soulDirDisplay = agent.soulDir
    ? escapeHtml(agent.soulDir)
    : `<span class="text-dim">${escapeHtml(defaults.soulDir)} (global)</span>`;

  const workDirDisplay = agent.workDir
    ? escapeHtml(agent.workDir)
    : `<span class="text-dim">${escapeHtml(`${defaults.productionsBaseDir || './productions'}/${agent.id}`)} (default)</span>`;

  const agentLoopEvery = agent.agentLoop?.every;
  const loopIntervalDisplay = agentLoopEvery
    ? escapeHtml(agentLoopEvery)
    : `<span class="text-dim">${escapeHtml(defaults.agentLoopInterval || '6h')} (global)</span>`;

  const alMode = agent.agentLoop?.mode || 'periodic';
  const alMaxToolRounds = agent.agentLoop?.maxToolRounds;
  const maxToolRoundsDisplay =
    alMaxToolRounds != null
      ? alMaxToolRounds
      : `<span class="text-dim">${defaults.agentLoop?.maxToolRounds ?? 30} (global)</span>`;
  const alStrategistEnabled = agent.agentLoop?.strategist?.enabled;
  const strategistDisplay =
    alStrategistEnabled === true
      ? 'On'
      : alStrategistEnabled === false
        ? 'Off'
        : `<span class="text-dim">${defaults.agentLoop?.strategist?.enabled !== false ? 'On' : 'Off'} (global)</span>`;
  const alLoopDetection = agent.agentLoop?.loopDetection?.enabled;
  const loopDetectionDisplay =
    alLoopDetection === true
      ? 'On'
      : alLoopDetection === false
        ? 'Off'
        : `<span class="text-dim">${defaults.agentLoop?.loopDetection?.enabled !== false ? 'On' : 'Off'} (global)</span>`;

  // Evolution: per-bot override → global default
  const evoPerBot = agent.agentLoop?.evolution?.enabled;
  const evoGlobal = defaults.evolution?.enabled ?? false;
  const evoEffective = evoPerBot ?? evoGlobal;
  const evolutionDisplay = evoEffective
    ? '<span class="badge badge-ok">On</span>'
    : '<span class="badge badge-disabled">Off</span>';

  const alEngagementGate = agent.agentLoop?.engagementGate;
  const egEffective = alEngagementGate?.enabled !== false;
  const engagementGateDisplay = egEffective
    ? `${alEngagementGate?.mode ?? 'soft'} (threshold: ${alEngagementGate?.threshold ?? 5})`
    : '<span class="badge badge-disabled">Off</span>';

  const systemPromptDisplay = agent.conversation?.systemPrompt
    ? escapeHtml(agent.conversation.systemPrompt).substring(0, 120) +
      (agent.conversation.systemPrompt.length > 120 ? '...' : '')
    : `<span class="text-dim">Global default</span>`;

  const tempDisplay =
    agent.conversation?.temperature !== undefined
      ? agent.conversation.temperature
      : `<span class="text-dim">${defaults.temperature} (global)</span>`;

  const maxHistDisplay =
    agent.conversation?.maxHistory !== undefined
      ? agent.conversation.maxHistory
      : `<span class="text-dim">${defaults.maxHistory} (global)</span>`;

  const actionsHtml = `
      ${
        agent.running
          ? `<button class="btn btn-danger" id="btn-toggle" title="Stops the agent now. This is transient: with Enabled on, it starts again on the next restart.">Stop</button>`
          : agent.enabled === false
            ? `<button class="btn btn-primary" id="btn-toggle" title="This agent is disabled, so the server refuses a plain Start. This turns Enabled on (saved) and starts it now.">Enable &amp; Start</button>`
            : `<button class="btn btn-primary" id="btn-toggle">Start</button>`
      }
      ${agent.running ? `<button class="btn" id="btn-run-loop" title="Run one agent-loop cycle now">Run now</button>` : ''}
      <a href="#/agents/${encodeURIComponent(agent.id)}/edit" class="btn">Edit</a>
      <button class="btn" id="btn-clone">Clone</button>
      <button class="btn" id="btn-export">Export</button>
      ${
        agent.running && agent.skills.includes('reflection')
          ? `<button class="btn" id="btn-reflect">Reflect</button>`
          : ''
      }
      ${agent.running ? '' : `<button class="btn btn-danger" id="btn-reset">Reset</button>`}
      <button class="btn btn-danger" id="btn-delete">Delete</button>
  `;
  const hasHome = Boolean(home && !home.error);
  const headerHtml = hasHome
    ? presenceHeader(home, {
        actions: actionsHtml,
        backHref: `#/agents/${encodeURIComponent(id)}`,
        avatarSrc: authedAvatarSrc,
        face: true,
        voice: Boolean(home.identity?.voiceEnabled),
      }) + homeTabs(id, 'config')
    : `<div class="detail-header">
      <a href="#/agents" class="back">&larr;</a>
      <div class="page-title">${escapeHtml(agent.name)} ${statusBadge}</div>
    </div>`;

  el.innerHTML = `
    ${headerHtml}
    <div class="detail-card">
      <table>
        <tr><td class="text-dim" style="width:140px">ID</td><td>${escapeHtml(agent.id)}</td></tr>
        <tr><td class="text-dim">Token</td><td>${tokenCell(agent.token)}</td></tr>
        <tr><td class="text-dim">Enabled</td><td>${agent.enabled ? 'Yes <span class="text-dim">&mdash; starts automatically on boot</span>' : 'No <span class="text-dim">&mdash; never started, on boot or on request</span>'}</td></tr>
        <tr><td class="text-dim">Model</td><td>${modelDisplay}</td></tr>
        <tr><td class="text-dim">Soul Dir</td><td>${soulDirDisplay}</td></tr>
        <tr><td class="text-dim">Work Dir</td><td>${workDirDisplay}</td></tr>
        <tr><td class="text-dim">Productions</td><td>${agent.productions?.enabled === false ? '<span class="badge badge-disabled">Disabled</span>' : '<span class="badge badge-ok">Enabled</span>'}</td></tr>
        <tr><td class="text-dim">System Prompt</td><td>${systemPromptDisplay}</td></tr>
        <tr><td class="text-dim">Temperature</td><td>${tempDisplay}</td></tr>
        <tr><td class="text-dim">Max History</td><td>${maxHistDisplay}</td></tr>
        <tr><td class="text-dim">Skills</td><td>${agent.skills.map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join(' ')}</td></tr>
        <tr><td class="text-dim">Allowed Users</td><td>${agent.allowedUsers?.length ? agent.allowedUsers.join(', ') : '<span class="text-dim">All</span>'}</td></tr>
        <tr><td class="text-dim">Mention Patterns</td><td>${agent.mentionPatterns?.length ? agent.mentionPatterns.join(', ') : '<span class="text-dim">None</span>'}</td></tr>
        <tr><td class="text-dim">Loop Interval</td><td>${loopIntervalDisplay}</td></tr>
        <tr><td class="text-dim">Mode</td><td>${alMode === 'continuous' ? '<span class="badge badge-running">Continuous</span>' : 'Periodic'}</td></tr>
        <tr><td class="text-dim">Max Tool Rounds</td><td>${maxToolRoundsDisplay}</td></tr>
        <tr><td class="text-dim">Strategist</td><td>${strategistDisplay}</td></tr>
        <tr><td class="text-dim">Loop Detection</td><td>${loopDetectionDisplay}</td></tr>
        <tr><td class="text-dim">Evolution</td><td>${evolutionDisplay}</td></tr>
        <tr><td class="text-dim">Engagement Gate</td><td>${engagementGateDisplay}</td></tr>
        <tr><td class="text-dim">Curiosity</td><td>${escapeHtml(curiositySummary(agent.agentLoop?.curiosity))}</td></tr>
        ${
          agent.running
            ? `<tr><td class="text-dim">Loop Status</td><td>${
                isExecutingLoop
                  ? '<span style="display:inline-flex;align-items:center;gap:6px"><span class="processing-pulse"></span> Executing cycle</span>'
                  : '<span class="text-dim">Idle</span>'
              }</td></tr>`
            : ''
        }
      </table>
    </div>
    ${
      !karmaData.error
        ? `
    <div class="detail-card" style="margin-top:16px">
      <div class="flex-between mb-16">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-weight:600">Karma</span>
          ${karmaTrendBadge(karmaData.trend)}
        </div>
        <a href="#/insights/karma/${encodeURIComponent(id)}" class="btn btn-sm">View Details</a>
      </div>
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
        <span style="font-size:32px;font-weight:700;color:${karmaScoreColor(karmaData.current)}">${karmaData.current}</span>
        <div style="flex:1;height:8px;background:var(--surface-2);border-radius:4px;overflow:hidden">
          <div style="width:${karmaData.current}%;height:100%;background:${karmaScoreColor(karmaData.current)};border-radius:4px"></div>
        </div>
        <span class="text-dim text-sm">/ 100</span>
      </div>
      ${
        karmaData.recentEvents?.length
          ? `
        <div class="text-dim text-sm" style="margin-bottom:4px">Recent events</div>
        ${karmaData.recentEvents
          .slice(0, 15)
          .map((evt) => {
            const sign = evt.delta >= 0 ? '+' : '';
            const color =
              evt.delta > 0 ? 'var(--green)' : evt.delta < 0 ? 'var(--red)' : 'var(--text-dim)';
            return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px">
            <span style="font-weight:600;color:${color};min-width:36px;font-family:monospace">${sign}${evt.delta}</span>
            <span class="badge badge-disabled" style="font-size:11px">${escapeHtml(evt.source)}</span>
            <span style="flex:1">${escapeHtml(evt.reason)}</span>
            <span class="text-dim text-sm">${timeAgo(evt.timestamp)}</span>
          </div>`;
          })
          .join('')}
      `
          : '<p class="text-dim text-sm">No karma events yet.</p>'
      }
    </div>
    `
        : ''
    }

    ${
      reflections.entries?.length || reflections.motivationsVersions?.length
        ? `
    <div class="detail-card" id="reflection-card" style="margin-top:16px">
      <div class="flex-between mb-16">
        <span style="font-weight:600">Reflection Journal</span>
        <span class="text-dim text-sm">Last: ${reflections.lastReflection?.date || 'never'}</span>
      </div>
      ${
        reflections.entries?.length
          ? `
      <div id="reflection-entries">
        ${reflections.entries
          .slice(0, 20)
          .map(
            (e, i) => `
          <div style="padding:8px 0;${i < Math.min(reflections.entries.length, 20) - 1 ? 'border-bottom:1px solid var(--border)' : ''}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span class="badge badge-disabled">${escapeHtml(e.date)}</span>
              <span class="text-dim text-sm">${escapeHtml(e.time)}</span>
              ${e.hasMotivationsBackup ? `<button class="btn btn-sm" data-action="view-motivations" data-date="${escapeHtml(e.date)}">Motivations</button>` : ''}
            </div>
            <div style="font-size:13px;line-height:1.5">${escapeHtml(e.journal)}</div>
          </div>
        `
          )
          .join('')}
      </div>
      ${reflections.entries.length > 20 ? `<button class="btn btn-sm" id="btn-load-more-reflections" style="margin-top:8px">Show all ${reflections.entries.length} entries</button>` : ''}
      `
          : '<p class="text-dim text-sm">No journal entries yet.</p>'
      }
      ${
        reflections.motivationsVersions?.length
          ? `
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
        <div class="text-dim text-sm" style="margin-bottom:8px">MOTIVATIONS.md versions (${reflections.motivationsVersions.length})</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${reflections.motivationsVersions
            .slice(0, 10)
            .map(
              (v) =>
                `<button class="btn btn-sm" data-action="view-motivations-version" data-version="${escapeHtml(v)}">${escapeHtml(v.replace('T', ' '))}</button>`
            )
            .join('')}
          ${reflections.motivationsVersions.length > 10 ? `<span class="text-dim text-sm" style="align-self:center">+${reflections.motivationsVersions.length - 10} more</span>` : ''}
        </div>
      </div>
      `
          : ''
      }
    </div>
    `
        : ''
    }

    ${llmStats ? buildLlmStatsCard(llmStats) : ''}

    ${buildEvolutionCard(evoState)}

    ${hasHome ? '' : `<div class="actions">${actionsHtml}</div>`}
    <div id="agent-loop-result"></div>
  `;

  startPresenceLive(el, id, home);

  el.querySelector('#btn-toggle')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const action = agent.running ? 'stop' : agent.enabled === false ? 'enable-start' : 'start';
    const r = await setRunning(id, action);
    if (r.ok)
      showToast(`${agent.name} ${action === 'stop' ? 'stopped' : 'started'}`, { tone: 'ok' });
    else
      showToast(`Could not ${action === 'stop' ? 'stop' : 'start'} ${agent.name}: ${r.error}`, {
        tone: 'danger',
        duration: 8000,
      });
    renderAgentDetail(el, id);
  });

  el.querySelector('#btn-clone')?.addEventListener('click', () => {
    showCloneModal(id, el, () => renderAgentDetail(el, id));
  });

  el.querySelector('#btn-export')?.addEventListener('click', () => showExportModal(id));

  el.querySelector('#btn-delete')?.addEventListener('click', async () => {
    if (await confirmAndDelete(id, agent.name)) location.hash = '#/agents';
  });

  el.querySelector('#btn-reset')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    await confirmAndReset(id, agent.name);
    renderAgentDetail(el, id);
  });

  // Masked token: Show toggles the server's preview, Copy puts it on the clipboard.
  el.querySelector('[data-token-toggle]')?.addEventListener('click', (e) => {
    const code = el.querySelector('[data-token-value]');
    if (!code) return;
    const shown = e.target.getAttribute('aria-pressed') === 'true';
    code.textContent = shown ? '••••••••' : code.dataset.tokenValue;
    e.target.setAttribute('aria-pressed', shown ? 'false' : 'true');
    e.target.textContent = shown ? 'Show' : 'Hide';
  });
  el.querySelector('[data-token-copy]')?.addEventListener('click', async () => {
    const value = el.querySelector('[data-token-value]')?.dataset.tokenValue ?? '';
    try {
      await navigator.clipboard.writeText(value);
      showToast('Copied', { tone: 'ok', duration: 2000 });
    } catch {
      showToast('Clipboard unavailable', { tone: 'warn' });
    }
  });

  const runLoopBtn = el.querySelector('#btn-run-loop');
  if (runLoopBtn) {
    runLoopBtn.addEventListener('click', async () => {
      runLoopBtn.disabled = true;
      runLoopBtn.textContent = 'Running...';
      const resultDiv = el.querySelector('#agent-loop-result');
      resultDiv.innerHTML = '<p class="text-dim text-sm mt-8">Executing agent loop...</p>';
      const res = await api(`/api/agent-loop/run/${encodeURIComponent(id)}`, { method: 'POST' });
      if (!res || res.error) {
        resultDiv.innerHTML = '';
        showToast(`Run failed: ${res?.error || 'request failed'}`, {
          tone: 'danger',
          duration: 8000,
        });
      } else {
        resultDiv.innerHTML = `<div class="detail-card mt-8">${renderAgentLoopResult(res.result)}</div>`;
      }
      runLoopBtn.disabled = false;
      runLoopBtn.textContent = 'Run now';
    });
  }

  const reflectBtn = el.querySelector('#btn-reflect');
  if (reflectBtn) {
    reflectBtn.addEventListener('click', async () => {
      reflectBtn.disabled = true;
      reflectBtn.textContent = 'Reflecting...';
      await reflectNow(id);
      reflectBtn.disabled = false;
      reflectBtn.textContent = 'Reflect';
    });
  }

  /** Open one MOTIVATIONS.md backup in the read-only modal. */
  async function showMotivations(version, btn) {
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = 'Loading...';
    const res = await api(
      `/api/agents/${encodeURIComponent(id)}/reflections/motivations/${encodeURIComponent(version)}`
    );
    btn.disabled = false;
    btn.textContent = origText;
    if (!res || res.error) {
      showToast(`Could not load MOTIVATIONS.md: ${res?.error || 'request failed'}`, {
        tone: 'danger',
      });
      return;
    }
    showResultModal(
      `MOTIVATIONS.md — ${version}`,
      `<div style="white-space:pre-wrap;font-size:13px;line-height:1.5;font-family:monospace">${escapeHtml(res.content)}</div>`
    );
  }

  // Reflection Journal buttons, delegated so "Show all" needs no re-wiring.
  el.querySelector('#reflection-card')?.addEventListener('click', (e) => {
    const byDate = e.target.closest('[data-action="view-motivations"]');
    if (byDate) {
      const date = byDate.dataset.date;
      const version = (reflections.motivationsVersions || []).find((v) => v.startsWith(date));
      if (!version) {
        showToast('No MOTIVATIONS backup found for this date.', { tone: 'muted' });
        return;
      }
      showMotivations(version, byDate);
      return;
    }
    const byVersion = e.target.closest('[data-action="view-motivations-version"]');
    if (byVersion) showMotivations(byVersion.dataset.version, byVersion);
  });

  const loadMoreBtn = el.querySelector('#btn-load-more-reflections');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      const container = el.querySelector('#reflection-entries');
      container.innerHTML = reflections.entries
        .map(
          (e, i) => `
        <div style="padding:8px 0;${i < reflections.entries.length - 1 ? 'border-bottom:1px solid var(--border)' : ''}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span class="badge badge-disabled">${escapeHtml(e.date)}</span>
            <span class="text-dim text-sm">${escapeHtml(e.time)}</span>
            ${e.hasMotivationsBackup ? `<button class="btn btn-sm" data-action="view-motivations" data-date="${escapeHtml(e.date)}">Motivations</button>` : ''}
          </div>
          <div style="font-size:13px;line-height:1.5">${escapeHtml(e.journal)}</div>
        </div>
      `
        )
        .join('');
      loadMoreBtn.remove();
    });
  }
}

function buildEvolutionCard(evo) {
  if (!evo || !evo.enabled) return '';

  const activeModules = Object.entries(evo.modules || {})
    .filter(([, v]) => v)
    .map(([k]) => k);

  // Outcome stats KPIs
  let outcomeHtml = '';
  if (evo.outcomeStats && evo.outcomeStats.total > 0) {
    const s = evo.outcomeStats;
    const rateColor =
      s.consumptionRate >= 0.5
        ? 'var(--green)'
        : s.consumptionRate >= 0.2
          ? 'var(--orange)'
          : 'var(--red)';
    outcomeHtml = `
      <div class="text-dim text-sm" style="margin-bottom:4px;margin-top:12px;text-transform:uppercase;letter-spacing:0.3px">Production Outcomes (7d)</div>
      <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px">
        <div style="text-align:center"><div style="font-size:24px;font-weight:700">${s.total}</div><div class="text-dim text-sm">Total</div></div>
        <div style="text-align:center"><div style="font-size:24px;font-weight:700;color:var(--green)">${s.consumed + s.validated}</div><div class="text-dim text-sm">Consumed</div></div>
        <div style="text-align:center"><div style="font-size:24px;font-weight:700;color:var(--orange)">${s.stale}</div><div class="text-dim text-sm">Stale</div></div>
        <div style="text-align:center"><div style="font-size:24px;font-weight:700;color:var(--red)">${s.rejected}</div><div class="text-dim text-sm">Rejected</div></div>
        <div style="text-align:center"><div style="font-size:24px;font-weight:700;color:${rateColor}">${Math.round(s.consumptionRate * 100)}%</div><div class="text-dim text-sm">Rate</div></div>
      </div>`;
  }

  // Recent outcomes list
  let recentHtml = '';
  if (evo.recentOutcomes?.length) {
    const statusIcon = (s) =>
      s === 'consumed'
        ? '✓'
        : s === 'validated'
          ? '★'
          : s === 'stale'
            ? '⏳'
            : s === 'rejected'
              ? '✗'
              : '○';
    const statusColor = (s) =>
      s === 'consumed' || s === 'validated'
        ? 'var(--green)'
        : s === 'stale'
          ? 'var(--orange)'
          : s === 'rejected'
            ? 'var(--red)'
            : 'var(--text-dim)';
    recentHtml = `
      <div class="text-dim text-sm" style="margin-bottom:4px;margin-top:12px;text-transform:uppercase;letter-spacing:0.3px">Recent Productions</div>
      ${evo.recentOutcomes
        .map((o) => {
          const ago = Math.round((Date.now() - o.timestamp) / 3_600_000);
          return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px">
          <span style="color:${statusColor(o.status)};font-weight:600">${statusIcon(o.status)}</span>
          <span class="text-dim text-sm">${ago}h</span>
          <span>${escapeHtml(o.description)}</span>
          <span class="badge badge-${o.status === 'consumed' || o.status === 'validated' ? 'ok' : o.status === 'stale' ? 'disabled' : o.status === 'rejected' ? 'error' : 'disabled'}">${o.status}</span>
        </div>`;
        })
        .join('')}`;
  }

  // Trait bars
  let traitsHtml = '';
  if (evo.traits) {
    const traitNames = [
      'curiosity',
      'caution',
      'sociability',
      'persistence',
      'creativity',
      'independence',
      'depth',
      'risk_tolerance',
    ];
    const traitColor = (v) => (v > 0.7 ? 'var(--green)' : v < 0.3 ? 'var(--red)' : 'var(--accent)');
    traitsHtml = `
      <div class="text-dim text-sm" style="margin-bottom:4px;margin-top:12px;text-transform:uppercase;letter-spacing:0.3px">Trait Registers</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;font-size:13px">
        ${traitNames
          .map((name) => {
            const val = evo.traits[name] ?? 0.5;
            const pct = Math.round(val * 100);
            return `<div style="display:flex;align-items:center;gap:8px">
            <span class="text-dim" style="width:100px;text-align:right">${name.replace('_', ' ')}</span>
            <div style="flex:1;height:6px;background:var(--surface-2,#2a2d36);border-radius:3px;overflow:hidden;min-width:60px">
              <div style="width:${pct}%;height:100%;background:${traitColor(val)};border-radius:3px"></div>
            </div>
            <span style="width:32px;font-family:monospace;font-size:11px">${val.toFixed(2)}</span>
          </div>`;
          })
          .join('')}
      </div>`;
  }

  // Derived parameters
  let paramsHtml = '';
  if (evo.traitParams) {
    const p = evo.traitParams;
    paramsHtml = `
      <div class="text-dim text-sm" style="margin-bottom:4px;margin-top:12px;text-transform:uppercase;letter-spacing:0.3px">Derived Parameters</div>
      <table style="font-size:13px">
        <tr><td class="text-dim" style="width:180px">Executor Temperature</td><td>${p.executorTemperature.toFixed(2)}</td></tr>
        <tr><td class="text-dim">Planner Temperature</td><td>${p.plannerTemperature.toFixed(2)}</td></tr>
        <tr><td class="text-dim">Ask Human Check-in</td><td>every ${p.askHumanCheckInCycles} cycles</td></tr>
        <tr><td class="text-dim">Tool Rounds Bonus</td><td>+${p.maxToolRoundsBonus}</td></tr>
        <tr><td class="text-dim">Web Tools Always On</td><td>${p.webToolAlwaysIncluded ? 'Yes' : 'No'}</td></tr>
      </table>`;
  }

  // Sensors
  let sensorsHtml = '';
  if (evo.cachedSensorEvents?.length) {
    sensorsHtml = `
      <div class="text-dim text-sm" style="margin-bottom:4px;margin-top:12px;text-transform:uppercase;letter-spacing:0.3px">Sensor Readings</div>
      ${evo.cachedSensorEvents
        .map(
          (e) => `
        <div style="display:flex;align-items:center;gap:8px;padding:2px 0;font-size:13px">
          <span class="badge">${e.category}</span>
          <span>${escapeHtml(e.summary)}</span>
          <span class="text-dim text-sm">(${(e.relevance * 100).toFixed(0)}%)</span>
        </div>
      `
        )
        .join('')}`;
  } else if (evo.sensorCount) {
    sensorsHtml = `<div class="text-dim text-sm" style="margin-top:8px">${evo.sensorCount} sensor(s) configured — readings appear after next cycle</div>`;
  }

  // Knowledge mesh
  let meshHtml = '';
  if (evo.meshEntryCount > 0) {
    meshHtml = `
      <div class="text-dim text-sm" style="margin-bottom:4px;margin-top:12px;text-transform:uppercase;letter-spacing:0.3px">Knowledge Mesh (${evo.meshEntryCount} entries)</div>
      ${(evo.meshRecent || [])
        .map(
          (e) => `
        <div style="padding:3px 0;font-size:13px">
          <span class="badge">${escapeHtml(e.sourceBotId)}</span>
          <span style="font-weight:600">${escapeHtml(e.topic)}</span>
          — ${escapeHtml(e.insight.substring(0, 100))}
          <span class="text-dim text-sm">(${(e.confidence * 100).toFixed(0)}% conf)</span>
        </div>
      `
        )
        .join('')}`;
  }

  return `
    <div class="detail-card" style="margin-top:16px">
      <div class="flex-between mb-16">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-weight:600">Evolution</span>
          <span class="badge badge-ok">Active</span>
        </div>
        <span class="text-dim text-sm">${activeModules.length} module${activeModules.length !== 1 ? 's' : ''}: ${activeModules.join(', ')}</span>
      </div>
      ${outcomeHtml}
      ${recentHtml}
      ${traitsHtml}
      ${paramsHtml}
      ${sensorsHtml}
      ${meshHtml}
      ${!outcomeHtml && !traitsHtml && !sensorsHtml && !meshHtml ? '<div class="text-dim" style="font-size:13px">No evolution data yet — run an agent loop cycle to populate.</div>' : ''}
    </div>`;
}

function buildLlmStatsCard(stats) {
  const successRate =
    stats.totalCalls > 0 ? ((stats.successCount / stats.totalCalls) * 100).toFixed(1) : '0.0';
  const rateColor =
    Number(successRate) >= 95
      ? 'var(--green)'
      : Number(successRate) >= 80
        ? 'var(--orange)'
        : 'var(--red)';
  const lastCallDisplay = stats.lastCallAt ? timeAgo(stats.lastCallAt) : 'Never';

  const callerRows = Object.entries(stats.callerBreakdown || {})
    .sort(([, a], [, b]) => b.calls - a.calls)
    .map(([caller, cs]) => {
      const avgMs = cs.calls > 0 ? Math.round(cs.totalDurationMs / cs.calls) : 0;
      return `<tr>
        <td style="font-family:monospace;font-size:12px">${escapeHtml(caller)}</td>
        <td>${cs.calls}</td>
        <td>${cs.errors > 0 ? `<span style="color:var(--red)">${cs.errors}</span>` : '0'}</td>
        <td class="text-dim">${formatDuration(avgMs)}</td>
      </tr>`;
    })
    .join('');

  return `
    <div class="detail-card" style="margin-top:16px">
      <div style="font-weight:600;margin-bottom:12px">LLM Stats</div>
      <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:16px">
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700">${stats.totalCalls}</div>
          <div class="text-dim text-sm">Total Calls</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700;color:var(--green)">${stats.successCount}</div>
          <div class="text-dim text-sm">Successes</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700;color:${stats.failCount > 0 ? 'var(--red)' : 'inherit'}">${stats.failCount}</div>
          <div class="text-dim text-sm">Failures</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700;color:${stats.fallbackCount > 0 ? 'var(--orange)' : 'inherit'}">${stats.fallbackCount}</div>
          <div class="text-dim text-sm">Fallbacks</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700;color:${rateColor}">${successRate}%</div>
          <div class="text-dim text-sm">Success Rate</div>
        </div>
      </div>
      <table style="font-size:13px;margin-bottom:8px">
        <tr>
          <td class="text-dim" style="width:120px">Avg Duration</td>
          <td>${formatDuration(stats.avgDurationMs)}</td>
        </tr>
        <tr>
          <td class="text-dim">Last Call</td>
          <td>${lastCallDisplay}</td>
        </tr>
        ${
          stats.lastError
            ? `<tr>
          <td class="text-dim">Last Error</td>
          <td><details><summary style="cursor:pointer;color:var(--red);font-size:12px">Show error</summary><pre style="white-space:pre-wrap;font-size:11px;margin-top:4px;max-height:100px;overflow-y:auto">${escapeHtml(stats.lastError)}</pre></details></td>
        </tr>`
            : ''
        }
      </table>
      ${
        callerRows
          ? `
        <div class="text-dim text-sm" style="margin-bottom:4px;margin-top:12px">Breakdown by caller</div>
        <table style="font-size:13px">
          <thead><tr><th style="text-align:left">Caller</th><th>Calls</th><th>Errors</th><th>Avg Duration</th></tr></thead>
          <tbody>${callerRows}</tbody>
        </table>
      `
          : ''
      }
      ${buildModelTokenBreakdown(stats)}
    </div>`;
}

function buildModelTokenBreakdown(stats) {
  const mb = stats.modelBreakdown;
  if (!mb || Object.keys(mb).length === 0) return '';
  const totalTokens = (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0);
  if (totalTokens === 0) return '';

  const rows = Object.values(mb)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map(
      (m) => `<tr>
        <td style="font-family:monospace;font-size:12px">${escapeHtml(m.model)}</td>
        <td style="text-align:right">${formatTokenCount(m.promptTokens)}</td>
        <td style="text-align:right">${formatTokenCount(m.completionTokens)}</td>
        <td style="text-align:right;font-weight:600">${formatTokenCount(m.totalTokens)}</td>
        <td style="text-align:right" class="text-dim">${m.calls}</td>
      </tr>`
    )
    .join('');

  return `
    <div class="text-dim text-sm" style="margin-bottom:4px;margin-top:12px">Token usage by model (${formatTokenCount(totalTokens)} total)</div>
    <table style="font-size:13px">
      <thead><tr><th style="text-align:left">Model</th><th style="text-align:right">In</th><th style="text-align:right">Out</th><th style="text-align:right">Total</th><th style="text-align:right">Calls</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function buildSoulStatusBanner(soulStatus) {
  if (!soulStatus || soulStatus.error) {
    return `<div class="soul-banner soul-banner-error">
      <span class="soul-banner-icon">&#9888;</span>
      <div class="soul-banner-text">
        <strong>Soul status unknown</strong>
        <span class="text-dim text-sm">Could not check soul files.</span>
      </div>
      <button class="btn btn-sm btn-primary" id="btn-soul-retry">Generate Soul</button>
    </div>`;
  }

  if (soulStatus.complete) return '';

  const missing = [];
  if (!soulStatus.files.identity.exists || soulStatus.files.identity.length === 0)
    missing.push('IDENTITY.md');
  if (!soulStatus.files.soul.exists || soulStatus.files.soul.length === 0) missing.push('SOUL.md');
  if (!soulStatus.files.motivations.exists || soulStatus.files.motivations.length === 0)
    missing.push('MOTIVATIONS.md');

  if (!soulStatus.hasSoulDir) {
    return `<div class="soul-banner soul-banner-error">
      <span class="soul-banner-icon">&#9888;</span>
      <div class="soul-banner-text">
        <strong>No soul directory</strong>
        <span class="text-dim text-sm">Soul files have not been created yet. Generate a soul to give this agent a personality.</span>
      </div>
      <button class="btn btn-sm btn-primary" id="btn-soul-retry">Generate Soul</button>
    </div>`;
  }

  return `<div class="soul-banner soul-banner-warn">
    <span class="soul-banner-icon">&#9888;</span>
    <div class="soul-banner-text">
      <strong>Incomplete soul files</strong>
      <span class="text-dim text-sm">Missing: ${missing.join(', ')}. Generate or regenerate soul to fix this.</span>
    </div>
    <button class="btn btn-sm btn-primary" id="btn-soul-retry">Generate Soul</button>
  </div>`;
}

export async function renderAgentEdit(el, id) {
  const [agent, skills, defaults, soulStatus] = await Promise.all([
    api(`/api/agents/${id}`),
    api('/api/skills'),
    api('/api/agents/defaults'),
    api(`/api/agents/${id}/soul-status`),
  ]);

  teardownEditGuard();
  if (!agent || agent.error) {
    el.innerHTML = `<div class="page-title">Edit agent</div>${emptyState({
      icon: '∅',
      title: 'Agent not found',
      hint: agent?.error || 'The server did not return this agent.',
      action: '<a class="btn" href="#/agents">Back to agents</a>',
    })}`;
    return;
  }

  const soulBanner = buildSoulStatusBanner(soulStatus);
  // Where Save / Cancel go: the agent's Config, Home or the list, whichever opened the form.
  const returnHash = editReturnHash(id, prevHash);

  el.innerHTML = `
    <div class="detail-header">
      <a href="${escapeHtml(returnHash)}" class="back" title="Back">&larr;</a>
      <div class="page-title">Edit ${escapeHtml(agent.name)}</div>
      <span class="edit-dirty" id="edit-dirty" hidden>Unsaved changes · Ctrl+S to save</span>
    </div>
    ${soulBanner}
    <div id="edit-jump-slot" class="edit-jump-slot"></div>
    <form id="edit-form" class="detail-card">
      <div class="form-section-title" id="sec-general">General</div>
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
        <div style="margin-bottom:6px">
          <a href="#" id="skills-select-all" class="text-sm" style="margin-right:12px">Select all</a>
          <a href="#" id="skills-unselect-all" class="text-sm">Unselect all</a>
        </div>
        <div class="checkbox-group" id="skills-group">
          ${skills
            .map(
              (s) => `
            <label class="${agent.skills.includes(s.id) ? 'checked' : ''}">
              <input type="checkbox" name="skills" value="${s.id}" ${agent.skills.includes(s.id) ? 'checked' : ''}>
              ${escapeHtml(s.name)}
            </label>
          `
            )
            .join('')}
        </div>
      </div>
      <div class="form-group">
        <label>Mention Patterns (comma-separated)</label>
        <input type="text" name="mentionPatterns" value="${(agent.mentionPatterns || []).join(', ')}">
      </div>

      <div class="form-separator"></div>
      <div class="form-section-title" id="sec-overrides">Agent Overrides <span class="text-dim text-sm">(empty = use global default)</span></div>

      <div class="form-group">
        <label>Model</label>
        <select name="model">
          <option value="">Global default (${escapeHtml(defaults.model)})</option>
          ${(defaults.availableModels || [])
            .map((m) => {
              const selected =
                m === 'claude-cli'
                  ? agent.llmBackend === 'claude-cli'
                    ? 'selected'
                    : ''
                  : agent.model === m && agent.llmBackend !== 'claude-cli'
                    ? 'selected'
                    : '';
              return `<option value="${escapeHtml(m)}" ${selected}>${escapeHtml(m)}</option>`;
            })
            .join('')}
        </select>
      </div>
      <div class="form-group" id="claude-model-group"${agent.llmBackend === 'claude-cli' ? '' : ' hidden'}>
        <label>Claude model <span class="text-dim" style="text-transform:none;letter-spacing:0">(only for claude-cli; the global default is set in Settings → Claude CLI)</span></label>
        ${claudeModelSelect(defaults, agent)}
      </div>
      <div class="form-group">
        <label>System Prompt</label>
        <textarea name="systemPrompt" rows="4" placeholder="${escapeHtml(defaults.systemPrompt)}">${escapeHtml(agent.conversation?.systemPrompt || '')}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Temperature</label>
          <input type="number" name="temperature" min="0" max="2" step="0.1" value="${agent.conversation?.temperature ?? ''}" placeholder="${defaults.temperature}">
        </div>
        <div class="form-group">
          <label>Max History</label>
          <input type="number" name="maxHistory" min="1" step="1" value="${agent.conversation?.maxHistory ?? ''}" placeholder="${defaults.maxHistory}">
        </div>
      </div>
      <div class="form-group">
        <label>Soul Directory</label>
        <div class="input-with-btn">
          <input type="text" name="soulDir" value="${escapeHtml(agent.soulDir || '')}" placeholder="${escapeHtml(defaults.soulDir)}">
          <button type="button" class="btn btn-sm" id="btn-init-soul">Init Custom Soul</button>
        </div>
      </div>
      <div class="form-group">
        <label>Working Directory</label>
        <input type="text" name="workDir" value="${escapeHtml(agent.workDir || '')}" placeholder="${escapeHtml(`${defaults.productionsBaseDir || './productions'}/${agent.id}`)}">
        <span class="text-dim text-sm">File tools and exec operate within this directory. Default: productions/&lt;botId&gt;</span>
      </div>
      <div class="form-group">
        <label>Productions</label>
        <select name="productionsEnabled">
          <option value="true" ${agent.productions?.enabled !== false ? 'selected' : ''}>Enabled (default)</option>
          <option value="false" ${agent.productions?.enabled === false ? 'selected' : ''}>Disabled</option>
        </select>
        <span class="text-dim text-sm">When disabled, the agent loop won't instruct the bot to produce files or scan the working directory</span>
      </div>

      <div class="form-separator"></div>
      <div class="form-section-title" id="sec-loop">Agent Loop <span class="text-dim text-sm">(empty = use global default)</span></div>

      <div class="form-group">
        <label>Agent Loop Enabled</label>
        <select name="agentLoopEnabled">
          <option value="" ${agent.agentLoop?.enabled == null ? 'selected' : ''}>Inherit global</option>
          <option value="true" ${agent.agentLoop?.enabled === true ? 'selected' : ''}>On</option>
          <option value="false" ${agent.agentLoop?.enabled === false ? 'selected' : ''}>Off</option>
        </select>
        <span class="text-dim text-sm">Override global agent loop setting for this bot</span>
      </div>

      <div class="form-group">
        <label>Loop Interval</label>
        <input type="text" name="agentLoopEvery" value="${escapeHtml(agent.agentLoop?.every || '')}" placeholder="${escapeHtml(defaults.agentLoopInterval || '6h')}">
        <span class="text-dim text-sm">How often this bot runs autonomously (e.g. 30m, 1h, 6h, 1d)</span>
      </div>

      <div class="form-group">
        <label>Mode</label>
        <select name="agentLoopMode">
          <option value="periodic" ${(agent.agentLoop?.mode || 'periodic') === 'periodic' ? 'selected' : ''}>Periodic</option>
          <option value="continuous" ${agent.agentLoop?.mode === 'continuous' ? 'selected' : ''}>Continuous</option>
        </select>
        <span class="text-dim text-sm">Periodic = runs at interval, Continuous = runs non-stop with pauses</span>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>Max Tool Rounds</label>
          <input type="number" name="agentLoopMaxToolRounds" min="1" max="50" value="${agent.agentLoop?.maxToolRounds ?? ''}" placeholder="${defaults.agentLoop?.maxToolRounds ?? 30}">
        </div>
        <div class="form-group">
          <label>Report Chat ID</label>
          <input type="number" name="agentLoopReportChatId" value="${agent.agentLoop?.reportChatId ?? ''}" placeholder="Telegram chat ID">
        </div>
      </div>

      <div id="continuous-fields" style="display:${agent.agentLoop?.mode === 'continuous' ? 'block' : 'none'}">
        <div class="form-row">
          <div class="form-group">
            <label>Continuous Pause (ms)</label>
            <input type="number" name="agentLoopContinuousPauseMs" min="0" value="${agent.agentLoop?.continuousPauseMs ?? ''}" placeholder="5000">
          </div>
          <div class="form-group">
            <label>Memory Flush Every N Cycles</label>
            <input type="number" name="agentLoopContinuousMemoryEvery" min="1" value="${agent.agentLoop?.continuousMemoryEvery ?? ''}" placeholder="5">
          </div>
        </div>
      </div>

      <details class="form-details">
        <summary class="form-details-summary">Strategist</summary>
        <div class="form-group">
          <label>Strategist Enabled</label>
          <select name="agentLoopStrategistEnabled">
            <option value="" ${agent.agentLoop?.strategist?.enabled == null ? 'selected' : ''}>Inherit global</option>
            <option value="true" ${agent.agentLoop?.strategist?.enabled === true ? 'selected' : ''}>On</option>
            <option value="false" ${agent.agentLoop?.strategist?.enabled === false ? 'selected' : ''}>Off</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Every N Cycles</label>
            <input type="number" name="agentLoopStrategistEveryCycles" min="1" value="${agent.agentLoop?.strategist?.everyCycles ?? ''}" placeholder="${defaults.agentLoop?.strategist?.everyCycles ?? 4}">
          </div>
          <div class="form-group">
            <label>Min Interval</label>
            <input type="text" name="agentLoopStrategistMinInterval" value="${escapeHtml(agent.agentLoop?.strategist?.minInterval || '')}" placeholder="${escapeHtml(defaults.agentLoop?.strategist?.minInterval || '4h')}">
          </div>
        </div>
      </details>

      <details class="form-details">
        <summary class="form-details-summary">Timeouts</summary>
        <div class="form-group">
          <label>Claude Timeout (ms)</label>
          <input type="number" name="agentLoopClaudeTimeout" min="1" value="${agent.agentLoop?.claudeTimeout ?? ''}" placeholder="${defaults.agentLoop?.claudeTimeout ?? 300000}">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Feedback (ms)</label>
            <input type="number" name="agentLoopPhaseTimeoutFeedback" min="1" value="${agent.agentLoop?.phaseTimeouts?.feedbackMs ?? ''}" placeholder="${defaults.agentLoop?.phaseTimeouts?.feedbackMs ?? 30000}">
          </div>
          <div class="form-group">
            <label>Strategist (ms)</label>
            <input type="number" name="agentLoopPhaseTimeoutStrategist" min="1" value="${agent.agentLoop?.phaseTimeouts?.strategistMs ?? ''}" placeholder="${defaults.agentLoop?.phaseTimeouts?.strategistMs ?? 60000}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Planner (ms)</label>
            <input type="number" name="agentLoopPhaseTimeoutPlanner" min="1" value="${agent.agentLoop?.phaseTimeouts?.plannerMs ?? ''}" placeholder="${defaults.agentLoop?.phaseTimeouts?.plannerMs ?? 60000}">
          </div>
          <div class="form-group">
            <label>Executor (ms)</label>
            <input type="number" name="agentLoopPhaseTimeoutExecutor" min="1" value="${agent.agentLoop?.phaseTimeouts?.executorMs ?? ''}" placeholder="${defaults.agentLoop?.phaseTimeouts?.executorMs ?? 90000}">
          </div>
        </div>
      </details>

      <details class="form-details">
        <summary class="form-details-summary">Retry</summary>
        <div class="form-row">
          <div class="form-group">
            <label>Max Retries</label>
            <input type="number" name="agentLoopRetryMaxRetries" min="0" max="10" value="${agent.agentLoop?.retry?.maxRetries ?? ''}" placeholder="${defaults.agentLoop?.retry?.maxRetries ?? 2}">
          </div>
          <div class="form-group">
            <label>Backoff Multiplier</label>
            <input type="number" name="agentLoopRetryBackoffMultiplier" min="1" max="10" step="0.5" value="${agent.agentLoop?.retry?.backoffMultiplier ?? ''}" placeholder="${defaults.agentLoop?.retry?.backoffMultiplier ?? 2}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Initial Delay (ms)</label>
            <input type="number" name="agentLoopRetryInitialDelay" min="1000" max="300000" value="${agent.agentLoop?.retry?.initialDelayMs ?? ''}" placeholder="${defaults.agentLoop?.retry?.initialDelayMs ?? 10000}">
          </div>
          <div class="form-group">
            <label>Max Delay (ms)</label>
            <input type="number" name="agentLoopRetryMaxDelay" min="1000" max="600000" value="${agent.agentLoop?.retry?.maxDelayMs ?? ''}" placeholder="${defaults.agentLoop?.retry?.maxDelayMs ?? 60000}">
          </div>
        </div>
      </details>

      <details class="form-details">
        <summary class="form-details-summary">Loop Detection</summary>
        <div class="form-group">
          <label>Loop Detection Enabled</label>
          <select name="agentLoopLoopDetectionEnabled">
            <option value="" ${agent.agentLoop?.loopDetection?.enabled == null ? 'selected' : ''}>Inherit global</option>
            <option value="true" ${agent.agentLoop?.loopDetection?.enabled === true ? 'selected' : ''}>On</option>
            <option value="false" ${agent.agentLoop?.loopDetection?.enabled === false ? 'selected' : ''}>Off</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Warning Threshold</label>
            <input type="number" name="agentLoopLoopDetectionWarning" min="2" max="100" value="${agent.agentLoop?.loopDetection?.warningThreshold ?? ''}" placeholder="${defaults.agentLoop?.loopDetection?.warningThreshold ?? 8}">
          </div>
          <div class="form-group">
            <label>Critical Threshold</label>
            <input type="number" name="agentLoopLoopDetectionCritical" min="3" max="200" value="${agent.agentLoop?.loopDetection?.criticalThreshold ?? ''}" placeholder="${defaults.agentLoop?.loopDetection?.criticalThreshold ?? 16}">
          </div>
        </div>
        <div class="form-group">
          <label>Circuit Breaker Threshold</label>
          <input type="number" name="agentLoopLoopDetectionCircuitBreaker" min="5" max="500" value="${agent.agentLoop?.loopDetection?.globalCircuitBreakerThreshold ?? ''}" placeholder="${defaults.agentLoop?.loopDetection?.globalCircuitBreakerThreshold ?? 25}">
        </div>
      </details>

      <details class="form-details">
        <summary class="form-details-summary">Evolution & Behavioral</summary>
        <div class="form-group">
          <label>Evolution System</label>
          <select name="evolutionEnabled">
            <option value="true" ${(agent.agentLoop?.evolution?.enabled ?? defaults.evolution?.enabled ?? false) ? 'selected' : ''}>On</option>
            <option value="false" ${!(agent.agentLoop?.evolution?.enabled ?? defaults.evolution?.enabled ?? false) ? 'selected' : ''}>Off</option>
          </select>
          <span class="text-dim text-sm">Outcome ledger, trait registers, sensors, skill crystallizer, knowledge mesh, goal genealogy</span>
        </div>

        <div class="form-group">
          <label>Engagement Gate</label>
          <select name="engagementGateEnabled">
            <option value="true" ${agent.agentLoop?.engagementGate?.enabled !== false ? 'selected' : ''}>On</option>
            <option value="false" ${agent.agentLoop?.engagementGate?.enabled === false ? 'selected' : ''}>Off</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Gate Mode</label>
            <select name="engagementGateMode">
              <option value="" ${!agent.agentLoop?.engagementGate?.mode ? 'selected' : ''}>Default (soft)</option>
              <option value="soft" ${agent.agentLoop?.engagementGate?.mode === 'soft' ? 'selected' : ''}>Soft</option>
              <option value="hard" ${agent.agentLoop?.engagementGate?.mode === 'hard' ? 'selected' : ''}>Hard</option>
            </select>
          </div>
          <div class="form-group">
            <label>Gate Threshold</label>
            <input type="number" name="engagementGateThreshold" min="1" max="50" value="${agent.agentLoop?.engagementGate?.threshold ?? ''}" placeholder="5">
          </div>
        </div>

        <div class="form-group">
          <label>RSS Feeds (sensors)</label>
          <textarea name="evolutionRssFeeds" rows="3" placeholder="One URL per line">${escapeHtml((agent.agentLoop?.evolution?.sensors?.rss?.feeds || []).join('\n'))}</textarea>
          <span class="text-dim text-sm">RSS/Atom feed URLs for the environmental sensor. Bot will detect new articles relevant to its goals.</span>
        </div>
      </details>

      <details class="form-details" id="curiosity-details">
        <summary class="form-details-summary">Curiosity</summary>
        <span class="text-dim text-sm">How far this agent may roam and how often it explores. Every dial: closed stays inside, ask proposes crossing to you, open crosses and reports.</span>
        ${curiosityFormSection(agent.agentLoop?.curiosity)}
      </details>

      <div class="form-group">
        <label>Standing Directives</label>
        <textarea name="agentLoopDirectives" rows="3" placeholder="One directive per line — ongoing behavioral instructions for the agent loop">${escapeHtml((agent.agentLoop?.directives || []).join('\n'))}</textarea>
        <span class="text-dim text-sm">Ongoing instructions injected into strategist/planner/executor prompts (max 10, 500 chars each)</span>
      </div>

      <div class="form-group">
        <label>Preset Directives</label>
        <div class="checkbox-group">
          <label class="${(agent.agentLoop?.presetDirectives || []).includes('conversation-review') ? 'checked' : ''}">
            <input type="checkbox" name="presetDirectives" value="conversation-review" ${(agent.agentLoop?.presetDirectives || []).includes('conversation-review') ? 'checked' : ''}>
            Conversation Review <span class="text-dim text-sm">— periodically review session logs for quality improvements</span>
          </label>
        </div>
      </div>

      ${
        defaults.ttsEnabled
          ? `
      <div class="form-separator"></div>
      <div class="form-section-title" id="sec-voice">Voice (TTS) <span class="text-dim text-sm">(empty = use global default)</span></div>

      <div class="form-group">
        <label>Voice</label>
        <div class="input-with-btn">
          <select name="ttsVoiceId" id="tts-voice-select">
            ${voiceOptions([], { selected: agent.tts?.voiceId, defaultVoiceId: defaults.ttsVoiceId })}
          </select>
          <button type="button" class="btn btn-sm" id="btn-preview-voice" title="Play the ElevenLabs sample for the selected voice (no credits)">Preview</button>
        </div>
        <input type="text" name="ttsVoiceCustom" id="tts-voice-custom" class="tts-voice-custom" placeholder="ElevenLabs voice id" value="" hidden>
        <div class="text-dim text-sm tts-voice-note" id="tts-voice-note">Loading voices…</div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Speed</label>
          <input type="number" name="ttsSpeed" min="0.5" max="2" step="0.1" value="${agent.tts?.voiceSettings?.speed ?? ''}" placeholder="1.0">
        </div>
        <div class="form-group">
          <label>Stability</label>
          <input type="number" name="ttsStability" min="0" max="1" step="0.1" value="${agent.tts?.voiceSettings?.stability ?? ''}" placeholder="0.5">
        </div>
      </div>
      `
          : ''
      }

      ${
        defaults.availableTools?.length
          ? `
      <div class="form-separator"></div>
      <div class="form-section-title" id="sec-tools">Tools <span class="text-dim text-sm">(uncheck to disable)</span></div>

      <div class="form-group">
        <div class="checkbox-group" id="tools-group">
          ${defaults.availableTools
            .map((t) => {
              const disabled = (agent.disabledTools || []).includes(t);
              return `
            <label class="${!disabled ? 'checked' : ''}">
              <input type="checkbox" name="tools" value="${escapeHtml(t)}" ${!disabled ? 'checked' : ''}>
              ${escapeHtml(t)}
            </label>`;
            })
            .join('')}
        </div>
      </div>
      `
          : ''
      }

      ${
        defaults.availableSkills?.length
          ? `
      <div class="form-separator"></div>
      <div class="form-section-title" id="sec-ext-skills">External Skills <span class="text-dim text-sm">(uncheck to disable all tools from a skill)</span></div>

      <div class="form-group">
        <div class="checkbox-group" id="ext-skills-group">
          ${defaults.availableSkills
            .map((s) => {
              const disabled = (agent.disabledSkills || []).includes(s);
              return `
            <label class="${!disabled ? 'checked' : ''}">
              <input type="checkbox" name="extSkills" value="${escapeHtml(s)}" ${!disabled ? 'checked' : ''}>
              ${escapeHtml(s)}
            </label>`;
            })
            .join('')}
        </div>
      </div>
      `
          : ''
      }

      ${
        defaults.defaultToolPermissions
          ? `
      <div class="form-separator"></div>
      <div class="form-section-title" id="sec-permissions">Tool Permissions</div>

      <div class="form-group">
        <label>Permission Matrix <span class="text-dim text-sm">(override defaults per tool)</span></label>
        <p class="text-dim text-sm" style="margin:4px 0 8px">Conversation never hides a tool the agent has. <code>blocked</code> there is treated as <code>confirm</code> (operator approval). To remove a tool entirely, disable it on the agent.</p>
        <details>
          <summary class="text-dim text-sm" style="cursor:pointer;margin-bottom:8px">Show/hide matrix (${Object.keys(defaults.defaultToolPermissions).length} tools)</summary>
          <div style="max-height:400px;overflow:auto">
          <table class="perm-matrix" style="width:100%;font-size:0.85em;border-collapse:collapse">
            <thead>
              <tr>
                <th style="text-align:left;padding:4px">Tool</th>
                <th style="padding:4px">Agent Loop</th>
                <th style="padding:4px">Conversation</th>
              </tr>
            </thead>
            <tbody>
              ${renderPermissionMatrixRows(defaults, agent)}
            </tbody>
          </table>
          </div>
        </details>
      </div>
      `
          : ''
      }

      <div class="actions edit-actions">
        <button type="submit" class="btn btn-primary" id="btn-edit-save" title="Save (Ctrl+S)">Save</button>
        <button type="button" class="btn" id="btn-generate-soul">Generate Soul</button>
        <button type="button" class="btn" id="btn-edit-cancel">Cancel</button>
      </div>
    </form>
  `;

  // Toggle checkbox styling
  el.querySelectorAll('.checkbox-group input').forEach((inp) => {
    inp.addEventListener('change', () => {
      inp.parentElement.classList.toggle('checked', inp.checked);
    });
  });

  // Skills select all / unselect all
  function setAllSkillCheckboxes(checked) {
    el.querySelectorAll('#skills-group input[type="checkbox"]').forEach((inp) => {
      inp.checked = checked;
      inp.parentElement.classList.toggle('checked', checked);
    });
  }
  document.getElementById('skills-select-all')?.addEventListener('click', (e) => {
    e.preventDefault();
    setAllSkillCheckboxes(true);
  });
  document.getElementById('skills-unselect-all')?.addEventListener('click', (e) => {
    e.preventDefault();
    setAllSkillCheckboxes(false);
  });

  // Init custom soul button
  document.getElementById('btn-init-soul').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Initializing...';
    const result = await api(`/api/agents/${id}/init-soul`, { method: 'POST' });
    if (!result || result.error) {
      showToast(`Init soul failed: ${result?.error || 'request failed'}`, {
        tone: 'danger',
        duration: 8000,
      });
      e.target.disabled = false;
      e.target.textContent = 'Init Custom Soul';
      return;
    }
    if (result.soulDir) {
      const soulDirInput = document.querySelector('input[name="soulDir"]');
      soulDirInput.value = result.soulDir;
      soulDirInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    e.target.textContent = 'Done';
    setTimeout(() => {
      e.target.disabled = false;
      e.target.textContent = 'Init Custom Soul';
    }, 2000);
  });

  // Toggle continuous fields visibility based on mode
  wireCuriosityForm(document.getElementById('curiosity-details'));
  const modeSelect = document.querySelector('select[name="agentLoopMode"]');
  if (modeSelect) {
    modeSelect.addEventListener('change', () => {
      const fields = document.getElementById('continuous-fields');
      if (fields) fields.style.display = modeSelect.value === 'continuous' ? 'block' : 'none';
    });
  }

  // Generate soul button (bottom of form)
  document.getElementById('btn-generate-soul').addEventListener('click', () => {
    showGenerateSoulModal(id, agent.name, () => renderAgentEdit(el, id));
  });

  // Soul status banner retry button
  const soulRetryBtn = document.getElementById('btn-soul-retry');
  if (soulRetryBtn) {
    soulRetryBtn.addEventListener('click', () => {
      showGenerateSoulModal(id, agent.name, () => renderAgentEdit(el, id));
    });
  }

  // Load ElevenLabs voices button
  // Voice select (session S4): filled from the cached /api/tts/voices, with a
  // "Custom voice id…" escape hatch and a credit-free preview of the sample.
  const voiceSelect = document.getElementById('tts-voice-select');
  if (voiceSelect) {
    const customInput = document.getElementById('tts-voice-custom');
    const note = document.getElementById('tts-voice-note');
    const previewBtn = document.getElementById('btn-preview-voice');
    let previewAudio = null;
    const syncCustom = () => {
      const custom = voiceSelect.value === CUSTOM_VOICE;
      customInput.hidden = !custom;
      if (custom) customInput.focus();
      const opt = voiceSelect.selectedOptions?.[0];
      previewBtn.disabled = !opt?.dataset.preview;
    };
    voiceSelect.addEventListener('change', syncCustom);
    previewBtn.addEventListener('click', () => {
      const url = voiceSelect.selectedOptions?.[0]?.dataset.preview;
      if (!url) return;
      if (previewAudio) {
        previewAudio.pause();
        previewAudio = null;
        previewBtn.textContent = 'Preview';
        return;
      }
      previewAudio = new Audio(url);
      previewBtn.textContent = 'Stop';
      previewAudio.addEventListener('ended', () => {
        previewAudio = null;
        previewBtn.textContent = 'Preview';
      });
      previewAudio.play().catch(() => {
        previewAudio = null;
        previewBtn.textContent = 'Preview';
      });
    });
    (async () => {
      const data = await api('/api/tts/voices').catch((err) => ({ error: err.message }));
      if (!data || data.error) {
        note.textContent = `Voice list unavailable: ${data?.error || 'request failed'}. You can still paste a voice id.`;
      } else {
        voiceSelect.innerHTML = voiceOptions(data.voices, {
          selected: agent.tts?.voiceId,
          defaultVoiceId: data.defaultVoiceId || defaults.ttsVoiceId,
        });
        note.textContent = `${data.voices.length} ElevenLabs voices. Press play on the agent's header to hear its now-line.`;
      }
      syncCustom();
      rebaselineEdit();
    })();
    syncCustom();
  }

  // Show the Claude model picker only while claude-cli is the chosen backend.
  const editForm = document.getElementById('edit-form');
  const claudeGroup = document.getElementById('claude-model-group');
  editForm.model.addEventListener('change', () => {
    if (claudeGroup) claudeGroup.hidden = !showClaudeModelSelect(editForm.model.value);
  });

  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const patch = { name: form.name.value, enabled: form.enabled.checked };

    if (form.token.value) patch.token = form.token.value;

    patch.skills = Array.from(form.querySelectorAll('input[name="skills"]:checked')).map(
      (i) => i.value
    );
    patch.mentionPatterns = form.mentionPatterns.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Per-agent overrides (use null to clear — undefined is stripped by JSON.stringify)
    const selectedModel = form.model.value.trim();
    if (selectedModel === 'claude-cli') {
      // Empty = follow the fleet-wide claudeCli.model; a value pins this agent.
      patch.model = form.claudeModel?.value.trim() || null;
      patch.llmBackend = 'claude-cli';
    } else {
      patch.model = selectedModel || null;
      patch.llmBackend = null;
    }
    patch.soulDir = form.soulDir.value.trim() || null;
    patch.workDir = form.workDir.value.trim() || null;

    // Productions toggle
    const productionsEnabledVal = form.productionsEnabled.value;
    patch.productions = { ...agent.productions, enabled: productionsEnabledVal !== 'false' };

    // Build conversation overrides
    const systemPrompt = form.systemPrompt.value.trim() || undefined;
    const temperature =
      form.temperature.value !== '' ? Number.parseFloat(form.temperature.value) : undefined;
    const maxHistory =
      form.maxHistory.value !== '' ? Number.parseInt(form.maxHistory.value, 10) : undefined;

    if (systemPrompt !== undefined || temperature !== undefined || maxHistory !== undefined) {
      patch.conversation = { systemPrompt, temperature, maxHistory };
    } else {
      patch.conversation = undefined;
    }

    // Disabled tools (unchecked = disabled)
    if (defaults.availableTools?.length) {
      const checkedTools = Array.from(form.querySelectorAll('input[name="tools"]:checked')).map(
        (i) => i.value
      );
      const disabledTools = defaults.availableTools.filter((t) => !checkedTools.includes(t));
      patch.disabledTools = disabledTools.length > 0 ? disabledTools : [];
    }

    // Disabled external skills (unchecked = disabled)
    if (defaults.availableSkills?.length) {
      const checkedSkills = Array.from(
        form.querySelectorAll('input[name="extSkills"]:checked')
      ).map((i) => i.value);
      const disabledSkills = defaults.availableSkills.filter((s) => !checkedSkills.includes(s));
      patch.disabledSkills = disabledSkills.length > 0 ? disabledSkills : [];
    }

    // Tool permissions (only send overrides that differ from defaults)
    if (defaults.defaultToolPermissions) {
      const overrides = {};
      form.querySelectorAll('.perm-matrix select').forEach((sel) => {
        const tool = sel.dataset.tool;
        const mode = sel.dataset.mode;
        const defVal = sel.dataset.default;
        const val = sel.value;
        if (val !== defVal) {
          if (!overrides[tool]) overrides[tool] = {};
          overrides[tool][mode] = val;
        }
      });
      patch.toolPermissions = Object.keys(overrides).length > 0 ? overrides : null;
    }

    // Agent loop overrides
    const agentLoopEvery = form.agentLoopEvery.value.trim() || undefined;
    const agentLoopEnabledVal = form.agentLoopEnabled.value;
    const agentLoopEnabled =
      agentLoopEnabledVal === 'true' ? true : agentLoopEnabledVal === 'false' ? false : undefined;
    const directivesRaw = form.agentLoopDirectives.value.trim();
    const agentLoopDirectives = directivesRaw
      ? directivesRaw
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 10)
      : undefined;
    const presetCheckboxes = form.querySelectorAll
      ? el.querySelectorAll('input[name="presetDirectives"]:checked')
      : [];
    const presetDirectives = Array.from(presetCheckboxes).map((cb) => cb.value);

    // Helper: parse number input, return undefined if empty
    const numOrUndef = (name) => {
      const v = form[name]?.value;
      return v !== '' && v != null ? Number(v) : undefined;
    };
    // Helper: parse select with inherit option
    const boolOrUndef = (name) => {
      const v = form[name]?.value;
      return v === 'true' ? true : v === 'false' ? false : undefined;
    };

    const agentLoopPatch = { ...agent.agentLoop };

    // Core fields (use null for "inherit global" so JSON serialization preserves the intent to clear)
    agentLoopPatch.enabled = agentLoopEnabled ?? null;
    agentLoopPatch.every = agentLoopEvery;
    agentLoopPatch.mode = form.agentLoopMode.value === 'continuous' ? 'continuous' : undefined;
    agentLoopPatch.maxToolRounds = numOrUndef('agentLoopMaxToolRounds');
    agentLoopPatch.reportChatId = numOrUndef('agentLoopReportChatId');
    agentLoopPatch.claudeTimeout = numOrUndef('agentLoopClaudeTimeout');

    // Continuous mode fields
    agentLoopPatch.continuousPauseMs = numOrUndef('agentLoopContinuousPauseMs');
    agentLoopPatch.continuousMemoryEvery = numOrUndef('agentLoopContinuousMemoryEvery');

    // Directives
    agentLoopPatch.directives = agentLoopDirectives;
    agentLoopPatch.presetDirectives = presetDirectives.length > 0 ? presetDirectives : undefined;

    // Strategist sub-object
    const stratEnabled = boolOrUndef('agentLoopStrategistEnabled');
    const stratEveryCycles = numOrUndef('agentLoopStrategistEveryCycles');
    const stratMinInterval = form.agentLoopStrategistMinInterval?.value.trim() || undefined;
    if (stratEnabled != null || stratEveryCycles != null || stratMinInterval != null) {
      agentLoopPatch.strategist = {
        enabled: stratEnabled,
        everyCycles: stratEveryCycles,
        minInterval: stratMinInterval,
      };
    } else {
      agentLoopPatch.strategist = undefined;
    }

    // Phase timeouts sub-object
    const ptFeedback = numOrUndef('agentLoopPhaseTimeoutFeedback');
    const ptStrategist = numOrUndef('agentLoopPhaseTimeoutStrategist');
    const ptPlanner = numOrUndef('agentLoopPhaseTimeoutPlanner');
    const ptExecutor = numOrUndef('agentLoopPhaseTimeoutExecutor');
    if (ptFeedback != null || ptStrategist != null || ptPlanner != null || ptExecutor != null) {
      agentLoopPatch.phaseTimeouts = {
        feedbackMs: ptFeedback,
        strategistMs: ptStrategist,
        plannerMs: ptPlanner,
        executorMs: ptExecutor,
      };
    } else {
      agentLoopPatch.phaseTimeouts = undefined;
    }

    // Retry sub-object
    const retryMax = numOrUndef('agentLoopRetryMaxRetries');
    const retryInitial = numOrUndef('agentLoopRetryInitialDelay');
    const retryMaxDelay = numOrUndef('agentLoopRetryMaxDelay');
    const retryBackoff = numOrUndef('agentLoopRetryBackoffMultiplier');
    if (retryMax != null || retryInitial != null || retryMaxDelay != null || retryBackoff != null) {
      agentLoopPatch.retry = {
        maxRetries: retryMax,
        initialDelayMs: retryInitial,
        maxDelayMs: retryMaxDelay,
        backoffMultiplier: retryBackoff,
      };
    } else {
      agentLoopPatch.retry = undefined;
    }

    // Loop detection sub-object
    const ldEnabled = boolOrUndef('agentLoopLoopDetectionEnabled');
    const ldWarning = numOrUndef('agentLoopLoopDetectionWarning');
    const ldCritical = numOrUndef('agentLoopLoopDetectionCritical');
    const ldCircuitBreaker = numOrUndef('agentLoopLoopDetectionCircuitBreaker');
    if (ldEnabled != null || ldWarning != null || ldCritical != null || ldCircuitBreaker != null) {
      agentLoopPatch.loopDetection = {
        enabled: ldEnabled,
        warningThreshold: ldWarning,
        criticalThreshold: ldCritical,
        globalCircuitBreakerThreshold: ldCircuitBreaker,
      };
    } else {
      agentLoopPatch.loopDetection = undefined;
    }

    // Evolution sub-object
    const evoEnabled = form.evolutionEnabled?.value === 'true';
    const evoRssFeeds = form.evolutionRssFeeds?.value?.trim();
    const evoRssFeedsArr = evoRssFeeds
      ? evoRssFeeds
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    agentLoopPatch.evolution = {
      enabled: evoEnabled,
      ...(evoRssFeedsArr.length > 0 ? { sensors: { rss: { feeds: evoRssFeedsArr } } } : {}),
    };

    // Engagement gate sub-object
    const egEnabled = form.engagementGateEnabled?.value === 'true';
    const egMode = form.engagementGateMode?.value || undefined;
    const egThreshold = numOrUndef('engagementGateThreshold');
    agentLoopPatch.engagementGate = {
      enabled: egEnabled,
      ...(egMode ? { mode: egMode } : {}),
      ...(egThreshold != null ? { threshold: egThreshold } : {}),
    };

    // Curiosity DNA override (null clears it server-side)
    agentLoopPatch.curiosity =
      readCuriosityForm(readCuriosityValues(form), agent.agentLoop?.curiosity) ?? null;

    {
      const hasValues = Object.values(agentLoopPatch).some((v) => v !== undefined);
      patch.agentLoop = hasValues ? agentLoopPatch : undefined;
    }

    // TTS overrides
    if (defaults.ttsEnabled) {
      const ttsVoiceId = resolveVoiceChoice(form.ttsVoiceId?.value, form.ttsVoiceCustom?.value);
      const ttsSpeed =
        form.ttsSpeed?.value !== '' ? Number.parseFloat(form.ttsSpeed.value) : undefined;
      const ttsStability =
        form.ttsStability?.value !== '' ? Number.parseFloat(form.ttsStability.value) : undefined;

      if (ttsVoiceId || ttsSpeed !== undefined || ttsStability !== undefined) {
        patch.tts = { voiceId: ttsVoiceId };
        if (ttsSpeed !== undefined || ttsStability !== undefined) {
          patch.tts.voiceSettings = {};
          if (ttsSpeed !== undefined) patch.tts.voiceSettings.speed = ttsSpeed;
          if (ttsStability !== undefined) patch.tts.voiceSettings.stability = ttsStability;
        }
      } else {
        patch.tts = undefined;
      }
    }

    const saveBtn = form.querySelector('#btn-edit-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }
    const res = await api(`/api/agents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    });
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
    if (!res || res.error) {
      // Stay on the form: the edits are still here to fix and retry.
      showToast(`Could not save: ${res?.error || 'request failed'}`, {
        tone: 'danger',
        duration: 10000,
      });
      return;
    }
    guard.release();
    showToast(`Saved ${patch.name || agent.name}`, { tone: 'ok' });
    location.hash = returnHash;
  });

  // --- Section jump-nav, dirty tracking, Ctrl+S, Cancel ----------------------
  const jumpSlot = el.querySelector('#edit-jump-slot');
  const sections = [...editForm.querySelectorAll('.form-section-title[id]')].map((t) => ({
    id: t.id,
    label: t.firstChild?.textContent?.trim() || t.textContent.trim(),
  }));
  if (jumpSlot) jumpSlot.innerHTML = editSectionNav(sections);
  jumpSlot?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-jump]');
    if (!b) return;
    const target = editForm.querySelector(`#${CSS.escape(b.dataset.jump)}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const snap = () => snapshotForm([...editForm.elements]);
  let baseline = snap();
  let touched = false;
  const dirtyNote = el.querySelector('#edit-dirty');
  const isDirty = () => snap() !== baseline;
  const syncDirty = () => {
    touched = true;
    if (dirtyNote) dirtyNote.hidden = !isDirty();
  };
  editForm.addEventListener('input', syncDirty);
  editForm.addEventListener('change', syncDirty);
  // The voice list loads asynchronously and swaps the select's options:
  // re-baseline once it has, unless the operator already edited something.
  rebaselineEdit = () => {
    if (!touched) baseline = snap();
  };

  const guard = installEditGuard(editForm, {
    isDirty,
    onSave: () => editForm.requestSubmit(),
  });

  el.querySelector('#btn-edit-cancel')?.addEventListener('click', () => {
    // The guard asks before discarding when there are edits.
    location.hash = returnHash;
  });
}

/** Set by renderAgentEdit; called when async form content (voice list) settles. */
let rebaselineEdit = () => {};

/** Raw values of the Curiosity block, in the shape readCuriosityForm expects. */
function readCuriosityValues(form) {
  const dials = {};
  for (const d of LIMIT_DIALS) dials[d] = form[`curiosityDial_${d}`]?.value ?? '';
  return {
    enabled: form.curiosityEnabled?.value ?? '',
    preset: form.curiosityPreset?.value ?? '',
    dials,
    exploreInherit: Boolean(form.curiosityExploreInherit?.checked),
    exploreRatio: form.curiosityExploreRatio?.value ?? '',
    dispatchEnabled: form.curiosityDispatchEnabled?.value ?? '',
    dispatchMaxChars: form.curiosityDispatchMaxChars?.value ?? '',
  };
}

/** Live help text: the preset fills "From preset (x)" and each dial explains its level. */
function wireCuriosityForm(root) {
  if (!root) return;
  const preset = root.querySelector('select[name="curiosityPreset"]');
  const sync = () => {
    const effective = previewDials(preset?.value || '', {});
    for (const d of LIMIT_DIALS) {
      const sel = root.querySelector(`select[name="curiosityDial_${d}"]`);
      if (!sel) continue;
      if (sel.options[0]) sel.options[0].textContent = `From preset (${effective[d]})`;
      const level = sel.value || effective[d];
      const help = root.querySelector(`[data-dial-help="${d}"]`);
      if (help) help.textContent = DIAL_MEANINGS[d][level];
    }
  };
  preset?.addEventListener('change', sync);
  for (const sel of root.querySelectorAll('select[data-dial]'))
    sel.addEventListener('change', sync);
  const range = root.querySelector('input[name="curiosityExploreRatio"]');
  const out = root.querySelector('output[name="curiosityExploreOut"]');
  const inherit = root.querySelector('input[name="curiosityExploreInherit"]');
  range?.addEventListener('input', () => {
    if (out) out.textContent = `${Math.round(Number(range.value) * 100)}%`;
  });
  inherit?.addEventListener('change', () => {
    if (range) range.disabled = inherit.checked;
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

    const res = await api(`/api/agents/${encodeURIComponent(sourceId)}/clone`, {
      method: 'POST',
      body: { id, name },
    });
    if (!res || res.error) {
      showToast(`Clone failed: ${res?.error || 'request failed'}`, {
        tone: 'danger',
        duration: 8000,
      });
      return;
    }
    closeModal();
    showToast(`Cloned into ${name}`, { tone: 'ok' });
    if (onDone) onDone();
    else renderAgents(el);
  });
}

async function showGenerateSoulModal(agentId, agentName, onComplete) {
  const defaults = await api('/api/agents/defaults');
  const models = defaults.availableModels || ['claude-cli'];

  showModal(`
    <div class="modal-title">Generate Soul with AI</div>
    <div class="form-group">
      <label>Role</label>
      <input type="text" id="gen-role" placeholder="e.g. therapist, coach, assistant, comedian">
    </div>
    <div class="form-group">
      <label>Personality Description</label>
      <textarea id="gen-personality" rows="4" placeholder="Describe the bot's personality, tone, and character traits..."></textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Language</label>
        <select id="gen-language">
          <option value="Spanish" selected>Spanish</option>
          <option value="English">English</option>
        </select>
      </div>
      <div class="form-group">
        <label>Emoji (optional)</label>
        <input type="text" id="gen-emoji" placeholder="AI picks if empty" maxlength="4" style="width:80px">
      </div>
    </div>
    <div class="form-group">
      <label>Generation Model</label>
      <select id="gen-model">
        ${models.map((m) => `<option value="${escapeHtml(m)}"${m === 'claude-cli' ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('')}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn" id="gen-cancel">Cancel</button>
      <button class="btn btn-primary" id="gen-submit">Generate</button>
    </div>
  `);

  document.getElementById('gen-cancel').addEventListener('click', closeModal);
  document.getElementById('gen-submit').addEventListener('click', async () => {
    const role = document.getElementById('gen-role').value.trim();
    const personalityDescription = document.getElementById('gen-personality').value.trim();
    const language = document.getElementById('gen-language').value;
    const emoji = document.getElementById('gen-emoji').value.trim();
    const selectedModel = document.getElementById('gen-model').value;

    if (!role || !personalityDescription) {
      showToast('Role and personality description are required.', { tone: 'warn' });
      return;
    }

    const llmBackend = selectedModel === 'claude-cli' ? 'claude-cli' : 'ollama';
    const model = selectedModel === 'claude-cli' ? undefined : selectedModel;

    const btn = document.getElementById('gen-submit');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    try {
      const result = await api(`/api/agents/${agentId}/generate-soul`, {
        method: 'POST',
        body: {
          name: agentName,
          role,
          personalityDescription,
          language,
          emoji: emoji || undefined,
          llmBackend,
          model,
        },
      });

      if (result.error) {
        showToast(`Generation failed: ${result.error}`, { tone: 'danger', duration: 8000 });
        btn.disabled = false;
        btn.textContent = 'Generate';
        return;
      }

      showSoulPreviewModal(
        agentId,
        agentName,
        result,
        { role, personalityDescription, language, emoji, llmBackend, model },
        { onComplete }
      );
    } catch (err) {
      showToast(`Generation failed: ${err.message || err}`, { tone: 'danger', duration: 8000 });
      btn.disabled = false;
      btn.textContent = 'Generate';
    }
  });
}

function showSoulPreviewModal(agentId, agentName, soulData, inputData, options = {}) {
  const { onComplete } = options;
  closeModal();
  showModal(`
    <div class="modal-title">Generated Soul Preview</div>
    <div style="max-height:60vh;overflow-y:auto">
      <h4>IDENTITY.md</h4>
      <pre class="code-block">${escapeHtml(soulData.identity)}</pre>
      <h4>SOUL.md</h4>
      <pre class="code-block">${escapeHtml(soulData.soul)}</pre>
      <h4>MOTIVATIONS.md</h4>
      <pre class="code-block">${escapeHtml(soulData.motivations)}</pre>
    </div>
    <div class="modal-actions">
      ${
        onComplete
          ? '<button class="btn" id="preview-skip">Skip</button>'
          : '<button class="btn" id="preview-cancel">Cancel</button>'
      }
      <button class="btn" id="preview-regenerate">Regenerate</button>
      <button class="btn btn-primary" id="preview-apply">Apply</button>
    </div>
  `);

  if (onComplete) {
    document.getElementById('preview-skip').addEventListener('click', () => {
      closeModal();
      onComplete();
    });
  } else {
    document.getElementById('preview-cancel').addEventListener('click', closeModal);
  }

  document.getElementById('preview-regenerate').addEventListener('click', async () => {
    const btn = document.getElementById('preview-regenerate');
    btn.disabled = true;
    btn.textContent = 'Regenerating...';

    try {
      const result = await api(`/api/agents/${agentId}/generate-soul`, {
        method: 'POST',
        body: {
          name: agentName,
          role: inputData.role,
          personalityDescription: inputData.personalityDescription,
          language: inputData.language,
          emoji: inputData.emoji || undefined,
          llmBackend: inputData.llmBackend,
          model: inputData.model,
        },
      });

      if (result.error) {
        showToast(`Regeneration failed: ${result.error}`, { tone: 'danger', duration: 8000 });
        btn.disabled = false;
        btn.textContent = 'Regenerate';
        return;
      }

      showSoulPreviewModal(agentId, agentName, result, inputData, options);
    } catch (err) {
      showToast(`Regeneration failed: ${err.message || err}`, { tone: 'danger', duration: 8000 });
      btn.disabled = false;
      btn.textContent = 'Regenerate';
    }
  });

  document.getElementById('preview-apply').addEventListener('click', async () => {
    const btn = document.getElementById('preview-apply');
    btn.disabled = true;
    btn.textContent = 'Applying...';

    try {
      const result = await api(`/api/agents/${agentId}/apply-soul`, {
        method: 'POST',
        body: soulData,
      });

      if (result.error) {
        showToast(`Apply failed: ${result.error}`, { tone: 'danger', duration: 8000 });
        btn.disabled = false;
        btn.textContent = 'Apply';
        return;
      }

      closeModal();
      if (onComplete) {
        onComplete();
      }
    } catch (err) {
      showToast(`Apply failed: ${err.message || err}`, { tone: 'danger', duration: 8000 });
      btn.disabled = false;
      btn.textContent = 'Apply';
    }
  });
}

/**
 * "New Agent" opens the three-step wizard (#/agents/new, session S6). The
 * old modal's fields (id, token, language, emoji, generation model) live in
 * the wizard's Advanced block on its last step.
 */
function showNewAgentModal() {
  location.hash = '#/agents/new';
}

/** Download one agent's export archive. `{ ok, error }`; never throws. */
async function downloadExport(botId, params) {
  try {
    const headers = {};
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`/api/agents/${encodeURIComponent(botId)}/export?${params}`, {
      headers,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Export failed' }));
      return { ok: false, error: err.error || 'Export failed' };
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = match?.[1] || `${botId}-export.tar.gz`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function showExportModal(botId) {
  showModal(`
    <div class="modal-title">Export Agent: ${escapeHtml(botId)}</div>
    <p class="text-dim mb-16">Select what to include in the export archive (.tar.gz). Soul files are always included.</p>
    <div class="form-group">
      <label><input type="checkbox" id="export-productions" checked> Include productions</label>
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="export-conversations" checked> Include conversations</label>
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="export-karma" checked> Include karma</label>
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="export-sessions" checked> Include Telegram sessions / chat history</label>
    </div>
    <div class="modal-actions">
      <button class="btn" id="export-cancel">Cancel</button>
      <button class="btn btn-primary" id="export-confirm">Download Export</button>
    </div>
  `);

  document.getElementById('export-cancel').addEventListener('click', closeModal);
  document.getElementById('export-confirm').addEventListener('click', async () => {
    const productions = document.getElementById('export-productions').checked;
    const conversations = document.getElementById('export-conversations').checked;
    const karma = document.getElementById('export-karma').checked;
    const sessions = document.getElementById('export-sessions').checked;

    const params = new URLSearchParams();
    if (!productions) params.set('productions', 'false');
    if (!conversations) params.set('conversations', 'false');
    if (!karma) params.set('karma', 'false');
    if (!sessions) params.set('sessions', 'false');

    const btn = document.getElementById('export-confirm');
    btn.disabled = true;
    btn.textContent = 'Downloading...';
    const r = await downloadExport(botId, params);
    if (!r.ok) {
      showToast(`Export failed: ${r.error}`, { tone: 'danger', duration: 8000 });
      btn.disabled = false;
      btn.textContent = 'Download Export';
      return;
    }
    showToast(`Exported ${botId}`, { tone: 'ok' });
    closeModal();
  });
}

function showImportModal(el) {
  showModal(`
    <div class="modal-title">Import Agent</div>
    <p class="text-dim mb-16">Upload a .tar.gz export archive to import an agent.</p>
    <div class="form-group">
      <label>Archive file</label>
      <input type="file" id="import-file" accept=".tar.gz,.gz">
    </div>
    <div class="form-group">
      <label>New Bot ID (optional, overrides the ID in the archive)</label>
      <input type="text" id="import-bot-id" placeholder="Leave empty to use original ID">
    </div>
    <div class="form-group">
      <label>New Bot Name (optional)</label>
      <input type="text" id="import-bot-name" placeholder="Leave empty to use original name">
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="import-overwrite"> Overwrite if agent already exists</label>
    </div>
    <div class="modal-actions">
      <button class="btn" id="import-cancel">Cancel</button>
      <button class="btn btn-primary" id="import-confirm">Import</button>
    </div>
  `);

  document.getElementById('import-cancel').addEventListener('click', closeModal);
  document.getElementById('import-confirm').addEventListener('click', async () => {
    const fileInput = document.getElementById('import-file');
    const file = fileInput.files?.[0];
    if (!file) {
      showToast('Choose an archive file first', { tone: 'warn' });
      return;
    }

    const btn = document.getElementById('import-confirm');
    btn.disabled = true;
    btn.textContent = 'Importing...';

    try {
      const newBotId = document.getElementById('import-bot-id').value.trim();
      const newBotName = document.getElementById('import-bot-name').value.trim();
      const overwrite = document.getElementById('import-overwrite').checked;

      const params = new URLSearchParams();
      if (newBotId) params.set('newBotId', newBotId);
      if (newBotName) params.set('newBotName', newBotName);
      if (overwrite) params.set('overwrite', 'true');

      const formData = new FormData();
      formData.append('file', file);

      const headers = {};
      const token = getAuthToken();
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(`/api/agents/import?${params}`, {
        method: 'POST',
        headers,
        body: formData,
      });

      const result = await res.json();
      if (!res.ok) {
        showToast(`Import failed: ${result.error}`, { tone: 'danger', duration: 8000 });
        btn.disabled = false;
        btn.textContent = 'Import';
        return;
      }

      let msg = `Imported ${result.botName} (${result.botId})`;
      if (result.warnings?.length) {
        msg += ` · warnings: ${result.warnings.join('; ')}`;
      }
      showToast(msg, {
        tone: result.warnings?.length ? 'warn' : 'ok',
        duration: result.warnings?.length ? 10000 : 4000,
      });
      closeModal();
      renderAgents(el);
    } catch (err) {
      showToast(`Import failed: ${err.message || err}`, { tone: 'danger', duration: 8000 });
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  });
}
