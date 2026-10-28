import { describe, expect, it } from 'bun:test';
import {
  ROSTER_RUN_KEY,
  briefPayload,
  draftFromBrief,
  isRosterRow,
  isRosterStatus,
  proposeBlock,
  rosterCardHtml,
  rosterOutcomeText,
  wantLabel,
} from '../../web/pages/watcher-roster-helpers.js';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function want(over: Record<string, unknown> = {}) {
  return {
    id: 'w-aaaaaa',
    what: 'A weekly digest of job offers in Buenos Aires',
    cadence: 'every Monday',
    delivery: 'Telegram',
    success: 'Five offers I would apply to',
    ...over,
  };
}

function brief(over: Record<string, unknown> = {}) {
  return { wants: [want()], notes: 'No crypto.', updatedAt: iso(NOW - 2 * H), ...over };
}

function status(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    proposalsOn: true,
    running: false,
    lastRunAt: iso(NOW - 26 * H),
    nextRunAt: iso(NOW + 3 * 24 * H),
    lastOutcome: null,
    proposals: [],
    bots: [],
    ...over,
  };
}

describe('isRosterStatus', () => {
  it('accepts a RosterStatus and rejects the watcher-off answer', () => {
    expect(isRosterStatus(status())).toBe(true);
    expect(isRosterStatus(status({ enabled: false }))).toBe(true);
    expect(isRosterStatus({ enabled: false })).toBe(false);
    expect(isRosterStatus(null)).toBe(false);
    expect(isRosterStatus({ error: 'x' })).toBe(false);
  });
});

describe('isRosterRow', () => {
  it('matches roster:* log rows only', () => {
    expect(isRosterRow({ op: 'roster:run' })).toBe(true);
    expect(isRosterRow({ type: 'roster:proposed' })).toBe(true);
    expect(isRosterRow({ op: 'self-study:run' })).toBe(false);
    expect(isRosterRow(null)).toBe(false);
  });
});

describe('draftFromBrief', () => {
  it('gives one blank row for an empty or missing brief', () => {
    for (const b of [null, undefined, { wants: [], notes: '' }, { enabled: false }]) {
      const d = draftFromBrief(b);
      expect(d.wants).toEqual([{ what: '', cadence: '', delivery: '', success: '' }]);
      expect(d.notes).toBe('');
    }
  });

  it('copies the saved wants with their ids and the notes', () => {
    const d = draftFromBrief(brief());
    expect(d.wants).toEqual([want()]);
    expect(d.notes).toBe('No crypto.');
  });
});

describe('briefPayload', () => {
  it('drops wants with an empty what, keeps ids, trims and omits a missing id', () => {
    const body = briefPayload({
      wants: [
        want(),
        { what: '   ', cadence: 'daily', delivery: '', success: '' },
        { what: '  Morning agenda ', cadence: ' daily ', delivery: 'dashboard', success: '' },
      ],
      notes: '  be brief  ',
    });
    expect(body.wants).toEqual([
      want(),
      { what: 'Morning agenda', cadence: 'daily', delivery: 'dashboard', success: '' },
    ]);
    expect('id' in body.wants[1]).toBe(false);
    expect(body.notes).toBe('be brief');
  });

  it('caps at 5 wants and clips every field to its limit', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      want({ id: `w-00000${i}`, what: 'x'.repeat(400), cadence: 'c'.repeat(100) })
    );
    const body = briefPayload({ wants: many, notes: 'n'.repeat(2500) });
    expect(body.wants).toHaveLength(5);
    expect(body.wants[0].what).toHaveLength(300);
    expect(body.wants[0].cadence).toHaveLength(80);
    expect(body.notes).toHaveLength(2000);
  });

  it('survives a missing draft', () => {
    expect(briefPayload(null)).toEqual({ wants: [], notes: '' });
  });
});

describe('wantLabel', () => {
  it('maps a want id to its what, clipped; an unknown id stays as is', () => {
    const b = brief({ wants: [want({ what: 'y'.repeat(120) })] });
    expect(wantLabel('w-aaaaaa', b)).toBe(`${'y'.repeat(59)}…`);
    expect(wantLabel('w-zzzzzz', b)).toBe('w-zzzzzz');
  });
});

describe('proposeBlock', () => {
  it('says why Propose is off, in order', () => {
    expect(proposeBlock(status({ enabled: false }), brief())).toMatch(/roster is off/i);
    expect(proposeBlock(status({ proposalsOn: false }), brief())).toMatch(
      /agent proposals are off/i
    );
    expect(proposeBlock(status({ running: true }), brief())).toMatch(/running/i);
    expect(proposeBlock(status(), brief({ wants: [] }))).toMatch(/save at least one want/i);
    expect(proposeBlock(status(), null)).toMatch(/save at least one want/i);
    expect(proposeBlock(status(), brief())).toBe('');
  });
});

describe('rosterOutcomeText', () => {
  it('puts each status in words', () => {
    expect(rosterOutcomeText(null)).toBe('');
    expect(
      rosterOutcomeText({
        status: 'proposed',
        trigger: 'manual',
        proposed: [{}, {}],
        dropped: [{}],
        retire: [],
        questions: [],
      })
    ).toMatch(/proposed 2 bots.*1 dropped/i);
    expect(
      rosterOutcomeText({ status: 'refused', reason: 'budget cap', proposed: [], dropped: [] })
    ).toMatch(/refused.*budget cap/i);
    expect(rosterOutcomeText({ status: 'nothing', proposed: [], dropped: [] })).toMatch(
      /nothing to propose/i
    );
  });
});

describe('rosterCardHtml', () => {
  it('renders nothing when the status is not a roster answer (watcher off)', () => {
    expect(rosterCardHtml({ enabled: false }, brief(), { nowMs: NOW })).toBe('');
    expect(rosterCardHtml(null, brief(), { nowMs: NOW })).toBe('');
  });

  it('shows the head, an empty editor row and the add button for an empty brief', () => {
    const html = rosterCardHtml(
      status({ lastRunAt: null }),
      { wants: [], notes: '' },
      { nowMs: NOW }
    );
    expect(html).toContain('Roster');
    expect(html).toContain('What you want');
    expect((html.match(/data-roster-field="what"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-action="roster-add"');
    expect(html).toContain('maxlength="300"');
    expect(html).toContain('maxlength="80"');
    expect(html).toContain('maxlength="2000"');
    expect(html).not.toContain('Saved ');
    expect(html).toMatch(/has not run yet/);
    // No saved wants: Propose is disabled with the reason.
    expect(html).toMatch(/data-action="roster-run"[^>]*disabled/);
    expect(html).toMatch(/save at least one want/i);
  });

  it('hides "+ Add want" at 5 rows', () => {
    const wants = Array.from({ length: 5 }, (_, i) => want({ id: `w-00000${i}` }));
    const html = rosterCardHtml(status(), brief({ wants }), { nowMs: NOW });
    expect((html.match(/data-roster-field="what"/g) ?? []).length).toBe(5);
    expect(html).not.toContain('data-action="roster-add"');
    expect((html.match(/data-action="roster-remove"/g) ?? []).length).toBe(5);
  });

  it('uses the editor draft over the saved brief and shows when it was saved', () => {
    const html = rosterCardHtml(status(), brief(), {
      nowMs: NOW,
      ui: { draft: { wants: [want({ what: 'Draft text' })], notes: 'draft notes' } },
    });
    expect(html).toContain('value="Draft text"');
    expect(html).toContain('draft notes');
    expect(html).toMatch(/Saved 2 h ago/);
  });

  it('escapes user text everywhere', () => {
    const evil = '<script>alert(1)</script>';
    const html = rosterCardHtml(
      status({
        lastOutcome: {
          at: iso(NOW - H),
          trigger: 'manual',
          status: 'proposed',
          proposed: [{ proposalId: 'p1', agentId: 'a', name: evil, serves: ['w-aaaaaa'] }],
          dropped: [{ name: evil, reason: evil }],
          retire: [{ botId: evil, reason: evil }],
          questions: [evil],
          note: evil,
        },
        proposals: [
          {
            id: 'p1',
            agentId: 'a',
            name: evil,
            status: 'pending',
            createdAt: iso(NOW),
            serves: ['w-aaaaaa'],
            deliverable: evil,
            cadence: '1d',
            killCriterion: evil,
          },
        ],
        bots: [
          {
            botId: 'b',
            name: evil,
            enabled: true,
            approvedAt: iso(NOW - 48 * H),
            serves: [],
            killCriterion: evil,
            cyclesCompleted: 1,
            productions: 0,
            approved: 0,
            rejected: 0,
          },
        ],
      }),
      brief({ wants: [want({ what: evil })], notes: evil }),
      { nowMs: NOW, ui: { error: evil, saveError: evil } }
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('disables Propose with the reason while off, without proposals, or running', () => {
    const off = rosterCardHtml(status({ proposalsOn: false }), brief(), { nowMs: NOW });
    expect(off).toMatch(/data-action="roster-run"[^>]*disabled/);
    expect(off).toMatch(/agent proposals are off/i);
    const running = rosterCardHtml(status({ running: true }), brief(), { nowMs: NOW });
    expect(running).toMatch(/data-action="roster-run"[^>]*disabled/);
    expect(running).toContain('Running…');
    const busy = rosterCardHtml(status(), brief(), { nowMs: NOW, ui: { busy: true } });
    expect(busy).toMatch(/data-action="roster-run"[^>]*disabled/);
  });

  it('arms Propose on the first click and shows next and last run', () => {
    const idle = rosterCardHtml(status(), brief(), { nowMs: NOW });
    expect(idle).not.toMatch(/data-action="roster-run"[^>]*disabled/);
    expect(idle).toContain('Propose bots');
    expect(idle).toMatch(/next automatic run in 3 d/);
    expect(idle).toMatch(/last run 1 d ago/);
    const armed = rosterCardHtml(status(), brief(), {
      nowMs: NOW,
      ui: { armed: { key: ROSTER_RUN_KEY, until: NOW + 1000 } },
    });
    expect(armed).toContain('Click again to propose');
  });

  it('shows save errors inline and the saving state', () => {
    const html = rosterCardHtml(status(), brief(), {
      nowMs: NOW,
      ui: { saveError: 'wants[0].what is too long', saving: true },
    });
    expect(html).toContain('wants[0].what is too long');
    expect(html).toMatch(/data-action="roster-save"[^>]*disabled/);
  });

  it('renders the last outcome: proposed, dropped, questions, retire, note, cost', () => {
    const html = rosterCardHtml(
      status({
        lastOutcome: {
          at: iso(NOW - H),
          trigger: 'brief-changed',
          status: 'proposed',
          proposed: [
            { proposalId: 'p1', agentId: 'job-scout', name: 'Job Scout', serves: ['w-aaaaaa'] },
          ],
          dropped: [{ name: 'Crypto Bot', reason: 'cites no known want' }],
          retire: [{ botId: 'old-bot', reason: 'nothing approved in a month' }],
          questions: ['Which cities besides Buenos Aires?'],
          note: 'Started small.',
          tokens: 12345,
          costUsd: 0.42,
        },
      }),
      brief(),
      { nowMs: NOW }
    );
    expect(html).toContain('Job Scout');
    expect(html).toContain('A weekly digest of job offers');
    expect(html).toContain('Crypto Bot');
    expect(html).toContain('cites no known want');
    expect(html).toContain('The mind asks');
    expect(html).toContain('Which cities besides Buenos Aires?');
    expect(html).toContain('Consider turning off');
    expect(html).toContain('old-bot');
    expect(html).toContain('nothing approved in a month');
    expect(html).toContain('Started small.');
    expect(html).toContain('$0.42');
    expect(html).toContain('12,345 tokens');
    expect(html).toMatch(/after you edited the brief/);
  });

  it('lists the proposals with status, serves and a link to review them', () => {
    const html = rosterCardHtml(
      status({
        proposals: [
          {
            id: 'p1',
            agentId: 'job-scout',
            name: 'Job Scout',
            status: 'pending',
            createdAt: iso(NOW - H),
            serves: ['w-aaaaaa'],
            deliverable: 'A Monday list of 5 offers',
            cadence: '1d',
            killCriterion: 'No approval in 3 weeks',
          },
          {
            id: 'p2',
            agentId: 'x',
            name: 'Rejected One',
            status: 'rejected',
            createdAt: iso(NOW - 30 * H),
            serves: [],
          },
        ],
      }),
      brief(),
      { nowMs: NOW }
    );
    expect(html).toContain('Job Scout');
    expect(html).toContain('pending');
    expect(html).toContain('rejected');
    expect(html).toContain('A Monday list of 5 offers');
    expect(html).toContain('No approval in 3 weeks');
    expect(html).toContain('A weekly digest of job offers');
    expect(html).toContain('href="#/needs/proposals"');
  });

  it('lists the bots with their outcomes', () => {
    const html = rosterCardHtml(
      status({
        bots: [
          {
            botId: 'job-scout',
            name: 'Job Scout',
            enabled: false,
            approvedAt: iso(NOW - 72 * H),
            serves: ['w-aaaaaa'],
            killCriterion: 'No approval in 3 weeks',
            cyclesCompleted: 7,
            lastCycleAt: iso(NOW - 5 * H),
            productions: 4,
            approved: 2,
            rejected: 1,
          },
        ],
      }),
      brief(),
      { nowMs: NOW }
    );
    expect(html).toContain('Job Scout');
    expect(html).toMatch(/\boff\b/);
    expect(html).toContain('7 cycles');
    expect(html).toMatch(/2 approved, 1 rejected of 4/);
    expect(html).toMatch(/last cycle 5 h ago/);
    expect(html).toContain('No approval in 3 weeks');
  });
});
