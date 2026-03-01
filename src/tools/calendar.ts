import type { CalendarConfig } from '../config';
import type { Logger } from '../logger';
import { apiRequest } from './api-client';
import { TtlCache } from './cache';
import type { Tool, ToolResult } from './types';
import { wrapExternalContent } from './types';

// --- Provider abstraction ---

interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  description?: string;
  location?: string;
  attendees?: string[];
}

interface TimeSlot {
  start: string;
  end: string;
}

interface NewEvent {
  title: string;
  start: string;
  durationMinutes: number;
  description?: string;
  attendees?: string[];
}

interface CalendarProvider {
  listEvents(start: string, end: string, limit: number): Promise<CalendarEvent[]>;
  getAvailability(start: string, end: string): Promise<TimeSlot[]>;
  scheduleEvent(event: NewEvent): Promise<CalendarEvent>;
}

// --- Calendly Provider ---

class CalendlyProvider implements CalendarProvider {
  constructor(
    private apiKey: string,
    private timeout: number
  ) {}

  private async getUserUri(): Promise<string> {
    const result = await apiRequest<{ resource: { uri: string } }>(
      'https://api.calendly.com/users/me',
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: this.timeout,
      }
    );
    if (!result.ok) throw new Error(`Calendly auth failed: ${result.status}`);
    return result.data.resource.uri;
  }

  async listEvents(start: string, end: string, limit: number): Promise<CalendarEvent[]> {
    const userUri = await this.getUserUri();
    const url = new URL('https://api.calendly.com/scheduled_events');
    url.searchParams.set('user', userUri);
    url.searchParams.set('min_start_time', start);
    url.searchParams.set('max_start_time', end);
    url.searchParams.set('count', String(limit));
    url.searchParams.set('status', 'active');
    url.searchParams.set('sort', 'start_time:asc');

    const result = await apiRequest<{
      collection: Array<{
        uri: string;
        name: string;
        start_time: string;
        end_time: string;
        location?: { location?: string };
      }>;
    }>(url.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeout: this.timeout,
    });

    if (!result.ok) throw new Error(`Calendly API error: ${result.status} ${result.message}`);

    return result.data.collection.map((e) => ({
      id: e.uri.split('/').pop()!,
      title: e.name,
      start: e.start_time,
      end: e.end_time,
      location: e.location?.location,
    }));
  }

  async getAvailability(start: string, end: string): Promise<TimeSlot[]> {
    const userUri = await this.getUserUri();
    const url = new URL('https://api.calendly.com/user_busy_times');
    url.searchParams.set('user', userUri);
    url.searchParams.set('start_time', start);
    url.searchParams.set('end_time', end);

    const result = await apiRequest<{
      collection: Array<{ start_time: string; end_time: string }>;
    }>(url.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeout: this.timeout,
    });

    if (!result.ok) throw new Error(`Calendly API error: ${result.status} ${result.message}`);

    // Return busy times — the LLM can infer free slots from these
    return result.data.collection.map((b) => ({
      start: b.start_time,
      end: b.end_time,
    }));
  }

  async scheduleEvent(_event: NewEvent): Promise<CalendarEvent> {
    // Calendly doesn't support creating events via API — it's a scheduling link platform.
    // Return a helpful message directing to use scheduling links.
    throw new Error(
      'Calendly does not support direct event creation via API. Use scheduling links instead.'
    );
  }
}

// --- Google Calendar Provider ---

class GoogleCalendarProvider implements CalendarProvider {
  private calendarId: string;

  constructor(
    private apiKey: string,
    calendarId: string | undefined,
    private timeout: number
  ) {
    this.calendarId = calendarId || 'primary';
  }

  private get baseUrl(): string {
    return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}`;
  }

  async listEvents(start: string, end: string, limit: number): Promise<CalendarEvent[]> {
    const url = new URL(`${this.baseUrl}/events`);
    url.searchParams.set('timeMin', start);
    url.searchParams.set('timeMax', end);
    url.searchParams.set('maxResults', String(limit));
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');

    const result = await apiRequest<{
      items?: Array<{
        id: string;
        summary: string;
        start: { dateTime?: string; date?: string };
        end: { dateTime?: string; date?: string };
        description?: string;
        location?: string;
        attendees?: Array<{ email: string }>;
      }>;
    }>(url.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeout: this.timeout,
    });

    if (!result.ok)
      throw new Error(`Google Calendar API error: ${result.status} ${result.message}`);

    return (result.data.items ?? []).map((e) => ({
      id: e.id,
      title: e.summary || '(no title)',
      start: e.start.dateTime || e.start.date || '',
      end: e.end.dateTime || e.end.date || '',
      description: e.description,
      location: e.location,
      attendees: e.attendees?.map((a) => a.email),
    }));
  }

  async getAvailability(start: string, end: string): Promise<TimeSlot[]> {
    const url = 'https://www.googleapis.com/calendar/v3/freeBusy';

    const result = await apiRequest<{
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
    }>(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: {
        timeMin: start,
        timeMax: end,
        items: [{ id: this.calendarId }],
      },
      timeout: this.timeout,
    });

    if (!result.ok)
      throw new Error(`Google Calendar API error: ${result.status} ${result.message}`);

    const calData = result.data.calendars?.[this.calendarId];
    return (calData?.busy ?? []).map((b) => ({ start: b.start, end: b.end }));
  }

  async scheduleEvent(event: NewEvent): Promise<CalendarEvent> {
    const startDate = new Date(event.start);
    const endDate = new Date(startDate.getTime() + event.durationMinutes * 60_000);

    const body: Record<string, unknown> = {
      summary: event.title,
      start: { dateTime: startDate.toISOString() },
      end: { dateTime: endDate.toISOString() },
    };
    if (event.description) body.description = event.description;
    if (event.attendees?.length) {
      body.attendees = event.attendees.map((email) => ({ email }));
    }

    const result = await apiRequest<{
      id: string;
      summary: string;
      start: { dateTime: string };
      end: { dateTime: string };
      htmlLink?: string;
    }>(`${this.baseUrl}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body,
      timeout: this.timeout,
    });

    if (!result.ok)
      throw new Error(`Google Calendar API error: ${result.status} ${result.message}`);

    return {
      id: result.data.id,
      title: result.data.summary,
      start: result.data.start.dateTime,
      end: result.data.end.dateTime,
    };
  }
}

// --- Provider factory ---

function createProvider(config: CalendarConfig): CalendarProvider {
  if (config.provider === 'calendly') {
    return new CalendlyProvider(config.apiKey, config.timeout);
  }
  return new GoogleCalendarProvider(config.apiKey, config.calendarId, config.timeout);
}

// --- Response formatting ---

function formatEvent(event: CalendarEvent, index: number): string {
  const start = formatDateTime(event.start);
  const end = formatTime(event.end);
  const lines = [`${index + 1}. ${event.title}`, `   ${start} — ${end}`];
  if (event.location) lines.push(`   Location: ${event.location}`);
  if (event.description) {
    const desc =
      event.description.length > 150 ? `${event.description.slice(0, 150)}...` : event.description;
    lines.push(`   ${desc}`);
  }
  if (event.attendees?.length) {
    lines.push(`   Attendees: ${event.attendees.join(', ')}`);
  }
  return lines.join('\n');
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('es-AR', { timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function formatBusySlot(slot: TimeSlot, index: number): string {
  return `${index + 1}. Busy: ${formatDateTime(slot.start)} — ${formatTime(slot.end)}`;
}

// --- Tool factories ---

export function createCalendarListTool(config: CalendarConfig): Tool {
  const cache = new TtlCache<string>(config.cacheTtlMs);
  const provider = createProvider(config);

  return {
    definition: {
      type: 'function',
      function: {
        name: 'calendar_list',
        description: 'List upcoming calendar events. Returns event titles, times, and details.',
        parameters: {
          type: 'object',
          properties: {
            days: {
              type: 'number',
              description: 'Number of days to look ahead (1-30, default 7)',
            },
            limit: {
              type: 'number',
              description: 'Maximum events to return (1-50, default 10)',
            },
          },
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const days = Math.min(Math.max(Number(args.days) || 7, 1), 30);
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);

      const now = new Date();
      const end = new Date(now.getTime() + days * 86_400_000);
      const startIso = now.toISOString();
      const endIso = end.toISOString();

      const cacheKey = `list:${days}:${limit}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        logger.debug('calendar_list cache hit');
        return { success: true, content: cached };
      }

      try {
        logger.info({ days, limit }, 'Executing calendar_list');
        const events = await provider.listEvents(startIso, endIso, limit);

        if (events.length === 0) {
          const content = wrapExternalContent(`No upcoming events in the next ${days} day(s).`);
          return { success: true, content };
        }

        const formatted = events.map((e, i) => formatEvent(e, i)).join('\n\n');
        const content = wrapExternalContent(`Upcoming events (next ${days} days):\n\n${formatted}`);

        cache.set(cacheKey, content);
        logger.debug({ eventCount: events.length }, 'calendar_list completed');
        return { success: true, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'calendar_list failed');
        return { success: false, content: `Calendar list failed: ${message}` };
      }
    },
  };
}

export function createCalendarAvailabilityTool(config: CalendarConfig): Tool {
  const cache = new TtlCache<string>(config.cacheTtlMs);
  const provider = createProvider(config);

  return {
    definition: {
      type: 'function',
      function: {
        name: 'calendar_availability',
        description:
          'Check calendar availability for a specific date. Returns busy time slots so you can identify free times.',
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'Date to check (YYYY-MM-DD format)',
            },
            duration_minutes: {
              type: 'number',
              enum: [15, 30, 60],
              description: 'Desired meeting duration in minutes (default 30)',
            },
          },
          required: ['date'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const date = String(args.date ?? '').trim();
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return {
          success: false,
          content: 'Missing or invalid date parameter (expected YYYY-MM-DD)',
        };
      }

      const durationMinutes = Number(args.duration_minutes) || 30;
      const tz = config.defaultTimezone;

      const cacheKey = `avail:${date}:${durationMinutes}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        logger.debug({ date }, 'calendar_availability cache hit');
        return { success: true, content: cached };
      }

      try {
        // Create start/end for the full day in the configured timezone
        const startIso = new Date(`${date}T00:00:00`).toISOString();
        const endIso = new Date(`${date}T23:59:59`).toISOString();

        logger.info({ date, durationMinutes }, 'Executing calendar_availability');
        const busySlots = await provider.getAvailability(startIso, endIso);

        if (busySlots.length === 0) {
          const content = wrapExternalContent(
            `Availability for ${date}: Entire day is free (timezone: ${tz}).`
          );
          cache.set(cacheKey, content);
          return { success: true, content };
        }

        const formatted = busySlots.map((s, i) => formatBusySlot(s, i)).join('\n');
        const content = wrapExternalContent(
          `Busy slots for ${date} (timezone: ${tz}):\n\n${formatted}\n\nLooking for ${durationMinutes}-minute slots. Free times are outside the busy periods listed above.`
        );

        cache.set(cacheKey, content);
        logger.debug({ date, busyCount: busySlots.length }, 'calendar_availability completed');
        return { success: true, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message, date }, 'calendar_availability failed');
        return { success: false, content: `Calendar availability failed: ${message}` };
      }
    },
  };
}

export function createCalendarScheduleTool(config: CalendarConfig): Tool {
  const provider = createProvider(config);

  return {
    definition: {
      type: 'function',
      function: {
        name: 'calendar_schedule',
        description:
          'Schedule a new calendar event. IMPORTANT: Before scheduling, use ask_permission to get operator approval.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Event title' },
            start_time: {
              type: 'string',
              description: 'Event start time in ISO 8601 format (e.g. 2026-03-01T14:00:00-03:00)',
            },
            duration_minutes: {
              type: 'number',
              description: 'Duration in minutes (default 30)',
            },
            description: { type: 'string', description: 'Event description (optional)' },
            attendees: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of attendee email addresses (optional)',
            },
          },
          required: ['title', 'start_time', 'duration_minutes'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const title = String(args.title ?? '').trim();
      const startTime = String(args.start_time ?? '').trim();
      const durationMinutes = Number(args.duration_minutes) || 30;

      if (!title) return { success: false, content: 'Missing required parameter: title' };
      if (!startTime) return { success: false, content: 'Missing required parameter: start_time' };

      // Validate ISO date
      const parsed = new Date(startTime);
      if (Number.isNaN(parsed.getTime())) {
        return {
          success: false,
          content: 'Invalid start_time format. Use ISO 8601 (e.g. 2026-03-01T14:00:00-03:00)',
        };
      }

      try {
        logger.info({ title, startTime, durationMinutes }, 'Executing calendar_schedule');

        const event = await provider.scheduleEvent({
          title,
          start: startTime,
          durationMinutes,
          description: args.description ? String(args.description) : undefined,
          attendees: Array.isArray(args.attendees) ? args.attendees.map(String) : undefined,
        });

        const endTime = formatTime(event.end);
        const content = [
          'Event scheduled successfully!',
          `Title: ${event.title}`,
          `Start: ${formatDateTime(event.start)}`,
          `End: ${endTime}`,
          `ID: ${event.id}`,
        ].join('\n');

        logger.info({ eventId: event.id }, 'calendar_schedule completed');
        return { success: true, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message, title }, 'calendar_schedule failed');
        return { success: false, content: `Calendar schedule failed: ${message}` };
      }
    },
  };
}
