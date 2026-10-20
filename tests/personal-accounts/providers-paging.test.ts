/**
 * A calendar listing reads every page the provider returns (prepass finding,
 * 2026-10-20): a busy week used to stop at the first page, so later events
 * were missing and free-slot answers reported occupied time as free.
 */
import { describe, expect, test } from 'bun:test';
import { googleProvider } from '../../src/personal-accounts/providers/google';
import { microsoftProvider } from '../../src/personal-accounts/providers/microsoft';
import type { AccountApi } from '../../src/personal-accounts/providers/types';

const FROM = new Date('2026-10-19T00:00:00Z');
const TO = new Date('2026-10-26T00:00:00Z');

/** Answers the url → body map in order; records every url asked for. */
function fakeApi(pages: Array<(url: string) => unknown>) {
  const urls: string[] = [];
  const api = (async (url: string) => {
    urls.push(url);
    const next = pages[urls.length - 1];
    if (!next) throw new Error(`unexpected request ${url}`);
    return next(url);
  }) as AccountApi;
  return { api, urls };
}

const gEvent = (id: string, day: number) => ({
  id,
  summary: id,
  start: { dateTime: `2026-10-${day}T10:00:00Z` },
  end: { dateTime: `2026-10-${day}T11:00:00Z` },
});

const msEvent = (id: string, day: number) => ({
  id,
  subject: id,
  start: { dateTime: `2026-10-${day}T10:00:00.0000000`, timeZone: 'UTC' },
  end: { dateTime: `2026-10-${day}T11:00:00.0000000`, timeZone: 'UTC' },
});

describe('calendar listings follow every page', () => {
  test('Google: nextPageToken is followed', async () => {
    const { api, urls } = fakeApi([
      () => ({ items: [gEvent('a', 20)], nextPageToken: 'p2' }),
      () => ({ items: [gEvent('b', 22)] }),
    ]);
    const events = await googleProvider.listEvents(api, FROM, TO);
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(urls[1]).toContain('pageToken=p2');
  });

  test('Microsoft: @odata.nextLink is followed', async () => {
    const next = 'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=abc';
    const { api, urls } = fakeApi([
      () => ({ value: [msEvent('a', 20)], '@odata.nextLink': next }),
      () => ({ value: [msEvent('b', 22)] }),
    ]);
    const events = await microsoftProvider.listEvents(api, FROM, TO);
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(urls[1]).toBe(next);
  });

  test('Microsoft: a next link off Graph is not followed (the token would go with it)', async () => {
    const { api, urls } = fakeApi([
      () => ({ value: [msEvent('a', 20)], '@odata.nextLink': 'https://evil.example/steal' }),
    ]);
    const events = await microsoftProvider.listEvents(api, FROM, TO);
    expect(events.map((e) => e.id)).toEqual(['a']);
    expect(urls).toHaveLength(1);
  });

  test('a provider that never stops paging is cut at a page cap', async () => {
    const endless = Array.from({ length: 100 }, (_, i) => () => ({
      items: [gEvent(`e${i}`, 20)],
      nextPageToken: `p${i + 1}`,
    }));
    const { api, urls } = fakeApi(endless);
    await googleProvider.listEvents(api, FROM, TO);
    expect(urls.length).toBeLessThanOrEqual(20);
  });
});
