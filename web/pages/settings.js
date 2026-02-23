import { api } from './shared.js';

export async function renderSettings(el) {
  el.innerHTML = '<div class="page-title">Settings</div><p class="text-dim">Loading...</p>';

  const [session, collab, skillsFolders] = await Promise.all([
    api('/api/settings/session'),
    api('/api/settings/collaboration'),
    api('/api/settings/skills-folders'),
  ]);
  if (session.error || collab.error) {
    el.innerHTML = '<div class="page-title">Settings</div><p>Failed to load settings.</p>';
    return;
  }

  const sfPaths = skillsFolders.paths || [];
  const sfDefault = skillsFolders.defaultPath || '';

  el.innerHTML = `
    <div class="page-title">Settings</div>

    <div class="detail-card" id="skills-folders-card">
      <div class="form-section-title">Skill Folders</div>
      <p class="text-dim text-sm mb-16">Directories containing external skill packages (skill.json + handlers). Changes take effect on restart.</p>
      <div id="sf-list"></div>
      <div class="form-row" style="align-items:flex-end;gap:8px;margin-top:12px">
        <div class="form-group" style="flex:1;margin-bottom:0">
          <label>Add Folder Path</label>
          <input type="text" id="sf-new-path" placeholder="./productions/tsc/src/skills">
        </div>
        <button type="button" class="btn btn-sm" id="sf-add-btn" style="margin-bottom:0">Add</button>
      </div>
      <div class="actions" style="margin-top:12px">
        <button type="button" class="btn btn-primary btn-sm" id="sf-save-btn">Save Folders</button>
        <span class="text-dim text-sm" id="sf-save-status"></span>
      </div>
    </div>

    <form id="settings-form">

      <div class="detail-card">
        <div class="form-section-title">Group Activation</div>

        <div class="form-row">
          <div class="form-group">
            <label>Activation Mode</label>
            <select name="groupActivation">
              <option value="mention" ${session.groupActivation === 'mention' ? 'selected' : ''}>Mention</option>
              <option value="always" ${session.groupActivation === 'always' ? 'selected' : ''}>Always</option>
            </select>
          </div>
          <div class="form-group">
            <label>Reply Window (minutes, 0 = unlimited)</label>
            <input type="number" name="replyWindow" min="0" step="1" value="${session.replyWindow}">
          </div>
        </div>

        <div class="form-group">
          <label>Forum Topic Isolation</label>
          <label class="toggle">
            <input type="checkbox" name="forumTopicIsolation" ${session.forumTopicIsolation ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="detail-card">
        <div class="form-section-title">LLM Relevance Check</div>

        <div class="form-group">
          <label>Enabled</label>
          <label class="toggle">
            <input type="checkbox" name="rlcEnabled" ${session.llmRelevanceCheck.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <p class="text-dim text-sm mt-8">When a reply-window message arrives, ask the LLM if it's really directed at the bot before responding.</p>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Temperature</label>
            <input type="number" name="rlcTemperature" min="0" max="2" step="0.1" value="${session.llmRelevanceCheck.temperature}">
          </div>
          <div class="form-group">
            <label>Timeout (ms)</label>
            <input type="number" name="rlcTimeout" min="1000" step="1000" value="${session.llmRelevanceCheck.timeout}">
          </div>
          <div class="form-group">
            <label>Context Messages</label>
            <input type="number" name="rlcContextMessages" min="0" step="1" value="${session.llmRelevanceCheck.contextMessages}">
          </div>
        </div>

        <div class="form-separator"></div>

        <div class="form-group">
          <label>Broadcast Check</label>
          <label class="toggle">
            <input type="checkbox" name="rlcBroadcastCheck" ${session.llmRelevanceCheck.broadcastCheck ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <p class="text-dim text-sm mt-8">When no mention/reply/window matches, run an LLM check as fallback. Enables messages like "presentense todos" to trigger all bots.</p>
        </div>
      </div>

      <div class="detail-card">
        <div class="form-section-title">Reset Policy</div>

        <div class="form-row">
          <div class="form-group">
            <label>Daily Reset</label>
            <label class="toggle">
              <input type="checkbox" name="dailyEnabled" ${session.resetPolicy.daily.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="form-group">
            <label>Reset Hour (0-23)</label>
            <input type="number" name="dailyHour" min="0" max="23" step="1" value="${session.resetPolicy.daily.hour}">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Idle Reset</label>
            <label class="toggle">
              <input type="checkbox" name="idleEnabled" ${session.resetPolicy.idle.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="form-group">
            <label>Idle Minutes</label>
            <input type="number" name="idleMinutes" min="1" step="1" value="${session.resetPolicy.idle.minutes}">
          </div>
        </div>
      </div>

      <div class="detail-card">
        <div class="form-section-title">Agent Collaboration</div>

        <div class="form-group">
          <label>Enabled</label>
          <label class="toggle">
            <input type="checkbox" name="collabEnabled" ${collab.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <p class="text-dim text-sm mt-8">Allow bots to collaborate with each other via the collaborate tool.</p>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Max Rounds</label>
            <input type="number" name="collabMaxRounds" min="1" max="20" step="1" value="${collab.maxRounds}">
            <p class="text-dim text-sm mt-8">Max collaboration exchanges per cooldown window.</p>
          </div>
          <div class="form-group">
            <label>Cooldown (ms)</label>
            <input type="number" name="collabCooldownMs" min="0" step="1000" value="${collab.cooldownMs}">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Internal Query Timeout (ms)</label>
            <input type="number" name="collabInternalQueryTimeout" min="1000" step="1000" value="${collab.internalQueryTimeout}">
          </div>
          <div class="form-group">
            <label>Session TTL (ms)</label>
            <input type="number" name="collabSessionTtlMs" min="1000" step="1000" value="${collab.sessionTtlMs}">
          </div>
        </div>

        <div class="form-group">
          <label>Enable Target Tools</label>
          <label class="toggle">
            <input type="checkbox" name="collabEnableTargetTools" ${collab.enableTargetTools ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <p class="text-dim text-sm mt-8">Allow the target bot to use tools (memory, web search, etc.) during collaboration.</p>
        </div>

        <div class="form-separator"></div>

        <div class="form-row">
          <div class="form-group">
            <label>Internal Max Turns</label>
            <input type="number" name="collabMaxConverseTurns" min="1" max="10" step="1" value="${collab.maxConverseTurns}">
            <p class="text-dim text-sm mt-8">Max turns for internal (invisible) multi-turn conversations.</p>
          </div>
          <div class="form-group">
            <label>Visible Max Turns</label>
            <input type="number" name="collabVisibleMaxTurns" min="1" max="10" step="1" value="${collab.visibleMaxTurns}">
            <p class="text-dim text-sm mt-8">Max turns for visible back-and-forth discussions in group chat.</p>
          </div>
        </div>
      </div>

      <div class="actions">
        <button type="submit" class="btn btn-primary" id="btn-save">Save</button>
        <span class="text-dim text-sm" id="save-status"></span>
      </div>
    </form>
  `;

  // --- Skill Folders UI logic ---
  let currentSfPaths = [...sfPaths];

  function renderSfList() {
    const listEl = document.getElementById('sf-list');
    const items = [];

    // Default folder (non-removable)
    if (sfDefault) {
      items.push(`<div style="display:flex;align-items:center;gap:8px;padding:6px 0">
        <code style="flex:1">${sfDefault}</code>
        <span class="badge badge-disabled">(default)</span>
      </div>`);
    }

    // Extra folders
    for (let i = 0; i < currentSfPaths.length; i++) {
      items.push(`<div style="display:flex;align-items:center;gap:8px;padding:6px 0">
        <code style="flex:1">${currentSfPaths[i]}</code>
        <button type="button" class="btn btn-sm btn-danger sf-remove-btn" data-idx="${i}">Remove</button>
      </div>`);
    }

    if (items.length === 0) {
      listEl.innerHTML = '<p class="text-dim text-sm">No skill folders configured.</p>';
    } else {
      listEl.innerHTML = items.join('');
    }

    // Wire remove buttons
    listEl.querySelectorAll('.sf-remove-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentSfPaths.splice(parseInt(btn.dataset.idx, 10), 1);
        renderSfList();
      });
    });
  }

  renderSfList();

  document.getElementById('sf-add-btn').addEventListener('click', () => {
    const input = document.getElementById('sf-new-path');
    const val = input.value.trim();
    if (val && !currentSfPaths.includes(val)) {
      currentSfPaths.push(val);
      input.value = '';
      renderSfList();
    }
  });

  document.getElementById('sf-save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sf-save-btn');
    const status = document.getElementById('sf-save-status');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const res = await api('/api/settings/skills-folders', { method: 'PATCH', body: { paths: currentSfPaths } });

    btn.disabled = false;
    btn.textContent = 'Save Folders';

    if (res.error) {
      status.textContent = 'Failed to save';
      status.style.color = 'var(--red)';
    } else {
      status.textContent = 'Saved (restart to apply)';
      status.style.color = 'var(--green)';
      setTimeout(() => { status.textContent = ''; }, 4000);
    }
  });

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = document.getElementById('btn-save');
    const status = document.getElementById('save-status');

    btn.disabled = true;
    btn.textContent = 'Saving...';

    const sessionPatch = {
      groupActivation: form.groupActivation.value,
      replyWindow: parseInt(form.replyWindow.value, 10),
      forumTopicIsolation: form.forumTopicIsolation.checked,
      resetPolicy: {
        daily: {
          enabled: form.dailyEnabled.checked,
          hour: parseInt(form.dailyHour.value, 10),
        },
        idle: {
          enabled: form.idleEnabled.checked,
          minutes: parseInt(form.idleMinutes.value, 10),
        },
      },
      llmRelevanceCheck: {
        enabled: form.rlcEnabled.checked,
        temperature: parseFloat(form.rlcTemperature.value),
        timeout: parseInt(form.rlcTimeout.value, 10),
        contextMessages: parseInt(form.rlcContextMessages.value, 10),
        broadcastCheck: form.rlcBroadcastCheck.checked,
      },
    };

    const collabPatch = {
      enabled: form.collabEnabled.checked,
      maxRounds: parseInt(form.collabMaxRounds.value, 10),
      cooldownMs: parseInt(form.collabCooldownMs.value, 10),
      internalQueryTimeout: parseInt(form.collabInternalQueryTimeout.value, 10),
      enableTargetTools: form.collabEnableTargetTools.checked,
      maxConverseTurns: parseInt(form.collabMaxConverseTurns.value, 10),
      sessionTtlMs: parseInt(form.collabSessionTtlMs.value, 10),
      visibleMaxTurns: parseInt(form.collabVisibleMaxTurns.value, 10),
    };

    const [result, collabResult] = await Promise.all([
      api('/api/settings/session', { method: 'PATCH', body: sessionPatch }),
      api('/api/settings/collaboration', { method: 'PATCH', body: collabPatch }),
    ]);

    btn.disabled = false;
    btn.textContent = 'Save';

    if (result.error || collabResult.error) {
      status.textContent = 'Failed to save';
      status.style.color = 'var(--red)';
    } else {
      status.textContent = 'Saved';
      status.style.color = 'var(--green)';
      setTimeout(() => { status.textContent = ''; }, 3000);
    }
  });
}
