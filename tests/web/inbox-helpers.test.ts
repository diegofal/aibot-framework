import { describe, expect, it } from 'bun:test';
import { threadWhy } from '../../web/pages/inbox-helpers.js';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

describe('threadWhy', () => {
  it('renders the server-built why of an ask thread with the shared panel', () => {
    const html = threadWhy(
      {
        what: 'A question it asked you during a work cycle',
        by: 'agent',
        cycle: { id: 'c-1', botId: 'b1', plan: 'Draft <it>' },
        outcome: 'You answered it.',
      },
      { botId: 'b1', nowMs: NOW }
    );
    expect(html).toStartWith('<div class="inbox-why">');
    expect(html).toContain('<details class="why">');
    expect(html).toContain('data-open-cycle="c-1"');
    expect(html).toContain('Draft &lt;it&gt;');
  });

  it('no why (old server, or not an ask thread), no fold', () => {
    expect(threadWhy(undefined, { botId: 'b1', nowMs: NOW })).toBe('');
  });
});
