import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// The card's mount, driven through a minimal fake DOM: a rejected Test request
// must reach the click handler's catch and show its message on the card.
class FakeElement {
  constructor(private attrs: Record<string, string> = {}) {}
  id = '';
  hasAttribute(n: string) {
    return n in this.attrs;
  }
  getAttribute(n: string) {
    return this.attrs[n] ?? null;
  }
}
// Other web tests assert behaviour *without* a document: set these only for
// this file and put back whatever was there.
const G = globalThis as any;
const saved = {
  HTMLElement: G.HTMLElement,
  HTMLInputElement: G.HTMLInputElement,
  document: G.document,
};
beforeAll(() => {
  G.HTMLElement = FakeElement;
  G.HTMLInputElement = class extends FakeElement {};
  G.document = { activeElement: null };
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete G[k];
    else G[k] = v;
  }
});

let failTest = false;
mock.module('../../web/pages/shared.js', () => ({
  escapeHtml: (s: string) => String(s),
  api: async (url: string) => {
    if (url.endsWith('/test')) {
      if (failTest) throw new Error('network down');
      return { ok: true, latencyMs: 1 };
    }
    return {
      accounts: [
        {
          slug: 'a',
          label: 'A',
          active: true,
          loggedIn: true,
          limits: { checkedAt: new Date().toISOString(), status: 'allowed' },
        },
      ],
    };
  },
}));

describe('claude accounts card mount', () => {
  test('a Test request that throws shows its error on the card', async () => {
    const { mountClaudeAccounts } = await import('../../web/pages/claude-accounts.js');
    const listeners: Record<string, (e: unknown) => Promise<unknown>> = {};
    const card = {
      innerHTML: '',
      isConnected: true,
      querySelector: () => null,
      addEventListener: (k: string, fn: (e: unknown) => Promise<unknown>) => {
        listeners[k] = fn;
      },
    };
    await mountClaudeAccounts(card);
    failTest = true;
    await listeners.click({ target: new FakeElement({ 'data-ca-test': 'a' }) });
    expect(card.innerHTML).toContain('network down');
  });
});
