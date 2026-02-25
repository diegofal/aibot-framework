import { describe, test, expect, mock, afterEach } from 'bun:test';
import { createCalendarListTool, createCalendarAvailabilityTool, createCalendarScheduleTool } from '../../src/tools/calendar';
import type { CalendarConfig } from '../../src/config';

const mockLogger = {
  info: mock(() => {}),
  debug: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  child: () => mockLogger,
} as any;

const googleConfig: CalendarConfig = {
  enabled: true,
  provider: 'google',
  apiKey: 'test-google-api-key',
  calendarId: 'primary',
  defaultTimezone: 'America/Argentina/Buenos_Aires',
  cacheTtlMs: 60_000,
  timeout: 30_000,
};

const calendlyConfig: CalendarConfig = {
  ...googleConfig,
  provider: 'calendly',
  apiKey: 'test-calendly-token',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// --- calendar_list ---

describe('calendar_list', () => {
  test('definition has correct name', () => {
    const tool = createCalendarListTool(googleConfig);
    expect(tool.definition.function.name).toBe('calendar_list');
  });

  test('returns formatted events (Google)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(
        JSON.stringify({
          items: [
            {
              id: 'evt1',
              summary: 'Team Standup',
              start: { dateTime: '2026-03-01T09:00:00-03:00' },
              end: { dateTime: '2026-03-01T09:30:00-03:00' },
              location: 'Office',
            },
            {
              id: 'evt2',
              summary: 'Lunch Meeting',
              start: { dateTime: '2026-03-01T12:00:00-03:00' },
              end: { dateTime: '2026-03-01T13:00:00-03:00' },
              attendees: [{ email: 'bob@example.com' }],
            },
          ],
        }),
        { status: 200 },
      )),
    ) as typeof fetch;

    const tool = createCalendarListTool(googleConfig);
    const result = await tool.execute({ days: 7 }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Team Standup');
    expect(result.content).toContain('Lunch Meeting');
    expect(result.content).toContain('Office');
    expect(result.content).toContain('bob@example.com');
    expect(result.content).toContain('EXTERNAL_UNTRUSTED_CONTENT');
  });

  test('returns message for no events', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 })),
    ) as typeof fetch;

    const tool = createCalendarListTool(googleConfig);
    const result = await tool.execute({ days: 1 }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('No upcoming events');
  });

  test('handles API errors', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })),
    ) as typeof fetch;

    const tool = createCalendarListTool(googleConfig);
    const result = await tool.execute({}, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('failed');
  });

  test('caches results', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(
        JSON.stringify({ items: [{ id: '1', summary: 'Event', start: { dateTime: '2026-03-01T10:00:00Z' }, end: { dateTime: '2026-03-01T11:00:00Z' } }] }),
        { status: 200 },
      )),
    ) as typeof fetch;

    const tool = createCalendarListTool(googleConfig);
    const r1 = await tool.execute({ days: 3, limit: 5 }, mockLogger);
    const r2 = await tool.execute({ days: 3, limit: 5 }, mockLogger);
    expect(r1.content).toBe(r2.content);
  });

  test('clamps days and limit', async () => {
    let capturedUrl = '';
    globalThis.fetch = mock((url: string) => {
      capturedUrl = url;
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }) as typeof fetch;

    const tool = createCalendarListTool(googleConfig);
    await tool.execute({ days: 100, limit: 200 }, mockLogger);
    expect(capturedUrl).toContain('maxResults=50');
  });

  test('works with Calendly provider', async () => {
    let callCount = 0;
    globalThis.fetch = mock((url: string) => {
      callCount++;
      if (url.includes('/users/me')) {
        return Promise.resolve(new Response(
          JSON.stringify({ resource: { uri: 'https://api.calendly.com/users/abc123' } }),
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response(
        JSON.stringify({
          collection: [{
            uri: 'https://api.calendly.com/scheduled_events/evt1',
            name: 'Calendly Meeting',
            start_time: '2026-03-01T10:00:00Z',
            end_time: '2026-03-01T10:30:00Z',
          }],
        }),
        { status: 200 },
      ));
    }) as typeof fetch;

    const tool = createCalendarListTool(calendlyConfig);
    const result = await tool.execute({ days: 7 }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Calendly Meeting');
  });
});

// --- calendar_availability ---

describe('calendar_availability', () => {
  test('definition has correct name and required params', () => {
    const tool = createCalendarAvailabilityTool(googleConfig);
    expect(tool.definition.function.name).toBe('calendar_availability');
    expect(tool.definition.function.parameters.required).toEqual(['date']);
  });

  test('returns error for missing date', async () => {
    const tool = createCalendarAvailabilityTool(googleConfig);
    const result = await tool.execute({}, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing or invalid');
  });

  test('returns error for invalid date format', async () => {
    const tool = createCalendarAvailabilityTool(googleConfig);
    const result = await tool.execute({ date: 'tomorrow' }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('YYYY-MM-DD');
  });

  test('returns busy slots (Google)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(
        JSON.stringify({
          calendars: {
            primary: {
              busy: [
                { start: '2026-03-01T09:00:00Z', end: '2026-03-01T10:00:00Z' },
                { start: '2026-03-01T14:00:00Z', end: '2026-03-01T15:30:00Z' },
              ],
            },
          },
        }),
        { status: 200 },
      )),
    ) as typeof fetch;

    const tool = createCalendarAvailabilityTool(googleConfig);
    const result = await tool.execute({ date: '2026-03-01' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Busy');
    expect(result.content).toContain('30-minute slots');
  });

  test('returns all-free message when no busy slots', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(
        JSON.stringify({ calendars: { primary: { busy: [] } } }),
        { status: 200 },
      )),
    ) as typeof fetch;

    const tool = createCalendarAvailabilityTool(googleConfig);
    const result = await tool.execute({ date: '2026-03-01' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Entire day is free');
  });
});

// --- calendar_schedule ---

describe('calendar_schedule', () => {
  test('definition has correct name and includes ask_permission instruction', () => {
    const tool = createCalendarScheduleTool(googleConfig);
    expect(tool.definition.function.name).toBe('calendar_schedule');
    expect(tool.definition.function.description).toContain('ask_permission');
  });

  test('returns error for missing title', async () => {
    const tool = createCalendarScheduleTool(googleConfig);
    const result = await tool.execute({ start_time: '2026-03-01T10:00:00Z', duration_minutes: 30 }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('title');
  });

  test('returns error for missing start_time', async () => {
    const tool = createCalendarScheduleTool(googleConfig);
    const result = await tool.execute({ title: 'Meeting', duration_minutes: 30 }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('start_time');
  });

  test('returns error for invalid start_time', async () => {
    const tool = createCalendarScheduleTool(googleConfig);
    const result = await tool.execute({ title: 'Meeting', start_time: 'not-a-date', duration_minutes: 30 }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Invalid');
  });

  test('schedules event successfully (Google)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(
        JSON.stringify({
          id: 'new-evt-123',
          summary: 'Team Sync',
          start: { dateTime: '2026-03-01T14:00:00-03:00' },
          end: { dateTime: '2026-03-01T14:30:00-03:00' },
        }),
        { status: 200 },
      )),
    ) as typeof fetch;

    const tool = createCalendarScheduleTool(googleConfig);
    const result = await tool.execute({
      title: 'Team Sync',
      start_time: '2026-03-01T14:00:00-03:00',
      duration_minutes: 30,
    }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('successfully');
    expect(result.content).toContain('Team Sync');
    expect(result.content).toContain('new-evt-123');
  });

  test('sends attendees in request (Google)', async () => {
    let capturedBody: string = '';
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string ?? '';
      return Promise.resolve(new Response(
        JSON.stringify({
          id: 'evt-with-attendees',
          summary: 'With Attendees',
          start: { dateTime: '2026-03-01T14:00:00Z' },
          end: { dateTime: '2026-03-01T15:00:00Z' },
        }),
        { status: 200 },
      ));
    }) as typeof fetch;

    const tool = createCalendarScheduleTool(googleConfig);
    await tool.execute({
      title: 'With Attendees',
      start_time: '2026-03-01T14:00:00Z',
      duration_minutes: 60,
      attendees: ['alice@example.com', 'bob@example.com'],
    }, mockLogger);

    const body = JSON.parse(capturedBody);
    expect(body.attendees).toEqual([{ email: 'alice@example.com' }, { email: 'bob@example.com' }]);
  });

  test('handles Calendly schedule limitation gracefully', async () => {
    // Calendly's user/me endpoint must succeed first
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(
        JSON.stringify({ resource: { uri: 'https://api.calendly.com/users/abc' } }),
        { status: 200 },
      )),
    ) as typeof fetch;

    const tool = createCalendarScheduleTool(calendlyConfig);
    const result = await tool.execute({
      title: 'Meeting',
      start_time: '2026-03-01T10:00:00Z',
      duration_minutes: 30,
    }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('scheduling links');
  });

  test('handles API errors', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Forbidden', { status: 403, statusText: 'Forbidden' })),
    ) as typeof fetch;

    const tool = createCalendarScheduleTool(googleConfig);
    const result = await tool.execute({
      title: 'Meeting',
      start_time: '2026-03-01T10:00:00Z',
      duration_minutes: 30,
    }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('failed');
  });
});
