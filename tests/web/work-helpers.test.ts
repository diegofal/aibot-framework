import { describe, expect, it } from 'bun:test';
import {
  WORK_STATUSES,
  entriesList,
  entryRow,
  entryStatus,
  entryTitle,
  fileHref,
  filterEntries,
  sortEntries,
  workFilters,
  workSummary,
} from '../../web/pages/work-helpers.js';

const NOW = 1_700_000_000_000;
const H = 3_600_000;
const names = { b1: 'Bot One', b2: 'Bot <Two>' };

const unreviewed = {
  id: 'e1',
  timestamp: new Date(NOW - 2 * H).toISOString(),
  botId: 'b1',
  tool: 'file_write',
  path: 'reports/2026-09-15 weekly.md',
  action: 'create',
  description: 'Weekly <summary>',
  size: 1200,
  trackOnly: false,
};
const approved = {
  ...unreviewed,
  id: 'e2',
  timestamp: new Date(NOW - 30 * H).toISOString(),
  botId: 'b2',
  action: 'edit',
  path: 'notes.md',
  evaluation: { status: 'approved', rating: 4 },
};
const rejected = {
  ...unreviewed,
  id: 'e3',
  timestamp: new Date(NOW - H).toISOString(),
  evaluation: { status: 'rejected' },
};
const archived = {
  ...unreviewed,
  id: 'e4',
  action: 'archive',
  timestamp: new Date(NOW).toISOString(),
};

describe('entryStatus / filterEntries / sortEntries / workSummary', () => {
  it('derives the review status', () => {
    expect(entryStatus(unreviewed)).toBe('unreviewed');
    expect(entryStatus(approved)).toBe('approved');
    expect(entryStatus(rejected)).toBe('rejected');
    expect(entryStatus(archived)).toBe('archived');
  });
  it('filters by status and agent', () => {
    const all = [unreviewed, approved, rejected, archived];
    expect(filterEntries(all, { status: 'unreviewed' }).map((e) => e.id)).toEqual(['e1']);
    expect(filterEntries(all, { status: 'approved' }).map((e) => e.id)).toEqual(['e2']);
    expect(filterEntries(all, { botId: 'b2' }).map((e) => e.id)).toEqual(['e2']);
    expect(filterEntries(all, { status: 'all' })).toHaveLength(4);
    expect(WORK_STATUSES.map((s) => s.id)).toEqual(['all', 'unreviewed', 'approved', 'rejected']);
  });
  it('sorts newest first without mutating', () => {
    const input = [approved, unreviewed, rejected];
    expect(sortEntries(input).map((e) => e.id)).toEqual(['e3', 'e1', 'e2']);
    expect(input[0].id).toBe('e2');
  });
  it('counts by status', () => {
    expect(workSummary([unreviewed, approved, rejected, archived])).toEqual({
      total: 4,
      unreviewed: 1,
      approved: 1,
      rejected: 1,
      archived: 1,
    });
  });
});

describe('entryTitle / fileHref', () => {
  it('uses the file name as the title and the description as the detail', () => {
    expect(entryTitle(unreviewed)).toBe('2026-09-15 weekly.md');
    expect(entryTitle({ ...unreviewed, path: 'a/b/c' })).toBe('c');
  });
  it('links into the productions explorer with bot and file', () => {
    expect(fileHref(unreviewed)).toBe(
      '#/work/productions?bot=b1&file=reports%2F2026-09-15%20weekly.md'
    );
  });
});

describe('entryRow / entriesList', () => {
  it('renders avatar, agent, title, action badge, age and review buttons for an unreviewed entry', () => {
    const html = entryRow(unreviewed, { names, nowMs: NOW });
    expect(html).toContain('data-id="e1"');
    expect(html).toContain('data-bot-id="b1"');
    expect(html).toContain('ui-avatar');
    expect(html).toContain('Bot One');
    expect(html).toContain('2026-09-15 weekly.md');
    expect(html).toContain('&lt;summary&gt;');
    expect(html).toContain('2h ago');
    expect(html).toContain('data-action="approve"');
    expect(html).toContain('data-action="reject"');
    expect(html).toContain(fileHref(unreviewed));
  });
  it('shows the verdict instead of buttons once reviewed', () => {
    const html = entryRow(approved, { names, nowMs: NOW });
    expect(html).not.toContain('data-action="approve"');
    expect(html).toContain('approved');
    expect(html).toContain('★');
    expect(html).toContain('&lt;Two&gt;');
  });
  it('entriesList renders rows or an empty state', () => {
    expect(entriesList([unreviewed, approved], { names, nowMs: NOW })).toContain(
      'class="work-list"'
    );
    expect(entriesList([], { names, nowMs: NOW, filtered: true })).toContain('Nothing matches');
    expect(entriesList([], { names, nowMs: NOW })).toContain('No outputs yet');
  });
});

describe('workFilters', () => {
  it('renders status chips with counts and an agent select', () => {
    const html = workFilters({
      status: 'unreviewed',
      botId: 'b1',
      agents: [
        { id: 'b1', name: 'Bot One' },
        { id: 'b2', name: 'Bot <Two>' },
      ],
      counts: { total: 4, unreviewed: 1, approved: 1, rejected: 1 },
    });
    expect(html).toContain('data-status="all"');
    expect(html).toContain('data-status="unreviewed" aria-pressed="true"');
    expect(html).toContain('To review');
    expect(html).toContain('>1<');
    expect(html).toContain('id="work-filter-agent"');
    expect(html).toContain('value="b1" selected');
    expect(html).toContain('&lt;Two&gt;');
  });
});
