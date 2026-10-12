import { describe, expect, it } from 'bun:test';
import { fileWhy } from '../../web/pages/productions-helpers.js';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

describe('fileWhy', () => {
  it("renders the file's server-built why with the shared panel", () => {
    const html = fileWhy(
      {
        what: 'Last edited with file_edit',
        by: 'agent',
        cycle: { id: 'c-2', botId: 'b1', plan: 'Tighten <it>' },
        goal: { id: 'g-1', title: 'Map the market' },
        outcome: 'Waiting for your review.',
      },
      { botId: 'b1', nowMs: NOW }
    );
    expect(html).toStartWith('<div class="prod-file-why">');
    expect(html).toContain('<details class="why">');
    expect(html).toContain('data-open-cycle="c-2"');
    expect(html).toContain('Tighten &lt;it&gt;');
  });

  it('no why (old server, untracked file), no fold', () => {
    expect(fileWhy(undefined, { botId: 'b1', nowMs: NOW })).toBe('');
  });
});
