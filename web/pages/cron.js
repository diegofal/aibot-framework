import { confirmDialog, confirmInline, emptyState, showToast, undoable } from '../ui/index.js';
import { mountAutomationBox } from './automations.js';
import {
  attentionHtml,
  chipsHtml,
  drawerHtml,
  groupsHtml,
  weekHtml,
} from './cron-board-helpers.js';
import { apiList, cronErrorState, jobWhySection, runWhyCell } from './cron-list-helpers.js';
import { api, closeModal, escapeHtml, showModal } from './shared.js';

// Board state that survives re-renders (filter, search, open folds); the open
// job is per visit.
const board = { filter: 'all', query: '', open: new Set() };

export async function renderCron(el) {
  el.innerHTML = '<div class="page-title">Cron</div><p class="text-dim">Loading…</p>';

  const [jobsRes, skillsRes, agentsRes] = await Promise.all([
    api('/api/cron'),
    api('/api/skills'),
    api('/api/agents'),
  ]);
  const agents = Array.isArray(agentsRes) ? agentsRes : [];
  const skills = Array.isArray(skillsRes) ? skillsRes : [];
  const { list: jobs, error } = apiList(jobsRes);

  if (error) {
    el.innerHTML = `<div class="page-title">Cron</div>${cronErrorState(error)}`;
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () => renderCron(el));
    return;
  }

  const names = Object.fromEntries(agents.map((a) => [a.id, a.name || a.id]));
  let selected = null; // GET /api/cron/:id of the open job (runs + why)

  el.innerHTML = `<div class="cj-board">
    <div class="cj-head">
      <div><h1>Cron</h1><p>What your agents do on their own, and when.</p></div>
      <div class="cj-sp"></div>
      <a href="#/automations/cron/new" class="cj-btn ghost" data-page-new>+ New job</a>
    </div>
    <div id="automation-box"></div>
    <div class="cj-bar" id="cj-bar"></div>
    <section class="cj-week" id="cj-week"></section>
    <section class="cj-attn" id="cj-attn"></section>
    <div id="cj-groups"></div>
    <div class="cj-scrim" id="cj-scrim"></div>
    <aside class="cj-drawer" id="cj-drawer" aria-label="Cron job"></aside>
  </div>`;

  // "Tell an agent what to do and when" (S8): parse -> preview -> the same POST /api/cron.
  mountAutomationBox(document.getElementById('automation-box'), {
    agents,
    onCreated: () => renderCron(el),
  });

  const root = el.querySelector('.cj-board');
  const $ = (id) => document.getElementById(id);
  const opts = () => ({ names, nowMs: Date.now(), ...board, selected: selected?.id ?? null });

  // A save or run that lands after the page was left has nothing to draw.
  const drawBar = () => {
    if (!root.isConnected) return;
    const focused = document.activeElement?.id === 'cj-q';
    $('cj-bar').innerHTML = chipsHtml(jobs, opts());
    if (focused) {
      const q = $('cj-q');
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
  };
  const drawGroups = () => {
    if (!root.isConnected) return;
    $('cj-groups').innerHTML = groupsHtml(jobs, opts());
  };
  const drawDrawer = () => {
    if (!root.isConnected) return;
    $('cj-drawer').innerHTML = selected ? drawerHtml(selected, opts()) : '';
    $('cj-drawer').classList.toggle('on', !!selected);
    $('cj-scrim').classList.toggle('on', !!selected);
  };
  const draw = () => {
    if (!root.isConnected) return;
    drawBar();
    $('cj-week').innerHTML = weekHtml(jobs, opts());
    $('cj-attn').innerHTML = attentionHtml(jobs, opts());
    drawGroups();
    drawDrawer();
  };

  const reloadAll = async () => {
    const fresh = apiList(await api('/api/cron'));
    if (!fresh.error) jobs.splice(0, jobs.length, ...fresh.list);
    if (selected) await openJob(selected.id);
    draw();
  };
  // Only the latest open (or a close) decides the selection: an earlier, slower
  // request that lands later is dropped.
  let openSeq = 0;
  async function openJob(id) {
    const seq = ++openSeq;
    const res = await api(`/api/cron/${encodeURIComponent(id)}`);
    if (seq !== openSeq) return;
    if (!res || res.error) {
      showToast(res?.error || 'Could not open the job', { tone: 'danger' });
      selected = null;
      return;
    }
    selected = res;
  }
  const close = () => {
    openSeq++;
    selected = null;
    drawDrawer();
    drawGroups();
  };

  draw();

  root.addEventListener('input', (e) => {
    if (e.target.id !== 'cj-q') return;
    board.query = e.target.value;
    drawGroups();
  });

  const onKey = (e) => {
    if (e.key !== 'Escape' || !selected) return;
    if (!root.isConnected) return document.removeEventListener('keydown', onKey);
    close();
  };
  document.addEventListener('keydown', onKey);

  root.addEventListener('click', async (e) => {
    const hit = (s) => e.target.closest(s);
    if (hit('#automation-box') || hit('[data-page-new]')) return;

    const tg = hit('[data-tg]');
    if (tg) {
      e.stopPropagation();
      const id = tg.dataset.tg;
      const job = jobs.find((j) => j.id === id);
      if (!job) return;
      tg.disabled = true;
      const enabled = job.enabled === false;
      const res = await api(`/api/cron/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { enabled },
      });
      if (!res || res.error) {
        tg.disabled = false;
        showToast(`Could not update the job: ${res?.error || 'error'}`, { tone: 'danger' });
        return;
      }
      showToast(enabled ? 'Turned on' : 'Paused', { tone: 'ok' });
      await reloadAll();
      return;
    }

    if (hit('[data-show-all]')) {
      board.filter = 'all';
      board.query = '';
      drawBar();
      drawGroups();
      return;
    }

    const chip = hit('[data-f]');
    if (chip) {
      const f = chip.dataset.f;
      board.filter = board.filter === f && f !== 'all' ? 'all' : f;
      drawBar();
      drawGroups();
      return;
    }

    const fold = hit('[data-fold]');
    if (fold) {
      const k = fold.dataset.fold;
      if (board.open.has(k)) board.open.delete(k);
      else board.open.add(k);
      drawGroups();
      return;
    }

    const run = hit('[data-run]');
    if (run) {
      const id = run.dataset.run;
      run.disabled = true;
      const label = run.textContent;
      run.textContent = 'Running…';
      const res = await api(`/api/cron/${encodeURIComponent(id)}/run`, { method: 'POST' });
      if (res?.ok) showToast('Job ran', { tone: 'ok' });
      else showToast(`Run failed: ${res?.reason || res?.error || 'error'}`, { tone: 'danger' });
      run.disabled = false;
      run.textContent = label;
      await reloadAll();
      return;
    }

    const edit = hit('[data-edit]');
    if (edit) {
      const job = jobs.find((j) => j.id === edit.dataset.edit);
      if (job) showCronEditModal(job, el, null, skills, reloadAll);
      return;
    }

    const del = hit('[data-del]');
    if (del) {
      const id = del.dataset.del;
      const job = jobs.find((j) => j.id === id);
      const i = jobs.findIndex((j) => j.id === id);
      if (i < 0) return;
      jobs.splice(i, 1);
      if (selected?.id === id) selected = null;
      draw();
      const { undone, result } = await undoable(`Deleted "${job?.name ?? id}"`, {
        commit: () => api(`/api/cron/${encodeURIComponent(id)}`, { method: 'DELETE' }),
        undo: () => {
          jobs.splice(i, 0, job);
          if (root.isConnected) draw();
        },
      }).catch((err) => ({ undone: false, result: { error: err?.message || 'error' } }));
      if (undone) return;
      if (result?.error) {
        showToast(`Delete failed: ${result.error}`, { tone: 'danger' });
        await reloadAll();
      }
      return;
    }

    if (hit('[data-close]') || e.target.id === 'cj-scrim') return close();
    if (hit('a[href]')) return;

    const open = hit('[data-open]');
    if (open) {
      await openJob(open.dataset.open);
      drawDrawer();
      drawGroups();
    }
  });
}

export async function renderCronDetail(el, id) {
  el.innerHTML = '<div class="page-title">Cron job</div><p class="text-dim">Loading...</p>';
  const [job, skills] = await Promise.all([
    api(`/api/cron/${encodeURIComponent(id)}`),
    api('/api/skills'),
  ]);
  if (!job || job.error) {
    const notFound = /not found/i.test(job?.error ?? '');
    el.innerHTML = `
      <div class="detail-header">
        <a href="#/automations/cron" class="back">&larr;</a>
        <div class="page-title">Cron job</div>
      </div>
      ${
        notFound
          ? emptyState({
              icon: '◷',
              title: 'Cron job not found',
              hint: 'It may have been deleted. Back to the list to see the jobs that exist.',
              action: '<a href="#/automations/cron" class="btn btn-sm">All cron jobs</a>',
            })
          : cronErrorState(job?.error ?? 'Unexpected response', 'Could not load this cron job')
      }`;
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () =>
      renderCronDetail(el, id)
    );
    return;
  }

  const scheduleText = formatSchedule(job.schedule);
  let payloadHtml;
  if (job.payload.kind === 'message' || job.payload.kind === 'instruction') {
    payloadHtml = `<tr><td class="text-dim">Bot ID</td><td>${escapeHtml(job.payload.botId)}</td></tr>
       <tr><td class="text-dim">Chat ID</td><td>${job.payload.chatId}</td></tr>
       <tr><td class="text-dim">${job.payload.kind === 'instruction' ? 'Instruction' : 'Text'}</td><td><pre style="white-space:pre-wrap;margin:0;font-family:inherit">${escapeHtml(job.payload.text)}</pre></td></tr>`;
  } else {
    const skillDefault = resolveSkillDefault(skills, job.payload.skillId);
    const backendDisplay = job.payload.llmBackend
      ? `${job.payload.llmBackend} (override)`
      : `${skillDefault} (skill default)`;
    payloadHtml = `<tr><td class="text-dim">Skill ID</td><td>${escapeHtml(job.payload.skillId)}</td></tr>
       <tr><td class="text-dim">Job ID</td><td>${escapeHtml(job.payload.jobId)}</td></tr>
       <tr><td class="text-dim">LLM Backend</td><td>${escapeHtml(backendDisplay)}</td></tr>`;
  }

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/automations/cron" class="back">&larr;</a>
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
        <tr><td class="text-dim">Last Status</td><td>${
          job.state.lastStatus
            ? `<span class="badge badge-${job.state.lastStatus}">${job.state.lastStatus}</span>`
            : '--'
        }</td></tr>
        ${job.state.lastError ? `<tr><td class="text-dim">Last Error</td><td class="text-sm" style="color:var(--red)">${escapeHtml(job.state.lastError)}</td></tr>` : ''}
        <tr><td class="text-dim">Consecutive Errors</td><td>${job.state.consecutiveErrors}</td></tr>
        <tr><td class="text-dim">Created</td><td class="text-dim">${new Date(job.createdAtMs).toLocaleString()}</td></tr>
      </table>
    </div>
    ${jobWhySection(job)}

    <div class="actions mb-16">
      <button class="btn btn-primary" id="btn-run">Run Now</button>
      <button class="btn" id="btn-edit">Edit</button>
      <button class="btn ${job.enabled ? 'btn-danger' : 'btn-primary'}" id="btn-toggle">${job.enabled ? 'Disable' : 'Enable'}</button>
      <button class="btn btn-danger" id="btn-delete">Delete</button>
    </div>

    ${
      job.runs?.length
        ? `
      <div class="flex-between mb-16">
        <h3>Recent Runs</h3>
        <button class="btn btn-sm btn-danger" id="btn-clear-logs">Clear Logs</button>
      </div>
      <table id="cron-detail-runs">
        <thead><tr><th>Time</th><th>Status</th><th>Duration</th><th>Output</th><th>Error</th><th>Why</th><th></th></tr></thead>
        <tbody>
          ${job.runs
            .map(
              (r) => `
            <tr>
              <td class="text-sm">${r.runAtMs ? new Date(r.runAtMs).toLocaleString() : '--'}</td>
              <td><span class="badge badge-${r.status || 'disabled'}">${r.status || '--'}</span></td>
              <td class="text-dim">${r.durationMs != null ? `${r.durationMs}ms` : '--'}</td>
              <td class="text-sm">${r.output ? formatOutput(r.output) : ''}</td>
              <td class="text-sm" style="color:var(--red)">${r.error ? escapeHtml(r.error) : ''}</td>
              ${runWhyCell(r)}
              <td><button class="btn btn-sm btn-icon" data-action="delete-run" data-ts="${r.ts}" title="Delete">&times;</button></td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    `
        : ''
    }
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
    const res = await api(`/api/cron/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { enabled: !job.enabled },
    });
    if (res?.error) showToast(`Could not update the job: ${res.error}`, { tone: 'danger' });
    renderCronDetail(el, id);
  });

  document.getElementById('btn-delete').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete this cron job?',
      message: `"${job.name}" and its run logs will be removed.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    const res = await api(`/api/cron/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res?.error) {
      showToast(`Delete failed: ${res.error}`, { tone: 'danger' });
      return;
    }
    showToast('Cron job deleted', { tone: 'ok' });
    location.hash = '#/automations/cron';
  });

  document.getElementById('btn-edit').addEventListener('click', () => {
    showCronEditModal(job, el, id, skills, () => renderCronDetail(el, id));
  });

  const clearLogsBtn = document.getElementById('btn-clear-logs');
  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', async () => {
      if (!confirmInline(clearLogsBtn, { label: 'Click again to clear' })) return;
      await api(`/api/cron/${encodeURIComponent(id)}/runs`, { method: 'DELETE' });
      renderCronDetail(el, id);
    });
  }

  // Bound to the runs table (not `el`, which outlives this page and would stack listeners).
  document.getElementById('cron-detail-runs')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action="delete-run"]');
    if (!btn) return;
    const ts = Number(btn.dataset.ts);
    if (!ts) return;
    await api(`/api/cron/${id}/runs/delete`, { method: 'POST', body: { timestamps: [ts] } });
    renderCronDetail(el, id);
  });
}

export async function renderCronCreate(el) {
  const [agents, skills] = await Promise.all([api('/api/agents'), api('/api/skills')]);

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/automations/cron" class="back">&larr;</a>
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
          <option value="instruction">Instruction</option>
          <option value="skillJob">Skill Job</option>
        </select>
      </div>
      <div id="payload-fields"></div>
      <div class="actions">
        <button type="submit" class="btn btn-primary">Create</button>
        <a href="#/automations/cron" class="btn">Cancel</a>
      </div>
    </form>
  `;

  const kindSelect = document.getElementById('job-kind');
  const payloadFields = document.getElementById('payload-fields');

  function renderPayloadFields() {
    if (kindSelect.value === 'message' || kindSelect.value === 'instruction') {
      const isInstruction = kindSelect.value === 'instruction';
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
          <label>${isInstruction ? 'Instruction' : 'Message Text'}</label>
          <textarea name="text" required rows="${isInstruction ? 6 : 3}" placeholder="${isInstruction ? 'Instruction to process through LLM pipeline...' : 'Hello!'}"></textarea>
          ${isInstruction ? '<div class="text-dim text-sm mt-8">Instructions are processed through the LLM pipeline (not sent as raw text)</div>' : ''}
        </div>
      `;
    } else {
      const firstSkillDefault = resolveSkillDefault(skills, skills[0]?.id);
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
        <div class="form-separator"></div>
        <div class="form-group">
          <label>LLM Backend</label>
          <select name="llmBackend" id="create-llmBackend">
            <option value="" id="create-llmBackend-default">Skill default (${firstSkillDefault})</option>
            <option value="ollama">Ollama</option>
            <option value="claude-cli">Claude CLI</option>
          </select>
        </div>
        <div id="create-claude-fields" style="display:none">
          <div class="form-group">
            <label>Claude Path</label>
            <input type="text" name="claudePath" placeholder="claude">
          </div>
          <div class="form-group">
            <label>Claude Timeout (ms)</label>
            <input type="number" name="claudeTimeout" placeholder="90000">
          </div>
        </div>
      `;
      document.getElementById('skill-select').addEventListener('change', (e) => {
        const def = resolveSkillDefault(skills, e.target.value);
        document.getElementById('create-llmBackend-default').textContent = `Skill default (${def})`;
      });
      document.getElementById('create-llmBackend').addEventListener('change', (e) => {
        document.getElementById('create-claude-fields').style.display =
          e.target.value === 'claude-cli' ? 'block' : 'none';
      });
    }
  }

  kindSelect.addEventListener('change', renderPayloadFields);
  renderPayloadFields();

  document.getElementById('cron-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const kind = form.kind.value;

    let payload;
    if (kind === 'message' || kind === 'instruction') {
      payload = {
        kind,
        text: form.text.value,
        chatId: Number(form.chatId.value),
        botId: form.botId.value,
      };
    } else {
      payload = { kind: 'skillJob', skillId: form.skillId.value, jobId: form.jobId.value };
      const backend = form.llmBackend?.value;
      if (backend) {
        payload.llmBackend = backend;
        if (backend === 'claude-cli') {
          if (form.claudePath?.value) payload.claudePath = form.claudePath.value;
          if (form.claudeTimeout?.value) payload.claudeTimeout = Number(form.claudeTimeout.value);
        }
      }
    }

    const created = await api('/api/cron', {
      method: 'POST',
      body: {
        name: form.name.value,
        enabled: true,
        schedule: { kind: 'cron', expr: form.schedule.value },
        payload,
      },
    });
    if (!created || created.error) {
      showToast(`Could not create the job: ${created?.error || 'error'}`, { tone: 'danger' });
      return;
    }
    showToast('Cron job created', { tone: 'ok' });
    location.hash = '#/automations/cron';
  });
}

function showCronEditModal(job, el, id, skills, onSaved) {
  const isMessage = job.payload.kind === 'message' || job.payload.kind === 'instruction';
  const isSkillJob = job.payload.kind === 'skillJob';
  const jobId = id || job.id;
  const scheduleExpr =
    job.schedule.kind === 'cron'
      ? job.schedule.expr
      : job.schedule.kind === 'every'
        ? `every ${job.schedule.everyMs}ms`
        : job.schedule.at || '';

  const currentBackend = isSkillJob ? job.payload.llmBackend || '' : '';
  const currentClaudePath = isSkillJob ? job.payload.claudePath || '' : '';
  const currentClaudeTimeout = isSkillJob ? job.payload.claudeTimeout || '' : '';
  const skillDefault = isSkillJob ? resolveSkillDefault(skills, job.payload.skillId) : 'ollama';

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
    ${
      isMessage
        ? `
      <div class="form-group">
        <label>${job.payload.kind === 'instruction' ? 'Instruction' : 'Text'}</label>
        <textarea id="edit-text" rows="${job.payload.kind === 'instruction' ? 6 : 3}">${escapeHtml(job.payload.text)}</textarea>
      </div>
      <div class="form-group">
        <label>Chat ID</label>
        <input type="number" id="edit-chatId" value="${job.payload.chatId}">
      </div>
    `
        : ''
    }
    ${
      isSkillJob
        ? `
      <div class="form-separator"></div>
      <div class="form-group">
        <label>LLM Backend</label>
        <select id="edit-llmBackend">
          <option value=""${currentBackend === '' ? ' selected' : ''}>Skill default (${skillDefault})</option>
          <option value="ollama"${currentBackend === 'ollama' ? ' selected' : ''}>Ollama</option>
          <option value="claude-cli"${currentBackend === 'claude-cli' ? ' selected' : ''}>Claude CLI</option>
        </select>
      </div>
      <div id="edit-claude-fields" style="display:${currentBackend === 'claude-cli' ? 'block' : 'none'}">
        <div class="form-group">
          <label>Claude Path</label>
          <input type="text" id="edit-claudePath" value="${escapeHtml(currentClaudePath)}" placeholder="claude">
        </div>
        <div class="form-group">
          <label>Claude Timeout (ms)</label>
          <input type="number" id="edit-claudeTimeout" value="${currentClaudeTimeout}" placeholder="90000">
        </div>
      </div>
    `
        : ''
    }
    <div class="modal-actions">
      <button class="btn" id="edit-cancel">Cancel</button>
      <button class="btn btn-primary" id="edit-save">Save</button>
    </div>
  `);

  // Toggle claude fields visibility
  const backendSelect = document.getElementById('edit-llmBackend');
  if (backendSelect) {
    backendSelect.addEventListener('change', () => {
      const claudeFields = document.getElementById('edit-claude-fields');
      if (claudeFields)
        claudeFields.style.display = backendSelect.value === 'claude-cli' ? 'block' : 'none';
    });
  }

  document.getElementById('edit-cancel').addEventListener('click', closeModal);
  document.getElementById('edit-save').addEventListener('click', async () => {
    const patch = { name: document.getElementById('edit-name').value };

    const scheduleVal = document.getElementById('edit-schedule').value.trim();
    if (scheduleVal !== scheduleExpr) {
      patch.schedule = { kind: 'cron', expr: scheduleVal };
    }

    if (isMessage) {
      patch.payload = {
        kind: job.payload.kind,
        text: document.getElementById('edit-text').value,
        chatId: Number(document.getElementById('edit-chatId').value),
      };
    }

    if (isSkillJob) {
      const backend = document.getElementById('edit-llmBackend').value;
      const payloadPatch = { kind: 'skillJob' };
      payloadPatch.llmBackend = backend || null;
      if (backend === 'claude-cli') {
        const cp = document.getElementById('edit-claudePath').value.trim();
        const ct = document.getElementById('edit-claudeTimeout').value.trim();
        payloadPatch.claudePath = cp || null;
        payloadPatch.claudeTimeout = ct ? Number(ct) : null;
      } else {
        payloadPatch.claudePath = null;
        payloadPatch.claudeTimeout = null;
      }
      patch.payload = payloadPatch;
    }

    const saved = await api(`/api/cron/${encodeURIComponent(jobId)}`, {
      method: 'PATCH',
      body: patch,
    });
    if (!saved || saved.error) {
      showToast(`Save failed: ${saved?.error || 'error'}`, { tone: 'danger' });
      return;
    }
    closeModal();
    if (onSaved) onSaved();
  });
}

function showRunLogsModal(job) {
  const runs = job.runs || [];
  const hasRuns = runs.length > 0;
  const rows = !hasRuns
    ? '<tr><td colspan="7" class="text-dim">No run logs yet.</td></tr>'
    : runs
        .map(
          (r) => `
        <tr>
          <td class="text-sm">${r.runAtMs ? new Date(r.runAtMs).toLocaleString() : '--'}</td>
          <td><span class="badge badge-${r.status || 'disabled'}">${r.status || '--'}</span></td>
          <td class="text-dim text-sm">${r.durationMs != null ? formatDuration(r.durationMs) : '--'}</td>
          <td class="text-sm">${r.output ? formatOutput(r.output) : ''}</td>
          <td class="text-sm" style="color:var(--red)">${r.error ? escapeHtml(r.error) : ''}</td>
          ${runWhyCell(r)}
          <td><button class="btn btn-sm btn-icon" data-action="modal-delete-run" data-ts="${r.ts}" title="Delete">&times;</button></td>
        </tr>
      `
        )
        .join('');

  showModal(`
    <div class="modal-title">${escapeHtml(job.name)} — Run Logs</div>
    <div style="max-height:400px;overflow:auto">
      <table>
        <thead><tr><th>Time</th><th>Status</th><th>Duration</th><th>Output</th><th>Error</th><th>Why</th><th></th></tr></thead>
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
      if (!confirmInline(clearAllBtn, { label: 'Click again to clear' })) return;
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

function resolveSkillDefault(skills, skillId) {
  const skill = (skills || []).find((s) => s.id === skillId);
  return skill?.llmBackend || 'ollama';
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
  return `${str.slice(0, max)}…`;
}

function formatOutput(output) {
  if (!output) return '';
  const escaped = escapeHtml(output);
  if (output.length <= 200) {
    return `<span class="text-dim">${escaped}</span>`;
  }
  const id = `out-${Math.random().toString(36).slice(2, 8)}`;
  const short = escapeHtml(output.slice(0, 200));
  return `<span class="text-dim"><span id="${id}-short">${short}… <a href="#" onclick="document.getElementById('${id}-short').style.display='none';document.getElementById('${id}-full').style.display='inline';return false">more</a></span><span id="${id}-full" style="display:none">${escaped}</span></span>`;
}
