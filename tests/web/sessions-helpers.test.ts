import { describe, expect, it } from 'bun:test';
import {
  TRANSCRIPT_PAGE,
  earlierWindow,
  latestWindow,
  normalizeSessionList,
  parseSessionKey,
  transcriptText,
} from '../../web/pages/sessions-helpers.js';

describe('normalizeSessionList', () => {
  it('sorts sessions by last activity, newest first', () => {
    const res = normalizeSessionList([
      { key: 'a', lastActivityAt: '2026-01-01T00:00:00Z' },
      { key: 'b', lastActivityAt: '2026-02-01T00:00:00Z' },
    ]);
    expect(res.error).toBeNull();
    expect(res.sessions.map((s) => s.key)).toEqual(['b', 'a']);
  });
  it('turns an API error object into an error instead of crashing', () => {
    expect(normalizeSessionList({ error: 'Unauthorized' })).toEqual({
      error: 'Unauthorized',
      sessions: [],
    });
  });
  it('treats null / garbage as an error', () => {
    expect(normalizeSessionList(null).error).toBeTruthy();
    expect(normalizeSessionList('nope').error).toBeTruthy();
  });
});

describe('parseSessionKey', () => {
  it('labels DMs, groups and topics', () => {
    expect(parseSessionKey('bot:scout:private:123').label).toBe('DM 123 (scout)');
    expect(parseSessionKey('bot:scout:group:-5:topic:9').label).toBe('group -5 (scout) #9');
    expect(parseSessionKey('').botId).toBe('?');
  });
});

describe('transcript windows', () => {
  it('opens on the latest page', () => {
    expect(latestWindow(50, TRANSCRIPT_PAGE)).toBe(0);
    expect(latestWindow(450, 200)).toBe(250);
  });
  it('loads the page before the current start', () => {
    expect(earlierWindow(250, 200)).toEqual({ offset: 50, limit: 200 });
    expect(earlierWindow(50, 200)).toEqual({ offset: 0, limit: 50 });
  });
  it('null when already at the start', () => {
    expect(earlierWindow(0, 200)).toBeNull();
  });
});

describe('transcriptText', () => {
  it('reads string or block content', () => {
    expect(transcriptText({ content: 'hi' })).toBe('hi');
    expect(transcriptText({ content: [{ text: 'a' }, { type: 'image' }] })).toBe('a\n[media]');
    expect(transcriptText({})).toBe('');
  });
});
