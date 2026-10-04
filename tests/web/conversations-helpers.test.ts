import { describe, expect, it } from 'bun:test';
import {
  CONV_STATUSES,
  CONV_TYPES,
  botDisplayName,
  convStatus,
  convTypeLabel,
  conversationFilters,
  deleteAllDialog,
  filterConversations,
} from '../../web/pages/conversations-helpers.js';

const inboxPending = { id: '1', type: 'inbox', title: 'Ask: budget?', inboxStatus: 'pending' };
const inboxAnswered = { id: '2', type: 'inbox', title: 'Ask: dates', inboxStatus: 'answered' };
const chat = { id: '3', type: 'general', title: 'Planning chat' };
const prod = { id: '4', type: 'productions', title: 'About the report' };
const all = [inboxPending, inboxAnswered, chat, prod];

describe('convStatus', () => {
  it('inbox conversations are pending or closed; chats have no status', () => {
    expect(convStatus(inboxPending)).toBe('pending');
    expect(convStatus(inboxAnswered)).toBe('closed');
    expect(convStatus({ type: 'inbox', inboxStatus: 'timed_out' })).toBe('closed');
    expect(convStatus(chat)).toBe('');
  });
});

describe('convTypeLabel', () => {
  it('general reads as Chat', () => {
    expect(convTypeLabel('general')).toBe('Chat');
    expect(convTypeLabel('inbox')).toBe('Inbox');
    expect(convTypeLabel('productions')).toBe('Productions');
    expect(convTypeLabel('weird')).toBe('weird');
  });
});

describe('filterConversations', () => {
  it('no filter returns everything', () => {
    expect(filterConversations(all, {})).toHaveLength(4);
  });
  it('filters by type', () => {
    expect(filterConversations(all, { type: 'inbox' }).map((c) => c.id)).toEqual(['1', '2']);
    expect(filterConversations(all, { type: 'general' }).map((c) => c.id)).toEqual(['3']);
  });
  it('filters by status (chats drop out of a status filter)', () => {
    expect(filterConversations(all, { status: 'pending' }).map((c) => c.id)).toEqual(['1']);
    expect(filterConversations(all, { status: 'closed' }).map((c) => c.id)).toEqual(['2']);
  });
  it('searches the title case-insensitively', () => {
    expect(filterConversations(all, { q: 'ASK' }).map((c) => c.id)).toEqual(['1', '2']);
    expect(filterConversations(all, { q: '  report ' }).map((c) => c.id)).toEqual(['4']);
  });
  it('tolerates a non-array', () => {
    expect(filterConversations(null, {})).toEqual([]);
  });
});

describe('botDisplayName', () => {
  it('maps a bot id to its name from the conversations index', () => {
    const bots = [{ botId: 'b1', name: 'Scout' }];
    expect(botDisplayName(bots, 'b1')).toBe('Scout');
    expect(botDisplayName(bots, 'b2')).toBe('b2');
    expect(botDisplayName(null, 'b3')).toBe('b3');
  });
});

describe('deleteAllDialog', () => {
  it('states the count and is a danger dialog', () => {
    const d = deleteAllDialog(12);
    expect(d.tone).toBe('danger');
    expect(d.message).toContain('12');
    expect(d.confirmLabel).toContain('12');
  });
  it('scopes to one bot when named', () => {
    const d = deleteAllDialog(3, 'Scout');
    expect(d.message).toContain('Scout');
    expect(d.message).toContain('3');
  });
  it('singular for one', () => {
    expect(deleteAllDialog(1).confirmLabel).toBe('Delete 1 conversation');
  });
});

describe('conversationFilters', () => {
  it('renders type + status selects and a page-filter search', () => {
    const html = conversationFilters({ type: 'inbox', status: 'pending', q: 'a"b' });
    expect(html).toContain('data-page-filter');
    expect(html).toContain('value="a&quot;b"');
    expect(html).toContain('value="inbox" selected');
    expect(html).toContain('value="pending" selected');
    for (const t of CONV_TYPES) expect(html).toContain(`value="${t.id}"`);
    for (const s of CONV_STATUSES) expect(html).toContain(`value="${s.id}"`);
  });
});
