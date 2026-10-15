import { describe, expect, test } from 'bun:test';
import {
  accountsHtml,
  loginPanelHtml,
  testResultHtml,
} from '../../web/pages/claude-accounts-helpers.js';

describe('claude accounts card', () => {
  const accounts = [
    { slug: 'default', label: 'Default', email: 'a@x.com', active: true, loggedIn: true },
    { slug: 'work-2', label: 'Work 2', email: 'b@x.com', active: false, loggedIn: true },
    { slug: 'old', label: 'Old', active: false, loggedIn: false },
  ];

  test('every account can be tested, renamed and logged in again', () => {
    const html = accountsHtml(accounts);
    for (const slug of ['default', 'work-2', 'old']) {
      expect(html).toContain(`data-ca-test="${slug}"`);
      expect(html).toContain(`data-ca-rename="${slug}"`);
      expect(html).toContain(`data-ca-relogin="${slug}"`);
    }
  });

  test('only a logged-in account that is not active can be used', () => {
    const html = accountsHtml(accounts);
    expect(html).toContain('data-ca-activate="work-2"');
    expect(html).not.toContain('data-ca-activate="default"');
    expect(html).not.toContain('data-ca-activate="old"');
  });

  // Deliberately changed: Remove was hidden on the active account and the
  // original login, which read as "cannot remove". Now it is always there,
  // disabled with the reason on the active one.
  test('remove: on every account, disabled on the active one with the reason', () => {
    const html = accountsHtml(accounts);
    expect(html).toContain('data-ca-remove="work-2"');
    expect(html).toContain('data-ca-remove="old"');
    expect(html).toMatch(
      /data-ca-remove="default"[^>]*disabled[^>]*title="Switch to another account first"/
    );
  });

  test('renaming shows an input with the current name and save/cancel', () => {
    const html = accountsHtml(accounts, { editing: 'work-2' });
    expect(html).toContain('id="ca-rename-input"');
    expect(html).toContain('value="Work 2"');
    expect(html).toContain('data-ca-rename-save="work-2"');
    expect(html).toContain('data-ca-rename-cancel');
  });

  test('a test result shows under its row', () => {
    const html = accountsHtml(accounts, {
      tests: { 'work-2': { ok: true, latencyMs: 2300, reply: 'OK' } },
    });
    expect(html).toContain('Connection works');
  });

  test('testResultHtml: working, at the limit, pending, broken', () => {
    expect(
      testResultHtml({ ok: true, latencyMs: 2300, reply: 'OK', model: 'claude-opus-5-5' })
    ).toContain('Connection works · 2.3 s');
    const limit = testResultHtml({
      ok: false,
      latencyMs: 900,
      status: 429,
      error: "You've hit your weekly limit · resets 3pm",
    });
    expect(limit).toContain('HTTP 429');
    expect(limit).toContain('weekly limit');
    expect(testResultHtml({ pending: true })).toContain('Testing');
    expect(testResultHtml({ ok: false, latencyMs: 10, error: '<b>x</b>' })).not.toContain(
      '<b>x</b>'
    );
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
    expect(
      loginPanelHtml({ loginId: 'l', url: 'https://x', slug: 'default', relogin: true })
    ).toContain('Log in again');
  });
});

describe('availability column', () => {
  const { availabilityHtml } = require('../../web/pages/claude-accounts-helpers.js');
  const NOW = Date.parse('2026-10-15T14:00:00Z');

  test('what is left of each window, when it resets, and when it was checked', () => {
    const html = availabilityHtml(
      {
        checkedAt: '2026-10-15T13:57:00Z',
        status: 'allowed',
        fiveHour: { utilization: 0.27, resetsAt: '2026-10-15T14:40:00Z' },
        sevenDay: { utilization: 0.43, resetsAt: '2026-10-17T21:00:00Z' },
      },
      NOW
    );
    expect(html).toContain('5h: 73% left');
    expect(html).toContain('resets in 40m');
    expect(html).toContain('Week: 57% left');
    expect(html).toContain('resets in 2d 7h');
    expect(html).toContain('checked 3m ago');
  });

  test('a rejected account says it is blocked; never checked says so', () => {
    expect(
      availabilityHtml(
        {
          checkedAt: '2026-10-15T13:00:00Z',
          status: 'rejected',
          sevenDay: { utilization: 1, resetsAt: '2026-10-15T18:00:00Z' },
        },
        NOW
      )
    ).toContain('Blocked');
    expect(availabilityHtml(undefined, NOW)).toContain('Not checked yet');
  });

  test('the table shows the column for each account', () => {
    const html = accountsHtml([
      {
        slug: 'a',
        label: 'A',
        active: true,
        loggedIn: true,
        limits: {
          checkedAt: '2026-10-15T13:00:00Z',
          status: 'allowed',
          fiveHour: { utilization: 0.5 },
        },
      },
    ]);
    expect(html).toContain('Available');
    expect(html).toContain('5h: 50% left');
  });
});
