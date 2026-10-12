import { describe, expect, it } from 'bun:test';
import {
  SENT_FILTERS,
  filterSent,
  mergeSentPage,
  recipientLabel,
  sentCard,
  sentCounts,
  sentList,
} from '../../web/pages/sent-helpers.js';

const NOW = Date.parse('2026-10-11T18:00:00Z');

const msg = (over: Record<string, unknown> = {}) => ({
  botId: 'b1',
  botName: 'Bot <One>',
  sentAt: '2026-10-11T17:00:00Z',
  recipient: 'operator',
  toOperator: true,
  message: 'Synthetic <b>hello</b>\nsecond line',
  status: 'delivered',
  delivered: true,
  why: {
    what: 'A message it chose to send you',
    by: 'agent',
    outcome: 'Delivered to you on Telegram.',
  },
  ...over,
});

describe('sent-helpers', () => {
  it('filters and counts by delivery', () => {
    const list = [
      msg(),
      msg({ status: 'refused', delivered: false, sentAt: '2026-10-11T16:00:00Z' }),
      msg({ status: 'failed', delivered: false, sentAt: '2026-10-11T15:00:00Z' }),
    ];
    expect(SENT_FILTERS.map((f) => f.id)).toEqual(['all', 'delivered', 'not-sent']);
    expect(filterSent(list, 'delivered')).toHaveLength(1);
    expect(filterSent(list, 'not-sent')).toHaveLength(2);
    expect(filterSent(list, 'all')).toHaveLength(3);
    expect(sentCounts(list)).toEqual({ all: 3, delivered: 1, 'not-sent': 2 });
  });

  it('labels the recipient', () => {
    expect(recipientLabel(msg())).toBe('to you');
    expect(recipientLabel(msg({ toOperator: false, recipient: '777' }))).toBe('to 777');
  });

  it('a card escapes, shows the bot, status and the shared why fold', () => {
    const html = sentCard(msg({ status: 'refused', delivered: false, reason: 'throttled <x>' }), {
      nowMs: NOW,
    });
    expect(html).toContain('Bot &lt;One&gt;');
    expect(html).toContain('Synthetic &lt;b&gt;hello&lt;/b&gt;');
    expect(html).not.toContain('<b>hello');
    expect(html).toContain('not sent');
    expect(html).toContain('throttled &lt;x&gt;');
    expect(html).toContain('<details class="why">');
    expect(html).toContain('href="#/agents/b1"');
  });

  it('a delivered card has no failure line', () => {
    const html = sentCard(msg(), { nowMs: NOW });
    expect(html).toContain('to you');
    expect(html).not.toContain('sent-reason');
  });

  it('an empty list is an empty state', () => {
    expect(sentList([], { emptyTitle: 'Nothing sent' })).toContain('Nothing sent');
  });

  it('merges an older page without duplicates', () => {
    const a = msg();
    const b = msg({ sentAt: '2026-10-11T10:00:00Z' });
    expect(mergeSentPage([a], [a, b])).toEqual([a, b]);
  });
});
