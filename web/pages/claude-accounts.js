/**
 * Claude accounts card (prototype, Integrations page): which Claude login the
 * fleet uses. Add, rename, test, log in again, switch, remove.
 * Login: the server runs `claude auth login`; the card shows the sign-in
 * link, you sign in and paste the code back.
 */
import { accountsHtml, loginPanelHtml } from './claude-accounts-helpers.js';
import { api, escapeHtml } from './shared.js';

export async function mountClaudeAccounts(card) {
  let accounts = [];
  let login = null;
  let editing = null;
  const tests = {};
  let message = '';

  const paint = () => {
    card.innerHTML = `
      <div class="form-section-title">Claude accounts</div>
      <p class="text-dim text-sm mb-16">The account every bot uses for Claude. When one hits its limit, switch to another; the bots resume at once.</p>
      <div id="ca-list">${accountsHtml(accounts, { editing, tests })}</div>
      ${
        login
          ? loginPanelHtml(login)
          : `<div class="form-row" style="gap:8px;margin-top:12px">
        <input type="text" id="ca-label" placeholder="Name for the new account (e.g. Work 2)" style="flex:1">
        <button type="button" class="btn btn-sm" id="ca-add">Add account</button>
      </div>`
      }
      <div id="ca-msg" class="text-sm" style="margin-top:8px">${escapeHtml(message)}</div>`;
    card.querySelector('#ca-rename-input')?.focus();
  };

  const refresh = async () => {
    const res = await api('/api/claude-accounts');
    if (res.error) message = res.error;
    accounts = res.accounts || accounts;
    paint();
  };

  const startLogin = async (body, relogin) => {
    message = 'Starting the sign-in…';
    paint();
    const res = await api('/api/claude-accounts/login', { method: 'POST', body });
    if (res.error) message = res.error;
    else {
      login = { ...res, relogin };
      message = '';
    }
    paint();
  };

  card.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || t.hasAttribute('disabled')) return;
    try {
      if (t.id === 'ca-add') {
        const label = card.querySelector('#ca-label')?.value?.trim();
        if (!label) {
          message = 'Give the account a name first.';
          return paint();
        }
        return startLogin({ label }, false);
      }
      if (t.id === 'ca-code-send' && login) {
        const code = card.querySelector('#ca-code')?.value?.trim();
        if (!code) return;
        message = 'Checking the code…';
        paint();
        const res = await api(
          `/api/claude-accounts/login/${encodeURIComponent(login.loginId)}/code`,
          {
            method: 'POST',
            body: { code },
          }
        );
        const was = login;
        login = null;
        message = res.ok
          ? `${was.relogin ? 'Logged in again' : 'Added'}: ${res.email || res.slug}.`
          : `Sign-in failed: ${res.error}`;
        return refresh();
      }
      if (t.id === 'ca-cancel' && login) {
        await api(`/api/claude-accounts/login/${encodeURIComponent(login.loginId)}/cancel`, {
          method: 'POST',
        });
        login = null;
        message = '';
        return paint();
      }
      const testSlug = t.getAttribute('data-ca-test');
      if (testSlug) {
        tests[testSlug] = { pending: true };
        paint();
        tests[testSlug] = await api(`/api/claude-accounts/${encodeURIComponent(testSlug)}/test`, {
          method: 'POST',
        });
        return refresh();
      }
      const relogin = t.getAttribute('data-ca-relogin');
      if (relogin) return startLogin({ slug: relogin }, true);
      const rename = t.getAttribute('data-ca-rename');
      if (rename) {
        editing = rename;
        return paint();
      }
      if (t.hasAttribute('data-ca-rename-cancel')) {
        editing = null;
        return paint();
      }
      const save = t.getAttribute('data-ca-rename-save');
      if (save) {
        const label = card.querySelector('#ca-rename-input')?.value ?? '';
        const res = await api(`/api/claude-accounts/${encodeURIComponent(save)}`, {
          method: 'PATCH',
          body: { label },
        });
        if (res.ok) editing = null;
        message = res.ok ? '' : res.error;
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
        if (t.dataset.confirm !== '1') {
          t.dataset.confirm = '1';
          t.textContent = 'Click again to remove';
          return;
        }
        const res = await api(`/api/claude-accounts/${encodeURIComponent(remove)}`, {
          method: 'DELETE',
        });
        message = res.ok ? `Removed ${remove}.` : res.error;
        return refresh();
      }
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
      paint();
    }
  });

  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target.id === 'ca-rename-input')
      card.querySelector('[data-ca-rename-save]')?.click();
  });

  await refresh().catch((err) => {
    card.innerHTML = `<div class="form-section-title">Claude accounts</div><p class="text-dim text-sm">Could not load accounts: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`;
  });
}
