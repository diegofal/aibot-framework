import { describe, expect, it } from 'bun:test';
import { WHY_ROW_ORDER, whyPanel } from '../../web/pages/why-helpers.js';

const NOW = Date.parse('2026-10-11T12:00:00Z');

const full = {
  what: 'A finding <from> a cycle',
  by: 'curiosity',
  cycle: {
    id: 'c-1',
    botId: 'b1',
    plan: 'Search FDE roles',
    mode: 'explore',
    modeReason: 'nothing had surprised it for a while',
    chasing: 'Do LATAM roles pay less?',
  },
  goal: { id: 'g-1', title: 'Find remote roles' },
  reason: { text: 'Roles were stale', source: 'Strategist' },
  rule: '5 idle cycles in a row',
  related: {
    label: 'Built from',
    items: [{ text: 'Motum is open', at: '2026-10-10T12:00:00Z', detail: 'score 0.57' }],
    note: 'Reconstructed from what was held at the time.',
  },
  outcome: 'Held: the editor scored it 0.49; it needed 0.50 to reach you.',
  notes: [{ label: 'Editor', text: 'Partly backed' }],
};

const keys = (html: string) =>
  [...html.matchAll(/<span class="why-key">([^<]*)<\/span>/g)].map((m) => m[1]);

describe('whyPanel', () => {
  it('renders every row in the fixed order', () => {
    const html = whyPanel(full, { nowMs: NOW });
    expect(html).toMatch(/^<details class="why">/);
    expect(keys(html)).toEqual([
      'What',
      'By',
      'Goal',
      'Working on',
      'Mode',
      'Reason',
      'Rule',
      'Built from',
      'Outcome',
      'Editor',
    ]);
    expect(WHY_ROW_ORDER[0]).toBe('what');
  });

  it('renders open when asked, so a page can keep a fold open across a redraw', () => {
    expect(whyPanel(full, { nowMs: NOW, open: true })).toMatch(/^<details class="why" open>/);
    expect(whyPanel(full, { nowMs: NOW, open: false })).toMatch(/^<details class="why">/);
  });

  it('escapes everything it prints', () => {
    const html = whyPanel(full, { nowMs: NOW });
    expect(html).toContain('A finding &lt;from&gt; a cycle');
    expect(html).not.toContain('<from>');
  });

  it('links the goal to the agent and opens the cycle in place', () => {
    const html = whyPanel(full, { nowMs: NOW });
    expect(html).toContain('href="#/agents/b1"');
    expect(html).toContain('data-open-cycle="c-1"');
    expect(html).toContain('data-bot-id="b1"');
    expect(html).toContain('Search FDE roles');
  });

  it('explains an exploration cycle and the question it chased', () => {
    const html = whyPanel(full, { nowMs: NOW });
    expect(html).toContain('Exploration cycle: nothing had surprised it for a while');
    expect(html).toContain('Do LATAM roles pay less?');
  });

  it('related items carry their age and detail, and the note', () => {
    const html = whyPanel(full, { nowMs: NOW });
    expect(html).toContain('Motum is open');
    expect(html).toContain('24h ago');
    expect(html).toContain('score 0.57');
    expect(html).toContain('Reconstructed from what was held at the time.');
  });

  it('names every actor in words, the watcher included', () => {
    const html = whyPanel({ what: 'A neuron', by: 'watcher' });
    expect(html).toContain('<span class="why-key">By</span><span>the watcher</span>');
    expect(html).toContain('by the watcher');
  });

  it('leaves out empty rows', () => {
    expect(keys(whyPanel({ what: 'Just this' }))).toEqual(['What']);
  });

  it('footnotes: a cycle matched by time, and what is missing', () => {
    const html = whyPanel({
      what: 'x',
      cycle: { id: 'c', botId: 'b', inferred: true },
      missing: 'No record of the cycle',
    });
    expect(html).toContain('Cycle matched by time');
    expect(html).toContain('No record of the cycle');
  });

  it('the folded line: the goal head, else the rule, else who', () => {
    const summary = (why: object) =>
      /<summary>([\s\S]*?)<\/summary>/.exec(whyPanel(why))?.[1] ?? '';
    const long = `Build the brief ${'with labels '.repeat(10)}end`;
    expect(summary({ what: 'x', goal: { title: long } })).toContain('…');
    expect(summary({ what: 'x', goal: { title: long } })).not.toContain('end');
    expect(summary({ what: 'x', rule: '5 idle cycles' })).toContain('5 idle cycles');
    expect(summary({ what: 'x', by: 'strategist' })).toContain('the strategist');
    expect(summary({ what: 'x' })).toContain('Why this?');
  });

  it('a missing or empty why renders nothing', () => {
    expect(whyPanel(null)).toBe('');
    expect(whyPanel({})).toBe('');
  });
});
