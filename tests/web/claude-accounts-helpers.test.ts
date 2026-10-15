import { describe, expect, test } from 'bun:test';
import { accountsHtml, loginPanelHtml } from '../../web/pages/claude-accounts-helpers.js';

describe('claude accounts card', () => {
  const accounts = [
    { slug: 'default', label: 'Default', email: 'a@x.com', active: true, loggedIn: true },
    { slug: 'work-2', label: 'Work 2', email: 'b@x.com', active: false, loggedIn: true },
    { slug: 'old', label: 'Old', active: false, loggedIn: false },
  ];

  test('the active account has no actions; a logged-in one can be used; the original cannot be removed', () => {
    const html = accountsHtml(accounts);
    expect(html).toContain('active');
    expect(html).toContain('data-ca-activate="work-2"');
    expect(html).not.toContain('data-ca-activate="default"');
    expect(html).not.toContain('data-ca-activate="old"');
    expect(html).toContain('not logged in');
    expect(html).toContain('data-ca-remove="work-2"');
    expect(html).not.toContain('data-ca-remove="default"');
  });

  test('names and emails are escaped', () => {
    const html = accountsHtml([
      { slug: 's', label: '<b>x</b>', email: '<i>', active: false, loggedIn: true },
    ]);
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;');
  });

  test('the login panel links the sign-in page in a new tab and asks for the code', () => {
    const html = loginPanelHtml({
      loginId: 'l',
      url: 'https://claude.com/cai/oauth/authorize?a=1&b=2',
    });
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('id="ca-code"');
    expect(loginPanelHtml(null)).toBe('');
  });
});
