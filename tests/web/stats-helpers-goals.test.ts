import { describe, expect, it } from 'bun:test';
import { goalsBoard } from '../../web/pages/stats-helpers.js';

// The Goals board on a bot's stats page rendered "(untitled)" for every goal
// on every bot — the backend field is `text`, the frontend read `title`.
// Notes never rendered either: the backend only ever sent `notesLength` (a
// number), not the text the frontend's preview needed.

describe('goalsBoard', () => {
  it('shows the real goal title (backend field is `text`, not `title`)', () => {
    const html = goalsBoard(
      [{ text: 'Iterate on the manifesto', status: 'blocked', priority: 'high' }],
      {}
    );
    expect(html).toContain('Iterate on the manifesto');
    expect(html).not.toContain('(untitled)');
  });

  it('falls back to "(untitled)" only when the goal genuinely has no text', () => {
    const html = goalsBoard([{ text: '', status: 'pending', priority: 'low' }], {});
    expect(html).toContain('(untitled)');
  });

  it('renders a truncated notes preview from real notes text', () => {
    const html = goalsBoard(
      [{ text: 'X', status: 'active', notes: 'a'.repeat(300) }],
      {}
    );
    expect(html).toContain('stats-goal-notes');
    expect(html).toContain(`${'a'.repeat(240)}…`);
    expect(html).not.toContain('a'.repeat(241));
  });

  it('omits the notes block entirely when there are none', () => {
    const html = goalsBoard([{ text: 'X', status: 'active', notes: null }], {});
    expect(html).not.toContain('stats-goal-notes');
  });

  it('groups by status in the fixed priority order and shows per-group counts', () => {
    const html = goalsBoard(
      [
        { text: 'C', status: 'completed' },
        { text: 'A1', status: 'active' },
        { text: 'B', status: 'blocked' },
        { text: 'A2', status: 'active' },
      ],
      {}
    );
    const activeIdx = html.indexOf('badge-mcp">active');
    const blockedIdx = html.indexOf('badge-error">blocked');
    const completedIdx = html.indexOf('badge-ok">completed');
    expect(activeIdx).toBeGreaterThanOrEqual(0);
    expect(activeIdx).toBeLessThan(blockedIdx);
    expect(blockedIdx).toBeLessThan(completedIdx);
    expect(html).toContain('<span class="count">2</span>'); // the two active goals
  });

  it('shows the priority chip and the completion date, and renders outcome text', () => {
    const html = goalsBoard(
      [{ text: 'Ship it', status: 'completed', priority: 'high', completed: '2026-08-10', outcome: 'shipped' }],
      {}
    );
    expect(html).toContain('stats-chip">high');
    expect(html).toContain('outcome:');
    expect(html).toContain('shipped');
  });

  it('surfaces the hygiene flags (archived-in-active, duplicates, oversized notes)', () => {
    const html = goalsBoard([{ text: 'X', status: 'active' }], {
      archivedInActive: 2,
      duplicates: 1,
      oversizedNotes: 3,
    });
    expect(html).toContain('2 archived in active');
    expect(html).toContain('1 duplicates');
    expect(html).toContain('3 oversized notes');
  });

  it('escapes hostile goal text', () => {
    const html = goalsBoard([{ text: '<script>alert(1)</script>', status: 'active' }], {});
    expect(html).not.toContain('<script>');
  });

  it('handles no goals and a missing detail array without throwing', () => {
    expect(goalsBoard([], {})).toContain('No goals');
    expect(goalsBoard(undefined, undefined)).toContain('No goals');
  });
});
