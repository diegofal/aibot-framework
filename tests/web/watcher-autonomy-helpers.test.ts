import { describe, expect, it } from 'bun:test';
import {
  ARM_MS,
  armClick,
  expiresText,
  formatValue,
  guardText,
  isArmed,
  isAutonomyRow,
  killBannerHtml,
  monthSpend,
  monthSpendHtml,
  orderProposals,
  proposalsPanelHtml,
  shouldRedrawProposals,
  startBlockedByKill,
} from '../../web/pages/watcher-autonomy-helpers.js';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function proposal(over: Record<string, unknown> = {}) {
  return {
    id: 'p-11111111',
    kind: 'threshold',
    title: 'Raise the notice bar',
    rationale: 'Most notice passes keep nothing.',
    support: ['n-0000aaaa', 'c0ffee00-1111-2222-3333-444455556666'],
    changes: [{ path: 'watcher.notice.salienceBar', from: 0.3, to: 0.4 }],
    predicted: { effect: 'Fewer notice passes, same served rate', savingUsdPerWeek: 1.5 },
    guard: { metric: 'servedRate', direction: 'min', bound: 0.2, windowHours: 72 },
    rollback: 'Put the bar back to 0.3.',
    proposedBy: 'watcher',
    contentHash: 'a'.repeat(64),
    status: 'pending',
    createdAt: iso(NOW - 3 * H),
    pendingAt: iso(NOW - 2 * H),
    expiresAt: iso(NOW + 70 * H),
    ...over,
  };
}

function change(over: Record<string, unknown> = {}) {
  return {
    id: 'c-22222222',
    proposalId: 'p-99999999',
    before: [{ path: 'watcher.integrate.wakeSalience', value: 3 }],
    after: [{ path: 'watcher.integrate.wakeSalience', value: 4 }],
    guard: { metric: 'integrateCostUsd', direction: 'max', bound: 2, windowHours: 48 },
    appliedAt: iso(NOW - 5 * H),
    guardUntil: iso(NOW + 43 * H),
    status: 'applied',
    ...over,
  };
}

function resp(over: Record<string, unknown> = {}) {
  return { enabled: true, proposals: [proposal()], changes: [], maxPending: 3, ...over };
}

describe('killBannerHtml (C1)', () => {
  it('nothing when not killed', () => {
    expect(killBannerHtml(undefined, NOW)).toBe('');
    expect(killBannerHtml(null, NOW)).toBe('');
  });
  it('names the environment source, since when, and what it takes to clear', () => {
    const html = killBannerHtml({ source: 'env', since: iso(NOW - 2 * H) }, NOW);
    expect(html).toContain('Stopped by the hard kill (environment: AIBOT_WATCHER_KILL)');
    expect(html).toContain('2 h ago');
    expect(html).toContain('Nothing runs until it is cleared and you start the watcher again.');
    expect(html).toContain('role="alert"');
  });
  it('names the sentinel file', () => {
    const html = killBannerHtml({ source: 'file', since: iso(NOW - 30_000) }, NOW);
    expect(html).toContain('(file: watcher-kill in the data folder)');
    expect(html).toContain('just now');
  });
});

describe('startBlockedByKill', () => {
  it('Start is disabled while killed; Stop of a running watcher never is', () => {
    expect(startBlockedByKill({ killed: { source: 'env', since: iso(NOW) } })).toBe(true);
    expect(startBlockedByKill({ running: true, killed: { source: 'env', since: iso(NOW) } })).toBe(
      false
    );
    expect(startBlockedByKill({ running: false })).toBe(false);
    expect(startBlockedByKill(null)).toBe(false);
  });
});

describe('monthSpend (C6)', () => {
  it('absent month: nothing', () => {
    expect(monthSpend(undefined)).toBeNull();
    expect(monthSpendHtml(undefined)).toBe('');
  });
  it('under 75 % is plain', () => {
    const m = monthSpend({ costUsd: 12.345, ceilingUsd: 90 });
    expect(m?.tone).toBe('ok');
    expect(m?.text).toBe('this month $12.35 of $90.00');
  });
  it('amber at 75 %, red with the refusal note at 100 %', () => {
    expect(monthSpend({ costUsd: 67.5, ceilingUsd: 90 })?.tone).toBe('warn');
    const over = monthSpend({ costUsd: 90, ceilingUsd: 90 });
    expect(over?.tone).toBe('over');
    expect(over?.text).toContain('ceiling reached: every call is refused');
    expect(monthSpendHtml({ costUsd: 95, ceilingUsd: 90 })).toContain('is-over');
    expect(monthSpendHtml({ costUsd: 70, ceilingUsd: 90 })).toContain('is-warn');
  });
  it('a zero ceiling refuses everything', () => {
    expect(monthSpend({ costUsd: 0, ceilingUsd: 0 })?.tone).toBe('over');
  });
});

describe('isAutonomyRow', () => {
  it('matches autonomy:* log rows only', () => {
    expect(isAutonomyRow({ op: 'autonomy:approved' })).toBe(true);
    expect(isAutonomyRow({ type: 'autonomy:rollback' })).toBe(true);
    expect(isAutonomyRow({ op: 'integrate:pass' })).toBe(false);
    expect(isAutonomyRow(null)).toBe(false);
  });
});

describe('armClick / isArmed (two-step buttons)', () => {
  it('first click arms, a second within the window fires and disarms', () => {
    const one = armClick(null, 'approve:p-1:h', NOW);
    expect(one.fire).toBe(false);
    expect(isArmed(one.armed, 'approve:p-1:h', NOW + 1000)).toBe(true);
    const two = armClick(one.armed, 'approve:p-1:h', NOW + 1000);
    expect(two.fire).toBe(true);
    expect(two.armed).toBeNull();
  });
  it('disarms after the window; another key re-arms instead of firing', () => {
    const one = armClick(null, 'approve:p-1:h', NOW);
    expect(isArmed(one.armed, 'approve:p-1:h', NOW + ARM_MS + 1)).toBe(false);
    expect(armClick(one.armed, 'approve:p-1:h', NOW + ARM_MS + 1).fire).toBe(false);
    const other = armClick(one.armed, 'revert:c-1', NOW + 10);
    expect(other.fire).toBe(false);
    expect(isArmed(other.armed, 'approve:p-1:h', NOW + 10)).toBe(false);
  });
});

describe('formatValue / guardText / expiresText', () => {
  it('values read as written', () => {
    expect(formatValue(0.3)).toBe('0.3');
    expect(formatValue('6h')).toBe('6h');
    expect(formatValue(true)).toBe('true');
    expect(formatValue(null)).toBe('null');
    expect(formatValue(undefined)).toBe('(unset)');
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });
  it('the guard in plain words', () => {
    expect(guardText({ metric: 'servedRate', direction: 'min', bound: 0.2, windowHours: 72 })).toBe(
      'If servedRate falls below 0.2 within 72 h of applying, code rolls it back by itself.'
    );
    expect(
      guardText({ metric: 'integrateCostUsd', direction: 'max', bound: 2, windowHours: 48 })
    ).toContain('rises above 2 within 48 h');
  });
  it('expiry in hours or days, or expired', () => {
    expect(expiresText(iso(NOW + 70 * H), NOW)).toBe('expires in 3 d');
    expect(expiresText(iso(NOW + 5 * H), NOW)).toBe('expires in 5 h');
    expect(expiresText(iso(NOW - H), NOW)).toBe('expired');
    expect(expiresText(undefined, NOW)).toBe('');
  });
});

describe('orderProposals', () => {
  it('pending (oldest first), queued, and decided; rejected-locked never shown', () => {
    const out = orderProposals([
      proposal({ id: 'p-q', status: 'queued' }),
      proposal({ id: 'p-new', pendingAt: iso(NOW - H) }),
      proposal({ id: 'p-old', pendingAt: iso(NOW - 5 * H) }),
      proposal({ id: 'p-locked', status: 'rejected-locked' }),
      proposal({ id: 'p-rej', status: 'rejected', decidedAt: iso(NOW - H) }),
    ]);
    expect(out.pending.map((p) => p.id)).toEqual(['p-old', 'p-new']);
    expect(out.queued.map((p) => p.id)).toEqual(['p-q']);
    expect(out.decided.map((p) => p.id)).toEqual(['p-rej']);
  });
});

describe('proposalsPanelHtml (C3, C4, C7)', () => {
  it('renders nothing when proposals are disabled or the list is missing', () => {
    expect(proposalsPanelHtml({ enabled: false, proposals: [], changes: [] }, { nowMs: NOW })).toBe(
      ''
    );
    expect(proposalsPanelHtml(null, { nowMs: NOW })).toBe('');
  });

  it('"Nothing to review" when enabled with no pending', () => {
    const html = proposalsPanelHtml(resp({ proposals: [] }), { nowMs: NOW });
    expect(html).toContain('Nothing to review');
  });

  it('a pending proposal shows everything in plain words', () => {
    const html = proposalsPanelHtml(resp(), { nowMs: NOW });
    expect(html).toContain('Raise the notice bar');
    expect(html).toContain('Watcher setting');
    expect(html).toContain('watcher.notice.salienceBar');
    expect(html).toContain('0.3 → 0.4');
    expect(html).toContain('Most notice passes keep nothing.');
    expect(html).toContain('n-0000aaaa');
    expect(html).toContain('c0ffee00-1111-2222-3333-444455556666');
    expect(html).toContain('Fewer notice passes, same served rate');
    expect(html).toContain('saves about $1.50 a week');
    expect(html).toContain('If servedRate falls below 0.2 within 72 h');
    expect(html).toContain('Put the bar back to 0.3.');
    expect(html).toContain('expires in 3 d');
  });

  it('a predicted cost reads as a cost', () => {
    const html = proposalsPanelHtml(
      resp({ proposals: [proposal({ predicted: { effect: 'x', costUsdPerWeek: 0.25 } })] }),
      { nowMs: NOW }
    );
    expect(html).toContain('costs about $0.25 a week');
  });

  it('Approve carries the rendered content hash and arms on the first click', () => {
    const html = proposalsPanelHtml(resp(), { nowMs: NOW });
    expect(html).toContain('data-action="autonomy-approve"');
    expect(html).toContain('data-proposal-id="p-11111111"');
    expect(html).toContain(`data-content-hash="${'a'.repeat(64)}"`);
    expect(html).toContain('>Approve<');
    const armed = proposalsPanelHtml(resp(), {
      nowMs: NOW,
      ui: { armed: { key: `approve:p-11111111:${'a'.repeat(64)}`, until: NOW + ARM_MS } },
    });
    expect(armed).toContain('Click again to approve');
  });

  it('an edited proposal (new hash) is not armed by the old click', () => {
    const html = proposalsPanelHtml(
      resp({ proposals: [proposal({ contentHash: 'b'.repeat(64) })] }),
      {
        nowMs: NOW,
        ui: { armed: { key: `approve:p-11111111:${'a'.repeat(64)}`, until: NOW + ARM_MS } },
      }
    );
    expect(html).not.toContain('Click again to approve');
  });

  it('Reject opens an inline note, never a dialog', () => {
    const closed = proposalsPanelHtml(resp(), { nowMs: NOW });
    expect(closed).toContain('data-action="autonomy-reject"');
    expect(closed).not.toContain('data-autonomy-note');
    const open = proposalsPanelHtml(resp(), {
      nowMs: NOW,
      ui: { rejecting: { 'p-11111111': 'not <now>' } },
    });
    expect(open).toContain('data-autonomy-note="p-11111111"');
    expect(open).toContain('value="not &lt;now&gt;"');
    expect(open).toContain('data-action="autonomy-reject-send"');
    expect(open).toContain('data-action="autonomy-reject-cancel"');
  });

  it('a 409 shows its error inline on that card; busy disables its buttons', () => {
    const html = proposalsPanelHtml(resp(), {
      nowMs: NOW,
      ui: { errors: { 'p-11111111': 'The live value changed <since>' }, busy: 'p-11111111' },
    });
    expect(html).toContain('The live value changed &lt;since&gt;');
    expect(html).toMatch(/data-action="autonomy-approve"[^>]*disabled/);
  });

  it('queued proposals wait for a review slot, without buttons', () => {
    const html = proposalsPanelHtml(
      resp({
        proposals: [proposal(), proposal({ id: 'p-q', title: 'Later one', status: 'queued' })],
      }),
      { nowMs: NOW }
    );
    expect(html.indexOf('Raise the notice bar')).toBeLessThan(html.indexOf('Later one'));
    expect(html).toContain('Waiting for a review slot');
    expect(html).not.toContain('data-proposal-id="p-q"');
  });

  it('an applied change shows its status, values and a two-step Revert', () => {
    const html = proposalsPanelHtml(
      resp({
        proposals: [
          proposal({ id: 'p-99999999', title: 'Wake integrate later', status: 'approved' }),
        ],
        changes: [change()],
      }),
      { nowMs: NOW }
    );
    expect(html).toContain('Wake integrate later');
    expect(html).toContain('Live');
    expect(html).toContain('watcher.integrate.wakeSalience');
    expect(html).toContain('3 → 4');
    expect(html).toContain('data-action="autonomy-revert"');
    expect(html).toContain('data-change-id="c-22222222"');
    expect(html).toContain('>Revert<');
    const armed = proposalsPanelHtml(resp({ changes: [change()] }), {
      nowMs: NOW,
      ui: { armed: { key: 'revert:c-22222222', until: NOW + ARM_MS } },
    });
    expect(armed).toContain('Click again to revert');
  });

  it('ended changes show their end reason and no Revert', () => {
    for (const [status, label] of [
      ['rolled-back', 'Rolled back by its guard'],
      ['reverted', 'Reverted by you'],
      ['revert-failed', 'Revert failed'],
    ]) {
      const html = proposalsPanelHtml(
        resp({
          proposals: [],
          changes: [change({ status, endedAt: iso(NOW - H), endReason: `reason <${status}>` })],
        }),
        { nowMs: NOW }
      );
      expect(html).toContain(label);
      expect(html).toContain(`reason &lt;${status}&gt;`);
      expect(html).not.toContain('data-action="autonomy-revert"');
    }
  });

  it('a rejected proposal stays in the history with its note', () => {
    const html = proposalsPanelHtml(
      resp({
        proposals: [
          proposal({
            id: 'p-r',
            title: 'No thanks',
            status: 'rejected',
            decidedAt: iso(NOW - H),
            note: 'too soon',
          }),
        ],
      }),
      { nowMs: NOW }
    );
    expect(html).toContain('Nothing to review');
    expect(html).toContain('No thanks');
    expect(html).toContain('Rejected');
    expect(html).toContain('too soon');
  });

  it('escapes every text field', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = proposalsPanelHtml(
      resp({
        proposals: [
          proposal({
            title: evil,
            rationale: evil,
            support: [evil],
            changes: [{ path: evil, from: evil, to: evil }],
            predicted: { effect: evil },
            rollback: evil,
            guard: { metric: evil, direction: 'min', bound: 1, windowHours: 1 },
          }),
        ],
        changes: [change({ status: 'reverted', endReason: evil })],
      }),
      { nowMs: NOW }
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('never uses the Why fold markup of the shared panel', () => {
    const html = proposalsPanelHtml(resp({ changes: [change()] }), { nowMs: NOW });
    expect(html).not.toMatch(/class="why[" -]/);
  });
});

describe('shouldRedrawProposals', () => {
  it('only when the markup changed, never under a focused note, unless forced', () => {
    expect(shouldRedrawProposals('a', 'a', {})).toBe(false);
    expect(shouldRedrawProposals('a', 'b', {})).toBe(true);
    expect(shouldRedrawProposals(null, 'b', {})).toBe(true);
    expect(shouldRedrawProposals('a', 'b', { typing: true })).toBe(false);
    expect(shouldRedrawProposals('a', 'b', { typing: true, force: true })).toBe(true);
  });
});

describe('change timing', () => {
  it('a live change says how long its guard still watches', () => {
    const html = proposalsPanelHtml(resp({ changes: [change()] }), { nowMs: NOW });
    expect(html).toContain('applied 5 h ago');
    expect(html).toContain('its guard watches 43 h more');
    const over = proposalsPanelHtml(resp({ changes: [change({ guardUntil: iso(NOW - H) })] }), {
      nowMs: NOW,
    });
    expect(over).toContain('guard window over');
  });
});
