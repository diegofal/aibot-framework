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

/** One row per account: name, email, state, actions. Pure. */
export function accountsHtml(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0)
    return '<p class="text-dim text-sm">No accounts.</p>';
  const rows = accounts
    .map((a) => {
      const state = a.active
        ? '<span class="fb-tag standing">active</span>'
        : a.loggedIn
          ? '<span class="text-dim text-sm">logged in</span>'
          : '<span class="fb-tag notasks">not logged in</span>';
      const actions = a.active
        ? ''
        : `${a.loggedIn ? `<button type="button" class="btn btn-sm btn-primary" data-ca-activate="${esc(a.slug)}">Use this account</button>` : ''}
           ${a.slug === 'default' ? '' : `<button type="button" class="btn btn-sm" data-ca-remove="${esc(a.slug)}">Remove</button>`}`;
      return `<tr>
        <td><strong>${esc(a.label || a.slug)}</strong><div class="text-dim text-sm">${esc(a.slug)}</div></td>
        <td>${a.email ? esc(a.email) : '<span class="text-dim">—</span>'}</td>
        <td>${state}</td>
        <td style="text-align:right;white-space:nowrap">${actions}</td>
      </tr>`;
    })
    .join('');
  return `<table class="data-table" style="width:100%"><thead><tr><th>Account</th><th>Email</th><th>State</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** The pending-login panel: the link to open and the box for the code. Pure. */
export function loginPanelHtml(login) {
  if (!login) return '';
  return `<div class="detail-card" style="margin-top:12px">
    <div class="text-sm"><strong>1.</strong> Open this link and sign in with the account you want to add:</div>
    <div style="margin:6px 0 10px"><a href="${esc(login.url)}" target="_blank" rel="noopener noreferrer">Sign in to Claude ↗</a></div>
    <div class="text-sm"><strong>2.</strong> Paste the code the page shows:</div>
    <div class="form-row" style="gap:8px;margin-top:6px">
      <input type="text" id="ca-code" placeholder="code" style="flex:1" autocomplete="off">
      <button type="button" class="btn btn-primary btn-sm" id="ca-code-send">Finish</button>
      <button type="button" class="btn btn-sm" id="ca-cancel">Cancel</button>
    </div>
  </div>`;
}
