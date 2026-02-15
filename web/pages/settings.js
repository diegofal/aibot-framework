import { api } from './shared.js';

export async function renderSettings(el) {
  el.innerHTML = '<div class="page-title">Settings</div><p class="text-dim">Loading...</p>';

  const session = await api('/api/settings/session');
  if (session.error) {
    el.innerHTML = '<div class="page-title">Settings</div><p>Failed to load settings.</p>';
    return;
  }

  el.innerHTML = `
    <div class="page-title">Settings</div>
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

      <div class="actions">
        <button type="submit" class="btn btn-primary" id="btn-save">Save</button>
        <span class="text-dim text-sm" id="save-status"></span>
      </div>
    </form>
  `;

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = document.getElementById('btn-save');
    const status = document.getElementById('save-status');

    btn.disabled = true;
    btn.textContent = 'Saving...';

    const patch = {
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

    const result = await api('/api/settings/session', { method: 'PATCH', body: patch });

    btn.disabled = false;
    btn.textContent = 'Save';

    if (result.error) {
      status.textContent = 'Failed to save';
      status.style.color = 'var(--red)';
    } else {
      status.textContent = 'Saved';
      status.style.color = 'var(--green)';
      setTimeout(() => { status.textContent = ''; }, 3000);
    }
  });
}
