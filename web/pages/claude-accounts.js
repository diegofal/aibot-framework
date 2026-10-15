/**
 * Claude accounts card (prototype, Integrations page): which Claude login the
 * fleet uses, switch with one click, add another account from here.
 * Login: "Add account" asks the server to start `claude auth login`; the card
 * shows the sign-in link, you sign in, paste the code back.
 */
import { accountsHtml, loginPanelHtml } from './claude-accounts-helpers.js';
import { api, escapeHtml } from './shared.js';

export async function mountClaudeAccounts(card) {
  let login = null;
  let message = '';

  const render = (accounts) => {
    card.innerHTML = `
      <div class="form-section-title">Claude accounts</div>
      <p class="text-dim text-sm mb-16">The account every bot uses for Claude. When one hits its limit, switch to another; the bots resume at once.</p>
      <div id="ca-list">${accountsHtml(accounts)}</div>
      ${
        login
          ? loginPanelHtml(login)
          : `<div class="form-row" style="gap:8px;margin-top:12px">
        <input type="text" id="ca-label" placeholder="Name for the new account (e.g. Work 2)" style="flex:1">
        <button type="button" class="btn btn-sm" id="ca-add">Add account</button>
      </div>`
      }
      <div id="ca-msg" class="text-sm" style="margin-top:8px">${escapeHtml(message)}</div>`;
  };

  const refresh = async () => {
    const res = await api('/api/claude-accounts');
    render(res.accounts || []);
  };

  card.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    try {
      if (t.id === 'ca-add') {
        const label = card.querySelector('#ca-label')?.value?.trim();
        if (!label) {
          message = 'Give the account a name first.';
          return refresh();
        }
        message = 'Starting the sign-in…';
        await refresh();
        const res = await api('/api/claude-accounts/login', { method: 'POST', body: { label } });
        if (res.error) message = res.error;
        else {
          login = res;
          message = '';
        }
        return refresh();
      }
      if (t.id === 'ca-code-send' && login) {
        const code = card.querySelector('#ca-code')?.value?.trim();
        if (!code) return;
        message = 'Checking the code…';
        await refresh();
        const res = await api(
          `/api/claude-accounts/login/${encodeURIComponent(login.loginId)}/code`,
          {
            method: 'POST',
            body: { code },
          }
        );
        login = null;
        message = res.ok ? `Added ${res.email || res.slug}.` : `Sign-in failed: ${res.error}`;
        return refresh();
      }
      if (t.id === 'ca-cancel' && login) {
        await api(`/api/claude-accounts/login/${encodeURIComponent(login.loginId)}/cancel`, {
          method: 'POST',
        });
        login = null;
        message = '';
        return refresh();
      }
      const activate = t.getAttribute('data-ca-activate');
      if (activate) {
        const res = await api(`/api/claude-accounts/${encodeURIComponent(activate)}/activate`, {
          method: 'POST',
        });
        message = res.ok ? `Now using ${activate}. The bots resume with it.` : res.error;
        return refresh();
      }
      const remove = t.getAttribute('data-ca-remove');
      if (remove) {
        const res = await api(`/api/claude-accounts/${encodeURIComponent(remove)}`, {
          method: 'DELETE',
        });
        message = res.ok ? `Removed ${remove}.` : res.error;
        return refresh();
      }
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
      return refresh();
    }
  });

  await refresh().catch((err) => {
    card.innerHTML = `<div class="form-section-title">Claude accounts</div><p class="text-dim text-sm">Could not load accounts: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`;
  });
}
