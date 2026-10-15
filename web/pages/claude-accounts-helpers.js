/**
 * Pure renderers for the Claude accounts card (web/pages/claude-accounts.js).
 */
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function span(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function windowLine(label, w, nowMs) {
  if (!w || typeof w.utilization !== 'number') return '';
  const left = Math.max(0, Math.round((1 - w.utilization) * 100));
  const reset = w.resetsAt ? Date.parse(w.resetsAt) - nowMs : Number.NaN;
  const resets = Number.isFinite(reset) && reset > 0 ? ` · resets in ${span(reset)}` : '';
  const color = left <= 10 ? 'var(--warn)' : 'inherit';
  return `<div style="color:${color}">${label}: ${left}% left${resets}</div>`;
}

/**
 * The Available cell: what is left of the 5-hour and weekly windows at the
 * last Test, when each resets and how old the reading is. Pure.
 */
export function availabilityHtml(limits, nowMs = Date.now()) {
  if (!limits) return '<span class="text-dim text-sm">Not checked yet · press Test</span>';
  const checked = Date.parse(limits.checkedAt);
  const age = Number.isFinite(checked) ? `checked ${span(Math.max(0, nowMs - checked))} ago` : '';
  const blocked =
    limits.status === 'rejected'
      ? '<div style="color:var(--warn)">Blocked: at its limit</div>'
      : '';
  return `<div class="text-sm">${blocked}${windowLine('5h', limits.fiveHour, nowMs)}${windowLine('Week', limits.sevenDay, nowMs)}<div class="text-dim">${age}</div></div>`;
}

/** The line under a row after "Test": pending, works (latency, model), or why not. Pure. */
export function testResultHtml(t) {
  if (!t) return '';
  if (t.pending) return '<span class="text-dim">Testing the connection…</span>';
  const secs = typeof t.latencyMs === 'number' ? ` · ${(t.latencyMs / 1000).toFixed(1)} s` : '';
  if (t.ok) {
    const model = t.model ? ` · ${esc(t.model)}` : '';
    return `<span style="color:var(--success, #4ade80)">✓ Connection works${secs}${model}</span>`;
  }
  const status = t.status ? `HTTP ${t.status} · ` : '';
  return `<span style="color:var(--warn)">✗ ${status}${esc(t.error || 'No answer')}${secs}</span>`;
}

/**
 * One row per account: name (rename in place), email, state, actions — Test,
 * Use this account, Log in again, Rename, Remove (disabled on the active one).
 * `opts.editing` = slug being renamed; `opts.tests` = test result per slug. Pure.
 */
export function accountsHtml(accounts, opts = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0)
    return '<p class="text-dim text-sm">No accounts.</p>';
  const tests = opts.tests || {};
  const rows = accounts
    .map((a) => {
      const slug = esc(a.slug);
      const state = a.active
        ? '<span class="fb-tag standing">active</span>'
        : a.loggedIn
          ? '<span class="text-dim text-sm">logged in</span>'
          : '<span class="fb-tag notasks">not logged in</span>';
      const name =
        opts.editing === a.slug
          ? `<div class="form-row" style="gap:6px">
              <input type="text" id="ca-rename-input" value="${esc(a.label || a.slug)}" style="flex:1" maxlength="60">
              <button type="button" class="btn btn-sm btn-primary" data-ca-rename-save="${slug}">Save</button>
              <button type="button" class="btn btn-sm" data-ca-rename-cancel>Cancel</button>
            </div>`
          : `<strong>${esc(a.label || a.slug)}</strong> <button type="button" class="btn btn-sm" data-ca-rename="${slug}" title="Rename">✎</button><div class="text-dim text-sm">${slug}</div>`;
      const remove = a.active
        ? `<button type="button" class="btn btn-sm" data-ca-remove="${slug}" disabled title="Switch to another account first">Remove</button>`
        : `<button type="button" class="btn btn-sm" data-ca-remove="${slug}">Remove</button>`;
      const actions = [
        `<button type="button" class="btn btn-sm" data-ca-test="${slug}">Test</button>`,
        !a.active && a.loggedIn
          ? `<button type="button" class="btn btn-sm btn-primary" data-ca-activate="${slug}">Use this account</button>`
          : '',
        `<button type="button" class="btn btn-sm" data-ca-relogin="${slug}">Log in again</button>`,
        remove,
      ].join(' ');
      const result = tests[a.slug]
        ? `<tr><td colspan="5" class="text-sm" style="padding-top:0">${testResultHtml(tests[a.slug])}</td></tr>`
        : '';
      return `<tr>
        <td>${name}</td>
        <td>${a.email ? esc(a.email) : '<span class="text-dim">—</span>'}</td>
        <td>${state}</td>
        <td>${availabilityHtml(a.limits, opts.nowMs)}</td>
        <td style="text-align:right;white-space:nowrap">${actions}</td>
      </tr>${result}`;
    })
    .join('');
  return `<table class="data-table" style="width:100%"><thead><tr><th>Account</th><th>Email</th><th>State</th><th>Available</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** The pending-login panel: the link to open and the box for the code. Pure. */
export function loginPanelHtml(login) {
  if (!login) return '';
  const intro = login.relogin
    ? `Log in again to <strong>${esc(login.slug)}</strong>: open this link and sign in with that account:`
    : 'Open this link and sign in with the account you want to add:';
  return `<div class="detail-card" style="margin-top:12px">
    <div class="text-sm"><strong>1.</strong> ${intro}</div>
    <div style="margin:6px 0 10px"><a href="${esc(login.url)}" target="_blank" rel="noopener noreferrer">Sign in to Claude ↗</a></div>
    <div class="text-sm"><strong>2.</strong> Paste the code the page shows:</div>
    <div class="form-row" style="gap:8px;margin-top:6px">
      <input type="text" id="ca-code" placeholder="code" style="flex:1" autocomplete="off">
      <button type="button" class="btn btn-primary btn-sm" id="ca-code-send">Finish</button>
      <button type="button" class="btn btn-sm" id="ca-cancel">Cancel</button>
    </div>
  </div>`;
}
