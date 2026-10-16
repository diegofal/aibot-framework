/**
 * Personal accounts card (Integrations page): the operator's Google and
 * Microsoft accounts that the calendar and mail tools read. Connect opens the
 * provider's consent page in a new tab; the provider sends the browser back to
 * /api/personal-accounts/callback/<provider>, which finishes the login. Coming
 * back to this tab (or Refresh) shows the account.
 */
import { accountsHtml, connectButtonsHtml } from './personal-accounts-helpers.js';
import { api, escapeHtml } from './shared.js';

export async function mountPersonalAccounts(card) {
  if (!card) return;
  let accounts = [];
  let providers = {};
  let editing = null;
  let confirmRemove = null;
  let message = '';

  const paint = () => {
    card.innerHTML = `
      <div class="form-section-title">Personal accounts</div>
      <p class="text-dim text-sm mb-16">Your Google and Microsoft accounts, for the calendar and mail tools. Only bots listed in <code>integrations.personalAccounts.bots</code> use them, and only to answer you.</p>
      <div id="pa-list">${accountsHtml(accounts, { editing, confirmRemove })}</div>
      ${connectButtonsHtml(providers)}
      <div class="form-row" style="gap:8px;margin-top:8px">
        <button type="button" class="btn btn-sm" id="pa-refresh">Refresh</button>
      </div>
      <div id="pa-msg" class="text-sm" style="margin-top:8px">${escapeHtml(message)}</div>`;
    card.querySelector('#pa-rename-input')?.focus();
  };

  const refresh = async () => {
    const res = await api('/api/personal-accounts');
    if (res.error) message = res.error;
    accounts = res.accounts || accounts;
    providers = res.providers || providers;
    paint();
  };

  const connect = async (provider, label) => {
    // Open the tab inside the click (popup blockers), then point it at the consent URL.
    const tab = window.open('about:blank', '_blank');
    const res = await api('/api/personal-accounts/login', {
      method: 'POST',
      body: { provider, label },
    });
    if (res.error || !res.url) {
      tab?.close();
      message = res.error || 'Could not start the sign-in.';
      return paint();
    }
    if (tab) tab.location.href = res.url;
    else window.location.href = res.url;
    message = 'Finish the sign-in in the new tab (valid for 10 minutes), then come back here.';
    paint();
  };

  card.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || t.hasAttribute('disabled')) return;
    try {
      if (t.id === 'pa-refresh') {
        message = '';
        return refresh();
      }
      const provider = t.getAttribute('data-pa-connect');
      if (provider) {
        const label = card.querySelector('#pa-label')?.value?.trim() || '';
        return connect(provider, label);
      }
      const reconnect = t.getAttribute('data-pa-reconnect');
      if (reconnect) return connect(reconnect, t.getAttribute('data-pa-label') || '');
      const rename = t.getAttribute('data-pa-rename');
      if (rename) {
        editing = rename;
        return paint();
      }
      if (t.hasAttribute('data-pa-rename-cancel')) {
        editing = null;
        return paint();
      }
      const save = t.getAttribute('data-pa-rename-save');
      if (save) {
        const label = card.querySelector('#pa-rename-input')?.value ?? '';
        const res = await api(`/api/personal-accounts/${encodeURIComponent(save)}`, {
          method: 'PATCH',
          body: { label },
        });
        if (res.ok) editing = null;
        message = res.ok ? '' : res.error;
        return refresh();
      }
      const remove = t.getAttribute('data-pa-remove');
      if (remove) {
        if (confirmRemove !== remove) {
          confirmRemove = remove;
          return paint();
        }
        confirmRemove = null;
        const res = await api(`/api/personal-accounts/${encodeURIComponent(remove)}`, {
          method: 'DELETE',
        });
        message = res.ok
          ? `Removed ${remove}. To revoke the app's access too, remove it in the account's security settings.`
          : res.error;
        return refresh();
      }
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
      paint();
    }
  });

  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target.id === 'pa-rename-input')
      card.querySelector('[data-pa-rename-save]')?.click();
  });

  // Back from the consent tab: show the new account without a click.
  const onFocus = () => {
    if (!card.isConnected) return window.removeEventListener('focus', onFocus);
    refresh().catch(() => {});
  };
  window.addEventListener('focus', onFocus);

  await refresh().catch((err) => {
    card.innerHTML = `<div class="form-section-title">Personal accounts</div><p class="text-dim text-sm">Could not load accounts: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`;
  });
}
