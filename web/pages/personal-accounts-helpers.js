/**
 * Pure renderers for the Personal accounts card (web/pages/personal-accounts.js):
 * the operator's Google and Microsoft accounts for calendar and mail.
 */
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const PROVIDERS = {
  google: { label: 'Google', env: 'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET' },
  microsoft: {
    label: 'Microsoft',
    env: 'MICROSOFT_OAUTH_CLIENT_ID / MICROSOFT_OAUTH_CLIENT_SECRET',
  },
};

export function providerLabel(provider) {
  return PROVIDERS[provider]?.label ?? String(provider ?? '');
}

/**
 * One row per account: name (rename in place), provider, email, status, and
 * actions — Reconnect (when the provider refused the refresh), Remove (second
 * click confirms). `opts.editing` / `opts.confirmRemove` = slug. Pure.
 */
export function accountsHtml(accounts, opts = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0)
    return '<p class="text-dim text-sm">No accounts connected yet.</p>';
  const rows = accounts
    .map((a) => {
      const slug = esc(a.slug);
      const name =
        opts.editing === a.slug
          ? `<div class="form-row" style="gap:6px">
              <input type="text" id="pa-rename-input" value="${esc(a.label || a.slug)}" style="flex:1" maxlength="60">
              <button type="button" class="btn btn-sm btn-primary" data-pa-rename-save="${slug}">Save</button>
              <button type="button" class="btn btn-sm" data-pa-rename-cancel>Cancel</button>
            </div>`
          : `<strong>${esc(a.label || a.slug)}</strong> <button type="button" class="btn btn-sm" data-pa-rename="${slug}" title="Rename">✎</button><div class="text-dim text-sm">${slug}</div>`;
      const reauth = a.status === 'reauth-needed';
      const status = reauth
        ? `<span class="fb-tag notasks">Needs reconnecting</span>${a.lastError ? `<div class="text-dim text-sm">${esc(a.lastError)}</div>` : ''}`
        : '<span class="text-dim text-sm">Connected</span>';
      const confirming = opts.confirmRemove === a.slug;
      const actions = [
        reauth
          ? `<button type="button" class="btn btn-sm btn-primary" data-pa-reconnect="${esc(a.provider)}" data-pa-label="${esc(a.label)}">Reconnect</button>`
          : '',
        `<button type="button" class="btn btn-sm" data-pa-remove="${slug}">${confirming ? 'Confirm remove' : 'Remove'}</button>`,
      ].join(' ');
      return `<tr>
        <td>${name}</td>
        <td>${esc(providerLabel(a.provider))}</td>
        <td>${a.email ? esc(a.email) : '<span class="text-dim">—</span>'}</td>
        <td>${status}</td>
        <td style="text-align:right;white-space:nowrap">${actions}</td>
      </tr>`;
    })
    .join('');
  return `<table class="data-table" style="width:100%"><thead><tr><th>Account</th><th>Provider</th><th>Email</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * "Connect Google" / "Connect Microsoft". A provider without its OAuth client
 * in the environment is disabled and says which variables to set. Pure.
 */
export function connectButtonsHtml(providers = {}) {
  const buttons = Object.entries(PROVIDERS).map(([id, p]) =>
    providers[id]
      ? `<button type="button" class="btn btn-sm" data-pa-connect="${id}">Connect ${p.label}</button>`
      : `<button type="button" class="btn btn-sm" data-pa-connect="${id}" disabled title="Set ${p.env}">Connect ${p.label}</button>`
  );
  const missing = Object.entries(PROVIDERS)
    .filter(([id]) => !providers[id])
    .map(([, p]) => `${p.label}: set ${p.env}`);
  const hint = missing.length
    ? `<div class="text-dim text-sm" style="margin-top:6px">Not configured — ${esc(missing.join('; '))} in the container environment (docs/personal-accounts-setup.md).</div>`
    : '';
  return `<div class="form-row" style="gap:8px;margin-top:12px">
    <input type="text" id="pa-label" placeholder="Name for the account (e.g. Personal, Work)" style="flex:1" maxlength="60">
    ${buttons.join(' ')}
  </div>${hint}`;
}
