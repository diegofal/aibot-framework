import { confirmDialog, emptyState, showToast } from '../ui/index.js';
import { agentNames, filterKarma, karmaToolbar, sortKarma } from './karma-helpers.js';
import { api, escapeHtml, timeAgo } from './shared.js';

// Sort + filter of the karma list; survives re-renders.
const karmaView = { query: '', trend: '', sortBy: 'score-desc' };

function trendBadge(trend) {
  if (trend === 'rising') return '<span class="badge badge-ok">&#8593; rising</span>';
  if (trend === 'falling') return '<span class="badge badge-error">&#8595; falling</span>';
  return '<span class="badge badge-disabled">&#8594; stable</span>';
}

function sourceBadge(source) {
  const cls =
    source === 'manual'
      ? 'badge-disabled'
      : source === 'feedback'
        ? 'eval-badge-approved'
        : source === 'production' || source === 'engagement'
          ? 'badge-ok'
          : source === 'tool'
            ? 'badge-error'
            : 'badge-disabled';
  return `<span class="badge ${cls}">${escapeHtml(source)}</span>`;
}

function signedDelta(n) {
  const color = n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--text-dim)';
  const sign = n > 0 ? '+' : '';
  return `<span style="font-weight:600;color:${color};font-family:monospace">${sign}${n}</span>`;
}

/**
 * "What the score is made of" — raw delta sums over the last N days grouped by
 * source and by outcome kind. Activity-only karma shows up as a single
 * agent-loop row; outcome-based karma spreads across production/engagement.
 */
function breakdownTable(breakdown) {
  if (!breakdown) return '';
  const sources = Object.entries(breakdown.bySource || {}).sort((a, b) => b[1] - a[1]);
  const kinds = Object.entries(breakdown.byKind || {}).sort((a, b) => b[1] - a[1]);
  if (sources.length === 0) {
    return `<p class="text-dim text-sm">No events in the last ${breakdown.windowDays} days.</p>`;
  }
  const sourceRows = sources
    .map(([src, sum]) => `<tr><td>${sourceBadge(src)}</td><td>${signedDelta(sum)}</td></tr>`)
    .join('');
  const kindRows = kinds
    .map(
      ([kind, sum]) =>
        `<tr><td class="text-sm">${escapeHtml(kind)}</td><td>${signedDelta(sum)}</td></tr>`
    )
    .join('');
  return `
    <div style="display:flex;gap:24px;flex-wrap:wrap">
      <table style="flex:1;min-width:200px">
        <thead><tr><th>Source</th><th>Δ</th></tr></thead>
        <tbody>${sourceRows}</tbody>
      </table>
      ${
        kinds.length > 0
          ? `<table style="flex:1;min-width:200px">
        <thead><tr><th>Outcome</th><th>Δ</th></tr></thead>
        <tbody>${kindRows}</tbody>
      </table>`
          : ''
      }
    </div>`;
}

function scoreColor(score) {
  if (score >= 70) return 'var(--green)';
  if (score >= 40) return 'var(--orange)';
  return 'var(--red)';
}

function scoreBar(score) {
  const color = scoreColor(score);
  return `<div style="display:flex;align-items:center;gap:8px;min-width:160px">
    <div style="flex:1;height:8px;background:var(--surface-2);border-radius:4px;overflow:hidden">
      <div style="width:${score}%;height:100%;background:${color};border-radius:4px;transition:width .3s"></div>
    </div>
    <span style="font-weight:600;color:${color};min-width:36px;text-align:right">${score}</span>
  </div>`;
}

export async function renderKarma(el) {
  el.innerHTML = '<div class="page-title">Karma</div><p class="text-dim">Loading...</p>';

  const [scores, agentsRes] = await Promise.all([api('/api/karma'), api('/api/agents')]);
  const names = agentNames(agentsRes);

  if (scores.error) {
    el.innerHTML = `
      <div class="page-title">Karma</div>
      ${emptyState({
        icon: '!',
        title: 'Could not load karma',
        hint: scores.error,
        action: '<button class="btn btn-sm" id="karma-retry">Retry</button>',
      })}
    `;
    document.getElementById('karma-retry')?.addEventListener('click', () => renderKarma(el));
    return;
  }

  if (!Array.isArray(scores) || scores.length === 0) {
    el.innerHTML = `
      <div class="page-title">Karma</div>
      <p class="text-dim">No karma data yet. Karma events will appear as bots run agent loops and productions.</p>
    `;
    return;
  }

  el.innerHTML = `
    <div class="page-title">Karma <span class="count" id="karma-count">${scores.length}</span></div>
    ${karmaToolbar(karmaView)}
    <div id="karma-table-wrap"></div>
  `;

  const wrap = document.getElementById('karma-table-wrap');
  const href = (botId) => `#/insights/karma/${encodeURIComponent(botId)}`;

  function draw() {
    const visible = sortKarma(filterKarma(scores, { ...karmaView, names }), karmaView.sortBy, names);
    const countEl = document.getElementById('karma-count');
    if (countEl)
      countEl.textContent =
        visible.length === scores.length ? String(scores.length) : `${visible.length}/${scores.length}`;
    if (visible.length === 0) {
      wrap.innerHTML = emptyState({
        icon: '⌕',
        title: 'No agents match',
        hint: 'Clear the filter to see every agent.',
      });
      return;
    }
    wrap.innerHTML = `<table>
      <thead><tr><th>Agent</th><th>Score</th><th>Trend</th><th>Recent Events</th></tr></thead>
      <tbody id="karma-tbody">${visible
        .map((bot) => {
          const name = names[bot.botId] ?? bot.botId;
          const idHint =
            name !== bot.botId ? ` <span class="text-dim text-sm">${escapeHtml(bot.botId)}</span>` : '';
          return `<tr class="karma-row" data-bot-id="${escapeHtml(bot.botId)}">
            <td><a href="${href(bot.botId)}">${escapeHtml(name)}</a>${idHint}</td>
            <td>${scoreBar(bot.current)}</td>
            <td>${trendBadge(bot.trend)}</td>
            <td class="text-dim">${bot.recentEvents?.length || 0}</td>
          </tr>`;
        })
        .join('')}</tbody>
    </table>`;
  }
  draw();

  document.getElementById('karma-filter-query')?.addEventListener('input', (e) => {
    karmaView.query = e.target.value;
    draw();
  });
  document.getElementById('karma-filter-trend')?.addEventListener('change', (e) => {
    karmaView.trend = e.target.value;
    draw();
  });
  document.getElementById('karma-sort')?.addEventListener('change', (e) => {
    karmaView.sortBy = e.target.value;
    draw();
  });
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const row = e.target.closest('tr.karma-row');
    if (row) location.hash = href(row.dataset.botId);
  });
}

export async function renderBotKarma(el, botId) {
  el.innerHTML = '<div class="page-title">Karma</div><p class="text-dim">Loading...</p>';

  const [scoreData, historyData, agentsRes] = await Promise.all([
    api(`/api/karma/${encodeURIComponent(botId)}`),
    api(`/api/karma/${encodeURIComponent(botId)}/history?limit=50`),
    api('/api/agents'),
  ]);
  const botName = agentNames(agentsRes)[botId] ?? botId;

  if (scoreData.error) {
    el.innerHTML = `
      <div class="page-title">Karma</div>
      <p class="text-dim">${escapeHtml(scoreData.error)}</p>
      <a href="#/insights/karma" class="btn btn-sm">&larr; Back</a>
    `;
    return;
  }

  const events = historyData.events || [];
  const total = historyData.total || 0;

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">${escapeHtml(botName)} Karma</div>
      <div style="display:flex;gap:8px;align-items:center">
        <a href="#/insights/karma" class="btn btn-sm">&larr; Back</a>
        <button class="btn btn-sm" id="karma-reset-btn" style="color:var(--red);border-color:var(--red)">Reset Karma</button>
      </div>
    </div>

    <div class="detail-card mb-16">
      <div style="display:flex;align-items:center;gap:24px;margin-bottom:16px">
        <div style="text-align:center">
          <div style="font-size:48px;font-weight:700;color:${scoreColor(scoreData.current)}">${scoreData.current}</div>
          <div class="text-dim text-sm">/ 100</div>
        </div>
        <div style="flex:1">
          <div style="height:12px;background:var(--surface-2);border-radius:6px;overflow:hidden;margin-bottom:8px">
            <div style="width:${scoreData.current}%;height:100%;background:${scoreColor(scoreData.current)};border-radius:6px;transition:width .3s"></div>
          </div>
          <div>${trendBadge(scoreData.trend)}</div>
        </div>
      </div>
      <div style="font-weight:600;margin-bottom:8px">Score composition <span class="text-dim text-sm">(last ${scoreData.breakdown?.windowDays ?? 30} days, raw deltas)</span></div>
      ${breakdownTable(scoreData.breakdown)}
    </div>

    <div class="detail-card mb-16">
      <div style="font-weight:600;margin-bottom:12px">Manual Adjustment</div>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <div class="form-group" style="margin-bottom:0;flex:0 0 80px">
          <label>Delta</label>
          <input type="number" id="karma-delta" value="0" style="width:100%">
        </div>
        <div class="form-group" style="margin-bottom:0;flex:1">
          <label>Reason</label>
          <input type="text" id="karma-reason" placeholder="Reason for adjustment">
        </div>
        <button class="btn btn-primary" id="karma-adjust-btn">Apply</button>
      </div>
    </div>

    <div class="detail-card">
      <div style="font-weight:600;margin-bottom:12px">Event History <span class="count">${total}</span></div>
      <div id="karma-events">
        ${events.length === 0 ? '<p class="text-dim text-sm">No events recorded yet.</p>' : ''}
      </div>
      ${
        total > events.length
          ? `
        <div style="text-align:center;margin-top:16px">
          <button class="btn btn-sm" id="karma-load-more">Load More</button>
        </div>
      `
          : ''
      }
    </div>
  `;

  // Render event rows
  function renderEvents(container, eventList) {
    for (const evt of eventList) {
      const row = document.createElement('div');
      const sign = evt.delta >= 0 ? '+' : '';
      const deltaColor =
        evt.delta > 0 ? 'var(--green)' : evt.delta < 0 ? 'var(--red)' : 'var(--text-dim)';
      row.style.cssText =
        'display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)';
      row.innerHTML = `
        <span style="font-weight:600;color:${deltaColor};min-width:48px;font-family:monospace;font-size:14px">${sign}${evt.delta}</span>
        ${sourceBadge(evt.source)}
        <span style="flex:1">${escapeHtml(evt.reason)}</span>
        <span class="text-dim text-sm">${timeAgo(evt.timestamp)}</span>
      `;
      container.appendChild(row);
    }
  }

  const eventsContainer = document.getElementById('karma-events');
  renderEvents(eventsContainer, events);

  // Manual adjust handler
  document.getElementById('karma-adjust-btn').addEventListener('click', async () => {
    const delta = Number(document.getElementById('karma-delta').value);
    const reason = document.getElementById('karma-reason').value.trim();
    if (!reason) {
      showToast('Give a reason for the adjustment.', { tone: 'warn' });
      document.getElementById('karma-reason').focus();
      return;
    }

    const btn = document.getElementById('karma-adjust-btn');
    btn.disabled = true;
    btn.textContent = 'Applying...';

    const res = await api(`/api/karma/${encodeURIComponent(botId)}/adjust`, {
      method: 'POST',
      body: { delta, reason },
    });

    btn.disabled = false;
    btn.textContent = 'Apply';
    if (res?.error) {
      showToast(`Adjustment failed: ${res.error}`, { tone: 'danger' });
      return;
    }

    // Reload the page to reflect new score
    renderBotKarma(el, botId);
  });

  // Reset karma handler
  document.getElementById('karma-reset-btn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Reset karma?',
      message: `Reset all karma events for "${botName}"? The score returns to its initial value. This cannot be undone.`,
      confirmLabel: 'Reset',
    });
    if (!ok) return;

    const btn = document.getElementById('karma-reset-btn');
    btn.disabled = true;
    btn.textContent = 'Resetting...';

    const res = await api(`/api/karma/${encodeURIComponent(botId)}/events`, { method: 'DELETE' });

    btn.disabled = false;
    btn.textContent = 'Reset Karma';
    if (res?.error) {
      showToast(`Reset failed: ${res.error}`, { tone: 'danger' });
      return;
    }
    showToast(`Karma reset for ${botName}`, { tone: 'ok' });

    renderBotKarma(el, botId);
  });

  // Load more handler
  let currentOffset = events.length;
  const loadMoreBtn = document.getElementById('karma-load-more');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', async () => {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = 'Loading...';

      const more = await api(
        `/api/karma/${encodeURIComponent(botId)}/history?limit=50&offset=${currentOffset}`
      );
      const moreEvents = more.events || [];

      renderEvents(eventsContainer, moreEvents);
      currentOffset += moreEvents.length;

      if (currentOffset >= (more.total || 0)) {
        loadMoreBtn.remove();
      } else {
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = 'Load More';
      }
    });
  }
}
