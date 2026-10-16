import { describe, expect, test } from 'bun:test';
import {
  accountsHtml,
  connectButtonsHtml,
  providerLabel,
} from '../../web/pages/personal-accounts-helpers.js';

const accounts = [
  {
    slug: 'personal',
    provider: 'google',
    email: 'ana@gmail.com',
    label: 'Personal',
    status: 'ok',
    addedAt: '2026-10-01T00:00:00Z',
  },
  {
    slug: 'work',
    provider: 'microsoft',
    email: 'ana@corp.com',
    label: 'Work <b>',
    status: 'reauth-needed',
    lastError: '400 invalid_grant',
    addedAt: '2026-10-02T00:00:00Z',
  },
];

describe('personal accounts card', () => {
  test('providerLabel names the provider', () => {
    expect(providerLabel('google')).toBe('Google');
    expect(providerLabel('microsoft')).toBe('Microsoft');
  });

  test('each account row shows label, provider, email, status and its actions', () => {
    const html = accountsHtml(accounts);
    expect(html).toContain('ana@gmail.com');
    expect(html).toContain('Google');
    expect(html).toContain('Microsoft');
    for (const slug of ['personal', 'work']) {
      expect(html).toContain(`data-pa-remove="${slug}"`);
      expect(html).toContain(`data-pa-rename="${slug}"`);
    }
    expect(html).toContain('Connected');
    expect(html).toContain('Needs reconnecting');
    expect(html).toContain('400 invalid_grant');
  });

  test('a reauth-needed account offers reconnecting with its own provider', () => {
    const html = accountsHtml(accounts);
    expect(html).toContain('data-pa-reconnect="microsoft"');
    expect(html).not.toContain('data-pa-reconnect="google"');
  });

  test('labels are escaped', () => {
    const html = accountsHtml(accounts);
    expect(html).toContain('Work &lt;b&gt;');
    expect(html).not.toContain('Work <b>');
  });

  test('remove asks for a second click', () => {
    const html = accountsHtml(accounts, { confirmRemove: 'work' });
    expect(html).toMatch(/data-pa-remove="work"[^>]*>Confirm remove/);
  });

  test('renaming shows an input for that account only', () => {
    const html = accountsHtml(accounts, { editing: 'personal' });
    expect(html).toContain('id="pa-rename-input"');
    expect(html).toContain('value="Personal"');
  });

  test('no accounts → an empty state', () => {
    expect(accountsHtml([])).toContain('No accounts connected');
  });

  test('connect buttons: enabled when configured, otherwise say which env vars are missing', () => {
    const html = connectButtonsHtml({ google: true, microsoft: false });
    expect(html).toMatch(/data-pa-connect="google"(?![^>]*disabled)/);
    expect(html).toMatch(/data-pa-connect="microsoft"[^>]*disabled/);
    expect(html).toContain('MICROSOFT_OAUTH_CLIENT_ID');
    expect(html).not.toContain('GOOGLE_OAUTH_CLIENT_ID');
  });
});
